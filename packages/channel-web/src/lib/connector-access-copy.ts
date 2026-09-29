/**
 * What a person is told at the moment they give an assistant access to a service
 * (TASK-700 — the launch disclosure for TASK-328).
 *
 * WHY THIS EXISTS. A connector's tools run without a per-call approval: the
 * policy table has no rule for them and "no rule matching is `allow`"
 * (`tool-policy/src/evaluate.ts`, the TASK-263 note). Vinay chose "accept and
 * disclose" for launch, so at every place a key, a sign-in or an attachment
 * hands an agent that reach, we say so plainly. This file is that sentence,
 * owned in one place — the same shape as `lib/grant-copy.ts`, for the same
 * reason: five surfaces show it, and five hand-typed copies of security text
 * are five chances to drift into saying different things.
 *
 * WHAT IS TRUE, AND WHAT THIS FILE IS CAREFUL NOT TO CLAIM.
 *   - "the same access the key has" — the credential proxy substitutes the
 *     stored key on requests to the connector's bound hosts, and the agent acts
 *     with it. Whatever the key can do, the agent can do.
 *   - "without asking you each time" — true today. It is the thing TASK-328
 *     would change, and the day it does this sentence must change with it.
 *   - "could trick it" — anything the agent reads (a page, a file) is untrusted
 *     text that reaches the same model that holds the access.
 *   - NOT claimed: that the agent can or cannot see the key (`KEY_SAFETY` says
 *     its piece next to the field; this does not repeat or contradict it), that
 *     actions are logged, that they can be undone, or that anything is limited
 *     beyond what the key itself allows. If a protection ships, add it then.
 *
 * FOUR KINDS, ONE SHAPE. They differ only where the moment differs:
 *   key      — a person is typing or saving an API key.
 *   sign-in  — a person is about to sign in to the service (no key to narrow,
 *              so the last sentence does not tell them to choose a narrower one).
 *   attach   — a person is choosing which connectors an agent gets.
 *   author   — a person is defining a connector; no key exists yet, so it says
 *              what will be true once one is added rather than "your key".
 *
 * NO JOKES IN THIS FILE. CLAUDE.md › Voice & Tone: when the subject is real
 * security, drop the humour and be direct. Also no "MCP", "scope" or "token" —
 * the card retired them from visible text, and `connector-access-copy.test.ts`
 * holds the line. Curly apostrophes, like `grant-copy.ts`: these render beside
 * strings that use them.
 */

export const CONNECTOR_ACCESS_KINDS = ['key', 'sign-in', 'attach', 'author'] as const;
export type ConnectorAccessNoticeKind = (typeof CONNECTOR_ACCESS_KINDS)[number];

export interface ConnectorAccessCopy {
  /** The point, in one sentence: what is being handed over. Shown emphasised. */
  headline: string;
  /** The risk and the advice. Shown as ordinary text under the headline. */
  details: string;
}

/** The risk, identical everywhere: it is a fact about the assistant, not about the surface. */
const RISK =
  'Something it reads, like a web page or a file, could trick it into using that access in a way you didn’t intend.';

const HEADLINE: Record<ConnectorAccessNoticeKind, string> = {
  key: 'Your assistant gets the same access the key has, and can read or change things in this service without asking you each time.',
  'sign-in':
    'Your assistant gets the access this sign-in allows, and can read or change things in this service without asking you each time.',
  attach:
    'Attaching a connector gives this agent the same access its key or sign-in has, and it can read or change things in that service without asking you each time.',
  author:
    'Any key added for this connector gives the assistant the same access the key has, and it can read or change things in this service without asking each time.',
};

const ADVICE: Record<ConnectorAccessNoticeKind, string> = {
  key: 'Only add a key you’d be comfortable handing to an assistant, and choose one with the fewest permissions the service offers.',
  'sign-in': 'Only connect an account you’d be comfortable handing to an assistant.',
  attach:
    'Only attach a connector whose key you’d be comfortable handing to an assistant, and prefer keys with the fewest permissions the service offers.',
  author:
    'Only add a key you’d be comfortable handing to an assistant, and prefer ones with the fewest permissions the service offers.',
};

export function connectorAccessCopy(kind: ConnectorAccessNoticeKind): ConnectorAccessCopy {
  return { headline: HEADLINE[kind], details: `${RISK} ${ADVICE[kind]}` };
}
