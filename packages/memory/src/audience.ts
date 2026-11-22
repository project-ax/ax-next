import {
  audienceOf,
  isOutsiderTurn,
  PluginError,
  type AgentContext,
  type AgentContextAudience,
  type HookBus,
} from '@ax/core';

import type { MemoryAccess } from './access.js';
import { captureCheck } from './capture.js';
import { PLUGIN_NAME } from './plugin-name.js';
import { rewriteSpeaker, SPEAKER_SUBJECT } from './subject.js';

/**
 * The audience of a memory READ (TASK-1091): on a personal agent, a turn whose
 * reply people without access to the agent can read recalls only what was
 * learned where they could see it. A team agent's memory is the team's
 * (TASK-1204, design §4c), so a member's reads aren't scoped by audience in
 * any session; an outsider's turn on it keeps shared-only recall, since §4c
 * shares it with the team, not with people outside AX, and never shows the
 * requester's own memory as the person talking (`augment.ts`,
 * `memory:recall`'s `aboutText`).
 *
 * And of a memory WRITE: every statement is stamped with
 * the audience of the turn it was learned in, and a turn that isn't private
 * files a person subject only where {@link speakerSubject} says (TASK-1204):
 * a team agent's member turn files the speaker's facts under the speaker's
 * own key, stamped private, since they're the team's and not the room's
 * ({@link recordFacts}), and any other shared turn stores nothing under
 * `user`, `user:<id>`, or a subject made of the speakers' names that
 * `memory:pre-capture` answered with (TASK-1146; {@link breaksSpeakerRule}).
 *
 * `ctx.audience` is stamped by the host and never read off a payload (see
 * `FORBIDDEN_PAYLOAD_FIELDS` in `plugin.ts`), so this scope comes from `ctx`
 * alone, like the owner scope. It is deliberately NOT folded into
 * `memoryReadScope`: that scope also rides the forget/correct/undo writes and
 * the `/memory` export, which audience must not narrow.
 *
 * Every engine read in this package goes through {@link recallFacts}: the
 * `memory:recall` reads, the injected block, and the observer's and the note
 * tool's twin reads. So a turn with the shared scope (a personal agent's
 * shared turn, an outsider's turn on any agent) behaves as if private rows did
 * not exist, rather than missing them in one place and meeting them in
 * another, and a team agent's member turn meets them everywhere. Every engine
 * write goes through {@link recordFacts} the same way.
 */

/**
 * The engine recall scope for a turn, decided in this order:
 *
 * 1. An outsider's turn (`isOutsiderTurn`, which fails closed for a source
 *    this build doesn't know): `{ audience: 'shared' }` on every agent,
 *    whatever the turn's audience stamp. Someone without access to the agent
 *    reads its reply, so it recalls only what was learned where they could
 *    see it, backstop and all: §4c shares a team agent's memory with the
 *    team, not with people outside AX. A private stamp or none fails closed
 *    here (TASK-1204 review), though no live producer sends one: channel-slack
 *    stamps an outsider's turn shared. (The orchestrator's security review
 *    reversed the planner's "every session" on a team agent; lifting it is
 *    this step, for team agents.)
 * 2. A team agent's MEMBER turn, in any audience (TASK-1204, design §4c):
 *    nothing at all. Its memory is the team's, so a member's shared turn
 *    reads what their private one reads. That removes a privacy boundary on
 *    purpose: a member's channel question already shows recall to everyone
 *    in the channel, and §4c's notices tell the room. An audience this build
 *    doesn't know reads everything here too, as a member reads everything
 *    anyway.
 * 3. Anything else: `{ audience: 'shared' }` for a shared turn, and for an
 *    audience this build does not know (`audienceOf` reads that as shared,
 *    the least recall). Nothing at all for a private turn, whose reads are
 *    exactly what they were before audiences existed. A visibility this build
 *    doesn't know isn't `'team'`, so it lands here and keeps the scope.
 */
export function recallAudienceScope(
  ctx: Pick<AgentContext, 'audience' | 'source'>,
  access: Pick<MemoryAccess, 'visibility'>,
): { audience?: 'shared' } {
  if (isOutsiderTurn(ctx)) return { audience: 'shared' };
  if (access.visibility === 'team') return {};
  return audienceOf(ctx) === 'shared' ? { audience: 'shared' } : {};
}

