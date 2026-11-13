/**
 * channel-slack's only egress: a small Slack Web API client over an injected
 * `fetch`. No Slack SDK: about thirteen methods don't earn a dependency tree,
 * or retries and logging we don't control.
 *
 * The capability is as small as we could make it (invariant 5):
 *   - one destination, `https://slack.com/api/<method>`, POST, for the thirteen
 *     methods below and no others. Nothing a caller passes reaches the URL;
 *   - redirects are refused (`redirect: 'manual'`; any 3xx, or an answer a
 *     fetch followed a redirect to anyway, is `redirect`), so no token is
 *     ever replayed to another host;
 *   - a deadline per call that holds even for a fetch that ignores its
 *     signal, so one stuck call can't stall a reply stream that waits on it;
 *   - at most SLACK_RESPONSE_CAP_BYTES of decoded body per answer;
 *   - every field of an answer is narrowed with typeof checks before use, and
 *     ids and secrets must also have a plausible length and alphabet.
 *
 * Encoding, per method (MEASURED from docs.slack.dev, 2026-11-12):
 * `tooling.tokens.rotate`, `oauth.v2.access` and `users.info` take ONLY form
 * bodies ("arguments sent in a JSON body are ignored by methods that don't
 * list application/json"), and so do the `apps.*` calls here. Every `chat.*`
 * call is JSON, and so are `reactions.add` and `reactions.remove` (both list
 * JSON; MEASURED working on the kind walk, 2026-11-13). `oauth.v2.access` authenticates the app with HTTP Basic, so
 * the client secret never rides in a body; `tooling.tokens.rotate` takes no
 * token at all; everything else sends `Authorization: Bearer <token>`.
 *
 * Failures are SlackApiError, whose message is only `slack <method>: <code>`.
 * The code is Slack's own `error` when it is a plain code (lowercase letters
 * and underscores, at most 64 characters), else `slack-error`; or one of
 * ours: `ratelimited` (with `retryAfterMs`), `redirect`, `http-<status>`,
 * `too-large`, `bad-response`, `timeout`, `network`. No digits: a secret
 * Slack echoed back as its error would be lowercase hex. An error never carries a token, a URL, a header, a
 * byte of the answer or an underlying error, so it is safe to log as it is.
 *
 * `rotateConfigToken` deliberately returns no refresh token. Rotating mints a
 * new live pair while the old ones keep working (TASK-1090 spike), and the
 * one AX keeps is the one the admin pasted and can Revoke on Slack's page.
 * Not returning the new one means no caller can store it.
 */
import { ResponseTooLargeError, capResponseBody } from '@ax/core/response-cap';
import {
  RETRY_AFTER_CAP_MS,
  RETRY_AFTER_DEFAULT_MS,
  SLACK_API_TIMEOUT_MS,
  SLACK_ID_MAX,
  SLACK_RESPONSE_CAP_BYTES,
  SLACK_TOKEN_MAX,
} from './limits.js';

/** A failed Slack call. The message is `slack <method>: <code>` and nothing else. */
export class SlackApiError extends Error {
  readonly method: string;
  readonly code: string;
  /** Only on `ratelimited`: how long to wait before asking again. */
  declare readonly retryAfterMs?: number;

