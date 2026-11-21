/**
 * channel-slack's only egress: a small Slack Web API client over an injected
 * `fetch`. No Slack SDK: about seventeen methods don't earn a dependency tree,
 * or retries and logging we don't control.
 *
 * The capability is as small as we could make it (invariant 5):
 *   - one destination, `https://slack.com/api/<method>`, POST, for the seventeen
 *     methods below and no others. Nothing a caller passes reaches the URL;
 *   - redirects are refused (`redirect: 'manual'`; any 3xx, or an answer a
 *     fetch followed a redirect to anyway, is `redirect`), so no token is
 *     ever replayed to another host;
 *   - a deadline per call that holds even for a fetch that ignores its
 *     signal, so one stuck call can't stall a reply stream that waits on it;
 *   - at most SLACK_RESPONSE_CAP_BYTES of decoded body per answer;
 *   - every field of an answer is narrowed with typeof checks before use, and
 *     ids and secrets must also have a plausible length and alphabet. A
 *     channel's refusing flags (private, archived, Slack Connect) fail
 *     closed: any value but absent, null or `false` counts as set.
 *
 * Encoding, per method (MEASURED from docs.slack.dev, 2026-11-12):
 * `tooling.tokens.rotate`, `oauth.v2.access`, `users.info` and
 * `users.lookupByEmail` take ONLY form bodies ("arguments sent in a JSON body are ignored by methods that don't
 * list application/json"), and so does `conversations.info` (read
 * 2026-11-13). The `apps.manifest.*` calls list both (the `apps.*` pages read
 * 2026-11-15) and are sent as forms like their siblings. `apps.icon.set` uploads its image as
 * `multipart/form-data`: the PNG as `file`, beside `app_id` (read on
 * docs.slack.dev 2026-11-18; the `url` argument made Slack fetch an image it
 * then refused, TASK-1133). Its content type is fetch's to write, because
 * only fetch knows the multipart boundary.
 * Every `chat.*` call is JSON, and so are `reactions.add` and
 * `reactions.remove` (both list JSON; MEASURED working on the kind walk,
 * 2026-11-13). `oauth.v2.access` authenticates the app with HTTP Basic, so
 * the client secret never rides in a body; `tooling.tokens.rotate` takes no
 * token at all; everything else sends `Authorization: Bearer <token>`.
 *
 * Failures are SlackApiError, whose message is only `slack <method>: <code>`.
 * The code is Slack's own `error` when it is a plain code (lowercase letters
 * and underscores, at most 64 characters), else `slack-error`; or one of
 * ours: `ratelimited` (with `retryAfterMs`), `redirect`, `http-<status>`,
 * `too-large`, `bad-response`, `timeout`, `network`. No digits: a secret
 * Slack echoed back as its error would be lowercase hex. Any refusal (an
 * `ok: false` answer, whatever its code) that names the scopes the call
 * needed keeps them as `needed`, and one that names the scopes the token
 * holds keeps those as `provided`, each only when it reads as scope names
 * (lowercase letters, `_`, `-`, `.`, `:` and `,`, no digits either; at most
 * 200 characters for `needed`, 1000 for `provided`, the token's whole list),
 * and drops it otherwise; a `provided` it can't read is kept as `''`.
 * Slack's documented case is `missing_scope`, but
 * nothing here checks the code first. The message never holds them. An
 * error never carries a token, a URL, a header, an underlying error, or any
 * byte of the answer but those three, so it is safe to log as it is.
 *
 * `rotateConfigToken` hands back the refresh token Slack mints with the
 * access token. Slack retires the refresh token it was sent some time after
 * the rotate, so the caller must store the new one before it uses the access
 * token, or the install loses its configuration token. How long the old one
 * lasts isn't pinned down. MEASURED on the TASK-1097 walk: it still worked
 * 18 s after its first rotate, and Slack refused it about 6 minutes after the
 * first rotate on one install and within 3 hours on the other. The 6 minutes
 * has a confound (the
 * admin also saved an app setting on api.slack.com in that gap, which may be
 * what retired it); the walk report names no confound for the 3 hours. The TASK-1090 spike reused the old
 * one before Slack refused it, and read that as "keeps working".
 */
