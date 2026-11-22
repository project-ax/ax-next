/**
 * Members' display names, for labelling memory on a team agent (TASK-1209).
 *
 * A team agent files each member's facts under the member's own key,
 * `user:<their id>` (TASK-1204, `subject.ts`). Shown to anyone but that
 * member, the key reads as the member's display name, or {@link TEAMMATE_TEXT}
 * when memory has no name to show. Never the raw id: it is an internal
 * identifier, it costs a model tokens, and a model may repeat it.
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
 * Only a team agent's turns whose recall reads everything: a member's, a
 * member's routine, and an outsider's (TASK-1209: outsiders recall what
 * members do). That is `recallAudienceScope`'s own rule, so names can't drift
 * from recall. A personal agent has no teammates and asks nobody. A team
 * agent's turn from a source this build doesn't know reads shared rows only
 * (it fails closed), and it is told no names either: its members read "a
 * teammate", with no lookup.
 *
 * ## Whose names
 *
 * Only a CURRENT member of the agent's own team (TASK-1209's security
 * review). A subject is model output shaped by chat, so a stored
 * `user:<id>` can name any account at all, and `auth:get-user` answers for
 * any account. So memory first asks `teams:is-member` about the agent's team
 * (`MemoryAccess.teamId`), the same source `@ax/agents` decides team access
 * with, and asks `auth:get-user` only about an id that hook answered
 * `member: true` for. Anything else fails closed for that id, with no
 * `auth:get-user` call: a non-member, a former member, an answer this can't
 * read, a throw, no team id, and no `teams:is-member` service at all. Each id
 * is its own question: `@ax/teams` throws on an id it can't hold (over 256
 * characters), and one such stored subject mustn't blank every name in an
 * answer.
 *
 * ## A name is untrusted text
 *
 * A member can rename themself to anything, at any length. So a name is
 * cleaned with core's surface-text helpers (the composition channel-slack's
 * `cleanLabel` uses: no control, bidi or zero-width characters, no lone
 * surrogate, one line, single spaces), clamped, and refused when it has no
 * letter or digit, or when it would read as the person talking (`you` in the
 * block and the memory view, where `aboutText === 'you'` is the self
 * sentinel; `user` in the evidence table) or as the agent. Every sink still
 * escapes it (`escapeStatementText`).
 *
 * ## It never fails a read
 *
 * A name is cosmetic. No service, no account, an answer this can't read, a
 * refused name or a throw: that member reads "a teammate", and the recall or
 * the block answers anyway. A throw is logged once per call, by its codes
 * (`faultLogFields`), never with an id, a name or an email.
 */

import {
  clampCodeUnits,
  faultLogFields,
  toWellFormedText,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { replaceSurfaceRewriters } from '@ax/core/surface-text';

import type { MemoryAccess } from './access.js';
import { isPersonSubject, nameWords, recallAudienceScope } from './audience.js';
import { isAgentSubject } from './self-report.js';
import { SPEAKER_SUBJECT } from './subject.js';

/** The hook that names an account by id (`@ax/auth-better`). */
export const AUTH_GET_USER_HOOK = 'auth:get-user';

/** The hook that says whether an account is a current member of a team (`@ax/teams`). */
export const TEAMS_IS_MEMBER_HOOK = 'teams:is-member';

/** What another member's key reads as when memory has no name to show. */
export const TEAMMATE_TEXT = 'a teammate';

/**
 * Logged once per {@link memberLabels} call in which a lookup threw. Bindings
 * are `agentId`, `hook` (which of the two lookups threw first) and that
 * error's codes (`faultLogFields`) only: an error's message may quote the id,
 * the name or the email.
 */
export const MEMBER_NAMES_FAILED_EVENT = 'memory_member_names_failed';

/** The longest name shown, in UTF-16 code units (channel-slack's sender-name cap). */
export const MEMBER_NAME_MAX = 80;

/**
 * Whole names, as {@link nameWords} reads them, that would read as the person
 * talking or as the agent: what memory's surfaces call the person talking
 * (`you`, and the evidence table's `user`), and the agent's own voice in the
 * block ("I also hold memory about"). `isPersonSubject` and `isAgentSubject`
 * answer the rest.
 */
const SELF_WORDS = new Set(['you', 'yourself', 'user', 'the user', 'i', 'me', 'myself']);

/** `user:<id>` with a non-empty id → `<id>`; anything else (`user`, `user:`, `User:x`, `acme`) → undefined. */
export function memberKeyId(about: string): string | undefined {
  const prefix = `${SPEAKER_SUBJECT}:`;
  return about.startsWith(prefix) && about.length > prefix.length ? about.slice(prefix.length) : undefined;
}

/**
 * A display name fit to show for a member, or undefined: not a string, no
 * letter or digit left once cleaned, or a name that reads as the person
 * talking or as the agent.
 *
 * The reserved check compares the whole name, word by word ({@link nameWords}:
 * fullwidth forms folded, invisible format characters and accents dropped,
 * case folded, punctuation a separator). So `You.`, fullwidth `you`, `you`
 * with a soft hyphen inside and `Yoü` are all `you`, while `You Li` and
 * `Agent Smith` are names.
 */
export function memberName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const flat = toWellFormedText(replaceSurfaceRewriters(raw)).replace(/\s+/g, ' ').trim();
  const name = clampCodeUnits(flat, MEMBER_NAME_MAX).trimEnd();
  const words = nameWords(name);
  // Nothing to read it by: blank, or only an emoji, punctuation, or a
  // character that draws nothing and isn't in core's class (a soft hyphen).
  if (words.length === 0) return undefined;
  if (isPersonSubject(name) || SELF_WORDS.has(words.join(' ')) || isAgentSubject(words.join('_'))) {
    return undefined;
  }
  return name;
}

