/**
 * An agent's Slack section: the wire client and the words for its failures
 * (TASK-1094). The routes live in @ax/channel-slack
 * (`packages/channel-slack/src/agent-routes.ts`); the types below mirror its
 * answers by shape, not by import (the SPA depends on no host plugin).
 *
 *   GET  /settings/slack/:agentId             → AgentSlackStatus
 *   GET  /settings/slack/:agentId/available   → { channels, truncated }
 *   POST /settings/slack/:agentId/connect     { channelId } → { channel, reconnected } (409 own-bot once its own bot is live)
 *   POST /settings/slack/:agentId/disconnect  { channelId } → { removed }
 *   POST /settings/slack/:agentId/remember    { channelId, remember } → {}
 *   POST /settings/slack/:agentId/bot         { botName, refreshToken?, iconPng? } → { installUrl, iconSet }
 *   POST /settings/slack/:agentId/bot/install-url  → { installUrl }
 *   POST /settings/slack/:agentId/bot/cancel  → { appDeleted }
 *   POST /settings/slack/:agentId/bot/disconnect  { installId } → { appDeleted }
 *        (TASK-1172: a live or pending bot, named by the install id the page showed; 409 no-bot for any other)
 *   POST /settings/slack/:agentId/bot-request         { botName } → {}
 *   POST /settings/slack/:agentId/bot-request/cancel  → {}
 *
 * Every request carries the session cookie (`httpFetch`, which also notices a
 * 401), and every POST the `x-requested-with: ax-admin` header the CSRF check
 * wants (the same write headers as `lib/slack-admin.ts`). Answers are read
 * field by field; a field of the wrong type is a `bad-response`, never a
 * half-drawn row.
 */
import { HttpError, httpFetch } from './http';
import { SLACK_ERROR_COPY } from './slack-admin';
import { BOT_NAME_COPY, BOT_NAME_FALLBACK, SLACK_TOKEN_COPY } from './slack-token-copy';

export interface SlackChannelRow {
  channelId: string;
  name: string;
  remember: boolean;
  connectedBy: string;
  needsReconnect: boolean;
  /**
   * The agent's own bot is live and has not answered in this channel yet, so
   * it still needs an invite. An older host omits it; that reads as false.
   */
  needsInvite: boolean;
}

/** A live bot as the moved-channel lines name it: its @handle, or its name when Slack never said one. */
export interface InviteTarget {
  botName: string;
  handle: string | null;
}

/**
 * The agent's own Slack bot, as this viewer may see it (mirrors
 * @ax/channel-slack's `AgentSlackBot` by shape). `pending` reaches only the
 * people who manage the agent. `approver` is a display name, never an email.
 *
 * `installId` is the bot's own opaque id, the key its Disconnect takes, so a
 * page only ever takes away the bot it showed (TASK-1172). Only the people
 * who manage the agent get it. It is null for anyone else, and from an older
 * server that doesn't send it; with no id there is no Disconnect.
 */
export type AgentSlackBot =
  /** `configTokenStored`: whether the server holds the viewer's OWN configuration token, so the form can skip the paste. */
  | { state: 'none'; configTokenStored: boolean }
  /**
   * A team admin asked the AX admins for it, and none has approved yet (TASK-1169). Nothing exists in Slack.
   * `requestedAt`: when it was asked, as an ISO 8601 instant. Like `pending`, it reaches only managers.
   */
  | { state: 'requested'; botName: string; requestedAt: string }
  /** `canContinue`: the viewer is the approver and Slack is connected, so "Continue in Slack" can finish it. */
  | { state: 'pending'; botName: string; approver: string; canContinue: boolean; installId: string | null }
  /** `handle`: the bot's @handle, or null when Slack never said. `needsClaim`: no team admin stands behind it now. */
  | {
      state: 'live';
      botName: string;
      handle: string | null;
      approver: string;
      needsClaim: boolean;
      installId: string | null;
    };

export type AgentSlackStatus =
  | {
      state: 'no-workspace';
      /**
       * Whether the viewer manages the agent. Slack may be gone while the
       * agent's own bot stays (TASK-1172), and its manager can still take it
       * away. An older host omits it; that reads as "a pending bot is theirs".
       */
      canManage: boolean;
      bot: AgentSlackBot;
    }
  | {
      state: 'personal-agent';
      botName: string;
      /**
       * Whether a direct message to the bot reaches this agent (its owner's
       * oldest personal agent). An older host omits it; that reads as true.
       */
      answersDms: boolean;
    }
  | {
      state: 'ready';
      botName: string;
      workspaceName: string;
      canManage: boolean;
      channels: SlackChannelRow[];
      bot: AgentSlackBot;
    };