/**
 * Call the engine's recall hook with the turn's audience scope, and only that
 * ({@link recallAudienceScope}: whose memory `access` says this is decides
 * whether there is one). Any `audience` a caller built into `input` is dropped
 * first, whatever the turn and the agent. Spreading the scope last isn't
 * enough on its own: a private turn's scope is empty, and so is a team agent
 * member's in any audience, so it would let a caller's value through.
 *
 * `access` is REQUIRED, so no read can forget whose memory it is in. Every
 * caller already resolved it (`resolveMemoryAccess`), so this makes no
 * `agents:resolve` of its own.
 *
 * ## The backstop
 *
 * Only for a read with the shared scope (a personal agent's shared turn, and
 * an outsider's turn on any agent): a team agent member's read asks for every
 * row, so every row is its answer.
 *
 * A shared read whose answer holds any row not stamped `'shared'` throws
 * `invalid-return` instead of returning it. Both in-repo engines drop an
 * unknown recall field without a word, so an engine without audience support
 * would answer a shared read with every row it has, and those rows would land
 * in a reply people without access to the agent can read. One stray row fails
 * the whole read. Dropping it instead would be the post-filter design §6.1
 * forbids: a short page, and nobody learns the engine ignored the scope.
 *
 * An unstamped row fails too. A row stored before audiences existed is not
 * provably shared, which is the engines' own strict-equality rule.
 *
 * The message names no row, neither its text nor its id: it goes to logs and,
 * through `memory_recall`, to a model in a shared turn.
 *
 * Not checked here: an answer that is not an object, or whose `statements` is
 * not an array. Every caller refuses those on its own terms, and none reads a
 * row out of them.
 */
export async function recallFacts<TOut>(
  bus: HookBus,
  ctx: AgentContext,
  access: Pick<MemoryAccess, 'visibility'>,
  hookName: string,
  input: Record<string, unknown>,
): Promise<TOut | null> {
  const scope = recallAudienceScope(ctx, access);
  const { audience: _callerAudience, ...rest } = input;
  const out = await bus.call<Record<string, unknown>, TOut | null>(hookName, ctx, {
    ...rest,
    ...scope,
  });
  if (scope.audience === 'shared') requireSharedRows(out, hookName);
  return out;
}

function requireSharedRows(out: unknown, hookName: string): void {
  if (out === null || typeof out !== 'object') return;
  const statements = (out as { statements?: unknown }).statements;
  if (!Array.isArray(statements)) return;
  // `for...of`, not `every`: `every` skips a hole, and a hole is not a row
  // stamped shared.
  for (const row of statements as unknown[]) {
    if (row === null || typeof row !== 'object' || (row as { audience?: unknown }).audience !== 'shared') {
      throw new PluginError({
        code: 'invalid-return',
        plugin: PLUGIN_NAME,
        hookName,
        message: `${hookName} answered a shared-audience read with a statement not stamped shared: the engine ignored the audience scope, so memory refuses the whole answer rather than show a private statement to people without access to the agent`,
      });
    }
  }
}

/**
 * Whether `about` names a person: the speaker as the extractor writes it
 * (`user`), or anyone's per-person subject (`user:<id>`), however a model
 * cased or padded it. Normalized (NFKC, so fullwidth lookalikes fold to ASCII;
 * format characters such as zero-width space/joiner and BOM stripped;
 * lowercased; trimmed), it is `user`, or `user` then optional whitespace then
 * `:` (so `user :x` counts).
 *
 * Accepted residuals, deliberately NOT matched: other words for the speaker
 * (`users`, `the user`, `me`, `I`), and the speaker named inside an object or
 * value field. A false match loses a fact; a miss on those is a best-effort
 * gap this check does not try to close. The speaker named by their name
 * (`vinay`) isn't this check's job: it knows no names. That's
 * {@link namesASpeaker}, with the names `memory:pre-capture` answered with.
 *
 * Deliberately BROAD, where `rewriteSpeaker` (`subject.ts`) is deliberately
 * narrow, because the two fail in opposite directions. A rewrite that matches
 * too much corrupts a subject key for good, so it takes only the exact
 * literal. This decides what a shared turn may not store at all, so matching
 * too much loses one fact, while missing one pins a passer-by's words on a
 * person. In a shared turn the speaker could be anyone in the room, yet the
 * rewrite would file their `user` under the owner's own key, and a
 * `user:<id>` written from the room's words could name anyone. The row would
 * be shared, so every private turn would read it too.
 */