/**
 * How each OTHER member's key among `subjects` reads, on a team agent: the
 * member's display name, else {@link TEAMMATE_TEXT}. Never holds `self` (the
 * caller's own key, which reads `you`), nor a subject that isn't a member key.
 * Empty on any other agent, with no lookup at all.
 *
 * Only in a turn whose recall reads everything, and only for a current member
 * of the agent's team (see the file header): per distinct id, one
 * `teams:is-member`, then one `auth:get-user` if and only if it answered
 * `member: true`. Ids are asked in parallel. Never throws.
 *
 * A name is shown only when no other key in this answer reads the same,
 * compared word by word as the reserved check does ({@link nameWords}), so
 * `Bob Smith` and `bob  smith.` collide. Otherwise every key holding it reads
 * {@link TEAMMATE_TEXT}: a member who renames themself to a teammate's name
 * can't pass for them, and neither reads as the other.
 */
export async function memberLabels(
  bus: HookBus,
  ctx: AgentContext,
  access: Pick<MemoryAccess, 'visibility' | 'teamId'>,
  subjects: Iterable<string>,
  self: string | undefined,
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
  const teamId = access.teamId;
  if (
    ids.size === 0 ||
    // The recall rule itself: a turn whose reads are scoped (a source this
    // build doesn't know, which fails closed) is told no names.
    recallAudienceScope(ctx, access).audience !== undefined ||
    // No team to ask about, or nobody to ask: no member is proven, so
    // nobody is named.
    typeof teamId !== 'string' ||
    teamId === '' ||
    !bus.hasService(TEAMS_IS_MEMBER_HOOK) ||
    !bus.hasService(AUTH_GET_USER_HOOK)
  ) {
    return labels;
  }
  const faults: Array<{ hook: string; err: unknown }> = [];
  const named = new Map<string, string>();
  await Promise.all(
    [...ids].map(async ([about, userId]) => {
      let membership: unknown;
      try {
        membership = await bus.call<{ teamId: string; userId: string }, unknown>(TEAMS_IS_MEMBER_HOOK, ctx, {
          teamId,
          userId,
        });
      } catch (err) {
        faults.push({ hook: TEAMS_IS_MEMBER_HOOK, err });
        return;
      }
      // Exactly `member: true`: anything else is no proof of membership.
      if (!isRecord(membership) || membership.member !== true) return;
      try {
        const user = await bus.call<{ userId: string }, unknown>(AUTH_GET_USER_HOOK, ctx, { userId });
        if (!isRecord(user) || user.id !== userId) return;
        const name = memberName(user.displayName);
        if (name !== undefined) named.set(about, name);
      } catch (err) {
        faults.push({ hook: AUTH_GET_USER_HOOK, err });
      }
    }),
  );
  // Two different members whose names read the same, word by word, would
  // pass for each other: both read "a teammate" in this answer instead.
  const holders = new Map<string, number>();
  for (const name of named.values()) {
    const key = nameWords(name).join(' ');
    holders.set(key, (holders.get(key) ?? 0) + 1);
  }
  for (const [about, name] of named) {
    if (holders.get(nameWords(name).join(' ')) === 1) labels.set(about, name);
  }
  const first = faults[0];
  if (first !== undefined) {
    try {
      ctx.logger.warn(MEMBER_NAMES_FAILED_EVENT, {
        agentId: ctx.agentId,
        hook: first.hook,
        ...faultLogFields(first.err),
      });
    } catch {
      // A label is cosmetic, and so is the warning about one.
    }
  }
  return labels;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
