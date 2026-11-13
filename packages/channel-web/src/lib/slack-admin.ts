/**
 * Admin › Slack wire client (TASK-1093). The routes live in @ax/channel-slack
 * (`packages/channel-slack/src/admin-routes.ts`); the types below mirror its
 * answers by shape, not by import (the SPA depends on no host plugin).
 *
 *   GET  /admin/slack              → SlackStatus
 *   POST /admin/slack/connect      { accessToken, refreshToken, botName } → { installUrl }
 *   POST /admin/slack/install-url  → { installUrl }, while an install is unfinished
 *   POST /admin/slack/disconnect   → { appDeleted }
 *
 * Every request carries the session cookie (`httpFetch`, which also notices a
 * 401), and every POST the `x-requested-with: ax-admin` header the CSRF check
 * wants (the same write headers as `lib/branding.ts`).
 *
 * The two pasted configuration tokens go out in the one Connect body and
 * nowhere else: nothing here keeps, logs or returns them. Answers are read
 * field by field, and an install link is followed only when it is Slack's own
 * Allow page.
 */
import { HttpError, httpFetch } from './http';

export type SlackStatus =
  | { state: 'not-connected'; defaultBotName: string; canConnect: boolean }
  | { state: 'pending'; botName: string; connectedBy: string; connectedAt: string }
  | {
      state: 'connected';
      botName: string;
      workspaceName: string;
      connectedBy: string;
      connectedAt: string;
    };

/** `unavailable`: this server doesn't run the Slack plugin. */
export type SlackStatusRead = SlackStatus | { state: 'unavailable' };

export interface ConnectSlackInput {
  accessToken: string;
  refreshToken: string;
  botName: string;
}

const STATUS_PATH = '/admin/slack';
const CONNECT_PATH = '/admin/slack/connect';
const INSTALL_URL_PATH = '/admin/slack/install-url';
const DISCONNECT_PATH = '/admin/slack/disconnect';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/** The server's own refusal codes (`invalid-bot-name`, `slack-token`, …). */
const CODE_RE = /^[a-z0-9-]{1,64}$/;

/**
 * A request that failed with an answer we could read, or an answer we
 * couldn't use (`bad-response`). `code` and `reason` are the server's, kept
 * only when they are code-shaped; `message` is for the console, never a page.
 */
export class SlackAdminError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | null;

  constructor(status: number, code: string, reason: string | null = null) {
    super(`slack admin request failed: ${status} ${code}`);
    this.name = 'SlackAdminError';
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codeOf(value: unknown): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

const badResponse = (status: number): SlackAdminError => new SlackAdminError(status, 'bad-response');

function parseStatus(body: unknown): SlackStatus | null {
  if (!isRecord(body)) return null;
  const str = (key: string): string | null => {
    const value = body[key];
    return typeof value === 'string' ? value : null;
  };
  const botName = str('botName');
  const connectedBy = str('connectedBy');
  const connectedAt = str('connectedAt');
  switch (body['state']) {
    case 'not-connected': {
      const defaultBotName = str('defaultBotName');
      const canConnect = body['canConnect'];
      if (defaultBotName === null || typeof canConnect !== 'boolean') return null;
      return { state: 'not-connected', defaultBotName, canConnect };
    }
    case 'pending':
      if (botName === null || connectedBy === null || connectedAt === null) return null;
      return { state: 'pending', botName, connectedBy, connectedAt };
    case 'connected': {
      const workspaceName = str('workspaceName');
      if (botName === null || workspaceName === null || connectedBy === null || connectedAt === null) {
        return null;
      }
      return { state: 'connected', botName, workspaceName, connectedBy, connectedAt };
    }
    default:
      return null;
  }
}

/**
 * How Slack stands. A 404 means this server has no Slack routes, and so does
 * a page that isn't JSON: a host that serves the app answers an unknown GET
 * with the app's own HTML. Any other failure throws, for a retry.
 */
export async function fetchSlackStatus(): Promise<SlackStatusRead> {
  const res = await httpFetch(STATUS_PATH);
  if (res.status === 404) return { state: 'unavailable' };
  if (!res.ok) throw new HttpError(STATUS_PATH, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: 'unavailable' };
  }
  const status = parseStatus(body);
  if (status === null) throw badResponse(res.status);
  return status;
}

/** A POST with the write headers. A non-ok answer becomes a SlackAdminError. */
async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await httpFetch(path, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify(body),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const fields = isRecord(json) ? json : {};
    throw new SlackAdminError(res.status, codeOf(fields['error']) ?? 'unknown', codeOf(fields['reason']));
  }
  return { status: res.status, body: json };
}

