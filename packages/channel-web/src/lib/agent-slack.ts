/**
 * An agent's Slack section: the wire client and the words for its failures
 * (TASK-1094). The routes live in @ax/channel-slack
 * (`packages/channel-slack/src/agent-routes.ts`); the types below mirror its
 * answers by shape, not by import (the SPA depends on no host plugin).
 *
 *   GET  /settings/slack/:agentId             → AgentSlackStatus
 *   GET  /settings/slack/:agentId/available   → { channels, truncated }
 *   POST /settings/slack/:agentId/connect     { channelId } → { channel, reconnected }
 *   POST /settings/slack/:agentId/disconnect  { channelId } → { removed }
 *   POST /settings/slack/:agentId/remember    { channelId, remember } → {}
 *
 * Every request carries the session cookie (`httpFetch`, which also notices a
 * 401), and every POST the `x-requested-with: ax-admin` header the CSRF check
 * wants (the same write headers as `lib/slack-admin.ts`). Answers are read
 * field by field; a field of the wrong type is a `bad-response`, never a
 * half-drawn row.
 */
import { HttpError, httpFetch } from './http';

export interface SlackChannelRow {
  channelId: string;
  name: string;
  remember: boolean;
  connectedBy: string;
  needsReconnect: boolean;
}

export type AgentSlackStatus =
  | { state: 'no-workspace' }
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

const base = (agentId: string): string => `/settings/slack/${encodeURIComponent(agentId)}`;

function parseRow(value: unknown): SlackChannelRow | null {
  if (!isRecord(value)) return null;
  const { channelId, name, remember, connectedBy, needsReconnect } = value;
  if (
    typeof channelId !== 'string' ||
    typeof name !== 'string' ||
    typeof remember !== 'boolean' ||
    typeof connectedBy !== 'string' ||
    typeof needsReconnect !== 'boolean'
  ) {
    return null;
  }
  return { channelId, name, remember, connectedBy, needsReconnect };
}

function parseStatus(body: unknown): AgentSlackStatus | null {
  if (!isRecord(body)) return null;
  switch (body['state']) {
    case 'no-workspace':
      return { state: 'no-workspace' };
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
      const rows: SlackChannelRow[] = [];
      for (const c of channels) {
        const row = parseRow(c);
        if (row === null) return null;
        rows.push(row);
      }
      return { state: 'ready', botName, workspaceName, canManage, channels: rows };
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
 * but they are answers about the channel, shown as they are.
 */
export function agentSlackStateChanged(err: unknown): boolean {
  if (!(err instanceof AgentSlackError)) return false;
  if (err.status === 403 || err.status === 404) return true;
  return err.status === 409 && (err.code === 'personal-agent' || err.code === 'no-workspace');
}

/**
 * A remember or disconnect the server refused because what we drew is gone or
 * no longer ours to change (403, 404, 409): read it again. Only a 5xx or a
 * dropped connection is worth "try again".
 */
export function agentSlackWriteStale(err: unknown): boolean {
  return err instanceof AgentSlackError && (err.status === 403 || err.status === 404 || err.status === 409);
}
