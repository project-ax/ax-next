import { createHash } from 'node:crypto';

import { extractFacts, type ExtractedFact, type LlmCallFn } from './extract.js';
import { rewriteSpeaker } from './subject.js';
import {
  filterDialogue,
  hasUserContent,
  renderDialogue,
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
  /** Provenance only, never a retrieval key. Absent on a turn with no conversation. */
  conversationId?: string | undefined;
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

  const mapped = toStatements(extraction.facts, {
    ownerUserId: input.ownerUserId,
    conversationId: input.conversationId,
  });
  if (mapped.statements.length === 0) {
    // "The extractor found nothing durable" and "the extractor found things
    // and every one was unreadable" are different events, and only the first
    // is ordinary.
    return mapped.unusable > 0
      ? { kind: 'all-unusable', unusable: mapped.unusable }
      : { kind: 'skipped', reason: 'no-facts' };
  }

  const batchKey = buildBatchKey({
    conversationId: input.conversationId,
    ownerUserId: input.ownerUserId,
    dialogue,
  });

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
    retried: extraction.retried,
    batchKey,
  };
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
  facts: readonly ExtractedFact[],
  opts: { ownerUserId: string; conversationId?: string | undefined },
): { statements: ObserverStatement[]; unusable: number } {
  const statements: ObserverStatement[] = [];
  let unusable = 0;
  for (const fact of facts) {
    const when = normalizeInstant(fact.validStart);
    if (when === undefined) {
      unusable += 1;
      continue;
    }
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
    });
    // No `slot`. Slot derivation is the normalizer's job (design §3.3,
    // TASK-489), so a statement recorded here is INERT for supersession: it
    // closes nothing and nothing closes it, exactly like every other no-slot
    // row. That is under-closing — the measured baseline and the safe
    // direction, because a false positive (`visited` -> `lives_in`) closes a
    // true fact while a false negative merely leaves two. Not `PENDING_SLOT`
    // either: pending additionally raises `degraded: ['pending']` on every
    // recall, and a flag about a component that does not exist to drain it is
    // noise rather than signal — the same call `memory:remember` made.
  }
  return { statements, unusable };
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