/** `unavailable`: this server doesn't run the Slack plugin (or can't show us the agent). */
export type AgentSlackRead = AgentSlackStatus | { state: 'unavailable' };

export interface AvailableSlackChannel {
  channelId: string;
  name: string;
  /** Who has it: nobody, this agent, or another one. */
  connected: 'this-agent' | 'other-agent' | null;
}

export interface AvailableSlackChannels {
  channels: AvailableSlackChannel[];
  truncated: boolean;
}

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/** The server's own refusal codes (`channel-taken`, `needs-reconnect`, …). */
const CODE_RE = /^[a-z0-9-]{1,64}$/;
/** A bot's install id as the server makes them: 16 random bytes, base64url. */
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * A request that failed with an answer we could read, or an answer we
 * couldn't use (`bad-response`). `code` and `reason` are the server's, kept
 * only when they are code-shaped; `message` is for the console, never a page.
 */
export class AgentSlackError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | null;

  constructor(status: number, code: string, reason: string | null = null) {
    super(`agent slack request failed: ${status} ${code}`);
    this.name = 'AgentSlackError';
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

const badResponse = (status: number): AgentSlackError => new AgentSlackError(status, 'bad-response');

/** A date for a line of prose ("Nov 20, 2026"); a value that isn't a date shows as it came. */
export function slackShortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const base = (agentId: string): string => `/settings/slack/${encodeURIComponent(agentId)}`;

function parseRow(value: unknown): SlackChannelRow | null {
  if (!isRecord(value)) return null;
  const { channelId, name, remember, connectedBy, needsReconnect, needsInvite = false } = value;
  if (
    typeof channelId !== 'string' ||
    typeof name !== 'string' ||
    typeof remember !== 'boolean' ||
    typeof connectedBy !== 'string' ||
    typeof needsReconnect !== 'boolean' ||
    typeof needsInvite !== 'boolean'
  ) {
    return null;
  }
  return { channelId, name, remember, connectedBy, needsReconnect, needsInvite };
}

/**
 * A bot's install id: one the server could have made, or null (the viewer
 * doesn't manage the agent). An older server omits it, which reads as null.
 * Anything else is no answer at all: it would be posted back as the bot to
 * disconnect.
 */
function isInstallId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && INSTALL_ID_RE.test(value));
}

function parseBot(value: unknown): AgentSlackBot | null {
  if (!isRecord(value)) return null;
  switch (value['state']) {
    case 'none': {
      const { configTokenStored } = value;
      return typeof configTokenStored === 'boolean' ? { state: 'none', configTokenStored } : null;
    }
    case 'requested': {
      const { botName, requestedAt } = value;
      return typeof botName === 'string' && typeof requestedAt === 'string'
        ? { state: 'requested', botName, requestedAt }
        : null;
    }
    case 'pending': {
      const { botName, approver, canContinue, installId = null } = value;
      return typeof botName === 'string' &&
        typeof approver === 'string' &&
        typeof canContinue === 'boolean' &&
        isInstallId(installId)
        ? { state: 'pending', botName, approver, canContinue, installId }
        : null;
    }
    case 'live': {
      const { botName, handle, approver, needsClaim, installId = null } = value;
      return typeof botName === 'string' &&
        (handle === null || typeof handle === 'string') &&
        typeof approver === 'string' &&
        typeof needsClaim === 'boolean' &&
        isInstallId(installId)
        ? { state: 'live', botName, handle, approver, needsClaim, installId }
        : null;
    }
    default:
      return null;
  }
}

function parseStatus(body: unknown): AgentSlackStatus | null {
  if (!isRecord(body)) return null;
  switch (body['state']) {
    case 'no-workspace': {
      const bot = parseBot(body['bot']);
      if (bot === null) return null;
      const canManage = 'canManage' in body ? body['canManage'] : bot.state === 'pending';
      return typeof canManage === 'boolean' ? { state: 'no-workspace', canManage, bot } : null;
    }
    case 'personal-agent': {
      const { botName, answersDms = true } = body;
      return typeof botName === 'string' && typeof answersDms === 'boolean'
        ? { state: 'personal-agent', botName, answersDms }
        : null;
    }
    case 'ready': {
      const { botName, workspaceName, canManage, channels } = body;
      if (
        typeof botName !== 'string' ||
        typeof workspaceName !== 'string' ||
        typeof canManage !== 'boolean' ||
        !Array.isArray(channels)
      ) {
        return null;
      }
      const bot = parseBot(body['bot']);
      if (bot === null) return null;
      const rows: SlackChannelRow[] = [];
      for (const c of channels) {
        const row = parseRow(c);
        if (row === null) return null;
        rows.push(row);
      }
      return { state: 'ready', botName, workspaceName, canManage, channels: rows, bot };
    }
    default:
      return null;
  }
}

