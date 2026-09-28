import { createHash } from 'node:crypto';

import { attributeFacts, attributeSpeakers } from './attribution.js';
import { extractFacts, type ExtractedFact, type LlmCallFn } from './extract.js';
import { dropNegatedFacts } from './negation.js';
import { isAgentContextSelfReport } from './self-report.js';
import { deriveSlot, type Slot } from './slots.js';
import { rewriteSpeaker } from './subject.js';
import { dropTwins, hasActiveTwin, hasRetractedTwin, type PriorRow } from './twins.js';
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
  /**
   * Who spoke that turn (TASK-648) — set by `attribution.ts` from OUR
   * transcript's roles, only when the turn shares the fact's words. Never
   * from model output, and never a tier: the statement stays `extracted`.
   * Set on the legacy `chat:end` path too, from its messages' roles
   * (TASK-661), though that path has no `sourceTurnId`.
   */
  sourceRole?: 'user' | 'assistant';
  kind?: MemoryStatementKind;
  slot?: Slot;
}

/** Where an extracted fact came from, as `attribution.ts` decided it. */
type SourceTurn = { sourceTurnId?: string; sourceRole?: 'user' | 'assistant' };

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
   * Every fact was a positive reading of something the dialogue only ever
   * negated ("I never lived in Denver" -> `lives_in | Denver`) — TASK-652,
   * `negation.ts`. Counted and named apart, like the self-reports.
   */
  | { kind: 'skipped'; reason: 'only-negations'; negated: number }
  /**
   * Every fact restated something the agent or the person had already saved
   * in this conversation (TASK-641, `twins.ts`), or a value the person had
   * marked never right (TASK-654). Ordinary: the first IS in memory, once,
   * under the higher tier; the second is what the person asked for.
   */
  | {
      kind: 'skipped';
      reason: 'only-twins';
      twins: number;
      /** Restatements of a value marked never right, dropped (TASK-654). */
      retracted: number;
      twinCheck: TwinCheck;
      /**
       * Why a twin read failed, when one did. Reachable here since TASK-654:
       * a failed conversation read keeps the batch, and the retracted check
       * can then drop all of it.
       */
      twinCheckError?: Error;
    }
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
      /**
       * Facts dropped because they read a negated statement as the positive
       * fact (TASK-652, `negation.ts`). Not `unusable`: the fact parsed fine,
       * it just said the opposite of the dialogue.
       */
      negated: number;
      /** Facts dropped because only a context turn supported them. */
      contextOnly: number;
      /**
       * Facts dropped because an agent- or human-saved row in the same
       * conversation already said them (TASK-641, `twins.ts`).
       */
      twins: number;
      /**
       * Facts dropped because they restated a SLOT-LESS row the person had
       * marked never right, in any conversation, and did not come from the
       * person's own turn (TASK-654, `twins.ts`'s `hasRetractedTwin`).
       */
      retracted: number;
      /** Whether the twin check ran — see {@link TwinCheck}. */
      twinCheck: TwinCheck;
      /** Why the twin check failed, when it did (TASK-649). */
      twinCheckError?: Error;
      retried: boolean;
      batchKey: string;
    };

/**
 * What happened to the twin checks (TASK-641, and TASK-654's retracted-twin
 * check):
 *
 * - `ran` — at least one of the two checks read its rows and dropped what
 *   it matched. The retracted check is owner-scoped, so it can run on a
 *   routine or conversation-less turn the conversation check skips;
 * - `skipped` — neither had anything to check against: no conversation for
 *   the first, no slot-less non-user statement for the second, or no reader
 *   wired;
 * - `failed` — the read threw, and the batch was recorded UNFILTERED (or,
 *   when only the TASK-649 chain read threw, with the statements it was
 *   asked about kept). Fail open on purpose: the check only removes a
 *   duplicate, and dropping a whole batch of real facts over a read error
 *   would be the worse loss. Reported, with its cause, so it is never silent.
 */
export type TwinCheck = 'ran' | 'skipped' | 'failed';

/**
 * Reads the rows already stored for the batch's conversation, for the twin
 * check: every row (active or closed) for these subjects, owned by the
 * batch's owner, in the batch's conversation. Provenance included.
 */
export type PriorRowsFn = (query: {
  abouts: string[];
  ownerUserId: string;
  conversationId: string;
}) => Promise<PriorRow[]>;

/**
 * Whether `value` is one the person marked NEVER right in the owner's
 * `(about, slot)` chain — across conversations, closed rows included. The
 * same rule `profile.ts`'s `restatedByPerson` applies at read time (TASK-648).
 */
export type RetractedValueFn = (query: {
  about: string;
  slot: string;
  value: string;
  ownerUserId: string;
}) => Promise<boolean>;

/**
 * Reads the owner's rows about these subjects in EVERY conversation, active
 * and closed, for the retracted-twin check (TASK-654). `neverTrue` included.
 */