/** Whether `url` is Slack's own Allow page, the one place an install link may lead. */
function isSlackAllowPage(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'slack.com' &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/oauth/v2/authorize'
    );
  } catch {
    return false;
  }
}

function installUrlFrom(answer: { status: number; body: unknown }): { installUrl: string } {
  const installUrl = isRecord(answer.body) ? answer.body['installUrl'] : undefined;
  if (!isSlackAllowPage(installUrl)) throw badResponse(answer.status);
  return { installUrl };
}

/** Create the Slack app from the pasted tokens; the answer is the link to Slack's Allow page. */
export async function connectSlack(input: ConnectSlackInput): Promise<{ installUrl: string }> {
  return installUrlFrom(
    await post(CONNECT_PATH, {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      botName: input.botName,
    }),
  );
}

/** A fresh link to Slack's Allow page for the unfinished install. */
export async function resumeSlackInstall(): Promise<{ installUrl: string }> {
  return installUrlFrom(await post(INSTALL_URL_PATH, {}));
}

/** Disconnect. `appDeleted` is false when Slack wouldn't delete the app for us. */
export async function disconnectSlack(): Promise<{ appDeleted: boolean }> {
  const answer = await post(DISCONNECT_PATH, {});
  const appDeleted = isRecord(answer.body) ? answer.body['appDeleted'] : undefined;
  if (typeof appDeleted !== 'boolean') throw badResponse(answer.status);
  return { appDeleted };
}

/** Hand the whole page to Slack's Allow page. Refuses any other address. */
export function goToSlack(installUrl: string): void {
  if (!isSlackAllowPage(installUrl)) throw new Error('not a Slack install link');
  window.location.assign(installUrl);
}

// ── What an error says ────────────────────────────────────────────────────

export const SLACK_ERROR_COPY = Object.freeze({
  'invalid-access-token': "That doesn't look like an access token. It starts with xoxe.xoxp-.",
  'invalid-refresh-token': "That doesn't look like a refresh token. It starts with xoxe-.",
  'slack-token': "Slack didn't accept the access token. Generate a new pair and paste both again.",
  'slack-name': "Slack didn't accept that bot name. Try another.",
  // Connect never heard back from Slack, so the app may exist with no way for us to delete it.
  'slack-unconfirmed':
    "Slack didn't give us a clear answer, so a Slack app may have been created anyway. Check api.slack.com/apps and delete it before you try again.",
  generic: 'Something went wrong talking to Slack. Try again in a minute.',
});

/** `invalid-bot-name`'s reasons (@ax/channel-slack's `checkBotName`). */
const BOT_NAME_COPY: Readonly<Record<string, string>> = Object.freeze({
  empty: 'Give the bot a name.',
  'too-long': 'Keep the name to 35 characters or fewer.',
  'bad-characters': 'Use letters, numbers, spaces, dots, dashes or underscores.',
  reserved: 'Slack keeps that name for itself. Pick another.',
});
const BOT_NAME_FALLBACK = "Slack can't use that name. Try another.";

/** Which Connect field an error is about, or null for the form as a whole. */
export type SlackErrorField = 'accessToken' | 'refreshToken' | 'botName' | null;

/** The sentence an error becomes, and where it goes. Never a raw code. */
export function slackErrorCopy(err: unknown): { field: SlackErrorField; message: string } {
  if (err instanceof SlackAdminError) {
    switch (err.code) {
      case 'invalid-access-token':
        return { field: 'accessToken', message: SLACK_ERROR_COPY['invalid-access-token'] };
      case 'invalid-refresh-token':
        return { field: 'refreshToken', message: SLACK_ERROR_COPY['invalid-refresh-token'] };
      case 'invalid-bot-name': {
        const known =
          err.reason !== null && Object.hasOwn(BOT_NAME_COPY, err.reason) ? BOT_NAME_COPY[err.reason] : undefined;
        return { field: 'botName', message: known ?? BOT_NAME_FALLBACK };
      }
      case 'slack-token':
        return { field: null, message: SLACK_ERROR_COPY['slack-token'] };
      case 'slack-name':
        return { field: 'botName', message: SLACK_ERROR_COPY['slack-name'] };
      case 'slack-unconfirmed':
        return { field: null, message: SLACK_ERROR_COPY['slack-unconfirmed'] };
    }
  }
  return { field: null, message: SLACK_ERROR_COPY.generic };
}

/** The refusals that mean "someone else got there first": read the state again. */
const STATE_CHANGED_CODES: ReadonlySet<string> = new Set([
  'already-connected',
  'not-pending',
  'not-connected',
  'public-origin-not-https',
]);

export function slackStateChanged(err: unknown): boolean {
  return err instanceof SlackAdminError && err.status === 409 && STATE_CHANGED_CODES.has(err.code);
}
