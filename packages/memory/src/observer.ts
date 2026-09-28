import { createHash } from 'node:crypto';

import { attributeFacts } from './attribution.js';
import { extractFacts, type ExtractedFact, type LlmCallFn } from './extract.js';
import { isAgentContextSelfReport } from './self-report.js';
import { deriveSlot, type Slot } from './slots.js';
import { rewriteSpeaker } from './subject.js';
import type { MemoryStatementKind } from './types.js';
import {
  filterDialogue,
  hasUserContent,
  renderDialogue,
  type IdentifiedTurn,
  type UntrustedMessage,
} from './transcript.js';

/**
 * The observer — design §3.0. `chat:end` -> dialogue -> ONE structured
 * extraction call -> statements, recorded as ONE batch.
 *
 * A pure async function on its inputs: it takes a `llmCall` and a `record`
 * rather than a `HookBus`, so every property below is testable without one.
 * The bus wiring lives in `plugin.ts`, and the acceptance tests drive
 * `bus.fire('chat:end')` end to end — a test that only called this function
 * would leave the wiring uncovered, which is exactly the hole TASK-434's
 * mutation pass found.
 */

/** One statement as the engine's `memory:facts:record` takes it. */
export interface ObserverStatement {
  about: string;
  relation: string;
  value: string;
  when: string;
  provenance: 'extracted';
  ownerUserId: string;
  conversationId?: string;
  /**
   * The canonical turn the fact came from (TASK-625) — provenance only,
   * never a retrieval key. Absent on the legacy `chat:end` path, whose
   * messages carry no turn ids.
   */
  sourceTurnId?: string;
  kind?: MemoryStatementKind;
  slot?: Slot;
}

export interface ObserverRecordInput {
  batchKey: string;
  statements: ObserverStatement[];
}

/** The engine call. Returns whatever `memory:facts:record` returned. */
export type ObserverRecordFn = (input: ObserverRecordInput) => Promise<{
  records?: Array<{ id?: unknown }>;
} | null | undefined>;

export type ObserverResult =
  /** Nothing worth extracting; no call was made and nothing was written. */
  | { kind: 'skipped'; reason: 'no-dialogue' | 'no-user-content' | 'no-facts' }
  /**
   * An incremental pass found no turn after its cursor (TASK-625) — the
   * normal outcome of `chat:end` after an idle pass already covered the
   * conversation.
   */
  | { kind: 'skipped'; reason: 'no-new-turns' }
  /**
   * An incremental pass for a user in the "memory paused" state. No call was
   * made: the turns stay for the `chat:end` pass, which always tries, because
   * only a resolved call may clear the pause.
   */
  | { kind: 'skipped'; reason: 'paused' }
  /**
   * Every fact was supported only by a context turn, which the previous pass
   * already covered — see `attribution.ts`.
   */
  | { kind: 'skipped'; reason: 'only-context'; contextOnly: number }
  /**
   * Every fact the extractor produced was the agent describing its own
   * context (TASK-612, `self-report.ts`). Ordinary, but counted and named
   * apart from `no-facts`, so a filter that over-drops a whole batch leaves a
   * trace instead of reading as "nothing durable was said".
   */
  | { kind: 'skipped'; reason: 'only-self-reports'; selfReports: number }
  /**
   * The extractor produced facts and EVERY ONE of them was unusable, so the
   * batch is empty for a reason.
   *
   * Distinct from `skipped: 'no-facts'` on purpose. Folding the two together
   * made the quietest line in the system describe the loudest failure: a
   * PARTIAL date regression surfaced as `recorded` with `unusable: N`, while a
   * TOTAL one — the systematic case, where the extractor has started emitting
   * dates nothing can read — logged as an ordinary "nothing durable was said"
   * at `debug` and threw the count away.
   */
  | { kind: 'all-unusable'; unusable: number }
  /** The extraction call did not return within the deadline. Nothing written. */
  | { kind: 'timeout'; timeoutMs: number }
  /** Both extraction attempts failed the schema. The batch is dropped. */
  | { kind: 'schema-failure'; detail: string }
  | {
      kind: 'recorded';
      /**
       * Rows the engine reports for this `batchKey`.
       *
       * ⚠ On a DEDUP'd re-fire this is the ORIGINAL batch's size, not what
       * this fire wrote — the engine returns the rows it already holds and
       * gives us no way to tell a fresh write from a replay. So this is "rows
       * this conversation's batch has", not "rows this call inserted", and an
       * alert keyed on it would count a double-fire twice.
       */
      recorded: number;
      /** Facts the extractor produced that could not be stored. */
      unusable: number;
      /**
       * Facts dropped because they were the agent describing its own runtime
       * context ("I have no rules") — see `self-report.ts`. Not `unusable`:
       * nothing is wrong with the extractor when this is non-zero.
       */
      selfReports: number;
      /** Facts dropped because only a context turn supported them. */
      contextOnly: number;
      retried: boolean;
      batchKey: string;
    };

