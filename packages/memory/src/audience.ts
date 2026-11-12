import { audienceOf, PluginError, type AgentContext, type HookBus } from '@ax/core';

import { PLUGIN_NAME } from './plugin-name.js';
import { SPEAKER_SUBJECT } from './subject.js';

/**
 * The audience of a memory READ (TASK-1091): a turn whose reply people
 * without access to the agent can read recalls only what was learned where
 * they could see it. And of a memory WRITE: every statement is stamped with
 * the audience of the turn it was learned in, and a shared turn stores
 * nothing about a person ({@link recordFacts}).
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
 * cased or padded it. Trimmed and lowercased, it is `user` or starts `user:`.
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
  const subject = about.trim().toLowerCase();
  return subject === SPEAKER_SUBJECT || subject.startsWith(`${SPEAKER_SUBJECT}:`);
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
 * In a shared turn, a batch holding any statement about a person
 * ({@link isPersonSubject}) is refused `forbidden` before anything is sent:
 * the whole batch, as the engine refuses a batch. The observer and
 * `memory_note` drop or refuse those statements themselves, before the
 * speaker rewrite, so they can count them and say why. `memory:remember` and
 * `memory:correct` don't, because only owner routes call them, and those
 * carry no audience. For them, and for any writer added later that forgets,
 * this is the refusal.
 *
 * The message names no statement: `about` and `value` can be model output,
 * and the error reaches logs.
 */
export async function recordFacts<TOut>(
  bus: HookBus,
  ctx: AgentContext,
  hookName: string,
  input: { batchKey?: string; statements: ReadonlyArray<object> },
): Promise<TOut | null> {
  const audience = audienceOf(ctx);
  if (audience === 'shared') refuseSpeakerFacts(input.statements, hookName);
  return bus.call<Record<string, unknown>, TOut | null>(hookName, ctx, {
    ...input,
    // `Array.from`, not `map`: `map` keeps a hole, and the engines' own `map`
    // would then skip it unseen. Here it becomes a statement with no subject,
    // which the engine refuses, and the whole batch with it.
    statements: Array.from(input.statements, (statement) => ({ ...statement, audience })),
  });
}

function refuseSpeakerFacts(statements: ReadonlyArray<object>, hookName: string): void {
  // `?.`: `for...of` reads a hole as `undefined`, which names nobody.
  for (const statement of statements as ReadonlyArray<{ about?: unknown } | undefined>) {
    const about = statement?.about;
    if (typeof about === 'string' && isPersonSubject(about)) {
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN_NAME,
        hookName,
        message: `a shared-audience turn tried to write a statement about a person through ${hookName}: the speaker could be anyone in the room, so memory writes none of the batch rather than file their words under a person`,
      });
    }
  }
}
