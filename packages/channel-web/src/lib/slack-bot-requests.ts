/**
 * Admin › Slack's bot requests: the wire client and the words for its
 * failures (TASK-1169). A team admin who can't install Slack apps asks the AX
 * admins for their agent's own bot; this is the list those admins approve or
 * decline from. The routes live in @ax/channel-slack
 * (`packages/channel-slack/src/bot-request-routes.ts`); the types mirror its
 * answers by shape, not by import (the SPA depends on no host plugin).
 *
 *   GET  /admin/slack/bot-requests                      → { requests, truncated, configTokenStored }
 *   POST /admin/slack/bot-requests/:requestId/approve   { refreshToken?, iconPng? } → { installUrl, iconSet }
 *   POST /admin/slack/bot-requests/:requestId/decline   → {}
 *
 * Every request carries the session cookie (`httpFetch`, which also notices a
 * 401), and every POST the `x-requested-with: ax-admin` header the CSRF check
 * wants. Answers are read field by field; a field of the wrong type is a
 * `bad-response`, never a half-drawn row. Nothing here carries a picture
 * (the requester sends none) or a person's id: names and dates only.
 */
import { AGENT_SLACK_BOT_COPY, AGENT_SLACK_COPY } from './agent-slack';
import { httpFetch } from './http';
import { SLACK_ERROR_COPY, SlackAdminError } from './slack-admin';
import { SLACK_TOKEN_COPY } from './slack-token-copy';

/** One open request, as Admin › Slack lists it (mirrors @ax/channel-slack's `AdminBotRequest`). */
export interface SlackBotRequest {
  requestId: string;
  botName: string;
  agentName: string;
  /** Null when the server has no teams plugin, or the requester can no longer see the agent. */
  teamName: string | null;
  requestedBy: string;
  /** An ISO 8601 instant. */
  requestedAt: string;
}

export interface SlackBotRequestList {
  requests: SlackBotRequest[];
  /** More requests are waiting than are listed (the server lists the oldest few). */
  truncated: boolean;
  /** Whether the server holds the VIEWING admin's own configuration token, so Approve can skip the paste. */
  configTokenStored: boolean;
}

const LIST_PATH = '/admin/slack/bot-requests';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/** The server's own refusal codes (`requester-not-admin`, `slack-config-token`, …). */
const CODE_RE = /^[a-z0-9-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codeOf(value: unknown): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

const badResponse = (status: number): SlackAdminError => new SlackAdminError(status, 'bad-response');

function parseRequest(value: unknown): SlackBotRequest | null {
  if (!isRecord(value)) return null;
  const { requestId, botName, agentName, teamName, requestedBy, requestedAt } = value;
  if (
    typeof requestId !== 'string' ||
    typeof botName !== 'string' ||
    typeof agentName !== 'string' ||
    (teamName !== null && typeof teamName !== 'string') ||
    typeof requestedBy !== 'string' ||
    typeof requestedAt !== 'string'
  ) {
    return null;
  }
  return { requestId, botName, agentName, teamName, requestedBy, requestedAt };
}

/** The open requests, oldest first, and whether this admin has a configuration token on file. */
export async function fetchSlackBotRequests(): Promise<SlackBotRequestList> {
  const res = await httpFetch(LIST_PATH);
  if (!res.ok) throw new SlackAdminError(res.status, 'unknown');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw badResponse(res.status);
  }
  if (
    !isRecord(body) ||
    !Array.isArray(body['requests']) ||
    typeof body['truncated'] !== 'boolean' ||
    typeof body['configTokenStored'] !== 'boolean'
  ) {
    throw badResponse(res.status);
  }
  const requests: SlackBotRequest[] = [];
  for (const row of body['requests']) {
    const request = parseRequest(row);
    if (request === null) throw badResponse(res.status);
    requests.push(request);
  }
  return { requests, truncated: body['truncated'], configTokenStored: body['configTokenStored'] };
}

/** A POST with the write headers. A non-ok answer becomes a SlackAdminError. */
async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await httpFetch(path, { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) });
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

const requestPath = (requestId: string, action: 'approve' | 'decline'): string =>
  `${LIST_PATH}/${encodeURIComponent(requestId)}/${action}`;

/**
 * Approve a request: create the bot in Slack with this admin's configuration
 * token (the one the server holds, unless `refreshToken` is pasted), and get
 * back where to send them to click Allow. Only what is given is sent. The
 * link is checked by `goToSlack`, which refuses any address but Slack's own.
 */