async function failure(res: Response): Promise<AgentSlackError> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const fields = isRecord(json) ? json : {};
  return new AgentSlackError(res.status, codeOf(fields['error']) ?? 'unknown', codeOf(fields['reason']));
}

/**
 * How Slack stands for one agent. A 404 means this server has no Slack routes
 * (or the agent isn't one we can see), and so does a page that isn't JSON: a
 * host that serves the app answers an unknown GET with the app's own HTML.
 * Any other failure throws, for a retry.
 */
export async function fetchAgentSlack(agentId: string): Promise<AgentSlackRead> {
  const res = await httpFetch(base(agentId));
  if (res.status === 404) return { state: 'unavailable' };
  if (!res.ok) throw new HttpError(base(agentId), res.status);
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

/** The channels a connect could accept, each marked by who has it. */
export async function fetchAvailableChannels(agentId: string): Promise<AvailableSlackChannels> {
  const res = await httpFetch(`${base(agentId)}/available`);
  if (!res.ok) throw await failure(res);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw badResponse(res.status);
  }
  if (!isRecord(body) || !Array.isArray(body['channels']) || typeof body['truncated'] !== 'boolean') {
    throw badResponse(res.status);
  }
  const channels: AvailableSlackChannel[] = [];
  for (const c of body['channels']) {
    if (!isRecord(c)) throw badResponse(res.status);
    const { channelId, name, connected } = c;
    if (
      typeof channelId !== 'string' ||
      typeof name !== 'string' ||
      (connected !== null && connected !== 'this-agent' && connected !== 'other-agent')
    ) {
      throw badResponse(res.status);
    }
    channels.push({ channelId, name, connected });
  }
  return { channels, truncated: body['truncated'] };
}

/** A POST with the write headers. A non-ok answer becomes an AgentSlackError. */
async function post(agentId: string, suffix: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await httpFetch(`${base(agentId)}${suffix}`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json };
}

/** Connect (or reconnect) a channel. The answer is the row to draw. */
export async function connectSlackChannel(
  agentId: string,
  channelId: string,
): Promise<{ channel: SlackChannelRow; reconnected: boolean }> {
  const answer = await post(agentId, '/connect', { channelId });
  const fields = isRecord(answer.body) ? answer.body : {};
  const channel = parseRow(fields['channel']);
  const reconnected = fields['reconnected'];
  if (channel === null || typeof reconnected !== 'boolean') throw badResponse(answer.status);
  return { channel, reconnected };
}

/** Disconnect a channel. `removed` is false when it was already gone. */
export async function disconnectSlackChannel(agentId: string, channelId: string): Promise<{ removed: boolean }> {
  const answer = await post(agentId, '/disconnect', { channelId });
  const removed = isRecord(answer.body) ? answer.body['removed'] : undefined;
  if (typeof removed !== 'boolean') throw badResponse(answer.status);
  return { removed };
}

/** Turn "remember this channel" on or off. Resolves once the server holds it. */
export async function setSlackChannelRemember(
  agentId: string,
  channelId: string,
  remember: boolean,
): Promise<void> {
  await post(agentId, '/remember', { channelId, remember });
}

/**
 * Ask for the agent's own Slack bot. `refreshToken` is sent only when the
 * person pasted one (the server uses the one it holds otherwise); `iconPng`
 * only when there is a picture. The answer is where to send the person to
 * click Allow.
 */
export async function requestSlackBot(
  agentId: string,
  i: { botName: string; refreshToken?: string; iconPng?: string },
): Promise<{ installUrl: string; iconSet: boolean }> {
  const answer = await post(agentId, '/bot', {
    botName: i.botName,
    ...(i.refreshToken !== undefined ? { refreshToken: i.refreshToken } : {}),
    ...(i.iconPng !== undefined ? { iconPng: i.iconPng } : {}),
  });
  const fields = isRecord(answer.body) ? answer.body : {};
  const { installUrl, iconSet } = fields;
  if (typeof installUrl !== 'string' || installUrl === '' || typeof iconSet !== 'boolean') {
    throw badResponse(answer.status);
  }
  return { installUrl, iconSet };
}

