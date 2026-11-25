import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { SlackChannel } from './slack-api.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * Who may manage a shared agent's Slack bot and its channels, and which
 * channel a bot may bind (TASK-1094, TASK-1167). The shared app connects no
 * channel (TASK-1186; design §4b.1): a shared agent is reached in a channel
 * only through its own bot.
 *
 * A shared agent is a team agent, or a personal agent shared with other
 * people (TASK-1248): its agents:resolve answer says `visibility: 'personal'`
 * and `shared: true`, exactly. A missing or non-boolean `shared` is a "Just
 * me" agent, and `audience` is never read (TASK-1246: `shared` is the one
 * answer). Team agents keep their own rule, below.
 *
 * Rights come from @ax/agents, never from here (invariant 4):
 *   - seeing an agent is `agents:resolve` for the person. Someone it refuses
 *     learns nothing: "not yours" and "doesn't exist" are one answer;
 *   - managing its bot and the bot's channels: on a team agent,
 *     `agents:can-set-shared-credential`, a team admin of the agent's team,
 *     always asked as a non-admin; on a shared personal agent, one of its
 *     owners (`isOwner` in the same resolve answer, no second question: that
 *     hook says no to every personal agent). A bot channel's outsiders run
 *     as the bot's requester (a Claim moves it), the same decision as
 *     choosing whose sign-in a team agent uses (TASK-813);
 *   - only a shared agent can have a bot, and so channels. A Just-me
 *     personal agent is refused before anything else is asked.
 *
 * A channel a bot may bind is a live channel of the install's own workspace,
 * public or private: not archived, not Slack Connect (`connectable`). A
 * private one is answered in (TASK-1188) and remembered like any other
 * (TASK-1203, design §4c).
 * Slack's answers are untrusted (slack-api.ts narrows them, and its refusing
 * flags fail closed). A channel can change after it is bound, so the router
 * asks Slack again when each turn starts (channel-check.ts, TASK-1184).
 */

/** What `agents:resolve` says about one person and one agent. `not-shared`: a Just-me personal agent. */
export type AgentAccess = 'yes' | 'no' | 'agent-gone' | 'not-shared';

/** `personal-agent`: a Just-me personal agent, which has no bot (the wire name predates sharing). */
export type Rights =
  | { ok: true; agentId: string; agentName: string }
  | { ok: false; reason: 'not-found' | 'personal-agent' | 'forbidden' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A service's own refusal code: the bus hands a PluginError back as it was thrown. */
function pluginCode(err: unknown): string | undefined {
  return err instanceof PluginError ? err.code : undefined;
}

// ── Rights ──────────────────────────────────────────────────────────────────

/**
 * What `agents:resolve` said, read for a bot. `kind` is which rule manages a
 * shared agent: a team agent's team admins, or a shared personal agent's
 * owners, `isOwner` being whether the person asked about is one.
 */
type Resolved =
  | { access: 'yes'; agentName: string; kind: 'team' }
  | { access: 'yes'; agentName: string; kind: 'personal'; isOwner: boolean }
  | { access: 'no' }
  | { access: 'agent-gone' }
  | { access: 'not-shared' };

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
  // Only an answer about THIS agent counts.
  if (!isRecord(agent) || agent['id'] !== agentId) return { access: 'not-shared' };
  const name = agent['displayName'];
  const agentName = typeof name === 'string' ? name : '';
  // A team agent: an answer that plainly says "team".
  if (agent['visibility'] === 'team') return { access: 'yes', agentName, kind: 'team' };
  // A personal agent shared with other people: `shared` exactly true (TASK-1248). Anything else is Just me.
  if (agent['visibility'] === 'personal' && agent['shared'] === true) {
    return { access: 'yes', agentName, kind: 'personal', isOwner: agent['isOwner'] === true };
  }
  return { access: 'not-shared' };
}

/**
 * `agents:resolve` for one person: forbidden → 'no', not-found → 'agent-gone',
 * resolved but neither a team agent nor a personal agent shared with other
 * people (or an answer about another agent) → 'not-shared'. Other errors
 * propagate: an outage is not a refusal.
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
 * A team agent's manage question, for a team agent `userId` can already
 * see: is `agents:can-set-shared-credential` an explicit yes? That is a team
 * admin of the agent's team. Always asked as a non-admin: workspace-admin
 * status never manages a team agent's bot (TASK-813's rule). Not-found →
 * 'agent-gone' (deleted since it was resolved); other errors propagate.
 */