export function isPersonSubject(about: string): boolean {
  const subject = about.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase().trim();
  return subject === SPEAKER_SUBJECT || new RegExp(`^${SPEAKER_SUBJECT}\\s*:`).test(subject);
}

/**
 * The words of `text`, for comparing a subject with a name: NFKC (fullwidth
 * lookalikes fold to ASCII), format characters stripped (zero-width
 * space/joiner, BOM), lowercased, accents dropped (NFD, then every combining
 * mark, so `José` and `jose` are one word), then each run of letters and
 * digits. Anything else (`_`, `-`, `.`, a space) separates words.
 */
function nameWords(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .replace(/\p{Cf}/gu, '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Whether `about` is made of the speakers' names (TASK-1146): the names a
 * channel labels the people speaking in a conversation with, as
 * `memory:pre-capture` answered them. The extractor reads those labels in
 * the transcript, and the pinned prompt asks for "snake_case entity
 * identifiers", so it files the speaker's words under their name (`vinay |
 * stated_standup_time | …`, the TASK-1134 walk) rather than `user`.
 *
 * A subject names a speaker when, compared word by word ({@link nameWords}):
 *
 * - every word of it is a word of some speaker's name: first name, surname or
 *   both, in either order, or a member id (`vinay`, `pulim_vinay`,
 *   `uhte83xe1` for `Vinay Pulim` + `UHTE83XE1`). The words may come from
 *   different names: they are all the same conversation's speakers. The
 *   extractor's own word for the speaker (`user`) is set aside beside a name
 *   (`user_vinay`, `vinay_user`, and with the run-together test below
 *   `user_vinaypulim`), but a subject of `user` alone is
 *   {@link isPersonSubject}'s. Or
 * - its words run together spell one name's words run together
 *   (`vinaypulim` for `Vinay Pulim`, `vinay_pulim` for `VinayPulim`).
 *
 * EVERY word, not any: a subject with another word in it is about something
 * else (`vinays_team`, `vinay_laptop`, `team_standup`), and a name in the
 * VALUE (`team_standup | owner | vinay`) is never read. A subject with no
 * letters or digits names nobody, nor does a name with none.
 *
 * The names are untrusted display text (a member sets their own). This only
 * compares words with them, so the most a hostile name can do is make memory
 * drop facts, and only in the conversation that answered with it. Accepted
 * residuals: misses nicknames and initials the label doesn't show (`vp`),
 * titles (`mr_pulim`), role words other than `user` (`speaker_vinay`,
 * `member_vinay`), transliterations, digits added to a name (`vinay2`), and
 * anyone named only in what's said; drops a
 * thing whose name is all the speaker's name words, and a work subject made
 * of a display name's words ("Standup Team" drops `team_standup`).
 *
 * The run-together test works within ONE name, so these are missed too:
 * `pulimvinay` (the words run together in the other order), `vinay_p` (an
 * initial), and `vinaypulim` when the label gives "Vinay" and "Pulim" as
 * separate entries (each entry's words are run together on their own).
 */
export function namesASpeaker(about: string, speakerNames: readonly string[]): boolean {
  // No names, nothing to compare: don't read the subject at all.
  if (speakerNames.length === 0) return false;
  const words = nameWords(about);
  if (words.length === 0) return false;
  const { words: known, runTogether } = speakerIndex(speakerNames);
  // The extractor's own speaker word is set aside beside a name (`user_vinay`,
  // `user_vinaypulim`), always: a co-speaker named "Test User" must not turn
  // that off, since a hostile name may only make memory drop MORE. With
  // nothing else left it never matches: a subject of `user` is
  // `isPersonSubject`'s one job. The last test still reads the whole subject,
  // for a one-word name that ends in it (`power_user` for "Poweruser").
  const rest = words.filter((word) => word !== SPEAKER_SUBJECT);
  if (rest.length === 0) return false;
  return rest.every((word) => known.has(word)) || runTogether.has(rest.join('')) || runTogether.has(words.join(''));
}

/** A name list's words, and each name's words run together. */
interface SpeakerIndex {
  readonly words: ReadonlySet<string>;
  readonly runTogether: ReadonlySet<string>;
}

/**
 * Each FROZEN name list read once, not once per subject: a pass checks every
 * fact against the same list, and NFKC grows some characters eighteenfold, so
 * 32 names at the core caps cost ~9 ms to read (measured), and a 200-fact
 * batch that read them per fact blocked the host ~1.5 s. Keyed by the list
 * itself, which is sound only if the list never changes once checked, and
 * `namesASpeaker` is exported with a merely `readonly` parameter. So only a
 * frozen list is remembered (`captureCheck` freezes its answer); any other is
 * read afresh, so a caller who edits a list in place is never answered from
 * what it used to say.
 */
const speakerIndexes = new WeakMap<readonly string[], SpeakerIndex>();

function speakerIndex(speakerNames: readonly string[]): SpeakerIndex {
  const frozen = Object.isFrozen(speakerNames);
  let index = frozen ? speakerIndexes.get(speakerNames) : undefined;
  if (index === undefined) {
    const names = speakerNames.map(nameWords);
    index = { words: new Set(names.flat()), runTogether: new Set(names.map((name) => name.join(''))) };
    if (frozen) speakerIndexes.set(speakerNames, index);
  }
  return index;
}

/**
 * The longest subject the speaker rule reads, in UTF-16 code units. In a turn
 * that isn't private, a longer one breaks the rule unread. No real subject is
 * that long (both in-repo engines refuse an `about` over 1024 code units, so
 * nothing refused here could have been stored there), while reading one costs
 * the host time its writer chooses: a `memory_note` `about` can be megabytes
 * (the IPC frame is 4 MiB), and NFKC grows some characters eighteenfold
 * (measured: 4 MiB of U+FDFA took ~4 s to compare with names). Refusing it
 * is the cheap direction, as everywhere in this rule.
 *
 * A caller that counts what the rule dropped counts these too: the observer's
 * `speakerFacts` includes a fact whose subject is this long, so a non-zero
 * count doesn't prove a person was named.
 */
export const SPEAKER_RULE_READS_AT_MOST = 1024;

/**
 * The speaker rule (TASK-1091, design §2a): a turn with this audience may not
 * store a statement whose subject is `about`, in every turn that keeps the
 * rule: a personal agent's shared turn, and any outsider's turn (`'withheld'`
 * in {@link speakerScope}). A team agent's member turn files the speaker's
 * facts under them instead ({@link speakerSubject}, TASK-1204). The observer
 * drops a fact on it (`toStatements`), `memory_note` refuses a note on it, and
 * {@link recordFacts} refuses a batch on it, all three through
 * {@link speakerSubject}'s `'withheld'` answer, so they can't drift apart
 * (TASK-1136).
 *
 * `!== 'private'`, not `=== 'shared'`, so an audience this build doesn't know
 * fails closed.
 *
 * It takes an audience, not a ctx, because {@link speakerSubject} is pure and
 * has none: it passes `'shared'` for every turn that keeps the rule. A caller
 * with a ctx passes `audienceOf(ctx)`: the type alone doesn't force it, but a
 * value this build doesn't know fails closed anyway.
 *
 * A person subject breaks it: `user` or `user:<id>` ({@link isPersonSubject}),
 * or a subject made of the speakers' names ({@link namesASpeaker}, TASK-1146).
 * `speakerNames` is what the turn's `memory:pre-capture` answer named
 * (`captureCheck`), and it is REQUIRED, so a caller can't forget it and
 * quietly get the `user`-only rule. Pass `[]` only when nobody was asked or
 * nobody was named. The rule reads the subject alone: a fact naming who owns
 * what is about the work, which the design keeps (`team_standup | owner |
 * vinay`).
 *
 * A subject longer than {@link SPEAKER_RULE_READS_AT_MOST} breaks it too,
 * unread.
 */
export function breaksSpeakerRule(
  audience: AgentContextAudience,
  about: string,
  speakerNames: readonly string[],
): boolean {
  return (
    audience !== 'private' &&
    (about.length > SPEAKER_RULE_READS_AT_MOST || isPersonSubject(about) || namesASpeaker(about, speakerNames))
  );
}

/**
 * Whose memory a write lands in, and who is talking (TASK-1204, design §4c):
 *
 * - `'private'`: the owner's own turn. The person talking is the person the
 *   turn runs as, and `user` is filed under their key ({@link rewriteSpeaker}),
 *   as it always was.
 * - `'team'`: a team agent's shared turn, run as the member who wrote it. A
 *   member's conversation holds only that member's turns (one conversation per
 *   person per thread), so the person talking IS `ctx.userId`. A fact about
 *   them is filed under their own key, the one their web chats write and read.
 * - `'withheld'`: any outsider's turn, and any other shared turn (a personal
 *   agent's). The speaker could be anyone in the room, so nothing is filed
 *   under a person ({@link breaksSpeakerRule}, TASK-1091 and TASK-1146).
 */
export type SpeakerScope = 'private' | 'team' | 'withheld';

/**
 * The {@link SpeakerScope} of a turn, from `ctx` and the agent's resolved
 * access (`resolveMemoryAccess`: a team agent's `visibility` is `'team'`).
 *
 * An outsider's turn is `'withheld'` whatever its audience: there `ctx.userId`
 * is whoever answers for the channel, never the person talking, so not even a
 * private stamp may file `user` under them. No live outsider turn is private,
 * so this changes nothing today; it fails closed, as `isOutsiderTurn` does for
 * a source this build doesn't know. A visibility this build doesn't know isn't
 * `'team'`, so it fails closed too.
 */
export function speakerScope(
  ctx: Pick<AgentContext, 'audience' | 'source'>,
  access: Pick<MemoryAccess, 'visibility'>,
): SpeakerScope {
  if (isOutsiderTurn(ctx)) return 'withheld';
  if (audienceOf(ctx) === 'private') return 'private';
  return access.visibility === 'team' ? 'team' : 'withheld';
}

/**
 * The extraction prompt's subject for the agent itself: never a person.
 * Spelled here, not imported, because the prompt is fingerprint-pinned and
 * exports no word list.
 */
const AGENT_SUBJECT = 'assistant';

/**
 * The subject a write in `scope` files `about` under, or `undefined`: not
 * stored at all. The ONE answer every memory write asks: the observer drops a
 * fact this says `undefined` for, `memory_note` refuses one, and
 * {@link recordFacts} refuses any statement whose subject isn't already what
 * this returns, so a writer that forgets to ask is refused, not misfiled.
 *
 * - `'private'`: {@link rewriteSpeaker}, the narrow rewrite (unchanged).
 * - `'withheld'`: `undefined` when the subject breaks the speaker rule
 *   ({@link breaksSpeakerRule}), else as written (unchanged).
 * - `'team'`, in this order:
 *   1. Longer than {@link SPEAKER_RULE_READS_AT_MOST}: `undefined`, unread.
 *   2. `assistant`: as written. The extractor's word for the agent itself is
 *      never a person, whatever a member's display name says.
 *   3. `user`, or the runner's own key `user:<userId>`: the runner's key.
 *   4. A subject made of the speakers' names ({@link namesASpeaker}): the
 *      runner's key. The names are how memory recognizes the speaker in a
 *      subject; the key is where their facts go. It is the key their web chats
 *      read, it survives a rename, and two members with one name don't share
 *      it. With no names answered (a conversation recorded before TASK-1146),
 *      a name subject isn't recognized, so it is kept as written (step 6).
 *   5. Any other person subject (`User`, ` user `, `user:<anyone else>`):
 *      `undefined`. Nothing in a member's own turn vouches for another
 *      person's key, and dropping beats filing a fact under the wrong person.
 *   6. Anything else (the work, a third party by name): as written.
 *
 * So the only person key a team turn ever produces is the runner's own. The
 * names are untrusted display text a member sets themself, and the most one
 * can do is file the speaker's own words under the speaker.
 */
export function speakerSubject(
  scope: SpeakerScope,
  about: string,
  userId: string,
  speakerNames: readonly string[],
): string | undefined {
  switch (scope) {
    case 'private':
      return rewriteSpeaker(about, userId);
    case 'withheld':
      return breaksSpeakerRule('shared', about, speakerNames) ? undefined : about;
    case 'team': {
      if (about.length > SPEAKER_RULE_READS_AT_MOST) return undefined;
      if (about === AGENT_SUBJECT) return about;
      const own = rewriteSpeaker(SPEAKER_SUBJECT, userId);
      if (about === SPEAKER_SUBJECT || about === own || namesASpeaker(about, speakerNames)) return own;
      return isPersonSubject(about) ? undefined : about;
    }
    default: {
      // A scope this build doesn't know stores nothing.
      const _exhaustive: never = scope;
      void _exhaustive;
      return undefined;
    }
  }
}

/**
 * Call the engine's record hook with every statement stamped with the turn's
 * audience. The one door every engine WRITE in this package goes through, as
 * {@link recallFacts} is for reads: the human write behind `memory:remember`
 * and `memory:correct`, the observer's batch, and `memory_note`.
 *
 * The stamp comes from `ctx` (`audienceOf`, so an audience this build does
 * not know stamps `'shared'`, the least recall) and OVERWRITES anything a
 * statement carried, so no caller-built statement picks its own audience.
 * Every row is stamped, private ones included: a row stored from now on
 * always says who could see the turn it was learned in.
 *
 * With one exception, which only ever narrows (TASK-1204 review): in a team
 * agent's member turn (`'team'`), a statement filed under the member's own
 * key (`user:<access.userId>`) is stamped `'private'`. That is what the
 * member said about themself, and design §4c shares a team agent's memory
 * with the team, not with people outside AX. A private row reaches every
 * member's turn, whose reads have no audience scope, and no outsider's turn,
 * whose reads are shared-only ({@link recallAudienceScope}), backstop and
 * all. Stamped here, at the write, because §6.1 forbids filtering a read's
 * answer afterwards. Everything else in that turn (the work, a third party
 * by name, the agent) keeps the turn's stamp, and nothing else ever gets
 * this one: a private turn stamps private anyway, and every other shared
 * turn files no person key at all. The subject decides it only after the
 * backstop below has checked it is already where {@link speakerSubject}
 * files it, so the only way to the private stamp is to be about the runner.
 *
 * Only a read's audience scope reads the stamp. Twin reads don't, and slot
 * chains are audience-blind, so a member's channel fact closes their
 * web-chat one in the same slot as before. One visible effect: the owner's
 * memory view shows no "Shared" badge on such a row, though it was said
 * where the room could see it, because the badge follows the stamp.
 *
 * `statements` is typed `object`, not a record of fields: the observer's
 * statements are an interface, which TypeScript won't widen to an index
 * signature. The engine validates every field; this reads only `about`.
 *
 * `access` is whose memory this is, as the caller already resolved it
 * (`resolveMemoryAccess`). It is REQUIRED, so no writer can forget it, and
 * every caller already holds it, so this makes no `agents:resolve` of its own.
 *
 * ## The backstop
 *
 * In a turn that isn't private ({@link speakerScope}), a batch holding any
 * statement whose subject isn't already what {@link speakerSubject} files it
 * under is refused `forbidden` before anything is sent: the whole batch, as
 * the engine refuses a batch.
 *
 * - In a turn that keeps the speaker rule (`'withheld'`: a personal agent's
 *   shared turn, any outsider's turn), that is any subject that breaks it
 *   ({@link breaksSpeakerRule}: `user`, `user:<id>`, a subject made of the
 *   speakers' names, or one too long to read).
 * - In a team agent's member turn (`'team'`, TASK-1204), it is a subject not
 *   yet filed under its speaker (`user`, or a speaker's name, rather than the
 *   speaker's own `user:<id>`), any other person's key, and one too long to
 *   read. A writer was meant to file it first, and one that forgot is refused,
 *   never misfiled.
 *
 * The observer and `memory_note` deal with those statements themselves first,
 * so they can count them and say why. `memory:remember` and `memory:correct`
 * don't, because only owner routes call them, and those carry no audience.
 * For them, and for any writer added later that forgets, this is the refusal.
 *
 * The names are `speakerNames` when the caller has them: the observer and
 * `memory_note` pass what their own `memory:pre-capture` ask answered, so a
 * write doesn't ask twice. A caller that passes none, in a turn that isn't
 * private, makes this ask (`captureCheck`), so a writer added later can't
 * forget the names either. A refused ask refuses the batch `forbidden`, and
 * an answer memory can't read throws `invalid-return`; either way nothing is
 * sent. A private write is never checked and never asks: the speaker rewrite
 * already ran upstream, and the rule never applies there.
 *
 * The message names no statement: `about` and `value` can be model output,
 * and the error reaches logs.
 */
export async function recordFacts<TOut>(
  bus: HookBus,
  ctx: AgentContext,
  access: MemoryAccess,
  hookName: string,
  input: { batchKey?: string; statements: ReadonlyArray<object> },
  speakerNames?: readonly string[],
): Promise<TOut | null> {
  const audience = audienceOf(ctx);
  const scope = speakerScope(ctx, access);
  if (scope !== 'private') {
    // The cheap refusal first: a subject no name can file (`User`, another
    // person's key, one too long to read) needs no names, so refuse it before
    // any ask, and a garbled answer can't mask it. With no names a subject is
    // refused only if it would be with them too, so this refuses nothing the
    // full check below wouldn't.
    refuseUnfiled(scope, input.statements, access.userId, [], hookName);
    const names = speakerNames ?? (await askSpeakerNames(bus, ctx, hookName));
    refuseUnfiled(scope, input.statements, access.userId, names, hookName);
  }
  // The one subject a team agent's member turn stamps private: the member's
  // own key. Every statement that reaches here is already filed where
  // `speakerSubject` says, so this is exactly what they said about themself.
  const ownKey = scope === 'team' ? rewriteSpeaker(SPEAKER_SUBJECT, access.userId) : undefined;
  return bus.call<Record<string, unknown>, TOut | null>(hookName, ctx, {
    ...input,
    // `Array.from`, not `map`: `map` keeps a hole, and the engines' own `map`
    // would then skip it unseen. Here it becomes a statement with no subject,
    // which the engine refuses, and the whole batch with it. (`?.` for the
    // same hole: it names nobody, so it gets the turn's stamp.)
    statements: Array.from(input.statements, (statement) => ({
      ...statement,
      audience:
        ownKey !== undefined && (statement as { about?: unknown } | undefined)?.about === ownKey ? 'private' : audience,
    })),
  });
}

/** `recordFacts`' own ask, for a caller that brought no names. */
async function askSpeakerNames(bus: HookBus, ctx: AgentContext, hookName: string): Promise<readonly string[]> {
  const check = await captureCheck(bus, ctx);
  if (check.refusal !== undefined) {
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      hookName,
      message: `a write through ${hookName} in a conversation memory may not learn from: memory writes none of the batch`,
    });
  }
  return check.speakerNames;
}

/**
 * Refuse the whole batch when any statement's subject isn't already what
 * {@link speakerSubject} files it under in this scope: a subject it would drop,
 * or one it would file under the speaker's key instead.
 */
function refuseUnfiled(
  scope: Exclude<SpeakerScope, 'private'>,
  statements: ReadonlyArray<object>,
  userId: string,
  speakerNames: readonly string[],
  hookName: string,
): void {
  // `?.`: `for...of` reads a hole as `undefined`, which names nobody.
  for (const statement of statements as ReadonlyArray<{ about?: unknown } | undefined>) {
    const about = statement?.about;
    if (typeof about === 'string' && speakerSubject(scope, about, userId, speakerNames) !== about) {
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN_NAME,
        hookName,
        message:
          scope === 'team'
            ? `a team agent's turn tried to write a statement through ${hookName} that isn't filed under its speaker: memory writes none of the batch rather than file someone's words under the wrong subject`
            : `a shared-audience turn tried to write a statement about a person through ${hookName}: the speaker could be anyone in the room, so memory writes none of the batch rather than file their words under a person`,
      });
    }
  }
}