  constructor(method: string, code: string, retryAfterMs?: number) {
    super(`slack ${method}: ${code}`);
    this.name = 'SlackApiError';
    this.method = method;
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** One element of a streamed reply. Every stream call sends these, never `markdown_text`. */
export type StreamChunkOut =
  | { type: 'markdown_text'; text: string }
  | {
      type: 'task_update';
      id: string;
      title: string;
      status: 'in_progress' | 'complete' | 'error';
    };

export interface RotatedConfigToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface CreatedApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

export interface OAuthInstall {
  botToken: string;
  botUserId: string;
  appId: string;
  teamId: string;
  teamName: string;
  enterpriseInstall: boolean;
}

export interface SlackApi {
  rotateConfigToken(refreshToken: string): Promise<RotatedConfigToken>;
  createApp(configToken: string, manifest: Record<string, unknown>): Promise<CreatedApp>;
  deleteApp(configToken: string, appId: string): Promise<void>;
  setAppIcon(configToken: string, appId: string, url: string): Promise<void>;
  oauthAccess(i: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<OAuthInstall>;
  /** The raw `user` object, unvalidated beyond being an object: admission checks it. */
  usersInfo(botToken: string, userId: string): Promise<unknown>;
  postMessage(
    botToken: string,
    a: { channel: string; threadTs: string; markdownText: string },
  ): Promise<void>;
  postEphemeral(
    botToken: string,
    a: { channel: string; user: string; text: string; threadTs?: string },
  ): Promise<void>;
  startStream(
    botToken: string,
    a: {
      channel: string;
      threadTs: string;
      recipientUserId: string;
      recipientTeamId: string;
      chunks: readonly StreamChunkOut[];
    },
  ): Promise<{ ts: string }>;
  appendStream(
    botToken: string,
    a: { channel: string; ts: string; chunks: readonly StreamChunkOut[] },
  ): Promise<void>;
  stopStream(
    botToken: string,
    a: { channel: string; ts: string; chunks?: readonly StreamChunkOut[] },
  ): Promise<void>;
  /** An emoji reaction (by name, e.g. `eyes`) from the bot on one message. */
  addReaction(botToken: string, a: { channel: string; ts: string; name: string }): Promise<void>;
  removeReaction(botToken: string, a: { channel: string; ts: string; name: string }): Promise<void>;
}

type SlackMethod =
  | 'tooling.tokens.rotate'
  | 'apps.manifest.create'
  | 'apps.manifest.delete'
  | 'apps.icon.set'
  | 'oauth.v2.access'
  | 'users.info'
  | 'chat.postMessage'
  | 'chat.postEphemeral'
  | 'chat.startStream'
  | 'chat.appendStream'
  | 'chat.stopStream'
  | 'reactions.add'
  | 'reactions.remove';

type Auth =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; clientId: string; clientSecret: string };

type Body =
  | { kind: 'form'; fields: Record<string, string> }
  | { kind: 'json'; fields: Record<string, unknown> };

const API_BASE = 'https://slack.com/api/';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * Slack's `error` when it is a plain code (`invalid_auth`, `msg_too_long`),
 * safe to log. Letters and underscores only: lowercase hex (a signing or
 * client secret echoed back) never passes. Anything else is `slack-error`.
 */
const SLACK_CODE = /^[a-z_]{1,64}$/;
const UNREADABLE_SLACK_CODE = 'slack-error';
const SLACK_ID = new RegExp(`^[A-Za-z0-9._-]{1,${SLACK_ID_MAX}}$`);
/** Printable ASCII with no space, so a secret can never break a header. */
const SLACK_TOKEN = new RegExp(`^[\\x21-\\x7e]{1,${SLACK_TOKEN_MAX}}$`);
const DIGITS = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && SLACK_ID.test(value) ? value : null;
}

function tokenOf(value: unknown): string | null {
  return typeof value === 'string' && SLACK_TOKEN.test(value) ? value : null;
}

function codeOf(value: unknown): string {
  return typeof value === 'string' && SLACK_CODE.test(value) ? value : UNREADABLE_SLACK_CODE;
}

/**
 * Retry-After in milliseconds: whole seconds only (an HTTP date or anything
 * else gets the default), at least RETRY_AFTER_DEFAULT_MS, at most
 * RETRY_AFTER_CAP_MS.
 */
function retryAfterMs(header: string | null): number {
  const value = header?.trim() ?? '';
  if (!DIGITS.test(value)) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(RETRY_AFTER_DEFAULT_MS, Number(value) * 1000));
}

/** Let an answer we will not read go, without holding its connection open. */
function discard(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // Nothing to do: the failure we report is the status, not the body.
  }
}

/**
 * `p`, or a rejection once `deadline` aborts, whichever comes first. The real
 * fetch honours the signal itself; this makes the deadline hold for any
 * injected fetch. A value that arrives after the deadline goes to `late`, so
 * a late Response's body can be let go.
 */
