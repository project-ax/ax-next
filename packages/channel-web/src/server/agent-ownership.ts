/**
 * TASK-1246 — who may change a personal agent here, and which agents a list
 * shows.
 *
 * `agents:resolve` used to admit a personal agent's owner and nobody else, so
 * channel-web read "resolved, and personal" as "owner". Since sharing it also
 * admits the people a personal agent is shared with (its audience), and its
 * answer says which one the caller is: `isOwner`. `agents:list-for-user` now
 * lists the agents shared with the caller too, with the same field. These two
 * helpers are how channel-web reads that answer.
 *
 * Both read `visibility` and `isOwner` structurally, as `unknown`: the answer
 * crossed the bus from another plugin (I2, no `@ax/agents` import), so its
 * TypeScript type describes the wire, not a guarantee.
 */

/** What either helper reads off an `agents:resolve` / `agents:list-for-user` answer. */
interface OwnershipFields {
  visibility?: unknown;
  isOwner?: unknown;
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
 * The agents a list shows until the UI can tell "mine" from "shared with me"
 * (card B): the caller's own and their teams'. A row goes only when it says
 * `isOwner: false` and isn't a team agent, which is a personal agent shared
 * with the caller. Order and rows are kept as given; the input is not changed.
 *
 * Lenient, because it shapes lists: a row with no `isOwner` at all (a producer
 * from before sharing) reads as owned, as it always did. Every client reader
 * of these lists takes "listed and personal" as "mine" (the onboarding gate,
 * Sites, Skills, Routines), so a shared agent must not appear in them yet.
 * Nothing is unlocked by being listed: every write asks again, strictly.
 */
export function hideAgentsSharedWithMe<T extends OwnershipFields>(agents: readonly T[]): T[] {
  return agents.filter((agent) => agent.visibility === 'team' || agent.isOwner !== false);
}