export interface RunObserverInput {
  /** `chat:end`'s `outcome.messages`, untrusted and unfiltered. */
  messages: readonly UntrustedMessage[];
  llmCall: LlmCallFn;
  record: ObserverRecordFn;
  /** Owner of every statement this batch writes. From `ctx`, never a payload. */
  ownerUserId: string;
  /**
   * The turn's conversation, as the batch IDENTITY: hashed into `batchKey`.
   * Absent on a turn with no conversation.
   */
  conversationId?: string | undefined;
  /**
   * The conversation the stored statements are ATTRIBUTED to — provenance
   * only, never a retrieval key. Usually `conversationId`; absent for a
   * routine turn, which is not a conversation the person had (TASK-616,
   * `conversation.ts`). Kept apart from `conversationId` so the dedup key
   * does not change with it.
   */
  statementConversationId?: string | undefined;
  /** Model id passed verbatim to `llm:call:<provider>`. */
  model: string;
  /** Injected for deterministic tests. */
  now: Date;
  /** Hard deadline for the extraction round trip, retry included. */
  timeoutMs: number;
}

export async function runObserver(input: RunObserverInput): Promise<ObserverResult> {
  const turns = filterDialogue(input.messages);
  if (turns.length === 0) return { kind: 'skipped', reason: 'no-dialogue' };
  if (!hasUserContent(turns)) return { kind: 'skipped', reason: 'no-user-content' };

  const dialogue = renderDialogue(turns);
  return extractAndRecord(input, dialogue, {
    attribute: (facts) => ({ facts, contextOnly: 0 }),
    batchKey: () =>
      buildBatchKey({
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        dialogue,
      }),
  });
}

export interface RunTurnObserverInput extends Omit<RunObserverInput, 'messages' | 'conversationId'> {
  /** The canonical transcript's conversation — part of the batch identity. */
  conversationId: string;
  /**
   * Up to two turns before `fresh`, shown to the extractor so references
   * resolve. Read-only: no statement is attributed to one, and a fact only
   * they support is dropped (`attribution.ts`).
   */
  context: readonly IdentifiedTurn[];
  /** The turns this pass covers. Never empty — the caller checks. */
  fresh: readonly IdentifiedTurn[];
}

/**
 * One INCREMENTAL pass (TASK-625): extract from `fresh` with `context` in
 * view, attribute each fact to its source turn, and record the batch under a
 * key made of the turn RANGE — so a pass that re-runs over the same turns (a
 * retry, a duplicate trigger, `chat:end` overlapping an idle pass whose
 * cursor write was lost) is an engine no-op rather than a second copy.
 *
 * Same extraction, same pinned prompt, same statement mapping as
 * {@link runObserver}; only the input shape, the attribution step and the
 * batch key differ.
 */
export async function runTurnObserver(input: RunTurnObserverInput): Promise<ObserverResult> {
  const first = input.fresh[0];
  const last = input.fresh[input.fresh.length - 1];
  if (first === undefined || last === undefined) return { kind: 'skipped', reason: 'no-new-turns' };
  // User content anywhere in view: a long assistant answer that spans two
  // passes is still a reply to the user turn in its context.
  if (!hasUserContent([...input.context, ...input.fresh])) {
    return { kind: 'skipped', reason: 'no-user-content' };
  }
  const dialogue = renderDialogue([...input.context, ...input.fresh]);
  return extractAndRecord(input, dialogue, {
    attribute: (facts) => attributeFacts(facts, { context: input.context, fresh: input.fresh }),
    batchKey: () =>
      buildTurnRangeBatchKey({
        conversationId: input.conversationId,
        ownerUserId: input.ownerUserId,
        firstTurnId: first.turnId,
        lastTurnId: last.turnId,
      }),
  });
}