import { ResponseTooLargeError, capResponseBody } from '@ax/core/response-cap';
import {
  RETRY_AFTER_CAP_MS,
  RETRY_AFTER_DEFAULT_MS,
  SLACK_API_TIMEOUT_MS,
  SLACK_ID_RE,
  SLACK_RESPONSE_CAP_BYTES,
  SLACK_TOKEN_MAX,
} from './limits.js';

/** A failed Slack call. The message is `slack <method>: <code>` and nothing else. */
export class SlackApiError extends Error {
  readonly method: string;
  readonly code: string;
  /** Only on `ratelimited`: how long to wait before asking again. */
  declare readonly retryAfterMs?: number;
  /**
   * The scopes Slack says the call needed, comma-separated (`channels:read`),
   * on any refusal whose answer names them, whatever its code (Slack's
   * documented case is `missing_scope`). Kept only when they read as scope
   * names (createSlackApi). Never in the message.
   */
  declare readonly needed?: string;
  /**
   * The scopes Slack says the token holds, comma-separated, on any refusal
   * whose answer names them, as for `needed`. channel-check.ts reads it to
   * tell a token that can't read public channels from a channel it can't
   * read. Kept only when it reads as scope names (createSlackApi), and `''`
   * when the answer named it in a form that doesn't. Never in the message.
   */
  declare readonly provided?: string;

  constructor(
    method: string,
    code: string,
    retryAfterMs?: number,
    scopes: { needed?: string | undefined; provided?: string | undefined } = {},
  ) {
    super(`slack ${method}: ${code}`);
    this.name = 'SlackApiError';
    this.method = method;
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (scopes.needed !== undefined) this.needed = scopes.needed;
    if (scopes.provided !== undefined) this.provided = scopes.provided;
  }
}

/** One Block Kit block, as Slack takes it. Built in prompt code, never from model text. */
export type SlackBlock = Readonly<Record<string, unknown>>;

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
  /** The refresh token to keep from now on: Slack retires the one that was sent some time after this rotate (header). */
  refreshToken: string;
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

/**
 * A channel as `conversations.info` describes it, narrowed. `name` is
 * Slack's raw text: whoever shows or stores it cleans it first. The flags
 * that refuse a channel (`isPrivate`, `isArchived`, `isExtShared`,
 * `isPendingExtShared`) fail closed; `isChannel` and `isMember` are true
 * only when Slack says literally `true`.
 */
export interface SlackChannel {
  id: string;
  name: string;
  isChannel: boolean;
  isPrivate: boolean;
  isArchived: boolean;
  isExtShared: boolean;
  isPendingExtShared: boolean;
  isMember: boolean;
}

