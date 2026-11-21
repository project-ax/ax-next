/**
 * Admin › Slack's list of team agents' own bots, and its Disconnect (TASK-1172).
 * The routes live in @ax/channel-slack
 * (`packages/channel-slack/src/admin-bot-routes.ts`); the types below mirror
 * their answers by shape, not by import (the SPA depends on no host plugin).
 *
 *   GET  /admin/slack/bots              → { bots: AdminSlackBot[] }
 *   POST /admin/slack/bots/disconnect   { installId } → { appDeleted }
 *   POST /admin/slack/bots/replace-token  { installId, refreshToken } → {}
 *        (TASK-1173: a live bot's approver replaces their configuration token; 403 not-approver for anyone else)
 *
 * Every request carries the session cookie (`httpFetch`, which also notices a
 * 401), and every POST the `x-requested-with: ax-admin` header the CSRF check
 * wants (the same write headers as `lib/slack-admin.ts`, whose
 * `SlackAdminError` these throw). Answers are read field by field. Unlike the
 * leftover-apps note, the list is not advisory: an offboarding admin relies on
 * it, so a malformed answer is a `bad-response` and never reads as "no bots".
 */
import { HttpError, httpFetch, REQUEST_TIMEOUT_MS, withRequestTimeout } from './http';
import { SLACK_ERROR_COPY, SlackAdminError } from './slack-admin';
import { BOT_TOKEN_COPY, SLACK_TOKEN_COPY } from './slack-token-copy';

/** One team agent's own bot, as an admin sees it (mirrors @ax/channel-slack's `AdminSlackBot`). */
export interface AdminSlackBot {
  /** The key Disconnect takes. Opaque; never shown. */
  installId: string;
  botName: string;
  /** Slack's @handle for the bot, or null when Slack never said. */
  handle: string | null;
  /** Who set it up: a name, or null when that person is no longer an account here. */
  approver: string | null;
  state: 'pending' | 'live';
  /** When the bot was asked for (ISO 8601). */
  addedAt: string;
  /** The viewer set this bot up, so they can replace its token. An older host omits it; that reads as false. */
  viewerIsApprover: boolean;
}

export type SlackBotsRead = { state: 'ready'; bots: AdminSlackBot[] } | { state: 'unavailable' };

const LIST_PATH = '/admin/slack/bots';
const DISCONNECT_PATH = '/admin/slack/bots/disconnect';
const REPLACE_TOKEN_PATH = '/admin/slack/bots/replace-token';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/** The server's own refusal codes (`no-bot`, `invalid-install-id`, …). */
const CODE_RE = /^[a-z0-9-]{1,64}$/;
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const BOT_NAME_MAX = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codeOf(value: unknown): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

const badResponse = (status: number): SlackAdminError => new SlackAdminError(status, 'bad-response');

/** One bot, with only the seven fields we draw; anything malformed is null. */
function parseBot(value: unknown): AdminSlackBot | null {
  if (!isRecord(value)) return null;
  const { installId, botName, handle, approver, state, addedAt, viewerIsApprover = false } = value;
  if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId)) return null;
  if (typeof botName !== 'string' || botName.length < 1 || botName.length > BOT_NAME_MAX) return null;
  if (handle !== null && typeof handle !== 'string') return null;
  if (approver !== null && typeof approver !== 'string') return null;
  if (state !== 'pending' && state !== 'live') return null;
  if (typeof addedAt !== 'string') return null;
  if (typeof viewerIsApprover !== 'boolean') return null;
  return { installId, botName, handle, approver, state, addedAt, viewerIsApprover };
}

/**
 * Every team bot. A 404 means this server has no such route, and so does a
 * page that isn't JSON (a host that serves the app answers an unknown GET with
 * the app's own HTML). Any other failure throws, for a retry; so does a list
 * or an item we can't read, and a read that doesn't answer within
 * `REQUEST_TIMEOUT_MS` (a `RequestTimeoutError`).
 */
export async function fetchSlackBots(): Promise<SlackBotsRead> {
  // A deadline over the whole read, body included: a hung request must reach
  // the card's error and Try again, never sit looking like "no bots".
  return withRequestTimeout(LIST_PATH, REQUEST_TIMEOUT_MS, async (signal): Promise<SlackBotsRead> => {
    const res = await httpFetch(LIST_PATH, { signal });
    if (res.status === 404) return { state: 'unavailable' };
    if (!res.ok) throw new HttpError(LIST_PATH, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { state: 'unavailable' };
    }
    const list = isRecord(body) ? body['bots'] : undefined;
    if (!Array.isArray(list)) throw badResponse(res.status);
    const bots: AdminSlackBot[] = [];
    for (const item of list) {
      const bot = parseBot(item);
      if (bot === null) throw badResponse(res.status);
      bots.push(bot);
    }
    return { state: 'ready', bots };
  });
}

/**
 * Take one bot away, by its install id (not its agent, so a stale row can't
 * remove a newer bot). `appDeleted` is false when its Slack app may still be on
 * Slack, where the server lists it among the apps it couldn't delete.
 */
export async function disconnectTeamBot(installId: string): Promise<{ appDeleted: boolean }> {
  const res = await httpFetch(DISCONNECT_PATH, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ installId }),
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
  const appDeleted = isRecord(json) ? json['appDeleted'] : undefined;
  if (typeof appDeleted !== 'boolean') throw badResponse(res.status);
  return { appDeleted };
}

/**
 * Replace a live bot's configuration token with a new one the person pasted
 * (TASK-1173; only the person who set the bot up may). Resolves once Slack
 * accepted the token and the server holds it.
 */
export async function replaceTeamBotToken(installId: string, refreshToken: string): Promise<void> {
  const res = await httpFetch(REPLACE_TOKEN_PATH, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ installId, refreshToken }),
  });
  if (res.ok) return;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const fields = isRecord(json) ? json : {};
  throw new SlackAdminError(res.status, codeOf(fields['error']) ?? 'unknown', codeOf(fields['reason']));
}

/**
 * 409 `no-bot` (someone got there first, or the bot was asked for again) or
 * 409 `not-live` (a reset or rebuild took it away). Read the list again.
 */
export function teamBotGone(err: unknown): boolean {
  return err instanceof SlackAdminError && err.status === 409 && (err.code === 'no-bot' || err.code === 'not-live');
}

/** A Replace that says the row is out of date: `teamBotGone`, or 403 `not-approver` (the bot was handed on). Read the list again. */
export function teamBotReplaceStale(err: unknown): boolean {
  return teamBotGone(err) || (err instanceof SlackAdminError && err.status === 403 && err.code === 'not-approver');
}

/** The sentence a refused Replace becomes, and where it goes. Never a raw code. */
export function teamBotReplaceErrorCopy(err: unknown): { field: 'refreshToken' | null; message: string } {
  if (err instanceof SlackAdminError) {
    switch (err.code) {
      case 'invalid-refresh-token':
      case 'slack-refresh-token':
        return { field: 'refreshToken', message: SLACK_TOKEN_COPY[err.code] };
      case 'slack-not-app-manager':
        return { field: 'refreshToken', message: BOT_TOKEN_COPY['slack-not-app-manager'] };
      case 'public-origin-not-https':
        return { field: null, message: SLACK_ERROR_COPY['public-origin-not-https'] };
    }
  }
  return { field: null, message: SLACK_ERROR_COPY.generic };
}
