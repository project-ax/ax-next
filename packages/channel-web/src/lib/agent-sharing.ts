/**
 * TASK-1247 — the pure half of the sharing settings: the draft the picker
 * edits, the comparisons that decide which confirmations to show, and who may
 * manage or delete an agent. No I/O (the calls live in `agent-sharing-api.ts`).
 *
 * The wire types come from `@ax/agents`, type-only, so they can't drift from
 * the server's.
 */
import type { AgentAudience, PersonView, SharingView } from '@ax/agents';
import type { AdminAgent } from './admin';
import type { AgentAccess } from './workspace-types';

/** The most people one "specific people" audience names. Mirrors
 *  `AUDIENCE_MEMBERS_MAX` in `packages/agents/src/sharing/service.ts:41`. It's
 *  a runtime value, so it can't be imported from there. */
export const AUDIENCE_MEMBERS_MAX = 50;
/** The most owners one agent has, its creator included. Mirrors `OWNERS_MAX` in
 *  `packages/agents/src/sharing/service.ts:43`. */
export const OWNERS_MAX = 10;

/** What the picker edits: the audience with names, so the list can show them. */
export type DraftAudience =
  | { kind: 'just-me' }
  | { kind: 'everyone' }
  | { kind: 'list'; members: PersonView[] };

/** The draft for the audience the server last said. */
export function draftFrom(view: SharingView['audience']): DraftAudience {
  if (view.kind !== 'list') return { kind: view.kind };
  return {
    kind: 'list',
    members: view.members.map((m) => ({ id: m.id, displayName: m.displayName })),
  };
}

/** The write body for a draft. An empty list is "Just me": the server refuses
 *  an empty `list`, and nobody listed means nobody else can use it. */
export function toAudienceBody(d: DraftAudience): AgentAudience {
  if (d.kind !== 'list') return { kind: d.kind };
  if (d.members.length === 0) return { kind: 'just-me' };
  return { kind: 'list', members: d.members.map((m) => ({ type: 'user', id: m.id })) };
}

function ids(d: DraftAudience): Set<string> {
  return new Set(d.kind === 'list' ? d.members.map((m) => m.id) : []);
}

/** Is it the same audience? List membership is compared as a set of ids. */
export function sameAudience(a: DraftAudience, b: DraftAudience): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'list' || b.kind !== 'list') return true;
  const x = ids(a);
  const y = ids(b);
  if (x.size !== y.size) return false;
  for (const id of x) if (!y.has(id)) return false;
  return true;
}

/** Does the change let someone use the agent who couldn't before? */
export function isWidening(from: DraftAudience, to: DraftAudience): boolean {
  if (to.kind === 'just-me') return false;
  if (from.kind === 'everyone') return false;
  if (to.kind === 'everyone') return true;
  if (from.kind === 'just-me') return true;
  const had = ids(from);
  return to.members.some((m) => !had.has(m.id));
}

/** Does the change take the agent away from someone who had it? */
export function isNarrowing(from: DraftAudience, to: DraftAudience): boolean {
  if (from.kind === 'just-me') return false;
  if (to.kind === 'just-me') return true;
  if (from.kind === 'everyone') return to.kind === 'list';
  if (to.kind !== 'list') return false;
  const keep = ids(to);
  return from.members.some((m) => !keep.has(m.id));
}

/** The people a change adds to a list (all of them when it starts from
 *  Just me). Empty when the new audience isn't a list. */
export function addedPeople(from: DraftAudience, to: DraftAudience): PersonView[] {
  if (to.kind !== 'list') return [];
  const had = ids(from);
  return to.members.filter((m) => !had.has(m.id));
}

/** The agents "Same people as…" offers: your other shared personal agents. */
export function sharedAgentChoices(agents: AdminAgent[], currentId: string): AdminAgent[] {
  return agents.filter(
    (a) =>
      a.visibility === 'personal' && a.isOwner === true && a.shared === true && a.id !== currentId,
  );
}

/** Settings, for everyone but a person the agent is only shared with. A
 *  missing `access` reads as the reader's own agent. */
export function canManageAgent(a: { access?: AgentAccess }): boolean {
  return a.access !== 'audience';
}

/** Delete, for the creator and for a team agent's reader; not co-owners. */
export function canDeleteAgent(a: { access?: AgentAccess }): boolean {
  return a.access === undefined || a.access === 'creator' || a.access === 'team';
}
