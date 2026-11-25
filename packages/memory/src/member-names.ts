/**
 * Members' display names, for labelling memory on an agent whose memory is
 * shared: a team agent (TASK-1209), or a personal agent shared with other
 * people (TASK-1248). Its "members" are the people who can use it.
 *
 * Such an agent files each member's facts under the member's own key,
 * `user:<their id>` (TASK-1204, `subject.ts`). Shown to anyone but that
 * member, the key reads as the member's display name, or {@link TEAMMATE_TEXT}
 * when memory has no name to show. Never the raw id: it is an internal
 * identifier, it costs a model tokens, and a model may repeat it.
 *
 * Names label `memory:recall`'s `aboutText` (the memory view, the evidence
 * table, receipts), the injected block's Recent and Digest, and the `/memory`
 * export's team Profile headings, user-journal headings and Recent lines
 * (TASK-1213). The export is one file per agent, read by every session that
 * mounts it. So it is labelled by the export pass's own ctx, with no `self`:
 * nobody in it reads `you`, and the caller's name isn't counted.
 *
 * ## Where a name comes from
 *
 * `auth:get-user`, which other plugins already ask to name a user by id. It
 * is declared in `@ax/memory`'s `optionalCalls`, so the capability shows in
 * the manifest (invariant 5). Only `displayName` is read. The answer also
 * carries the account's email and whether it is an admin, and neither leaves
 * this file: not as a fallback name, not in a log line. An answer counts only
 * when it is an object about the account asked for (its `id` is the id asked
 * about), so a provider that answers for another account can't put that
 * account's name on a fact.
 *
 * ## Who is told names
 *
 * Only turns whose recall reads everything, on an agent whose memory is
 * shared: a member's, a member's routine, and an outsider's (TASK-1209:
 * outsiders recall what members do). That is `recallAudienceScope`'s own
 * rule, so names can't drift from recall. A "Just me" personal agent has no
 * teammates and asks nobody. A turn on a shared agent from a source this
 * build doesn't know reads shared rows only (it fails closed), and it is told
 * no names either: its members read "a teammate", with no lookup. ("Doesn't
 * know" means `'unrecognized'`, a stored session source the session store and
 * IPC couldn't place (TASK-1213), or a context a host built with a source
 * outside the type. See `recallAudienceScope` step 2.) An export pass goes by
 * the turn that scheduled it, so a pass from such a turn writes "a teammate"
 * for everyone, until the next pass from a turn that is told names.
 *
 * ## Whose names
 *
 * Only someone who takes part in the agent NOW (TASK-1209's security review,
 * and TASK-1248's). A subject is model output shaped by chat, so a stored
 * `user:<id>` can name any account at all, and `auth:get-user` answers for
 * any account. So memory first proves the id is a member, and asks
 * `auth:get-user` only about an id it proved. The agent's access
 * (`MemoryAccess`) says which proof:
 *
 * - A team agent (`teamId`): `teams:is-member` about the agent's team, the
 *   same source `@ax/agents` decides team access with. Proven only by an
 *   answer of exactly `member: true`.
 * - A personal agent shared with other people (`memberCheck: 'agent'`,
 *   TASK-1248; it has no team): `agents:resolve` about this agent
 *   (`ctx.agentId`) must admit the id now (`@ax/agents`' one "can use it"
 *   rule, the one every memory read passes; only an answer about this agent
 *   counts), AND the id must take part in the agent. That is one of:
 *   - one of its owners: the answer says exactly `isOwner: true`;
 *   - someone its list names: the answer says `audience: 'list'`. On a list,
 *     `@ax/agents` admits only an owner or someone a member row names
 *     (`checkAccess`), so there, admission means an owner named them;
 *   - someone who owns a row in THIS agent's memory: they spoke to it. One
 *     `memory:facts:recall` on this agent's store (its tenant is
 *     `ctx.agentId`), scoped to their id (`ownerUserId`), closed rows
 *     included, one row at most. Every row is stamped with the user of the
 *     turn that wrote it, never with the subject it names and never from a
 *     payload (`owner.ts`). So a crafted `user:<id>` row is its writer's, and
 *     proves nothing about that id.
 *
 *   Admission alone is no proof. On an `everyone` agent it is every AX
 *   account, so it would name anyone a crafted subject points at: the hole
 *   TASK-1209 closed for team agents. Such a person reads "a teammate" until
 *   they speak to the agent. The one exception is the caller's own key, which
 *   is never shown, only counted ({@link memberLabels}): the person talking
 *   takes part by talking, so admission proves it. A refusal (`forbidden`, or
 *   `not-found` for an agent that is gone) is an answer, not a fault: that id
 *   is no member.
 *
 *   `audience` is read here although TASK-1246 says to ask `shared`, never
 *   `audience`. That rule is about whether an agent is shared, which the
 *   access already settled. Here `audience === 'list'` answers a narrower
 *   question: was this person's admission someone naming them on the agent?
 *   Only a list's is. Any other value, or none, falls to the row check, the
 *   narrower proof.
 *
 * Anything else fails closed for that id, with no `auth:get-user` call: a
 * non-member, a former member, someone an `everyone` agent admits who never
 * spoke to it, an answer this can't read, a throw, an access with neither
 * proof, and no service to prove it with (a store included). Each id is its
 * own question: `@ax/teams` throws on an id it can't hold (over 256
 * characters), and one such stored subject mustn't blank every name in an
 * answer. Nothing is cached: each call asks again, so someone removed from a
 * team, or an agent taken back to Just me, names nobody it no longer admits
 * from the next read on.
 *
 * ## A name is untrusted text
 *
 * A member can rename themself to anything, at any length. So a name is
 * cleaned with core's surface-text helpers (the composition channel-slack's
 * `cleanLabel` uses: no control, bidi or zero-width characters, no lone
 * surrogate, one line, single spaces), clamped, and refused when it has no
 * letter or digit, or when it would read as the person talking (`you` in the
 * block and the memory view, where `aboutText === 'you'` is the self
 * sentinel; `user` in the evidence table), as the agent (its kind, such as
 * "Assistant", or its own display name, `MemoryAccess.agentName`), or as
 * {@link TEAMMATE_TEXT}, which would pass for a member memory can't name
 * (TASK-1213). Every sink still escapes it (`escapeStatementText`).
 *
 * ## It never fails a read, and never holds one up
 *
 * A name is cosmetic. No service, no account, an answer this can't read, a
 * refused name or a throw: that member reads "a teammate", and the recall,
 * the block or the export answers anyway. A throw is logged once per call, by
 * its codes (`faultLogFields`), never with an id, a name or an email.
 * `agents:resolve`'s refusal is an answer, not a throw, and is never logged.
 *
 * The lookups of one call race one deadline, {@link MEMBER_NAMES_DEADLINE_MS}
 * (TASK-1213). A round that isn't done by then names nobody, not even a
 * member whose name already came back: a name can only be shown once every
 * name it might collide with is in. An answer that lands later changes
 * nothing already returned.
 */