export async function approveSlackBotRequest(
  requestId: string,
  i: { refreshToken?: string; iconPng?: string },
): Promise<{ installUrl: string }> {
  const answer = await post(requestPath(requestId, 'approve'), {
    ...(i.refreshToken !== undefined ? { refreshToken: i.refreshToken } : {}),
    ...(i.iconPng !== undefined ? { iconPng: i.iconPng } : {}),
  });
  const installUrl = isRecord(answer.body) ? answer.body['installUrl'] : undefined;
  if (typeof installUrl !== 'string' || installUrl === '') throw badResponse(answer.status);
  return { installUrl };
}

/** Turn a request down. The team can ask again, with another name or the same. */
export async function declineSlackBotRequest(requestId: string): Promise<void> {
  await post(requestPath(requestId, 'decline'), {});
}

// ── What an error says ────────────────────────────────────────────────────

export const SLACK_BOT_REQUEST_COPY: Readonly<Record<string, string>> = Object.freeze({
  title: 'Bot requests',
  description:
    "Team admins asked for their agent's own Slack bot. Approving creates it with your Slack configuration token, so you'll be the one who can change or delete it later.",
  storedToken: "We'll use the configuration token you gave us before.",
  cancel: 'Cancel',
  approve: 'Approve and open Slack',
  'requester-not-admin':
    "The person who asked is no longer an admin of that agent's team, so this can't be approved. Decline it instead.",
  'agent-gone': "That agent was deleted, so there's nothing to approve. Decline the request.",
  'bot-name-taken':
    'Another Slack bot here already uses that name. Decline this request, and the team can ask again with another name.',
  'slack-name':
    "Slack didn't accept that bot name. Decline this request, and the team can ask again with another name.",
  'no-workspace': "Slack isn't connected right now, so bots can't be approved.",
  loadFailed: "We couldn't load bot requests.",
  declineFailed: "We couldn't decline that just now. Try again in a minute.",
  changed: "This changed while you were here, so we've refreshed it.",
  more: 'There are more requests waiting. Approve or decline these to see the rest.',
});

/**
 * The sentence a refused approve becomes, and where it goes. `revealToken`:
 * the refusal means "paste a configuration token", so the dialog shows its
 * token field (and the message sits under it). Never a raw code.
 */
export function slackBotRequestErrorCopy(err: unknown): {
  field: 'refreshToken' | null;
  message: string;
  revealToken: boolean;
} {
  if (err instanceof SlackAdminError) {
    switch (err.code) {
      case 'requester-not-admin':
      case 'agent-gone':
      case 'bot-name-taken':
      case 'slack-name':
      case 'no-workspace': {
        const message = SLACK_BOT_REQUEST_COPY[err.code] ?? AGENT_SLACK_COPY.generic;
        return { field: null, message, revealToken: false };
      }
      case 'config-token-needed':
      case 'slack-config-token':
      case 'slack-token':
        return { field: 'refreshToken', message: AGENT_SLACK_BOT_COPY[err.code], revealToken: true };
      case 'invalid-refresh-token':
      case 'slack-refresh-token':
        return { field: 'refreshToken', message: SLACK_TOKEN_COPY[err.code], revealToken: false };
      case 'public-origin-not-https':
        return { field: null, message: SLACK_ERROR_COPY['public-origin-not-https'], revealToken: false };
      case 'slack-unconfirmed':
        return { field: null, message: SLACK_TOKEN_COPY['slack-unconfirmed'], revealToken: false };
      case 'slack-error':
        return { field: null, message: SLACK_ERROR_COPY.generic, revealToken: false };
    }
  }
  // Our own failure (`internal`), or a dropped connection: nothing to blame Slack for.
  return { field: null, message: AGENT_SLACK_COPY.generic, revealToken: false };
}

/**
 * An approve or decline that says what we drew is out of date: the request is
 * gone (404: someone approved, declined or cancelled it first), or its agent
 * already has a bot (409 `bot-exists`). Read the list again.
 */
export function slackBotRequestStale(err: unknown): boolean {
  return (
    err instanceof SlackAdminError &&
    ((err.status === 404 && err.code === 'not-found') || (err.status === 409 && err.code === 'bot-exists'))
  );
}