/**
 * Ask the AX admins to approve the agent's own bot, for a team admin who
 * can't install apps in Slack. Nothing secret goes: only the name.
 */
export async function askSlackBotApproval(agentId: string, i: { botName: string }): Promise<void> {
  await post(agentId, '/bot-request', { botName: i.botName });
}

/** Take back a request no AX admin has approved yet. */
export async function cancelSlackBotRequest(agentId: string): Promise<void> {
  await post(agentId, '/bot-request/cancel', {});
}

/** A fresh install link for the pending bot (its approver only). */
export async function continueSlackBot(agentId: string): Promise<{ installUrl: string }> {
  const answer = await post(agentId, '/bot/install-url', {});
  const installUrl = isRecord(answer.body) ? answer.body['installUrl'] : undefined;
  if (typeof installUrl !== 'string' || installUrl === '') throw badResponse(answer.status);
  return { installUrl };
}

/** Take back the pending request. `appDeleted` is false when the Slack app is left for its owner to delete. */
export async function cancelSlackBot(agentId: string): Promise<{ appDeleted: boolean }> {
  const answer = await post(agentId, '/bot/cancel', {});
  const appDeleted = isRecord(answer.body) ? answer.body['appDeleted'] : undefined;
  if (typeof appDeleted !== 'boolean') throw badResponse(answer.status);
  return { appDeleted };
}

/**
 * Take the agent's own bot away, pending or live: the one whose `installId`
 * the page showed, and no other (any other is a 409 `no-bot`, see
 * `agentSlackBotStale`). `appDeleted` is false when its Slack app may still
 * be on Slack.
 */
export async function disconnectSlackBot(agentId: string, installId: string): Promise<{ appDeleted: boolean }> {
  const answer = await post(agentId, '/bot/disconnect', { installId });
  const appDeleted = isRecord(answer.body) ? answer.body['appDeleted'] : undefined;
  if (typeof appDeleted !== 'boolean') throw badResponse(answer.status);
  return { appDeleted };
}

// ── What an error says ────────────────────────────────────────────────────

export const AGENT_SLACK_COPY = Object.freeze({
  notPublic: "That's a private channel. Only public channels can be connected.",
  archived: "That channel is archived. Pick one that's still in use.",
  shared: "Channels shared with another organization can't be connected.",
  channelNotAllowed: "That channel can't be connected.",
  channelTaken:
    "That channel is already connected to another agent. A team admin of that agent's team can disconnect it.",
  workspacePolicy: "Your Slack workspace doesn't let the bot join that channel. A Slack admin can change that.",
  needsReconnect: 'Slack needs to be reconnected before we can do that. An admin can do it in Admin settings.',
  slackError: "Slack didn't answer just now. Try again in a minute.",
  generic: 'Something went wrong. Try again in a minute.',
  rememberFailed: "We couldn't change that, so nothing is different. Try again.",
  movedNotice: (t: InviteTarget): string =>
    t.handle !== null
      ? `These channels still need @${t.handle}: run /invite @${t.handle} in each one. A channel leaves this list once @${t.handle} answers there.`
      : `These channels still need ${t.botName}: invite it to each one with /invite. A channel leaves this list once ${t.botName} answers there.`,
  movedRow: (t: InviteTarget): string =>
    t.handle !== null ? `Run /invite @${t.handle} here.` : `Invite ${t.botName} here with /invite.`,
  movedDisconnect: (channel: string): string =>
    `We'll take #${channel} off this list. The agent answers there only after its own bot is invited.`,
});

/** The sentence a refused connect or channel list becomes. Never a raw code. */
export function agentSlackErrorCopy(err: unknown): string {
  if (err instanceof AgentSlackError) {
    switch (err.code) {
      case 'needs-reconnect':
        return AGENT_SLACK_COPY.needsReconnect;
      case 'channel-taken':
        return AGENT_SLACK_COPY.channelTaken;
      case 'channel-not-allowed':
        switch (err.reason) {
          case 'not-public':
            return AGENT_SLACK_COPY.notPublic;
          case 'archived':
            return AGENT_SLACK_COPY.archived;
          case 'shared':
            return AGENT_SLACK_COPY.shared;
          case 'workspace-policy':
            return AGENT_SLACK_COPY.workspacePolicy;
          default:
            return AGENT_SLACK_COPY.channelNotAllowed;
        }
      case 'slack-error':
        return AGENT_SLACK_COPY.slackError;
    }
  }
  return AGENT_SLACK_COPY.generic;
}