export interface SlackApi {
  /**
   * A configuration access token for one use, and the refresh token that
   * replaces the one sent. The caller must store `refreshToken` before it
   * uses `accessToken` (header).
   */
  rotateConfigToken(refreshToken: string): Promise<RotatedConfigToken>;
  createApp(configToken: string, manifest: Record<string, unknown>): Promise<CreatedApp>;
  /**
   * Replace the app's manifest. Slack keeps nothing it isn't sent, so pass all
   * of it. `permissions_updated` is deliberately unread: the manifest carries
   * this build's scopes; a card that changes `BOT_SCOPES` owns existing installs.
   */
  updateApp(configToken: string, appId: string, manifest: Record<string, unknown>): Promise<void>;
  deleteApp(configToken: string, appId: string): Promise<void>;
  /** Upload the app's picture: a PNG's bytes, sent as they are (icon.ts checks them first). */
  setAppIcon(configToken: string, appId: string, png: Uint8Array): Promise<void>;
  oauthAccess(i: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<OAuthInstall>;
  /** The raw `user` object, unvalidated beyond being an object: admission checks it. */
  usersInfo(botToken: string, userId: string): Promise<unknown>;
  /**
   * The Slack user id `email` belongs to in the token's workspace
   * (`users.lookupByEmail`, `users:read.email`). Only the id is read: who that
   * is (a full member? a confirmed email?) is users.info's to say. Slack's
   * `users_not_found` is a SlackApiError with that code.
   */
  usersLookupByEmail(botToken: string, email: string): Promise<string>;
  postMessage(
    botToken: string,
    a: { channel: string; threadTs: string; markdownText: string },
  ): Promise<void>;
  /** A threaded message with Block Kit blocks; `text` is the notification and fallback. */
  postBlocks(
    botToken: string,
    a: { channel: string; threadTs: string; text: string; blocks: readonly SlackBlock[] },
  ): Promise<{ ts: string }>;
  /**
   * A top-level message to one person by their user id: Slack posts it in the
   * bot's DM with them (`chat.postMessage`). Answers that DM's channel id
   * (`chat.update` needs it; a user id won't do) and the message's ts.
   */
  postDirect(
    botToken: string,
    a: { user: string; text: string; blocks?: readonly SlackBlock[] },
  ): Promise<{ channel: string; ts: string }>;
  /** Replace a message the bot posted (`chat.update`), e.g. to close a prompt's buttons. */
  updateMessage(
    botToken: string,
    a: { channel: string; ts: string; text: string; blocks: readonly SlackBlock[] },
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
  /** One channel. An answer without a channel we can narrow is `bad-response`. */
  conversationsInfo(botToken: string, channel: string): Promise<SlackChannel>;
}

type SlackMethod =
  | 'tooling.tokens.rotate'
  | 'apps.manifest.create'
  | 'apps.manifest.update'
  | 'apps.manifest.delete'
  | 'apps.icon.set'
  | 'oauth.v2.access'
  | 'users.info'
  | 'users.lookupByEmail'
  | 'chat.postMessage'
  | 'chat.postEphemeral'
  | 'chat.update'
  | 'chat.startStream'
  | 'chat.appendStream'
  | 'chat.stopStream'
  | 'reactions.add'
  | 'reactions.remove'
  | 'conversations.info';

type Auth =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; clientId: string; clientSecret: string };

type Body =
  | { kind: 'form'; fields: Record<string, string> }
  | { kind: 'json'; fields: Record<string, unknown> }
  | {
      kind: 'multipart';
      fields: Record<string, string>;
      file: { name: string; filename: string; type: string; bytes: Uint8Array };
    };

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
/**
 * Slack's `needed` and `provided` on a refusal: scope names, comma-separated
 * (`channels:read`, `users:read.email`). No digits, as for a code: a secret
 * echoed back would be lowercase hex. Anything else is dropped, never kept.
 * `provided` lists every scope the token holds, so it gets more room.
 */
const SLACK_NEEDED = /^[a-z_.:,-]{1,200}$/;
const SLACK_PROVIDED = /^[a-z_.:,-]{1,1000}$/;
/** Printable ASCII with no space, so a secret can never break a header. */
const SLACK_TOKEN = new RegExp(`^[\\x21-\\x7e]{1,${SLACK_TOKEN_MAX}}$`);
const DIGITS = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && SLACK_ID_RE.test(value) ? value : null;
}

function tokenOf(value: unknown): string | null {
  return typeof value === 'string' && SLACK_TOKEN.test(value) ? value : null;
}

function codeOf(value: unknown): string {
  return typeof value === 'string' && SLACK_CODE.test(value) ? value : UNREADABLE_SLACK_CODE;
}

function scopesOf(value: unknown, shape: RegExp): string | undefined {
  return typeof value === 'string' && shape.test(value) ? value : undefined;
}

/**
 * `provided`, as scopesOf reads it, but an answer that names it in a form we
 * can't read keeps `''`: Slack said which scopes the token holds, we can't
 * tell which, so channel-check.ts reads that as unknown rather than falling
 * back to `needed` (TASK-1184: a fallback could delete a healthy binding).
 */
function providedOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return scopesOf(value, SLACK_PROVIDED) ?? '';
}

/**
 * A channel flag that would refuse the channel. Absent, null and `false` are
 * unset; anything else, a non-boolean included, is set, so a flag we can't
 * read fails closed (admission.ts reads a sender's flags the same way).
 */
function flagged(channel: Record<string, unknown>, key: string): boolean {
  const value = channel[key];
  return value !== undefined && value !== null && value !== false;
}