async function extractAndRecord(
  input: Omit<RunObserverInput, 'messages'>,
  dialogue: string,
  how: {
    attribute: (facts: ExtractedFact[]) => {
      facts: Array<ExtractedFact & { sourceTurnId?: string }>;
      contextOnly: number;
    };
    batchKey: () => string;
  },
): Promise<ObserverResult> {
  const now = input.now.toISOString();

  let extraction;
  try {
    extraction = await raceTimeout(
      extractFacts({ llmCall: input.llmCall, dialogue, now, model: input.model }),
      input.timeoutMs,
    );
  } catch (err) {
    if (err instanceof ObserverTimeoutError) {
      return { kind: 'timeout', timeoutMs: input.timeoutMs };
    }
    throw err;
  }

  if (extraction.kind === 'schema-failure') {
    return { kind: 'schema-failure', detail: extraction.detail };
  }

  const attributed = how.attribute(extraction.facts);
  const mapped = toStatements(attributed.facts, {
    ownerUserId: input.ownerUserId,
    conversationId: input.statementConversationId,
  });
  if (mapped.statements.length === 0) {
    // "The extractor found nothing durable" and "the extractor found things
    // and every one was unreadable" are different events, and only the first
    // is ordinary.
    if (mapped.unusable > 0) return { kind: 'all-unusable', unusable: mapped.unusable };
    if (mapped.selfReports > 0) {
      return { kind: 'skipped', reason: 'only-self-reports', selfReports: mapped.selfReports };
    }
    if (attributed.contextOnly > 0) {
      return { kind: 'skipped', reason: 'only-context', contextOnly: attributed.contextOnly };
    }
    return { kind: 'skipped', reason: 'no-facts' };
  }

  const batchKey = how.batchKey();

  const result = await input.record({ batchKey, statements: mapped.statements });
  // `== null`, deliberately: `HookBus.call` returns a handler's RAW value when
  // the hook declares no `returns` schema, and `memory:facts:record` declares
  // none — so an engine resolving to `null` arrives intact and `=== undefined`
  // is FALSE for it.
  if (result == null || !Array.isArray(result.records)) {
    throw new Error(
      'memory:facts:record returned no records array; a batch we cannot confirm was written is not a batch we may report as remembered',
    );
  }
  return {
    kind: 'recorded',
    recorded: result.records.length,
    unusable: mapped.unusable,
    selfReports: mapped.selfReports,
    contextOnly: attributed.contextOnly,
    retried: extraction.retried,
    batchKey,
  };
}

/**
 * The batch key for an incremental pass — the conversation, the owner, and
 * the RANGE of canonical turns covered (TASK-625).
 *
 * Range rather than content: the canonical transcript is append-only (the
 * display log never deletes a turn), so a range names one set of turns
 * forever and two passes over it are the same batch. The owner is hashed for
 * the same reason as in {@link buildBatchKey}. The `turns` tag keeps these
 * keys disjoint from the legacy `chat:end` path's.
 */
export function buildTurnRangeBatchKey(input: {
  conversationId: string;
  ownerUserId: string;
  firstTurnId: string;
  lastTurnId: string;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'turns',
        input.conversationId,
        input.ownerUserId,
        input.firstTurnId,
        input.lastTurnId,
      ]),
    )
    .digest('hex');
  return `memory-observer:${digest}`;
}

/**
 * The batch idempotency key — design §3.5.
 *
 * **`chat:end` firing twice on one conversation is the NORMAL case, not the
 * edge case.** The engine's `record` writes nothing and returns the original
 * rows when it has already seen a key, so the whole dedup lives in what this
 * function hashes.
 *
 * Three inputs, and the third is the one the design's shorthand
 * (`conversationId + content hash`) leaves out:
 *
 * - **`conversationId`** — the durable per-conversation identity. Absent on a
 *   turn with no conversation (a canary, an admin probe); hashed as the empty
 *   string rather than faked, so those turns dedup on content alone. Two
 *   conversation-less turns with a byte-identical transcript, the same owner
 *   and the same agent would collide — and that collision is correct, because
 *   the statements would be identical too.
 * - **`dialogue`** — the FILTERED transcript, so the key covers exactly the
 *   bytes the extractor saw. A second turn in the same conversation appends
 *   to the transcript, which changes the hash, which is what makes a longer
 *   conversation a new batch rather than a suppressed one.
 * - **`ownerUserId`** — NOT in the design's shorthand, and it has to be here.
 *   `batchKey` is scoped by TENANT (`agentId`), not by owner. Two people
 *   talking to the same team agent can produce the same transcript, and
 *   without the owner in the key the second person's batch would match the
 *   first's, write nothing, and return rows stamped with somebody else's
 *   `ownerUserId` — rows that person's own owner-scoped recall can never see.
 *   That is silent memory loss for the second person, so the owner is hashed.
 *
 * Hashing rather than exposing the parts: JSON encodes the string tuple with
 * unambiguous boundaries, including embedded NULs, so distinct triples cannot
 * produce one key by boundary confusion.
 */
export function buildBatchKey(input: {
  conversationId?: string | undefined;
  ownerUserId: string;
  dialogue: string;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.conversationId ?? '', input.ownerUserId, input.dialogue]))
    .digest('hex');
  return `memory-observer:${digest}`;
}

