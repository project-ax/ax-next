/**
 * Admin › Slack wire client (TASK-1093). The routes live in @ax/channel-slack
 * (`packages/channel-slack/src/admin-routes.ts`); the types below mirror its
 * answers by shape, not by import (the SPA depends on no host plugin).
 *
 *   GET  /admin/slack              → SlackStatus
 *   POST /admin/slack/connect      { accessToken, refreshToken, botName, iconPng? } → { installUrl }
 *   POST /admin/slack/install-url  → { installUrl }, while an install is unfinished
 *   POST /admin/slack/rename       { botName } → { botName }
 *   POST /admin/slack/replace-token  { refreshToken } → {}
 *   POST /admin/slack/disconnect   → { appDeleted, tokenKept }
 *   POST /admin/slack/forget-leftover-app  { appId } → {}
 *
 * Every request carries the session cookie (`httpFetch`, which also notices a
 * 401), and every POST the `x-requested-with: ax-admin` header the CSRF check
 * wants (the same write headers as `lib/branding.ts`).
 *
 * `GET /admin/slack`, in every state, also lists the Slack apps an earlier
 * Disconnect couldn't delete (`leftoverApps`). It is advisory: a broken list
 * reads as none, and an app id becomes a link only when it is plain letters
 * and digits. `forget-leftover-app` drops one from that list once the admin
 * has deleted it on Slack's page; nothing is asked of Slack.
 *
 * The bot's picture, drawn by `lib/slack-avatar.ts`, rides in the same Connect
 * body as `iconPng`. The pasted configuration tokens go out in one body each
 * (Connect's two, Replace's refresh token) and nowhere else: nothing here
 * keeps, logs or returns them. Answers are read
 * field by field, and an install link is followed only when it is Slack's own
 * Allow page.
 */
import { HttpError, httpFetch } from './http';
import { BOT_NAME_COPY, BOT_NAME_FALLBACK, SLACK_TOKEN_COPY } from './slack-token-copy';

/** A Slack app an earlier Disconnect couldn't delete (TASK-1132). */
export interface LeftoverSlackApp {
  botName: string;
  appId: string;
}

export type SlackStatus =
  | { state: 'not-connected'; defaultBotName: string; canConnect: boolean; leftoverApps: LeftoverSlackApp[] }
  | {
      state: 'pending';
      botName: string;
      connectedBy: string;
      connectedAt: string;
      leftoverApps: LeftoverSlackApp[];
    }
  | {
      state: 'connected';
      botName: string;
      workspaceName: string;
      connectedBy: string;
      connectedAt: string;
      leftoverApps: LeftoverSlackApp[];
    };

/** `unavailable`: this server doesn't run the Slack plugin. */
export type SlackStatusRead = SlackStatus | { state: 'unavailable' };

export interface ConnectSlackInput {
  accessToken: string;
  refreshToken: string;
  botName: string;
  /** Base64 PNG of the bot's picture; left out when there is none to send. */
  iconPng?: string;
}

const STATUS_PATH = '/admin/slack';
const CONNECT_PATH = '/admin/slack/connect';
const INSTALL_URL_PATH = '/admin/slack/install-url';
const RENAME_PATH = '/admin/slack/rename';
const REPLACE_TOKEN_PATH = '/admin/slack/replace-token';
const DISCONNECT_PATH = '/admin/slack/disconnect';
const FORGET_LEFTOVER_APP_PATH = '/admin/slack/forget-leftover-app';

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

/** Slack's own app ids are letters and digits; anything else never becomes a link. */
const APP_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const BOT_NAME_MAX = 80;

/** Advisory: a missing or broken list is none, and a malformed app is skipped. */
function parseLeftoverApps(value: unknown): LeftoverSlackApp[] {
  if (!Array.isArray(value)) return [];
  const apps: LeftoverSlackApp[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { botName, appId } = item;
    if (typeof botName !== 'string' || botName.length < 1 || botName.length > BOT_NAME_MAX) continue;
    if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) continue;
    apps.push({ botName, appId });
  }
  return apps;
}

/** The Slack page for one app: its settings, and the Delete App button. */
export function slackAppSettingsUrl(appId: string): string {
  return `https://api.slack.com/apps/${encodeURIComponent(appId)}`;
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
      return { state: 'not-connected', defaultBotName, canConnect, leftoverApps: parseLeftoverApps(body['leftoverApps']) };
    }
    case 'pending':
      if (botName === null || connectedBy === null || connectedAt === null) return null;
      return { state: 'pending', botName, connectedBy, connectedAt, leftoverApps: parseLeftoverApps(body['leftoverApps']) };
    case 'connected': {
      const workspaceName = str('workspaceName');
      if (botName === null || workspaceName === null || connectedBy === null || connectedAt === null) {
        return null;
      }
      return {
        state: 'connected',
        botName,
        workspaceName,
        connectedBy,
        connectedAt,
        leftoverApps: parseLeftoverApps(body['leftoverApps']),
      };
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
      ...(input.iconPng !== undefined ? { iconPng: input.iconPng } : {}),
    }),
  );
}

