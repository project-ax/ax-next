import { PluginError, type AgentContext, type HookBus, type Logger } from '@ax/core';
import type { ChannelBinding, ChannelStore } from './channel-store.js';
import { cleanChannelName } from './label.js';
import { CHANNEL_LIST_MAX_PAGES, CHANNEL_LIST_PAGE_LIMIT } from './limits.js';
import { logCode } from './log-code.js';
import type { SecretStore } from './secrets.js';
import { SlackApiError, TOKEN_REFUSED_CODES, type SlackApi, type SlackChannel } from './slack-api.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * Connecting a Slack channel to a team agent (TASK-1094): who may, and what a
 * channel must be first. One core for both ways in, the agent settings routes
 * (agent-routes.ts) and `/ax connect` in Slack, so the two can't disagree.
 *
 * Rights come from @ax/agents, never from here (invariant 4):
 *   - seeing an agent is `agents:resolve` for the person. Someone it refuses
 *     learns nothing: "not yours" and "doesn't exist" are one answer;
 *   - managing its channels is `agents:can-set-shared-credential`: a team
 *     admin of the agent's team. A connected channel's outsiders run as the
 *     person who connected it, the same decision as choosing whose sign-in a
 *     team agent uses (TASK-813). Always asked as a non-admin;
 *   - only a team agent can have channels. A personal agent is refused before
 *     Slack is asked anything.
 *
 * A channel must be a public, live channel of the install's own workspace:
 * not private, not archived, not Slack Connect. Slack's answers are untrusted
 * (slack-api.ts narrows them, and its refusing flags fail closed). Every
 * check reads `conversations.info` BEFORE the bot joins, an answer about some
 * other channel is refused, and the binding is written last: a refused or
 * failed step binds nothing.
 *
 * Log lines carry the install, a reason, a step and a code: never a channel's
 * id or name, a person or an agent.
 */

export interface ChannelDeps {
  bus: HookBus;
  installs: Pick<InstallStore, 'current'>;
  channels: ChannelStore;
  secrets: Pick<SecretStore, 'get'>;
  api: SlackApi;
  logger: Logger;
}

/** What `agents:resolve` says about one person and one agent. */
export type AgentAccess = 'yes' | 'no' | 'agent-gone' | 'not-team';

export type Rights =
  | { ok: true; agentId: string; agentName: string }
  | { ok: false; reason: 'not-found' | 'personal-agent' | 'forbidden' };

export type ConnectRefusal =
  | 'no-workspace'
  | 'needs-reconnect'
  | 'channel-taken'
  | 'not-public'
  | 'archived'
  | 'shared'
  /** The workspace's own policy keeps the bot out of the channel: trying again changes nothing. */
  | 'not-allowed'
  /** The agent was deleted while its channel was being bound: the binding was taken back. */
  | 'agent-gone'
  | 'slack-error';

/**
 * `code` is Slack's own code, and comes with the reasons a caller may need
 * it to tell apart: `slack-error` (or `id-mismatch`), `needs-reconnect`
 * (`missing_scope` is a scope, the rest a bot token Slack no longer takes)
 * and `not-allowed`.
 */
export type ConnectOutcome =
  | { ok: true; binding: ChannelBinding; reconnected: boolean }
  | { ok: false; reason: ConnectRefusal; code?: string };

export interface AvailableChannel {
  channelId: string;
  /** Cleaned (label.ts). */
  name: string;
  connected: 'this-agent' | 'other-agent' | null;
}

export type AvailableChannels =
  | { ok: true; channels: AvailableChannel[]; truncated: boolean }
  | { ok: false; reason: 'no-workspace' | 'needs-reconnect' | 'slack-error'; code?: string };

/**
 * A bot token Slack no longer takes (revoked, the app uninstalled, the bot
 * deactivated): only connecting Slack again fixes it, so it is never
 * `slack-error` ("try again").
 */
const TOKEN_REFUSED: ReadonlyArray<[string, 'needs-reconnect']> = [...TOKEN_REFUSED_CODES].map(
  (code): [string, 'needs-reconnect'] => [code, 'needs-reconnect'],
);

