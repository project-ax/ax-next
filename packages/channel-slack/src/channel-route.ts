import type { AgentAccess } from './channels.js';

/**
 * Who a mention in a connected channel runs as (TASK-1094; the plan's sender
 * tiers). Pure: the router (router.ts) gathers the facts from admission and
 * AX, never from the message, and this decides.
 *
 *   tier  sender                                       turn
 *   A     an AX user who can use the agent             attended, as themselves
 *   B     an AX user who can't                         external, as the connector
 *   C     no AX account, email on an approved domain   external, as the connector
 *   D     no AX account, any other email               refused: silence
 *   E     B or C while the connector can't use the     unavailable: a private line,
 *         agent anymore; or anyone, when the agent       no turn
 *         is gone or isn't a team agent
 *
 * Guests, bots, other workspaces, unconfirmed emails and Slack Connect never
 * get here: admission refuses them first (admission.ts).
 *
 * The connector is the person who connected the channel. An outsider's turn
 * runs as them, so they must still be able to use the agent: someone who left
 * the agent's team must not keep lending the channel their identity. A member
 * (A) runs as themselves and never depends on the connector.
 *
 * Every answer is matched exactly and fails closed: only `'yes'` attends,
 * only a mapped sender's `'no'` or an unmapped sender's literal `true` runs
 * as the connector, only the connector's `'yes'` lets them, and an empty
 * user id is nobody. Anything else is no turn.
 */

/**
 * What admission and AX said about the sender. `mappedUserId`: the AX account
 * their users.info email maps to, or null. `access`: `agents:resolve` for
 * that account and the channel's agent (null when unmapped). `approved`:
 * `auth:is-approved-email` for their email (null when mapped: an AX account
 * passed the same domain rule at sign-in).
 */
export interface SenderFacts {
  mappedUserId: string | null;
  access: AgentAccess | null;
  approved: boolean | null;
}

export type SenderTier =
  | { tier: 'attended'; userId: string }
  | { tier: 'external'; userId: string /* the connector */ }
  | { tier: 'refused'; reason: 'off-domain' }
  | { tier: 'unavailable'; reason: 'connector-no-access' | 'agent-gone' | 'not-team-agent' };

/** A user id that names someone: a non-empty string. */
function isUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Tiers B and C: an admitted member whose turn would run as the connector.
 * The router asks about the connector only then; `decideTier` uses this same
 * rule, so the two can't disagree.
 */
export function runsAsConnector(sender: SenderFacts): boolean {
  return isUserId(sender.mappedUserId) ? sender.access === 'no' : sender.approved === true;
}

export function decideTier(i: {
  sender: SenderFacts;
  /** `access` is null when it wasn't asked: the router asks only when `runsAsConnector`. */
  connector: { userId: string; access: AgentAccess | null };
}): SenderTier {
  const { sender, connector } = i;
  if (isUserId(sender.mappedUserId)) {
    if (sender.access === 'yes') return { tier: 'attended', userId: sender.mappedUserId };
    // The sender's own lookup says the channel's agent is gone, or isn't a
    // team agent: nobody can be served here, members included.
    if (sender.access === 'agent-gone') return { tier: 'unavailable', reason: 'agent-gone' };
    if (sender.access === 'not-team') return { tier: 'unavailable', reason: 'not-team-agent' };
  }
  // Off every approved domain (or an answer we can't read): silence, and
  // nothing said about the channel's connection.
  if (!runsAsConnector(sender)) return { tier: 'refused', reason: 'off-domain' };
  if (connector.access === 'agent-gone') return { tier: 'unavailable', reason: 'agent-gone' };
  if (connector.access === 'not-team') return { tier: 'unavailable', reason: 'not-team-agent' };
  // Never run as someone whose access nobody checked, or as nobody at all.
  if (connector.access !== 'yes' || !isUserId(connector.userId)) {
    return { tier: 'unavailable', reason: 'connector-no-access' };
  }
  return { tier: 'external', userId: connector.userId };
}