export type RetractedRowsFn = (query: {
  abouts: string[];
  ownerUserId: string;
}) => Promise<PriorRow[]>;

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
  /**
   * The twin check's read (TASK-641). Absent = no check, which is how the
   * pure-function tests that predate it keep their exact behaviour.
   */
  priorRows?: PriorRowsFn;
  /**
   * The chain read behind the twin check's one exception (TASK-649) — see
   * {@link withoutTwins}. Absent = no exception.
   */
  retractedValue?: RetractedValueFn;
  /**
   * The read behind the retracted-twin check (TASK-654) — see
   * {@link withoutTwins}. Absent = no check.
   */
  retractedRows?: RetractedRowsFn;
}

export async function runObserver(input: RunObserverInput): Promise<ObserverResult> {
  const turns = filterDialogue(input.messages);
  if (turns.length === 0) return { kind: 'skipped', reason: 'no-dialogue' };
  if (!hasUserContent(turns)) return { kind: 'skipped', reason: 'no-user-content' };

  const dialogue = renderDialogue(turns);
  return extractAndRecord(input, dialogue, {
    // No turn ids here, so no `sourceTurnId` — but the speaker (TASK-661).
    attribute: (facts) => ({ facts: attributeSpeakers(facts, turns), contextOnly: 0 }),
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
 * key made of the turn RANGE — so a pass that re-runs over EXACTLY the same
 * turns (a retry, a restart after a lost cursor write with nothing said
 * since) is an engine no-op rather than a second copy. A range that grew is
 * a different key; keeping passes from overlapping is the cursor's job.
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
      facts: Array<ExtractedFact & SourceTurn>;
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
  // TASK-652: a negated statement read as the positive fact is dropped before
  // anything is mapped. Checked against the whole dialogue the extractor saw,
  // so one un-negated mention anywhere keeps the fact.
  const polarity = dropNegatedFacts(attributed.facts, dialogue);
  const mapped = toStatements(polarity.facts, {
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
    if (polarity.negated > 0) {
      return { kind: 'skipped', reason: 'only-negations', negated: polarity.negated };
    }
    if (attributed.contextOnly > 0) {
      return { kind: 'skipped', reason: 'only-context', contextOnly: attributed.contextOnly };
    }
    return { kind: 'skipped', reason: 'no-facts' };
  }

  const { statements, twins, retracted, twinCheck, twinCheckError } = await withoutTwins(
    input,
    mapped.statements,
  );
  if (statements.length === 0) {
    return {
      kind: 'skipped',
      reason: 'only-twins',
      twins,
      retracted,
      twinCheck,
      ...(twinCheckError !== undefined ? { twinCheckError } : {}),
    };
  }

  const batchKey = how.batchKey();

  const result = await input.record({ batchKey, statements });
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
    negated: polarity.negated,
    contextOnly: attributed.contextOnly,
    twins,
    retracted,
    twinCheck,
    ...(twinCheckError !== undefined ? { twinCheckError } : {}),
    retried: extraction.retried,
    batchKey,
  };
}

/**
 * Both write-time twin checks, in order: the conversation's own twins
 * ({@link withoutConversationTwins}), then a restatement of a value the
 * person marked never right ({@link withoutRetractedTwins}). Either read
 * failing reports `failed` and keeps what it was asked about.
 */
async function withoutTwins(
  input: Pick<
    RunObserverInput,
    'priorRows' | 'retractedValue' | 'retractedRows' | 'ownerUserId' | 'statementConversationId'
  >,
  statements: ObserverStatement[],
): Promise<{
  statements: ObserverStatement[];
  twins: number;
  retracted: number;
  twinCheck: TwinCheck;
  twinCheckError?: Error;
}> {
  const same = await withoutConversationTwins(input, statements);
  const never = await withoutRetractedTwins(input, same.statements);
  const twinCheckError = same.twinCheckError ?? never.error;
  const twinCheck: TwinCheck =
    twinCheckError !== undefined
      ? 'failed'
      : same.twinCheck === 'ran' || never.ran
        ? 'ran'
        : 'skipped';
  return {
    statements: never.statements,
    twins: same.twins,
    retracted: never.retracted,
    twinCheck,
    ...(twinCheckError !== undefined ? { twinCheckError } : {}),
  };
}

/**
 * The retracted-twin check (TASK-654; human ruling, Vinay 2026-09-28:
 * "observer checks at write").
 *
 * A value the person marked NEVER right is hidden on read only inside a
 * single-valued slot (`profile.ts`). A SLOT-LESS row is in no chain, and its
 * re-extraction is usually paraphrased, so no read can match it — the walk's
 * "Denver" / "Oct 14" rows came straight back. So, before writing, a
 * slot-less statement that twins (`twins.ts`'s `hasRetractedTwin`) a
 * never-right row of the owner's — any conversation, any provenance — is
 * dropped.
 *
 * Kept when the person said it in their own turn (`sourceRole: 'user'`, the
 * TASK-648 ruling): nothing on read hides a slot-less row, so writing it is
 * what brings the value back. Both extraction paths attribute the speaker —
 * the legacy `chat:end` path too, from its messages' roles (TASK-661). An
 * UNKNOWN speaker (a paraphrase no turn shares a word with) is not the person.
 *
 * Slotted statements are left to the read side, whose exact `(about, slot)`
 * rule already hides them (TASK-639) and resurfaces a person's restatement
 * (TASK-648). Negation misreadings were dropped upstream (TASK-652).
 *
 * Fails OPEN like the rest of the twin check: a read error keeps every
 * statement and is reported. Known limit: the read is the owner's newest
 * {@link RetractedRowsFn} page per subject; a retraction older than that page
 * is not seen, and the statement is written (the pre-TASK-654 behaviour).
 */
async function withoutRetractedTwins(
  input: Pick<RunObserverInput, 'retractedRows' | 'ownerUserId'>,
  statements: ObserverStatement[],
): Promise<{ statements: ObserverStatement[]; retracted: number; ran: boolean; error?: Error }> {
  const candidates = statements.filter((s) => s.slot === undefined && s.sourceRole !== 'user');
  if (input.retractedRows === undefined || candidates.length === 0) {
    return { statements, retracted: 0, ran: false };
  }
  let rows: PriorRow[];
  try {
    rows = await input.retractedRows({
      abouts: [...new Set(candidates.map((s) => s.about))],
      ownerUserId: input.ownerUserId,
    });
  } catch (err) {
    return { statements, retracted: 0, ran: false, error: asError(err) };
  }
  const drop = new Set(candidates.filter((s) => hasRetractedTwin(s, rows)));
  return {
    statements: statements.filter((s) => !drop.has(s)),
    retracted: drop.size,
    ran: true,
  };
}

/**
 * Drop the statements that restate an agent- or human-saved row of the same
 * conversation (TASK-641, `twins.ts`). Fails OPEN — see {@link TwinCheck}.
 *
 * Only a conversation-attributed batch is checked: the twin rule is scoped to
 * one conversation, and a routine run's rows carry none (TASK-616).
 *
 * A batch that re-runs under the same key after a twin was saved can drop a
 * different set than the first run did; the engine answers a replayed key
 * with the rows it already holds, so nothing is written twice either way.
 *
 * ## The one exception (TASK-649, for TASK-648)
 *
 * A twin is KEPT when all of these hold: the person said it in their own turn
 * (`sourceRole: 'user'`), it has a slot, one of its twins is still ACTIVE, and
 * its value is one the person had marked never right in that slot's chain.
 * That row is what `profile.ts`'s `restatedByPerson` resurfaces the value
 * from; the agent note it twins stays hidden as a retracted value on a
 * non-human row, so nothing shows twice. Dropping it instead left the value
 * the person just restated hidden behind their old Fix.
 *
 * An active twin is required so TASK-641's in-window Fix still holds: when
 * the note was Fixed as never right BEFORE the pass over the turn it came
 * from, every twin is closed and the extractor's copy is still dropped.
 * Residual, stated: the person restating it in a LATER turn of the same
 * conversation with no fresh agent note looks the same and is dropped too.
 */
async function withoutConversationTwins(
  input: Pick<
    RunObserverInput,
    'priorRows' | 'retractedValue' | 'ownerUserId' | 'statementConversationId'
  >,
  statements: ObserverStatement[],
): Promise<{
  statements: ObserverStatement[];
  twins: number;
  twinCheck: TwinCheck;
  twinCheckError?: Error;
}> {
  const conversationId = input.statementConversationId;
  if (input.priorRows === undefined || conversationId === undefined) {
    return { statements, twins: 0, twinCheck: 'skipped' };
  }
  let prior: PriorRow[];
  try {
    prior = await input.priorRows({
      abouts: [...new Set(statements.map((s) => s.about))],
      ownerUserId: input.ownerUserId,
      conversationId,
    });
  } catch (err) {
    return { statements, twins: 0, twinCheck: 'failed', twinCheckError: asError(err) };
  }
  const spared = new Set<ObserverStatement>();
  let twinCheckError: Error | undefined;
  for (const s of statements) {
    if (s.sourceRole !== 'user' || s.slot === undefined || input.retractedValue === undefined) continue;
    if (!hasActiveTwin(s, prior)) continue;
    try {
      const retracted = await input.retractedValue({
        about: s.about,
        slot: s.slot,
        value: s.value,
        ownerUserId: input.ownerUserId,
      });
      if (retracted) spared.add(s);
    } catch (err) {
      // Fail open, like the read above: keep the statement, say so.
      spared.add(s);
      twinCheckError ??= asError(err);
    }
  }
  const { kept, twins } = dropTwins(statements, prior, (s) => spared.has(s));
  return twinCheckError !== undefined
    ? { statements: kept, twins, twinCheck: 'failed', twinCheckError }
    : { statements: kept, twins, twinCheck: 'ran' };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
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
  facts: ReadonlyArray<ExtractedFact & SourceTurn>,
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
      // Provenance only (TASK-648), same source as `sourceTurnId`. An explicit
      // allowlist rather than a copy: the fact object passed through the
      // extractor's parse, so nothing but these two literals may reach the
      // store under this name.
      ...(fact.sourceRole === 'user' || fact.sourceRole === 'assistant'
        ? { sourceRole: fact.sourceRole }
        : {}),
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