/** A channel object, narrowed; null when it has no usable id or name. */
function channelOf(raw: unknown): SlackChannel | null {
  if (!isRecord(raw)) return null;
  const id = idOf(raw['id']);
  const name = raw['name'];
  if (id === null || typeof name !== 'string') return null;
  return {
    id,
    name,
    isChannel: raw['is_channel'] === true,
    isPrivate: flagged(raw, 'is_private'),
    isArchived: flagged(raw, 'is_archived'),
    isExtShared: flagged(raw, 'is_ext_shared'),
    isPendingExtShared: flagged(raw, 'is_pending_ext_shared'),
    isMember: raw['is_member'] === true,
  };
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

/** A body as fetch sends it. */
function payloadOf(body: Body): string | FormData {
  if (body.kind === 'form') return new URLSearchParams(body.fields).toString();
  if (body.kind === 'json') return JSON.stringify(body.fields);
  const out = new FormData();
  for (const [name, value] of Object.entries(body.fields)) out.append(name, value);
  const { name, filename, type, bytes } = body.file;
  // A copy on a plain ArrayBuffer: a Blob won't take a view that may sit on a SharedArrayBuffer.
  out.append(name, new Blob([new Uint8Array(bytes)], { type }), filename);
  return out;
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
    const headers: Record<string, string> = {};
    // Never set by hand for multipart: fetch writes it, with the boundary.
    if (body.kind === 'form') headers['content-type'] = FORM_TYPE;
    if (body.kind === 'json') headers['content-type'] = JSON_TYPE;
    if (auth.kind === 'bearer') headers['authorization'] = `Bearer ${auth.token}`;
    if (auth.kind === 'basic') {
      const pair = Buffer.from(`${auth.clientId}:${auth.clientSecret}`, 'utf8').toString('base64');
      headers['authorization'] = `Basic ${pair}`;
    }
    const payload = payloadOf(body);
    const fail = (
      code: string,
      retryAfter?: number,
      scopes?: { needed: string | undefined; provided: string | undefined },
    ): SlackApiError => new SlackApiError(method, code, retryAfter, scopes);

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
        throw fail(code, wait, {
          needed: scopesOf(answer['needed'], SLACK_NEEDED),
          provided: providedOf(answer['provided']),
        });
      }
      throw fail('bad-response');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async rotateConfigToken(sent) {
      const method = 'tooling.tokens.rotate';
      const r = await call(method, { kind: 'none' }, form({ refresh_token: sent }));
      const accessToken = tokenOf(r['token']);
      const refreshToken = tokenOf(r['refresh_token']);
      const exp = r['exp'];
      if (
        accessToken === null ||
        refreshToken === null ||
        typeof exp !== 'number' ||
        !Number.isSafeInteger(exp) ||
        exp <= 0
      ) {
        throw badResponse(method);
      }
      return { accessToken, refreshToken, expiresAt: exp * 1000 };
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

    async updateApp(configToken, appId, manifest) {
      await call(
        'apps.manifest.update',
        bearer(configToken),
        form({ app_id: appId, manifest: JSON.stringify(manifest) }),
      );
    },

    async deleteApp(configToken, appId) {
      await call('apps.manifest.delete', bearer(configToken), form({ app_id: appId }));
    },

    async setAppIcon(configToken, appId, png) {
      await call('apps.icon.set', bearer(configToken), {
        kind: 'multipart',
        fields: { app_id: appId },
        file: { name: 'file', filename: 'icon.png', type: 'image/png', bytes: png },
      });
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

    async usersLookupByEmail(botToken, email) {
      const method = 'users.lookupByEmail';
      const r = await call(method, bearer(botToken), form({ email }));
      const user = r['user'];
      const id = isRecord(user) ? idOf(user['id']) : null;
      if (id === null) throw badResponse(method);
      return id;
    },

    async conversationsInfo(botToken, channel) {
      const method = 'conversations.info';
      const r = await call(method, bearer(botToken), form({ channel }));
      const out = channelOf(r['channel']);
      if (out === null) throw badResponse(method);
      return out;
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

    async postBlocks(botToken, a) {
      const method = 'chat.postMessage';
      const r = await call(
        method,
        bearer(botToken),
        json({
          channel: a.channel,
          thread_ts: a.threadTs,
          text: a.text,
          blocks: a.blocks,
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
      const ts = idOf(r['ts']);
      if (ts === null) throw badResponse(method);
      return { ts };
    },

    async postDirect(botToken, a) {
      const method = 'chat.postMessage';
      const r = await call(
        method,
        bearer(botToken),
        json({
          channel: a.user,
          text: a.text,
          ...(a.blocks !== undefined ? { blocks: a.blocks } : {}),
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
      const channel = idOf(r['channel']);
      const ts = idOf(r['ts']);
      if (channel === null || ts === null) throw badResponse(method);
      return { channel, ts };
    },

    async updateMessage(botToken, a) {
      await call(
        'chat.update',
        bearer(botToken),
        json({ channel: a.channel, ts: a.ts, text: a.text, blocks: a.blocks }),
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
