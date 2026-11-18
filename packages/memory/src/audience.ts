import { audienceOf, PluginError, type AgentContext, type AgentContextAudience, type HookBus } from '@ax/core';

import { captureCheck } from './capture.js';
import { PLUGIN_NAME } from './plugin-name.js';
import { SPEAKER_SUBJECT } from './subject.js';

/**
 * The audience of a memory READ (TASK-1091): a turn whose reply people
 * without access to the agent can read recalls only what was learned where
 * they could see it. And of a memory WRITE: every statement is stamped with
 * the audience of the turn it was learned in, and a shared turn stores
 * nothing under a person subject: `user`, `user:<id>`, or a subject made of
 * the speakers' names that `memory:pre-capture` answered with (TASK-1146;
 * {@link breaksSpeakerRule}).
 *
 * `ctx.audience` is stamped by the host and never read off a payload (see
 * `FORBIDDEN_PAYLOAD_FIELDS` in `plugin.ts`), so this scope comes from `ctx`
 * alone, like the owner scope. It is deliberately NOT folded into
 * `memoryReadScope`: that scope also rides the forget/correct/undo writes and
 * the `/memory` export, which audience must not narrow.
 *
 * Every engine read in this package goes through {@link recallFacts}: the
 * `memory:recall` reads, the injected block, and the observer's and the note
 * tool's twin reads. So a shared turn behaves as if private rows did not
 * exist, rather than missing them in one place and meeting them in another.
 * Every engine write goes through {@link recordFacts} the same way.
 */

/**
 * The engine recall scope for a turn: `{ audience: 'shared' }` for a shared
 * turn, and for an audience this build does not know (`audienceOf` reads that
 * as shared, the least recall). Nothing at all for a private turn, whose reads
 * are exactly what they were before audiences existed.
 */
export function recallAudienceScope(ctx: Pick<AgentContext, 'audience'>): { audience?: 'shared' } {
  return audienceOf(ctx) === 'shared' ? { audience: 'shared' } : {};
}

/**
 * Call the engine's recall hook with the turn's audience scope, and only that.
 * Any `audience` a caller built into `input` is dropped first, whatever the
 * turn. Spreading the scope last isn't enough on its own: a private turn's
 * scope is empty, so it would let a caller's value through.
 *
 * ## The backstop
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
  hookName: string,
  input: Record<string, unknown>,
): Promise<TOut | null> {
  const scope = recallAudienceScope(ctx);
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
 *   extractor's own word for the speaker (`user`) counts beside a name word
 *   (`user_vinay`, `vinay_user`), but a subject of `user` alone is
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
  // The extractor's own speaker word counts as known beside a real name word
  // (`user_vinay`), but never alone: that is `isPersonSubject`'s one job.
  const speakerWordsOnly = words.every((word) => known.has(word) || word === SPEAKER_SUBJECT);
  return (speakerWordsOnly && words.some((word) => known.has(word))) || runTogether.has(words.join(''));
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
 * store a statement whose subject is `about`. It is the ONE test every memory
 * write asks. The observer drops a fact on it (`toStatements`), `memory_note`
 * refuses a note on it, and {@link recordFacts} refuses a batch on it, so the
 * three can't drift apart (TASK-1136).
 *
 * `!== 'private'`, not `=== 'shared'`, so an audience this build doesn't know
 * fails closed.
 *
 * It takes an audience, not a ctx, because `toStatements` is pure and has
 * none. Pass `audienceOf(ctx)`, as every caller does: the type alone doesn't
 * force it, but a value this build doesn't know fails closed anyway.
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
 * Call the engine's record hook with every statement stamped with the turn's
 * audience. The one door every engine WRITE in this package goes through, as
 * {@link recallFacts} is for reads: the human write behind `memory:remember`
 * and `memory:correct`, the observer's batch, and `memory_note`.
 *
 * The stamp comes from `ctx` alone (`audienceOf`, so an audience this build
 * does not know stamps `'shared'`, the least recall) and OVERWRITES anything
 * a statement carried, so no caller-built statement picks its own audience.
 * Every row is stamped, private ones included: a row stored from now on
 * always says who could see the turn it was learned in.
 *
 * `statements` is typed `object`, not a record of fields: the observer's
 * statements are an interface, which TypeScript won't widen to an index
 * signature. The engine validates every field; this reads only `about`.
 *
 * ## The backstop
 *
 * In a shared turn, a batch holding any statement that breaks the speaker
 * rule ({@link breaksSpeakerRule}: `user`, `user:<id>`, a subject made of the
 * speakers' names, or one too long to read) is refused `forbidden` before
 * anything is sent: the
 * whole batch, as the engine refuses a batch. The observer and `memory_note`
 * drop or refuse those statements themselves, before the speaker rewrite, so
 * they can count them and say why. `memory:remember` and `memory:correct`
 * don't, because only owner routes call them, and those carry no audience.
 * For them, and for any writer added later that forgets, this is the refusal.
 *
 * The names are `speakerNames` when the caller has them: the observer and
 * `memory_note` pass what their own `memory:pre-capture` ask answered, so a
 * write doesn't ask twice. A caller that passes none, in a turn that isn't
 * private, makes this ask (`captureCheck`), so a writer added later can't
 * forget the names either. A refused ask refuses the batch `forbidden`, and
 * an answer memory can't read throws `invalid-return`; either way nothing is
 * sent. A private write never asks: the rule never applies there.
 *
 * The message names no statement: `about` and `value` can be model output,
 * and the error reaches logs.
 */
export async function recordFacts<TOut>(
  bus: HookBus,
  ctx: AgentContext,
  hookName: string,
  input: { batchKey?: string; statements: ReadonlyArray<object> },
  speakerNames?: readonly string[],
): Promise<TOut | null> {
  const audience = audienceOf(ctx);
  // The cheap refusal first: a `user` subject or one too long to read needs no
  // names, so refuse it before any ask, and a garbled answer can't mask it.
  refuseSpeakerFacts(audience, input.statements, [], hookName);
  const names = speakerNames ?? (audience === 'private' ? [] : await askSpeakerNames(bus, ctx, hookName));
  refuseSpeakerFacts(audience, input.statements, names, hookName);
  return bus.call<Record<string, unknown>, TOut | null>(hookName, ctx, {
    ...input,
    // `Array.from`, not `map`: `map` keeps a hole, and the engines' own `map`
    // would then skip it unseen. Here it becomes a statement with no subject,
    // which the engine refuses, and the whole batch with it.
    statements: Array.from(input.statements, (statement) => ({ ...statement, audience })),
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
      message: `a shared-audience write through ${hookName} in a conversation memory may not learn from: memory writes none of the batch`,
    });
  }
  return check.speakerNames;
}

function refuseSpeakerFacts(
  audience: AgentContextAudience,
  statements: ReadonlyArray<object>,
  speakerNames: readonly string[],
  hookName: string,
): void {
  // `?.`: `for...of` reads a hole as `undefined`, which names nobody.
  for (const statement of statements as ReadonlyArray<{ about?: unknown } | undefined>) {
    const about = statement?.about;
    if (typeof about === 'string' && breaksSpeakerRule(audience, about, speakerNames)) {
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN_NAME,
        hookName,
        message: `a shared-audience turn tried to write a statement about a person through ${hookName}: the speaker could be anyone in the room, so memory writes none of the batch rather than file their words under a person`,
      });
    }
  }
}