/** A fresh link to Slack's Allow page for the unfinished install. */
export async function resumeSlackInstall(): Promise<{ installUrl: string }> {
  return installUrlFrom(await post(INSTALL_URL_PATH, {}));
}

/**
 * Disconnect. `appDeleted` is false when Slack wouldn't delete the app for us.
 * `tokenKept` is true when the admin's configuration token stayed, because
 * another Slack app (a team agent's own bot) still needs it: revoking it on
 * Slack's page would strand that app. An answer missing either fact is refused.
 */
export async function disconnectSlack(): Promise<{ appDeleted: boolean; tokenKept: boolean }> {
  const answer = await post(DISCONNECT_PATH, {});
  const appDeleted = isRecord(answer.body) ? answer.body['appDeleted'] : undefined;
  const tokenKept = isRecord(answer.body) ? answer.body['tokenKept'] : undefined;
  if (typeof appDeleted !== 'boolean' || typeof tokenKept !== 'boolean') throw badResponse(answer.status);
  return { appDeleted, tokenKept };
}

/**
 * "I deleted it": the admin deleted a leftover app on Slack's page, so the
 * status stops naming it. Nothing is asked of Slack, and an app the server
 * no longer lists is not an error.
 */
export async function forgetLeftoverSlackApp(appId: string): Promise<void> {
  await post(FORGET_LEFTOVER_APP_PATH, { appId });
}

/** Rename the bot. Sends the name as typed; the answer is the name the server kept. */
export async function renameSlackBot(botName: string): Promise<{ botName: string }> {
  const answer = await post(RENAME_PATH, { botName });
  const kept = isRecord(answer.body) ? answer.body['botName'] : undefined;
  if (typeof kept !== 'string' || kept === '') throw badResponse(answer.status);
  return { botName: kept };
}

/**
 * Replace the configuration token with a pasted refresh token. The server
 * tries it once and keeps it only if Slack lets it manage this app; an answer
 * without an error is the whole answer.
 */
export async function replaceSlackConfigToken(refreshToken: string): Promise<void> {
  await post(REPLACE_TOKEN_PATH, { refreshToken });
}

/** Hand the whole page to Slack's Allow page. Refuses any other address. */
export function goToSlack(installUrl: string): void {
  if (!isSlackAllowPage(installUrl)) throw new Error('not a Slack install link');
  window.location.assign(installUrl);
}

// ── What an error says ────────────────────────────────────────────────────

export const SLACK_ERROR_COPY = Object.freeze({
  // The token and name lines an agent's own-bot form shows too live in slack-token-copy.ts.
  ...SLACK_TOKEN_COPY,
  'invalid-access-token': "That doesn't look like an access token. It starts with xoxe.xoxp-.",
  // Replace: the token works, but its owner can't manage this app (or is in another workspace).
  'slack-not-app-manager':
    "Slack says that token can't manage this Slack app. Paste a refresh token from someone who can manage it, in the same Slack workspace.",
  'slack-config-token':
    "We can't use the configuration token we have for this Slack app, so we couldn't rename the bot. Replace the token with one from someone who can manage this Slack app, then try again.",
  // A 409 the Rename form shows itself: a connected card has no https view for the re-read to land on.
  'public-origin-not-https':
    "Our public address isn't https right now, so we can't update the Slack app. Whoever runs this server can fix that.",
  'slack-app-gone':
    'Slack no longer has the app we made for this bot. It may have been deleted on api.slack.com/apps. Disconnect Slack, then connect it again.',
  generic: 'Something went wrong talking to Slack. Try again in a minute.',
});

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
      case 'slack-refresh-token':
        return { field: null, message: SLACK_ERROR_COPY['slack-refresh-token'] };
      case 'slack-not-app-manager':
        return { field: null, message: SLACK_ERROR_COPY['slack-not-app-manager'] };
      case 'slack-config-token':
        return { field: null, message: SLACK_ERROR_COPY['slack-config-token'] };
      case 'public-origin-not-https':
        return { field: null, message: SLACK_ERROR_COPY['public-origin-not-https'] };
      case 'slack-app-gone':
        return { field: null, message: SLACK_ERROR_COPY['slack-app-gone'] };
      case 'slack-name':
        return { field: 'botName', message: SLACK_ERROR_COPY['slack-name'] };
      case 'bot-name-taken':
        return { field: 'botName', message: SLACK_ERROR_COPY['bot-name-taken'] };
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