/** What Slack refusing `conversations.info` means for a connect. Any other code is `slack-error`. */
const INFO_REFUSALS: ReadonlyMap<string, ConnectRefusal> = new Map([
  ...TOKEN_REFUSED,
  // An install made before channels: no channels:read. Slack must be connected again.
  ['missing_scope', 'needs-reconnect'],
  // A private channel the bot isn't in, or nothing at all.
  ['channel_not_found', 'not-public'],
]);

/** What Slack refusing `conversations.join` means for a connect. Any other code is `slack-error`. */
const JOIN_REFUSALS: ReadonlyMap<string, ConnectRefusal> = new Map([
  ...TOKEN_REFUSED,
  ['missing_scope', 'needs-reconnect'],
  ['method_not_supported_for_channel_type', 'not-public'],
  ['channel_not_found', 'not-public'],
  ['is_archived', 'archived'],
  // The workspace's settings don't let this bot join channels.
  ['restricted_action', 'not-allowed'],
]);

/** What Slack refusing `conversations.list` means for the picker. Any other code is `slack-error`. */
const LIST_REFUSALS: ReadonlyMap<string, 'needs-reconnect'> = new Map([
  ...TOKEN_REFUSED,
  ['missing_scope', 'needs-reconnect'],
]);

/** The refusals whose outcome carries Slack's code. */
const CODED: ReadonlySet<ConnectRefusal> = new Set(['slack-error', 'needs-reconnect', 'not-allowed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A service's own refusal code: the bus hands a PluginError back as it was thrown. */
function pluginCode(err: unknown): string | undefined {
  return err instanceof PluginError ? err.code : undefined;
}

/** A log line never changes an answer. */
function quietly(logger: Logger, level: 'info' | 'warn', msg: string, fields: Record<string, unknown>): void {
  try {
    logger[level](msg, fields);
  } catch {
    // Nothing left to report it with.
  }
}

// ── Rights ──────────────────────────────────────────────────────────────────

type Resolved =
  | { access: 'yes'; agentName: string }
  | { access: 'no' }
  | { access: 'agent-gone' }
  | { access: 'not-team' };

async function resolveFor(bus: HookBus, ctx: AgentContext, agentId: string, userId: string): Promise<Resolved> {
  let out: unknown;
  try {
    out = await bus.call<{ agentId: string; userId: string }, unknown>('agents:resolve', ctx, { agentId, userId });
  } catch (err) {
    const code = pluginCode(err);
    if (code === 'forbidden') return { access: 'no' };
    if (code === 'not-found') return { access: 'agent-gone' };
    throw err;
  }
  const agent = isRecord(out) ? out['agent'] : undefined;
  // Only an answer about THIS agent that plainly says "team" is a team agent.
  if (!isRecord(agent) || agent['id'] !== agentId || agent['visibility'] !== 'team') return { access: 'not-team' };
  const name = agent['displayName'];
  return { access: 'yes', agentName: typeof name === 'string' ? name : '' };
}

/**
 * `agents:resolve` for one person: forbidden → 'no', not-found → 'agent-gone',
 * resolved but not visibility 'team' (or an answer about another agent) →
 * 'not-team'. Other errors propagate: an outage is not a refusal.
 */
export async function agentAccess(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
): Promise<AgentAccess> {
  return (await resolveFor(bus, ctx, agentId, userId)).access;
}

/**
 * May `userId` see (`view`) or manage (`manage`) the agent's Slack channels?
 * Someone who can't see the agent gets `not-found` whether or not it exists;
 * a personal agent is `personal-agent`; a member who isn't a team admin of
 * the agent's team is `forbidden` to manage. Other errors propagate.
 */
export async function checkRights(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
  need: 'view' | 'manage',
): Promise<Rights> {
  const seen = await resolveFor(bus, ctx, agentId, userId);
  // Never tell someone who can't see the agent that it exists.
  if (seen.access === 'no' || seen.access === 'agent-gone') return { ok: false, reason: 'not-found' };
  if (seen.access === 'not-team') return { ok: false, reason: 'personal-agent' };
  if (need === 'manage') {
    let out: unknown;
    try {
      // Workspace-admin status never connects a channel (TASK-813's rule);
      // a team admin of the agent's team does.
      out = await bus.call<{ agentId: string; actor: { userId: string; isAdmin: false } }, unknown>(
        'agents:can-set-shared-credential',
        ctx,
        { agentId, actor: { userId, isAdmin: false } },
      );
    } catch (err) {
      // Deleted between the two questions.
      if (pluginCode(err) === 'not-found') return { ok: false, reason: 'not-found' };
      throw err;
    }
    if (!isRecord(out) || out['allowed'] !== true) return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, agentId, agentName: seen.agentName };
}

// ── Slack ───────────────────────────────────────────────────────────────────

/**
 * The install to work in and its bot token, or null when there is no
 * workspace to work in: no install, one that isn't active, or no bot token.
 */
async function workspace(
  d: ChannelDeps,
  install: InstallRow | null,
): Promise<{ install: InstallRow; botToken: string } | null> {
  if (install === null || install.status !== 'active') return null;
  const botToken = await d.secrets.get(install, 'bot-token');
  return botToken === null ? null : { install, botToken };
}

function noWorkspace(d: ChannelDeps): { ok: false; reason: 'no-workspace' } {
  quietly(d.logger, 'info', 'slack_channel_refused', { reason: 'no-workspace', stage: 'install' });
  return { ok: false, reason: 'no-workspace' };
}

/**
 * Connect a channel to an agent the caller already checked `manage` rights
 * on, in `install`: it is active → its bot token → `conversations.info` →
 * the answer is about this channel → public, live, not Slack Connect → not
 * another agent's → the bot joins (unless Slack says it's in) → the binding
 * → the agent still exists. Each step's failure is the named reason and no
 * step after it runs. The requested `channelId` is the one joined and bound.
 * A store, vault or non-Slack failure propagates.
 *
 * The install is the caller's to choose, never a default: the agent settings
 * work in `installs.current()`; `/ax` in the install its request was signed
 * for, so another install row can't lend its bot token or take the binding.
 */
export async function connectChannel(
  d: ChannelDeps,
  i: {
    install: InstallRow | null;
    agentId: string;
    channelId: string;
    actorUserId: string;
    /** For the closing `agents:resolve`: the caller's lookup ctx. */
    ctx: AgentContext;
  },
): Promise<ConnectOutcome> {
  const ws = await workspace(d, i.install);
  if (ws === null) return noWorkspace(d);
  const { install, botToken } = ws;
  const installId = install.installId;

  const refuse = (reason: ConnectRefusal, stage: string, code?: string): ConnectOutcome => {
    const level = reason === 'needs-reconnect' || reason === 'slack-error' ? 'warn' : 'info';
    quietly(d.logger, level, 'slack_channel_refused', {
      installId,
      reason,
      stage,
      ...(code !== undefined ? { code } : {}),
    });
    return CODED.has(reason) && code !== undefined ? { ok: false, reason, code } : { ok: false, reason };
  };
  /** Slack refusing one step, as the connect's reason. Anything that isn't Slack's refusal propagates. */
  const refusedBySlack = (err: unknown, stage: string, known: ReadonlyMap<string, ConnectRefusal>): ConnectOutcome => {
    if (!(err instanceof SlackApiError)) throw err;
    return refuse(known.get(err.code) ?? 'slack-error', stage, err.code);
  };

  let info: SlackChannel;
  try {
    info = await d.api.conversationsInfo(botToken, i.channelId);
  } catch (err) {
    return refusedBySlack(err, 'info', INFO_REFUSALS);
  }
  // Every check below reads this answer, so it must be about the channel asked for.
  if (info.id !== i.channelId) return refuse('slack-error', 'info', 'id-mismatch');
  if (!info.isChannel || info.isPrivate) return refuse('not-public', 'info');
  if (info.isArchived) return refuse('archived', 'info');
  if (info.isExtShared || info.isPendingExtShared) return refuse('shared', 'info');

  // Another agent's channel is refused before the bot joins it, so a refused
  // connect never leaves the bot in a channel it won't serve. The upsert
  // below stays the final word on a connect racing this one.
  const held = await d.channels.get(installId, i.channelId);
  if (held !== null && held.agentId !== i.agentId) return refuse('channel-taken', 'pre-join');

  // Only now does the bot join. Slack's answer often leaves `is_member` out,
  // so this usually runs, and `already_in_channel` is a success.
  if (!info.isMember) {
    try {
      await d.api.conversationsJoin(botToken, i.channelId);
    } catch (err) {
      return refusedBySlack(err, 'join', JOIN_REFUSALS);
    }
  }

  const wrote = {
    installId,
    channelId: i.channelId,
    agentId: i.agentId,
    connectedByUserId: i.actorUserId,
    channelName: info.name,
  };
  const outcome = await d.channels.upsert(wrote);
  if (outcome === 'taken') return refuse('channel-taken', 'bind');
  // The agent deleted while this connect ran: agents:deleted cleared its
  // channels before this row landed, so nothing else ever would. Asked again
  // now, as the person connecting; only "gone" takes the binding back. A
  // re-check that fails leaves the connect as it is: the agent was there a
  // moment ago, and an outage is not a deletion.
  let access: AgentAccess | null = null;
  try {
    access = await agentAccess(d.bus, i.ctx, i.agentId, i.actorUserId);
  } catch (err) {
    quietly(d.logger, 'warn', 'slack_channel_recheck_failed', { installId, code: logCode(err) });
  }
  if (access === 'agent-gone') {
    await d.channels.remove(installId, i.channelId, i.agentId);
    return refuse('agent-gone', 'recheck');
  }
  // Read back, so a reconnect answers with the memory switch it kept. A
  // disconnect landing between the two leaves nothing to read: the answer
  // is then what this connect wrote, and the next read shows it gone.
  const stored = await d.channels.get(installId, i.channelId);
  const binding: ChannelBinding =
    stored !== null && stored.agentId === i.agentId
      ? stored
      : { ...wrote, channelName: cleanChannelName(info.name), remember: true, createdAt: new Date() };
  const reconnected = outcome === 'reconnected';
  quietly(d.logger, 'info', 'slack_channel_connected', { installId, reconnected });
  return { ok: true, binding, reconnected };
}

/** A channel the picker offers: a channel, public, live, and in no other workspace. */
function connectable(c: SlackChannel): boolean {
  return c.isChannel && !c.isPrivate && !c.isArchived && !c.isExtShared && !c.isPendingExtShared;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The channels the picker offers, by name: at most CHANNEL_LIST_MAX_PAGES
 * pages of CHANNEL_LIST_PAGE_LIMIT, `truncated` when Slack had more. Only
 * what a connect could accept is listed (the same checks as connectChannel),
 * each id once, each name cleaned, each marked by who has it.
 */
export async function listAvailableChannels(d: ChannelDeps, agentId: string): Promise<AvailableChannels> {
  const ws = await workspace(d, await d.installs.current());
  if (ws === null) return noWorkspace(d);
  const { install, botToken } = ws;
  const installId = install.installId;

  const names = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < CHANNEL_LIST_MAX_PAGES; page += 1) {
    let answer: { channels: SlackChannel[]; nextCursor: string | null };
    try {
      answer = await d.api.conversationsList(botToken, {
        limit: CHANNEL_LIST_PAGE_LIMIT,
        ...(cursor !== null ? { cursor } : {}),
      });
    } catch (err) {
      if (!(err instanceof SlackApiError)) throw err;
      const reason = LIST_REFUSALS.get(err.code) ?? 'slack-error';
      quietly(d.logger, 'warn', 'slack_channel_refused', { installId, reason, stage: 'list', code: err.code });
      return reason === 'slack-error' ? { ok: false, reason, code: err.code } : { ok: false, reason };
    }
    for (const c of answer.channels) {
      if (connectable(c) && !names.has(c.id)) names.set(c.id, cleanChannelName(c.name));
    }
    cursor = answer.nextCursor;
    if (cursor === null) break;
  }

  const bound = new Map((await d.channels.listAll(installId)).map((b) => [b.channelId, b.agentId]));
  const channels = [...names].map(([channelId, name]): AvailableChannel => {
    const holder = bound.get(channelId);
    return {
      channelId,
      name,
      connected: holder === undefined ? null : holder === agentId ? 'this-agent' : 'other-agent',
    };
  });
  channels.sort((a, b) => compare(a.name, b.name) || compare(a.channelId, b.channelId));
  return { ok: true, channels, truncated: cursor !== null };
}