/**
 * A refused connect that means the picture is stale: this agent is personal or
 * there is no workspace now (409), or it can't be managed (403) or seen (404)
 * any more. Read it again. `channel-taken` and `needs-reconnect` are 409s too,
 * but they are answers about the channel, shown as they are. `own-bot` is
 * stale too: the agent's own bot went live since this page was drawn.
 */
export function agentSlackStateChanged(err: unknown): boolean {
  if (!(err instanceof AgentSlackError)) return false;
  if (err.status === 403 || err.status === 404) return true;
  return err.status === 409 && (err.code === 'personal-agent' || err.code === 'no-workspace' || err.code === 'own-bot');
}

/**
 * A remember or disconnect the server refused because what we drew is gone or
 * no longer ours to change (403, 404, 409): read it again. Only a 5xx or a
 * dropped connection is worth "try again".
 */
export function agentSlackWriteStale(err: unknown): boolean {
  return err instanceof AgentSlackError && (err.status === 403 || err.status === 404 || err.status === 409);
}

export const AGENT_SLACK_BOT_COPY = Object.freeze({
  'slack-config-token':
    "The configuration token we kept for you stopped working. Generate a new one on Slack's app settings and paste it below.",
  'config-token-needed': 'Paste a configuration token to continue.',
  'slack-token': "Slack didn't accept the configuration token. Generate a new one and paste it below.",
  'no-workspace': "Slack isn't connected yet. An admin connects it first.",
  'not-approver': 'Only the person who set this up can continue it in Slack.',
});

/**
 * The sentence a refused bot request, continue or cancel becomes, and where it
 * goes. `revealToken`: the refusal means "paste a configuration token", so the
 * form shows its token field (and the message sits under it). Never a raw code.
 */
export function agentSlackBotErrorCopy(err: unknown): {
  field: 'botName' | 'refreshToken' | null;
  message: string;
  revealToken: boolean;
} {
  if (err instanceof AgentSlackError) {
    switch (err.code) {
      case 'invalid-bot-name': {
        const known =
          err.reason !== null && Object.hasOwn(BOT_NAME_COPY, err.reason) ? BOT_NAME_COPY[err.reason] : undefined;
        return { field: 'botName', message: known ?? BOT_NAME_FALLBACK, revealToken: false };
      }
      case 'bot-name-taken':
        return { field: 'botName', message: SLACK_TOKEN_COPY['bot-name-taken'], revealToken: false };
      case 'slack-name':
        return { field: 'botName', message: SLACK_TOKEN_COPY['slack-name'], revealToken: false };
      case 'invalid-refresh-token':
        return { field: 'refreshToken', message: SLACK_TOKEN_COPY['invalid-refresh-token'], revealToken: false };
      case 'slack-refresh-token':
        return { field: 'refreshToken', message: SLACK_TOKEN_COPY['slack-refresh-token'], revealToken: false };
      case 'slack-config-token':
      case 'config-token-needed':
      case 'slack-token':
        return { field: 'refreshToken', message: AGENT_SLACK_BOT_COPY[err.code], revealToken: true };
      case 'no-workspace':
      case 'not-approver':
        return { field: null, message: AGENT_SLACK_BOT_COPY[err.code], revealToken: false };
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
 * A bot request, continue, cancel or disconnect that says what we drew is out of date:
 * the bot is already there, already asked for, no longer pending or requested, or no longer
 * there (409), or the agent can't be managed (403 `forbidden`) or seen (404) any more. Read
 * the status again.
 * (`not-approver` is a 403 too, but it is an answer about the person, shown as it is.)
 */
export function agentSlackBotStale(err: unknown): boolean {
  if (!(err instanceof AgentSlackError)) return false;
  if (err.status === 404 || (err.status === 403 && err.code === 'forbidden')) return true;
  return (
    err.status === 409 &&
    (err.code === 'bot-exists' ||
      err.code === 'not-pending' ||
      err.code === 'bot-requested' ||
      err.code === 'not-requested' ||
      err.code === 'personal-agent' ||
      err.code === 'no-bot')
  );
}