import {
  clampCodeUnits,
  faultLogFields,
  PluginError,
  toWellFormedText,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { replaceSurfaceRewriters } from '@ax/core/surface-text';

import { AGENTS_RESOLVE_HOOK, type MemoryAccess } from './access.js';
import { isPersonSubject, nameWords, recallAudienceScope, recallFacts } from './audience.js';
import { PLUGIN_NAME } from './plugin-name.js';
import { isAgentSubject } from './self-report.js';
import { SPEAKER_SUBJECT } from './subject.js';

/** The hook that names an account by id (`@ax/auth-better`). */
export const AUTH_GET_USER_HOOK = 'auth:get-user';

/** The hook that says whether an account is a current member of a team (`@ax/teams`). */
export const TEAMS_IS_MEMBER_HOOK = 'teams:is-member';

/**
 * The facts engine's read: plugin.ts's `FACTS_RECALL_HOOK`, one of
 * `@ax/memory`'s hard `calls`. Spelled here because plugin.ts imports this
 * file, and importing it back would be a cycle.
 */
const FACTS_RECALL_HOOK = 'memory:facts:recall';

/** What another member's key reads as when memory has no name to show. */
export const TEAMMATE_TEXT = 'a teammate';

/**
 * Logged once per {@link memberLabels} call in which a lookup threw, or whose
 * lookups passed the deadline. Bindings are `agentId`, `hook` and the error's
 * codes (`faultLogFields`) only: an error's message may quote the id, the name
 * or the email. For a throw, `hook` is the lookup that threw, for the first
 * id, in the order asked, whose lookup threw. For the deadline, the code is
 * `timeout`, and `hook` is the earliest step any id is still waiting on, in
 * the order they are asked: the membership check's (`teams:is-member` on a
 * team agent; `agents:resolve`, then `memory:facts:recall`, on a shared
 * personal agent), then `auth:get-user`. A throw in the same round isn't
 * logged as well.
 */
export const MEMBER_NAMES_FAILED_EVENT = 'memory_member_names_failed';

/**
 * How long one {@link memberLabels} call waits for all of its lookups, in
 * milliseconds. Primary-key reads take milliseconds. This keeps a stalled one
 * from costing a turn more than 2 s, and from running a memory block into its
 * own 15 s deadline, past which the whole block is dropped.
 */
export const MEMBER_NAMES_DEADLINE_MS = 2_000;

/** The longest name shown, in UTF-16 code units (channel-slack's sender-name cap). */
export const MEMBER_NAME_MAX = 80;

/**
 * Whole names, as {@link nameWords} reads them, that memory never shows for a
 * member: what its surfaces call the person talking (`you`, and the evidence
 * table's `user`), the agent's own voice in the block ("I also hold memory
 * about"), and the fallback itself, "a teammate" (TASK-1213).
 * `isPersonSubject` and `isAgentSubject` answer the rest, and the agent's own
 * name is checked per agent ({@link memberName}).
 */
const RESERVED_NAMES = new Set([
  'you',
  'yourself',
  'user',
  'the user',
  'i',
  'me',
  'myself',
  nameWords(TEAMMATE_TEXT).join(' '),
]);

/** `user:<id>` with a non-empty id → `<id>`; anything else (`user`, `user:`, `User:x`, `acme`) → undefined. */
export function memberKeyId(about: string): string | undefined {
  const prefix = `${SPEAKER_SUBJECT}:`;
  return about.startsWith(prefix) && about.length > prefix.length ? about.slice(prefix.length) : undefined;
}

/**
 * A display name fit to show for a member, or undefined: not a string, no
 * letter or digit left once cleaned, or a name that reads as the person
 * talking, as the agent (its kind, or `agentName`, its own display name), or
 * as {@link TEAMMATE_TEXT}.
 *
 * The reserved check compares the whole name, word by word ({@link nameWords}:
 * fullwidth forms folded, invisible format characters and accents dropped,
 * case folded, punctuation a separator). So `You.`, fullwidth `you`, `you`
 * with a soft hyphen inside and `Yoü` are all `you`, `fern.` and fullwidth
 * `ＦＥＲＮ` are an agent named `Fern`, and `A-Teammate.` is the fallback,
 * while `You Li`, `Agent Smith`, `Fern Li` and `Teammate Tina` are names.
 */
export function memberName(raw: unknown, agentName?: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = asShown(raw);
  const words = nameWords(name);
  // Nothing to read it by: blank, or only an emoji, punctuation, or a
  // character that draws nothing and isn't in core's class (a soft hyphen).
  if (words.length === 0) return undefined;
  const key = words.join(' ');
  if (isPersonSubject(name) || RESERVED_NAMES.has(key) || isAgentSubject(words.join('_'))) {
    return undefined;
  }
  if (agentName !== undefined && readsAsAgentName(key, agentName)) return undefined;
  return name;
}

/** A display name as memory shows it: cleaned onto one line, then clamped (see the file header). */
function asShown(raw: string): string {
  const flat = toWellFormedText(replaceSurfaceRewriters(raw)).replace(/\s+/g, ' ').trim();
  return clampCodeUnits(flat, MEMBER_NAME_MAX).trimEnd();
}

/**
 * Whether a name's words (`key`, from {@link memberName}) are the agent's own
 * name's. The agent's name is compared as written, so an invisible character
 * in it hides nothing ({@link nameWords} drops it), and as memory would show
 * it for a member: an agent's name may run past {@link MEMBER_NAME_MAX}, and a
 * member who copies it is shown cut to that length. An agent name with no
 * letter or digit refuses nothing.
 */
function readsAsAgentName(key: string, agentName: string): boolean {
  return [agentName, asShown(agentName)].some((form) => {
    const agentKey = nameWords(form).join(' ');
    return agentKey !== '' && agentKey === key;
  });
}

/**
 * How each OTHER member's key among `subjects` reads, on an agent whose memory
 * is shared: the member's display name, else {@link TEAMMATE_TEXT}. Never
 * holds `self` (the caller's own key, which reads `you`), nor a subject that
 * isn't a member key. Empty on a Just-me agent, with no lookup at all.
 *
 * Only in a turn whose recall reads everything, and only for someone proven a
 * member right now (see the file header): per distinct id, one membership
 * check, then one `auth:get-user` if and only if it proved the id. The check
 * is `teams:is-member` on a team agent. On a shared personal agent it is
 * `agents:resolve`, plus one store read (`memory:facts:recall`, one row at
 * most) only for an id it admits that is neither an owner nor on a list. Ids
 * are asked in parallel. Never throws.
 *
 * Never waits past {@link MEMBER_NAMES_DEADLINE_MS} (`opts.deadlineMs`, for
 * tests) for the whole round. When the round loses that race, every member
 * key reads {@link TEAMMATE_TEXT}, the names already back included, with one
 * `timeout` warn ({@link MEMBER_NAMES_FAILED_EVENT}).
 *
 * The caller counts too (TASK-1213). When `self` is a member key and at least
 * one other member key is on the page, the caller's id goes through the same
 * lookups, but only so their name joins the check below. It is never a
 * label. On a shared personal agent its proof is admission alone, with no
 * store read: the person talking takes part by talking, and a sharee with no
 * row yet must still count, or a teammate renamed to their name would pass
 * for them in their first turn. With no other member key on the page there is
 * nothing to collide with, and nobody is asked, the caller included.
 *
 * A name is shown only when no other key WITHIN THIS ONE ANSWER, and not the
 * caller, reads the same, compared word by word as the reserved check does
 * ({@link nameWords}), so `Bob Smith` and `bob  smith.` collide. Otherwise
 * every key holding it reads {@link TEAMMATE_TEXT}: a member who renames
 * themself to a teammate's name can't pass for them beside that teammate's
 * rows, nor for the person talking, whose own rows read `you`.
 *
 * Residuals, documented and pinned by tests, not fixed here:
 *
 * - The check sees only the keys in this answer and the caller. A member who
 *   renames themself to a teammate's display name reads as that name
 *   wherever the real teammate's rows aren't in the same answer. Display
 *   names are self-chosen account text, the same as wherever names show
 *   (Slack included). A check across every member needs a list of them:
 *   `teams:list-members` gives one only to admins, and no hook lists the
 *   people a personal agent is shared with. Follow-up.
 * - Homoglyph and invisible variants of a name (a Cyrillic `а` for a Latin
 *   `a`) pass {@link nameWords}, so they don't collide.
 * - A lookup that fails, the caller's own included, leaves that one name out
 *   of the check for this answer (each id is its own question).
 * - Someone an `everyone` agent admits who has never spoken to it reads
 *   {@link TEAMMATE_TEXT}, even on rows others wrote about them: on that
 *   audience admission proves nothing (the file header). Once any row of
 *   theirs is in this agent's memory, a closed one included, they are named
 *   for as long as the agent admits them.
 * - The proof says who may be named, not who wrote a row. A crafted
 *   `user:<id>` naming someone who does take part reads as their name on a
 *   row they didn't write. It does on a team agent too, for any member.
 */
export async function memberLabels(
  bus: HookBus,
  ctx: AgentContext,
  access: Pick<MemoryAccess, 'visibility' | 'teamId' | 'agentName' | 'memberCheck'>,
  subjects: Iterable<string>,
  self: string | undefined,
  opts: { deadlineMs?: number } = {},
): Promise<ReadonlyMap<string, string>> {
  const labels = new Map<string, string>();
  if (access.visibility !== 'team') return labels;
  const ids = new Map<string, string>();
  for (const about of subjects) {
    if (typeof about !== 'string' || about === self || ids.has(about)) continue;
    const id = memberKeyId(about);
    if (id === undefined) continue;
    ids.set(about, id);
    labels.set(about, TEAMMATE_TEXT);
  }
  if (
    ids.size === 0 ||
    // The recall rule itself: a turn whose reads are scoped (a source this
    // build doesn't know, which fails closed) is told no names.
    recallAudienceScope(ctx, access).audience !== undefined
  ) {
    return labels;
  }
  // No way to prove a member, or nobody to ask a name of: no member is
  // proven, so nobody is named.
  const check = membershipCheck(bus, ctx, access);
  if (check === undefined || !bus.hasService(AUTH_GET_USER_HOOK)) return labels;
  // Every other member key on the page is asked about, to be shown. So is the
  // caller's own key, only to be counted.
  const [firstStep] = check.hooks;
  const lookups: Lookup[] = [...ids].map(([about, userId]) => ({ about, userId, shown: true, waitingOn: firstStep }));
  const selfId = self === undefined ? undefined : memberKeyId(self);
  if (self !== undefined && selfId !== undefined) {
    lookups.push({ about: self, userId: selfId, shown: false, waitingOn: firstStep });
  }
  const answers = await beforeDeadline(
    Promise.all(lookups.map((lookup) => lookUp(bus, ctx, check, access.agentName, lookup))),
    opts.deadlineMs ?? MEMBER_NAMES_DEADLINE_MS,
  );
  if (answers === TIMED_OUT) {
    // All or nothing: a name that came back can't be checked against one
    // that didn't, so nobody is named. `labels` still reads "a teammate" for
    // every member key, and no lookup ever writes to it. The warn names the
    // earliest step still out, in the order the steps are asked.
    const hook =
      [...check.hooks, AUTH_GET_USER_HOOK].find((step) => lookups.some((lookup) => lookup.waitingOn === step)) ??
      AUTH_GET_USER_HOOK;
    warnNamesFailed(
      ctx,
      hook,
      new PluginError({
        code: 'timeout',
        plugin: PLUGIN_NAME,
        hookName: hook,
        message: 'member name lookups passed their deadline',
      }),
    );
    return labels;
  }
  // Two different people whose names read the same, word by word, would
  // pass for each other: every member key holding that name reads "a
  // teammate" in this answer instead. The caller's name counts here and is
  // never shown. Within this answer only: see the residuals on
  // {@link memberLabels}.
  const holders = new Map<string, number>();
  for (const { name } of answers) {
    if (name === undefined) continue;
    const key = nameWords(name).join(' ');
    holders.set(key, (holders.get(key) ?? 0) + 1);
  }
  for (const { lookup, name } of answers) {
    if (name !== undefined && lookup.shown && holders.get(nameWords(name).join(' ')) === 1) {
      labels.set(lookup.about, name);
    }
  }
  const fault = answers.find((answer) => answer.fault !== undefined)?.fault;
  if (fault !== undefined) warnNamesFailed(ctx, fault.hook, fault.err);
  return labels;
}

/**
 * How {@link memberLabels} proves an id is a member before it asks
 * `auth:get-user` about it (the file header's "Whose names").
 */
interface MembershipCheck {
  /**
   * The hooks it may ask, in the order it asks them: the first about every
   * id, each later one only when the steps before it didn't settle the id. A
   * warn names the one that threw, or the earliest one still out at the
   * deadline.
   */
  readonly hooks: readonly [string, ...string[]];
  /**
   * True only on proof, false on any answer that isn't one. Throws on a
   * fault. Tells `asking` each hook before it asks it, so a throw or a stall
   * names the step it happened in.
   */
  readonly proves: (lookup: Pick<Lookup, 'userId' | 'shown'>, asking: (hook: string) => void) => Promise<boolean>;
}

/**
 * The membership check `access` calls for, or undefined when there is none
 * to ask: a team agent's team id first (TASK-1209, unchanged), else a shared
 * personal agent's `memberCheck` (TASK-1248), else nothing. Each needs its
 * first hook registered, and the agent check needs the turn's agent id.
 */
function membershipCheck(
  bus: HookBus,
  ctx: AgentContext,
  access: Pick<MemoryAccess, 'visibility' | 'teamId' | 'memberCheck'>,
): MembershipCheck | undefined {
  const { teamId } = access;
  if (typeof teamId === 'string' && teamId !== '') {
    return bus.hasService(TEAMS_IS_MEMBER_HOOK) ? teamMembership(bus, ctx, teamId) : undefined;
  }
  const { agentId } = ctx;
  if (
    access.memberCheck === 'agent' &&
    typeof agentId === 'string' &&
    agentId !== '' &&
    bus.hasService(AGENTS_RESOLVE_HOOK)
  ) {
    return agentMembership(bus, ctx, access, agentId);
  }
  return undefined;
}

/** A team agent's check (TASK-1209): `teams:is-member` about its team. */
function teamMembership(bus: HookBus, ctx: AgentContext, teamId: string): MembershipCheck {
  return {
    hooks: [TEAMS_IS_MEMBER_HOOK],
    proves: async ({ userId }, asking) => {
      asking(TEAMS_IS_MEMBER_HOOK);
      const membership = await bus.call<{ teamId: string; userId: string }, unknown>(TEAMS_IS_MEMBER_HOOK, ctx, {
        teamId,
        userId,
      });
      // Exactly `member: true`: anything else is no proof of membership.
      return isRecord(membership) && membership.member === true;
    },
  };
}

/**
 * A shared personal agent's check (TASK-1248): the id may use this agent now
 * AND takes part in it (the file header's "Whose names"). Each step runs only
 * when the one before it didn't settle the id:
 *
 * 1. `agents:resolve` must admit it to this agent. A refusal (`forbidden`, or
 *    `not-found` for an agent that is gone) is an answer: no proof, and no
 *    fault. So is an answer about another agent, or one this can't read. Any
 *    other throw is a fault.
 * 2. Its answer proves the people named on the agent itself: an owner
 *    (`isOwner: true`) or someone its list names (`audience: 'list'`). It
 *    also proves the caller's own key, never shown: the person talking takes
 *    part by talking.
 * 3. Anyone else it admits (on `everyone`, every AX account) must own a row in
 *    this agent's memory ({@link spokeTo}). With no store to ask, nobody is
 *    proven that way.
 */
function agentMembership(
  bus: HookBus,
  ctx: AgentContext,
  access: Pick<MemoryAccess, 'visibility'>,
  agentId: string,
): MembershipCheck {
  const hasStore = bus.hasService(FACTS_RECALL_HOOK);
  return {
    hooks: [AGENTS_RESOLVE_HOOK, FACTS_RECALL_HOOK],
    proves: async ({ userId, shown }, asking) => {
      asking(AGENTS_RESOLVE_HOOK);
      let out: unknown;
      try {
        out = await bus.call<{ agentId: string; userId: string }, unknown>(AGENTS_RESOLVE_HOOK, ctx, {
          agentId,
          userId,
        });
      } catch (err) {
        if (err instanceof PluginError && (err.code === 'forbidden' || err.code === 'not-found')) return false;
        throw err;
      }
      // Only an answer about this agent proves anything.
      const agent = isRecord(out) ? out.agent : undefined;
      if (!isRecord(agent) || agent.id !== agentId) return false;
      // Named on the agent itself. `audience` answers "did someone name them
      // here", never "is it shared" (the file header says why that is fine).
      if (agent.isOwner === true || agent.audience === 'list') return true;
      // The caller, only counted: admitted, and talking to it now.
      if (!shown) return true;
      if (!hasStore) return false;
      asking(FACTS_RECALL_HOOK);
      return spokeTo(bus, ctx, access, userId);
    },
  };
}

/**
 * Whether `userId` owns a row in this agent's memory: one their own turn
 * wrote, active or closed. One `memory:facts:recall` on this agent's store
 * (its tenant is `ctx.agentId`), scoped to that owner (`ownerUserId`, a
 * strict scope the engine enforces), at most one row back. It goes through
 * `recallFacts` like every engine read in this package, though a turn that is
 * told names is never audience-scoped, so that adds nothing. An answer this
 * can't read proves nothing. A throw propagates, and {@link lookUp} reports
 * it under `memory:facts:recall`.
 */
async function spokeTo(
  bus: HookBus,
  ctx: AgentContext,
  access: Pick<MemoryAccess, 'visibility'>,
  userId: string,
): Promise<boolean> {
  const out = await recallFacts<unknown>(bus, ctx, access, FACTS_RECALL_HOOK, {
    ownerUserId: userId,
    activeOnly: false,
    limit: 1,
  });
  const statements = isRecord(out) ? out.statements : undefined;
  return Array.isArray(statements) && statements.some(isRecord);
}

/** One id {@link memberLabels} asks about. */
interface Lookup {
  readonly about: string;
  readonly userId: string;
  /** Shown as a label, or only counted (the caller's own key). */
  readonly shown: boolean;
  /**
   * The hook this id's lookups are waiting on now, or undefined once they are
   * done. Written only while this id's own {@link lookUp} runs.
   */
  waitingOn: string | undefined;
}

/** What one {@link lookUp} found: a usable name, a throw, or neither. */
interface LookupAnswer {
  readonly lookup: Lookup;
  readonly name?: string;
  readonly fault?: { readonly hook: string; readonly err: unknown };
}

/**
 * One id's lookups: its membership check, then `auth:get-user` only once the
 * check proved it. Never throws. It answers with what it found and writes
 * nothing outside its own `lookup`, so an answer that lands after the
 * deadline reaches nothing already returned.
 */
async function lookUp(
  bus: HookBus,
  ctx: AgentContext,
  check: MembershipCheck,
  agentName: string | undefined,
  lookup: Lookup,
): Promise<LookupAnswer> {
  const { userId } = lookup;
  // The hook asked last: the one a throw is reported under.
  let hook: string = check.hooks[0];
  const asking = (next: string): void => {
    hook = next;
    lookup.waitingOn = next;
  };
  try {
    if (!(await check.proves(lookup, asking))) return { lookup };
    asking(AUTH_GET_USER_HOOK);
    const user = await bus.call<{ userId: string }, unknown>(AUTH_GET_USER_HOOK, ctx, { userId });
    if (!isRecord(user) || user.id !== userId) return { lookup };
    const name = memberName(user.displayName, agentName);
    return name === undefined ? { lookup } : { lookup, name };
  } catch (err) {
    return { lookup, fault: { hook, err } };
  } finally {
    lookup.waitingOn = undefined;
  }
}

/** What {@link beforeDeadline} answers when the timer wins. */
const TIMED_OUT = Symbol('member names timed out');

/**
 * `work`'s answer, or {@link TIMED_OUT} if `ms` pass first. The timer is
 * unref'd, so it never holds the process open, and it is cleared the moment
 * `work` settles, so a round that wins leaves no timer behind. (`work` never
 * rejects here: every {@link lookUp} catches its own throw.)
 */
function beforeDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The one warn of a {@link memberLabels} call ({@link MEMBER_NAMES_FAILED_EVENT}), by codes only. */
function warnNamesFailed(ctx: AgentContext, hook: string, err: unknown): void {
  try {
    ctx.logger.warn(MEMBER_NAMES_FAILED_EVENT, {
      agentId: ctx.agentId,
      hook,
      ...faultLogFields(err),
    });
  } catch {
    // A label is cosmetic, and so is the warning about one.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
