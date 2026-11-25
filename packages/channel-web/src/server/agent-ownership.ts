/**
 * TASK-1246 / TASK-1247 — who may change a personal agent here, which agents
 * a list shows, and how the caller stands with each one.
 *
 * `agents:resolve` used to admit a personal agent's owner and nobody else, so
 * channel-web read "resolved, and personal" as "owner". Since sharing it also
 * admits the people a personal agent is shared with (its audience), and its
 * answer says which one the caller is: `isOwner`. `agents:list-for-user` lists
 * the agents shared with the caller too, with the same field. These helpers
 * are how channel-web reads that answer.
 *
 * They read `visibility`, `isOwner` and `ownerId` structurally, as `unknown`:
 * the answer crossed the bus from another plugin (I2, no `@ax/agents` import),
 * so its TypeScript type describes the wire, not a guarantee.
 */
import type { AgentAccess } from '../lib/workspace-types.js';

/** What the helpers read off an `agents:resolve` / `agents:list-for-user` answer. */
interface OwnershipFields {
  visibility?: unknown;
  isOwner?: unknown;
}

/** `agentAccess` also reads who created the agent. */
interface AccessFields extends OwnershipFields {
  ownerId?: unknown;
}

/**
 * Is the caller one of this personal agent's owners (its creator or a
 * co-owner)? True only when the answer says both `visibility: 'personal'` and
 * `isOwner: true`. A missing `isOwner`, any other value, and a team agent are
 * all `false`.
 *
 * Strict, because it guards writes: a settings write on a personal agent is
 * for its owners, never for someone it is only shared with, and an answer that
 * doesn't say is never taken as an owner's.
 */
export function ownsPersonalAgent(agent: OwnershipFields): boolean {
  return agent.visibility === 'personal' && agent.isOwner === true;
}

/**
 * The rule for every list of agents the caller MANAGES: their own (created or
 * co-owned) and their teams'. A personal agent that is only shared with them
 * is not one of those, so it goes: a row goes only when it says
 * `isOwner: false` and isn't a team agent. Order and rows are kept as given;
 * the input is not changed.
 *
 * This is permanent, not a stopgap (TASK-1247). Its readers:
 *   - `GET /api/chat/agents` (routes-chat.ts), whose client readers all take
 *     "listed and personal" as "mine": the onboarding gate's count, Sites,
 *     Skills' install target, Routines and self-improvement;
 *   - `listAgents` in routes-workspace.ts, behind `POST /api/workspace/route`
 *     (a structural pick must never spend someone else's agent),
 *     `GET /api/workspace/tasks` and `GET /api/workspace/tasks/agents`
 *     (routines are their creator's).
 * The one list that shows agents shared with the caller is the workspace
 * roster (`GET /api/workspace/state`), and each of its rows says how the
 * caller stands with it ({@link agentAccess}). Its `audience` rows are exactly
 * the rows this drops.
 *
 * Lenient, because it shapes lists: a row with no `isOwner` at all (a producer
 * from before sharing) reads as owned, as it always did. Nothing is unlocked
 * by being listed: every write asks again, strictly.
 */
export function hideAgentsSharedWithMe<T extends OwnershipFields>(agents: readonly T[]): T[] {
  return agents.filter((agent) => agent.visibility === 'team' || agent.isOwner !== false);
}

/**
 * How `userId` stands with an agent, from an `agents:resolve` or
 * `agents:list-for-user` answer asked about them. In order:
 *
 *   1. `visibility: 'team'` → `team`, whatever else the answer says (a team
 *      agent's `ownerId` is the team's, never a person's);
 *   2. `isOwner: false` → `audience`: the agent is only shared with them;
 *   3. otherwise they own it (`isOwner: true`, or no `isOwner` at all from a
 *      producer older than sharing): `creator` when `ownerId` is theirs or
 *      absent, `co-owner` when it names someone else.
 *
 * Lenient like {@link hideAgentsSharedWithMe}, and for the same reason: it
 * labels rows, it never authorizes anything. The client uses it to decide what
 * to offer (Settings unless `audience`; Delete only for `creator` or `team`),
 * and the server checks every write again, strictly. Rule 2 is the same test
 * that list filter drops a row on, so the two can never disagree about which
 * agents are only shared with the caller.
 */
export function agentAccess(agent: AccessFields, userId: string): AgentAccess {
  if (agent.visibility === 'team') return 'team';
  if (agent.isOwner === false) return 'audience';
  return agent.ownerId === undefined || agent.ownerId === userId ? 'creator' : 'co-owner';
}