function settleBy<T>(p: Promise<T>, deadline: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(deadline.reason);
    if (deadline.aborted) onAbort();
    else deadline.addEventListener('abort', onAbort, { once: true });
    p.then(
      (value) => {
        deadline.removeEventListener('abort', onAbort);
        if (deadline.aborted) late?.(value);
        resolve(value);
      },
      (err: unknown) => {
        deadline.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** A chunk as Slack takes it: only its own fields, whatever else the caller's object holds. */
function chunkOut(chunk: StreamChunkOut): Record<string, string> {
  if (chunk.type === 'markdown_text') return { type: 'markdown_text', text: chunk.text };
  return { type: 'task_update', id: chunk.id, title: chunk.title, status: chunk.status };
}

const form = (fields: Record<string, string>): Body => ({ kind: 'form', fields });
const json = (fields: Record<string, unknown>): Body => ({ kind: 'json', fields });
const bearer = (token: string): Auth => ({ kind: 'bearer', token });
const badResponse = (method: SlackMethod): SlackApiError => new SlackApiError(method, 'bad-response');

export function createSlackApi(opts: { fetchImpl: typeof fetch; timeoutMs?: number }): SlackApi {
  const { fetchImpl } = opts;
  const timeoutMs = opts.timeoutMs ?? SLACK_API_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('createSlackApi: timeoutMs must be a positive integer');
  }

  /** One call. Resolves with Slack's answer when `ok` is true; rejects with SlackApiError. */
  async function call(method: SlackMethod, auth: Auth, body: Body): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'content-type': body.kind === 'form' ? FORM_TYPE : JSON_TYPE,
    };
    if (auth.kind === 'bearer') headers['authorization'] = `Bearer ${auth.token}`;
    if (auth.kind === 'basic') {
      const pair = Buffer.from(`${auth.clientId}:${auth.clientSecret}`, 'utf8').toString('base64');
      headers['authorization'] = `Basic ${pair}`;
    }
    const payload =
      body.kind === 'form'
        ? new URLSearchParams(body.fields).toString()
        : JSON.stringify(body.fields);
    const fail = (code: string, retryAfter?: number): SlackApiError =>
      new SlackApiError(method, code, retryAfter);

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    timer.unref?.();
    try {
      let res: Response;
      try {
        res = await settleBy(
          fetchImpl(`${API_BASE}${method}`, {
            method: 'POST',
            redirect: 'manual',
            headers,
            body: payload,
            signal: deadline.signal,
          }),
          deadline.signal,
          discard,
        );
      } catch {
        // Never the underlying error: fetch's messages can quote a header.
        throw fail(deadline.signal.aborted ? 'timeout' : 'network');
      }

      if (
        res.redirected ||
        res.type === 'opaqueredirect' ||
        (res.status >= 300 && res.status <= 399)
      ) {
        discard(res);
        throw fail('redirect');
      }
      if (res.status === 429) {
        discard(res);
        throw fail('ratelimited', retryAfterMs(res.headers.get('retry-after')));
      }
      if (res.status < 200 || res.status > 299) {
        discard(res);
        throw fail(`http-${res.status}`);
      }

      let text: string;
      try {
        text = await settleBy(capResponseBody(res, SLACK_RESPONSE_CAP_BYTES).text(), deadline.signal);
      } catch (err) {
        if (err instanceof ResponseTooLargeError) throw fail('too-large');
        throw fail(deadline.signal.aborted ? 'timeout' : 'network');
      }

      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        // Never JSON.parse's message: it quotes the text it choked on.
        throw fail('bad-response');
      }
      if (!isRecord(answer)) throw fail('bad-response');
      if (answer['ok'] === true) return answer;
      if (answer['ok'] === false) {
        const code = codeOf(answer['error']);
        const wait = code === 'ratelimited' ? retryAfterMs(res.headers.get('retry-after')) : undefined;
        throw fail(code, wait);
      }
      throw fail('bad-response');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async rotateConfigToken(refreshToken) {
      const method = 'tooling.tokens.rotate';
      const r = await call(method, { kind: 'none' }, form({ refresh_token: refreshToken }));
      const accessToken = tokenOf(r['token']);
      const exp = r['exp'];
      if (accessToken === null || typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0) {
        throw badResponse(method);
      }
      return { accessToken, expiresAt: exp * 1000 };
    },

    async createApp(configToken, manifest) {
      const method = 'apps.manifest.create';
      const r = await call(method, bearer(configToken), form({ manifest: JSON.stringify(manifest) }));
      const raw = r['credentials'];
      const credentials: Record<string, unknown> = isRecord(raw) ? raw : {};
      const appId = idOf(r['app_id']);
      const clientId = idOf(credentials['client_id']);
      const clientSecret = tokenOf(credentials['client_secret']);
      const signingSecret = tokenOf(credentials['signing_secret']);
      if (appId === null || clientId === null || clientSecret === null || signingSecret === null) {
        throw badResponse(method);
      }
      return { appId, clientId, clientSecret, signingSecret };
    },

    async deleteApp(configToken, appId) {
      await call('apps.manifest.delete', bearer(configToken), form({ app_id: appId }));
    },

    async setAppIcon(configToken, appId, url) {
      await call('apps.icon.set', bearer(configToken), form({ app_id: appId, url }));
    },

    async oauthAccess({ clientId, clientSecret, code, redirectUri }) {
      const method = 'oauth.v2.access';
      const r = await call(
        method,
        { kind: 'basic', clientId, clientSecret },
        form({ code, redirect_uri: redirectUri }),
      );
      const raw = r['team'];
      const team: Record<string, unknown> = isRecord(raw) ? raw : {};
      const botToken = tokenOf(r['access_token']);
      const botUserId = idOf(r['bot_user_id']);
      const appId = idOf(r['app_id']);
      const teamId = idOf(team['id']);
      const teamName = team['name'];
      const enterpriseInstall = r['is_enterprise_install'];
      if (
        r['token_type'] !== 'bot' ||
        botToken === null ||
        botUserId === null ||
        appId === null ||
        teamId === null ||
        typeof teamName !== 'string' ||
        typeof enterpriseInstall !== 'boolean'
      ) {
        throw badResponse(method);
      }
      return { botToken, botUserId, appId, teamId, teamName, enterpriseInstall };
    },

    async usersInfo(botToken, userId) {
      const method = 'users.info';
      const r = await call(method, bearer(botToken), form({ user: userId }));
      const user = r['user'];
      if (!isRecord(user)) throw badResponse(method);
      return user;
    },

    async postMessage(botToken, a) {
      await call(
        'chat.postMessage',
        bearer(botToken),
        json({
          channel: a.channel,
          thread_ts: a.threadTs,
          markdown_text: a.markdownText,
          // Slack's servers never fetch a model-chosen URL for a preview.
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
    },

    async addReaction(botToken, a) {
      await call('reactions.add', bearer(botToken), json({ channel: a.channel, timestamp: a.ts, name: a.name }));
    },

    async removeReaction(botToken, a) {
      await call('reactions.remove', bearer(botToken), json({ channel: a.channel, timestamp: a.ts, name: a.name }));
    },

    async postEphemeral(botToken, a) {
      await call(
        'chat.postEphemeral',
        bearer(botToken),
        json({
          channel: a.channel,
          user: a.user,
          text: a.text,
          ...(a.threadTs !== undefined ? { thread_ts: a.threadTs } : {}),
        }),
      );
    },

    async startStream(botToken, a) {
      const method = 'chat.startStream';
      const r = await call(
        method,
        bearer(botToken),
        json({
          channel: a.channel,
          thread_ts: a.threadTs,
          recipient_user_id: a.recipientUserId,
          recipient_team_id: a.recipientTeamId,
          chunks: a.chunks.map(chunkOut),
        }),
      );
      const ts = idOf(r['ts']);
      if (ts === null) throw badResponse(method);
      return { ts };
    },

    async appendStream(botToken, a) {
      await call(
        'chat.appendStream',
        bearer(botToken),
        json({ channel: a.channel, ts: a.ts, chunks: a.chunks.map(chunkOut) }),
      );
    },

    async stopStream(botToken, a) {
      await call(
        'chat.stopStream',
        bearer(botToken),
        json({
          channel: a.channel,
          ts: a.ts,
          ...(a.chunks !== undefined ? { chunks: a.chunks.map(chunkOut) } : {}),
        }),
      );
    },
  };
}