/**
 * Extracted facts -> statements the engine can store.
 *
 * ## Per-element, and the unusable ones are dropped BEFORE the call
 *
 * A batch is all-or-nothing in the engine: if any statement fails to settle,
 * none of them are stored. So one unreadable `validStart` out of a model
 * would cost every good fact in the turn — dem-memory measured exactly that
 * ("135-01-01T00:00:00Z" out of GLM abandoning a half-written batch), and its
 * answer is this one: validate every timestamp BEFORE touching the store, and
 * drop the elements that fail.
 *
 * Normalization (`new Date(...).toISOString()`) rather than a second ISO
 * validator: `@ax/memory-facts-contract` is the authority on what a valid
 * instant is, and two validators for one rule is the drift invariant 4 is
 * about. What this does is produce a CANONICAL `Z` form from whatever the
 * model wrote, and reject what cannot be read at all.
 */
export function toStatements(
  facts: ReadonlyArray<ExtractedFact & { sourceTurnId?: string }>,
  opts: { ownerUserId: string; conversationId?: string | undefined },
): { statements: ObserverStatement[]; unusable: number; selfReports: number } {
  const statements: ObserverStatement[] = [];
  let unusable = 0;
  let selfReports = 0;
  for (const fact of facts) {
    // TASK-612: the agent describing what rules/instructions/memory it can
    // see is a snapshot of one session's system prompt, not a fact about the
    // world, and it goes stale the moment a person saves a Rule. Dropped
    // before anything else, and counted apart from `unusable` because it is
    // not an extractor failure.
    if (isAgentContextSelfReport(fact)) {
      selfReports += 1;
      continue;
    }
    const when = normalizeInstant(fact.validStart);
    if (when === undefined) {
      unusable += 1;
      continue;
    }
    const slot = deriveSlot(fact.predicate);
    statements.push({
      // Design §3.2. The extractor canonicalizes whoever is speaking as the
      // literal subject `user`; the store is keyed by agent alone, so left
      // as-is every person talking to a team agent collapses into one
      // subject. Same rewrite a read uses, so a read finds what this wrote.
      about: rewriteSpeaker(fact.subject, opts.ownerUserId),
      relation: fact.predicate,
      value: fact.object,
      when,
      // Hardcoded, and THIS LINE is the provenance rule: `extracted` because
      // this is the observer's door, not because anybody asked for it.
      // Design §3.4's immunity ordering (`human > agent > extracted`) is the
      // only thing that makes a person's correction survive the next chat
      // mention, and it only holds if the observer can never claim a higher
      // tier. Nothing reachable from model output can change this.
      provenance: 'extracted',
      // A SCOPE from `ctx`, never a hint from a payload.
      ownerUserId: opts.ownerUserId,
      // Provenance only, never a retrieval key — and absent rather than faked
      // when the turn has no conversation.
      ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
      // Provenance only (TASK-625), set by `attribution.ts` from OUR turn
      // ids — never from model output.
      ...(fact.sourceTurnId !== undefined ? { sourceTurnId: fact.sourceTurnId } : {}),
      ...(fact.kind !== undefined ? { kind: fact.kind } : {}),
      // The slot comes from the deterministic synonym table (design §3.3,
      // TASK-489), derived HERE from the predicate we are about to store —
      // never taken from model output, so an extractor-emitted `slot` or
      // `provenance` field cannot reach the store. A relation the table does
      // not know lands with no slot: stored, retrievable, and inert for
      // supersession, exactly like every other unmapped row. Not
      // `PENDING_SLOT` either: pending raises `degraded: ['pending']` on
      // every recall, and a flag about a component that does not exist to
      // drain it is noise rather than signal — the same call
      // `memory:remember` made. Neither the model nor the caller decides.
      ...(slot !== null ? { slot } : {}),
    });
  }
  return { statements, unusable, selfReports };
}

/**
 * A model-written instant -> canonical ISO-8601 with an explicit `Z`, or
 * `undefined` when it cannot be read at all.
 */
function normalizeInstant(value: string): string | undefined {
  const parsed = new Date(value);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return undefined;
  return parsed.toISOString();
}

export class ObserverTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`memory observer exceeded ${timeoutMs}ms`);
    this.name = 'ObserverTimeoutError';
  }
}

/**
 * Bound a promise.
 *
 * `LlmCallInput` carries no `AbortSignal`, so the slow call continues in the
 * background and its eventual result is discarded — this bounds the WAIT, not
 * the round trip. It still matters: the observer is detached from `chat:end`,
 * so nothing else would ever stop it, and an unbounded detached extraction is
 * a promise that holds the transcript alive forever.
 *
 * `unref()` so a pending timer never keeps Node alive at shutdown.
 */
async function raceTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ObserverTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