async function adminOfTeam(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
): Promise<'yes' | 'no' | 'agent-gone'> {
  let out: unknown;
  try {
    out = await bus.call<{ agentId: string; actor: { userId: string; isAdmin: false } }, unknown>(
      'agents:can-set-shared-credential',
      ctx,
      { agentId, actor: { userId, isAdmin: false } },
    );
  } catch (err) {
    if (pluginCode(err) === 'not-found') return 'agent-gone';
    throw err;
  }
  return isRecord(out) && out['allowed'] === true ? 'yes' : 'no';
}

/**
 * The manage question for a shared agent `userId` can already see, by its
 * kind: a team agent's is `adminOfTeam`, unchanged; a shared personal
 * agent's is whether they are one of its owners, read from the same resolve
 * answer with no second call (TASK-1248). Never the team question for a
 * personal agent, whose answer is always no there.
 */
async function mayManage(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
  seen: Extract<Resolved, { access: 'yes' }>,
): Promise<'yes' | 'no' | 'agent-gone'> {
  if (seen.kind === 'team') return adminOfTeam(bus, ctx, agentId, userId);
  return seen.isOwner ? 'yes' : 'no';
}

/**
 * agentAccess, narrowed to someone who manages the agent: a team admin of a
 * team agent's team (asked with `isAdmin: false`), or an owner of a shared
 * personal agent (TASK-1248). Anyone else who can use it is 'no', and so is
 * anyone `agents:resolve` refuses, a deleted account included; not-found →
 * 'agent-gone'; a Just-me personal agent → 'not-shared'. Other errors
 * propagate. It is whom an agent's own bot (TASK-1167) runs its outsiders
 * as: its requester, only while this answers 'yes'. Asked afresh every time:
 * nothing here is kept.
 */
export async function managerAccess(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
): Promise<AgentAccess> {
  const seen = await resolveFor(bus, ctx, agentId, userId);
  if (seen.access !== 'yes') return seen.access;
  return mayManage(bus, ctx, agentId, userId, seen);
}

/**
 * May `userId` see (`view`) or manage (`manage`) the agent's Slack bot and
 * its channels? Someone who can't see the agent gets `not-found` whether or
 * not it exists; a Just-me personal agent is `personal-agent`; someone who
 * can use a shared agent but doesn't manage it (`mayManage`) is `forbidden`
 * to manage. Other errors propagate.
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
  if (seen.access === 'not-shared') return { ok: false, reason: 'personal-agent' };
  if (need === 'manage') {
    const manager = await mayManage(bus, ctx, agentId, userId, seen);
    // Deleted between the two questions.
    if (manager === 'agent-gone') return { ok: false, reason: 'not-found' };
    if (manager === 'no') return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, agentId, agentName: seen.agentName };
}

// ── The agent's own bot ─────────────────────────────────────────────────────

/**
 * The agent's own bot (TASK-1167) once its Allow is done (status `active`),
 * else null: none, or one still pending, is not live. A store failure
 * propagates, so a caller that can't tell fails closed instead of reading
 * it as "no bot".
 */
export async function liveOwnBot(
  installs: Pick<InstallStore, 'botForAgent'>,
  agentId: string,
): Promise<InstallRow | null> {
  const bot = await installs.botForAgent(agentId);
  return bot !== null && bot.status === 'active' ? bot : null;
}

// ── Channels ────────────────────────────────────────────────────────────────

/**
 * A channel a shared agent's own bot may bind at its first mention there
 * (router.ts, TASK-1167): a channel, live, and in no other workspace. Also
 * what every channel turn is checked against before it runs
 * (channel-check.ts, TASK-1184), so the two can't disagree.
 *
 * Public or private (TASK-1188): a bot answers in a private channel it was
 * invited to, and memory learns from it like any other channel (TASK-1203,
 * design §4c: a shared agent's memory is shared with anyone who talks to
 * it). Inviting the bot is a member's own act. Slack Connect and archived
 * stay refused, and so does anything Slack doesn't call a channel (a group
 * DM; a private group from before March 2021, which Slack still describes
 * with `is_channel` false).
 */
export function connectable(c: SlackChannel): boolean {
  return c.isChannel && !c.isArchived && !c.isExtShared && !c.isPendingExtShared;
}
