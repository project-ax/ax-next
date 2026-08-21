// ---------------------------------------------------------------------------
// Compaction policy: when to run the ladder, and when to stop trying.
//
// TWO ENTRY POINTS, because the ladder's rungs are not the same kind of thing.
//
//   `step()` — wired as `prepareStep` on the `ToolLoopAgent`, the one hook that
//   gets to rewrite the message list per step and have the rewrite carry
//   forward to later steps of the same turn. Runs rungs 1-2 and owns the
//   ceiling.
//
//   `turn()` — called from the loop at the turn boundary, after the user's
//   message is appended and before `agent.stream()`. Runs rung 3. Its site is
//   argued in summarize.ts: an LLM call and a persisted rewrite have no safe
//   moment inside a tool loop.
//
// WHAT THIS DOES NOT DO, and why:
//
//   - Rungs 1-2 do not write to the transcript. They are SEND-SITE transforms,
//     exactly like the reasoning prune in provider.ts. The transcript's bytes
//     are the host's source of truth (`prefixHash`, resume, the display history
//     the UI renders), and they are deterministic pure functions, so the stored
//     conversation keeps growing while the SENT one does not and every step and
//     every resume recomputes the same result for free.
//
//     Rung 3 is the deliberate exception: a model call cannot be recomputed for
//     free, and a summary that is not persisted would be bought again on the
//     next turn and on every resume. It rewrites the transcript and ships the
//     rewrite through `session.replace-transcript` — the caller's job, not
//     this module's (see main.ts).
//   - It does not retry. Design §7 is explicit that the failure mode to avoid
//     is thrashing: each step applies rungs 1-2 once, and if the fully
//     compacted prompt is still over the ceiling the turn fails with a message
//     a person can act on. A failed rung 3 falls through to exactly that path
//     and is not attempted again until the conversation has grown materially.
//   - It does not touch `@ax/memory-strata`. That plugin owns CROSS-conversation
//     memory off `chat:end`; this owns IN-turn context. Neither reads the
//     other (invariant 4).
//
// THE SIGNAL. `usage.inputTokens` from the previous step is authoritative and
// is used whenever it exists. It does not exist at step 0 of a turn — every
// turn is a fresh `stream()` call — so the estimator in estimate.ts stands in
// there. Relative reductions are always measured with the estimator and applied
// as a RATIO to the authoritative number, so the ladder's arithmetic inherits
// the provider's accuracy rather than the estimator's.
//
// At the TURN boundary there is no previous step at all, so `turn()` uses the
// same trick one step further out. Every step remembers the estimate for the
// messages it handed off; the report that arrives on the NEXT step is a count of
// exactly that request, so `reported / that estimate` is the estimator's scale
// error and nothing else. `turn()` multiplies its estimate by it. It is still an
// estimate — which is why, exactly as at the ceiling, it is allowed to decide
// "spend a model call" and never allowed to decide "end this conversation".
// ---------------------------------------------------------------------------

import type { ModelMessage } from 'ai';
import { contextWindowFor } from './context-window.js';
import {
  estimateMessageTokens,
  estimatePromptOverheadTokens,
} from './estimate.js';
import { maskStaleToolOutputs, pruneOldToolCalls } from './ladder.js';
import {
  summarizeConversation,
  type SummarizeFailure,
  type SummarizeText,
} from './summarize.js';

/**
 * Fraction of the window at which the ladder starts running. Design §7 says
 * 0.5-0.7; Gemini CLI uses 0.5 for the same decision. 0.6 leaves headroom for
 * one more large tool result plus the response, without spending fidelity on
 * conversations that were never going to get close.
 */
const COMPACT_AT = 0.6;

/**
 * Fraction of the window at which rung 3 (summarize) fires at the turn
 * boundary, sitting between the rung 1-2 trigger and the ceiling.
 *
 * The ladder is cheapest-first, so this is deliberately NOT the same number as
 * `COMPACT_AT`: rungs 1-2 get to try first, and rung 3 is only reached when the
 * conversation is large enough that even a fully masked-and-pruned version of
 * it is at 0.75 of the window — i.e. the growth is in the CONVERSATION, not in
 * one turn's tool output, and no amount of send-site surgery will fix it.
 *
 * Below the 0.9 ceiling on purpose: rung 3 exists to stop a conversation
 * reaching the ceiling, so firing at the ceiling would be firing too late.
 */
const SUMMARIZE_AT = 0.75;

/**
 * How much a conversation must GROW after a failed summarization before rung 3
 * is attempted again, as a fraction of the message count at the failure.
 *
 * Design §7's "do not retry in a loop" is about one attempt, and this is the
 * cross-turn form of the same rule. Without it a deterministic failure (a
 * summarizer that keeps producing something larger than the span) would buy a
 * model call at the top of every remaining turn and change nothing. Growth is
 * the signal that the input is materially different from the one that failed.
 */
const RETRY_AFTER_GROWTH = 1.25;

/**
 * Fraction of the window above which a FULLY compacted prompt is treated as
 * hopeless. Not 1.0: the request also has to fit the model's response, and a
 * prompt at 95% leaves no room to answer.
 */
const CEILING_AT = 0.9;

/**
 * The turn-ending error when even a fully compacted conversation does not fit.
 *
 * Its message is user-facing. A thrown loop error becomes the runner's
 * `chat:end{terminated}` reason, which the orchestrator turns into
 * `chat:turn-error` and the UI shows on the retry card — so it is written for
 * the person reading it, not for a log grep.
 */
export class ContextWindowExceededError extends Error {
  override readonly name = 'ContextWindowExceededError';
  /**
   * Nominal marker. The AI SDK wraps whatever `prepareStep` throws before the
   * turn loop sees it, and `instanceof` across a package boundary is exactly
   * the check that breaks when two copies of a module load. A own-property
   * brand survives both.
   */
  readonly isContextWindowExceededError = true;

  constructor(message: string) {
    super(message);
  }
}

/**
 * Find a `ContextWindowExceededError` anywhere in an error's `cause` chain.
 *
 * The turn loop calls this so the ceiling message reaches the user intact
 * instead of arriving as `model call failed: AI_NoOutputGeneratedError…`, which
 * is what the SDK's own wrapper would say.
 */
export function findContextWindowExceeded(
  err: unknown,
): ContextWindowExceededError | undefined {
  // Bounded rather than `while (true)`: a hand-built error with a cycle in its
  // cause chain would otherwise hang the failure path.
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth++) {
    if (
      typeof current === 'object' &&
      (current as { isContextWindowExceededError?: unknown })
        .isContextWindowExceededError === true
    ) {
      return current as ContextWindowExceededError;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The subset of `prepareStep`'s options this needs. */
export interface CompactStepInput {
  /**
   * Steps already executed in THIS `stream()` call — empty at step 0, which is
   * why the estimator exists.
   */
  steps: ReadonlyArray<{ usage: { inputTokens: number | undefined } }>;
  /** The messages that would be sent for this step. */
  messages: ModelMessage[];
}

/** What `turn()` is handed: the whole stored conversation, quiescent. */
export interface CompactTurnInput {
  /** Every message in the transcript, including the just-appended user turn. */
  messages: readonly ModelMessage[];
}

/** What `turn()` did, for the caller's log and the caller's persist decision. */
export type CompactTurnResult =
  | { summarized: true; messages: ModelMessage[] }
  | { summarized: false; reason: 'below-threshold' | SummarizeFailure | 'backoff' };

export interface Compactor {
  /** `prepareStep` body. Returns `undefined` to leave the step untouched. */
  step(input: CompactStepInput): { messages: ModelMessage[] } | undefined;
  /**
   * Rung 3, at the turn boundary. When it answers `summarized: true` the caller
   * MUST adopt `messages` as the transcript and persist the rewrite — the model
   * call has already been paid for, and a summary that is not stored is bought
   * again next turn.
   */
  turn(input: CompactTurnInput): Promise<CompactTurnResult>;
  /** The window this compactor is sizing against. Test/diagnostic seam. */
  readonly contextWindowTokens: number;
}

export interface CreateCompactorOptions {
  /** `agentConfig.model` — sizes the context window. */
  modelRef: string;
  /** The composed system prompt, for the fixed-overhead estimate. */
  instructions: string;
  /** How many tools are registered, for the same. */
  toolCount: number;
  /**
   * The summarizer call for rung 3. OMITTING IT DISABLES RUNG 3 — `turn()`
   * still answers, always `below-threshold`. That is the shape the ladder's own
   * unit tests use, and it is also the honest default for any future caller
   * that has no model to spend: rungs 1-2 plus the ceiling remain a complete,
   * working compactor on their own.
   */
  summarizeText?: SummarizeText;
  /** Where the per-compaction line goes. Defaults to stderr. */
  log?: (line: string) => void;
}

export function createCompactor(opts: CreateCompactorOptions): Compactor {
  const contextWindowTokens = contextWindowFor(opts.modelRef);
  const overhead = estimatePromptOverheadTokens({
    instructions: opts.instructions,
    toolCount: opts.toolCount,
  });
  const log =
    opts.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  const compactThreshold = contextWindowTokens * COMPACT_AT;
  const summarizeThreshold = contextWindowTokens * SUMMARIZE_AT;
  const ceiling = contextWindowTokens * CEILING_AT;

  /**
   * How wrong the estimator has been, most recently: reported ÷ estimated for
   * THE SAME REQUEST. 1 until the provider has reported anything, which is the
   * honest starting point — an uncalibrated estimator is the estimator.
   */
  let calibration = 1;

  /**
   * The estimate for the messages the LAST call to `step()` handed off, which
   * is what the provider's next report will be a count OF.
   *
   * Pairing the report with `estimatedBefore` instead would be quietly wrong:
   * `estimatedBefore` is the CURRENT step's list, which is the previous one
   * plus that step's response messages — so on a step whose tool returned 50 KB
   * the two describe visibly different requests, and the ratio would read low
   * by however much that tool printed. Biased low is the safe direction (rung 3
   * fires later), which is exactly why the bias would never have shown up as a
   * bug.
   */
  let lastSentEstimate: number | undefined;

  /**
   * Message count at the last FAILED rung-3 attempt, or 0. Backs the
   * grow-before-retry rule; see `RETRY_AFTER_GROWTH`.
   */
  let lastSummarizeFailureAt = 0;

  return {
    contextWindowTokens,

    step({ steps, messages }) {
      const reported = steps[steps.length - 1]?.usage.inputTokens;
      const estimatedBefore = overhead + estimateMessageTokens(messages);
      // Learn the estimator's scale error whenever the provider reports one.
      // `reported` is the provider's count for the request the PREVIOUS call to
      // this function handed off, so it is paired with that call's estimate —
      // not with this step's. Both include the fixed overhead, so the ratio is
      // the estimator's scale error and nothing else. Recorded before the early
      // return below, because the most useful reports come from steps that did
      // not need compacting at all.
      if (reported !== undefined && lastSentEstimate !== undefined && lastSentEstimate > 0) {
        calibration = reported / lastSentEstimate;
      }
      const used = reported ?? estimatedBefore;
      if (used < compactThreshold) {
        lastSentEstimate = estimatedBefore;
        return undefined;
      }

      // Rung 1, then rung 2 only if rung 1 was not enough. `project` converts
      // the estimator's relative reduction into the same units as `used`.
      const rungs: string[] = ['mask'];
      let compacted = maskStaleToolOutputs(messages);
      let estimatedAfter = overhead + estimateMessageTokens(compacted);
      if (project(used, estimatedBefore, estimatedAfter) >= compactThreshold) {
        compacted = pruneOldToolCalls(compacted);
        estimatedAfter = overhead + estimateMessageTokens(compacted);
        rungs.push('prune');
      }

      const projected = project(used, estimatedBefore, estimatedAfter);

      // The ceiling fires only on a number the PROVIDER reported. Ending a
      // conversation on the strength of a chars-per-token guess would be the
      // worst possible false positive, and there is a better fallback: send the
      // compacted prompt, and either it fits or the provider's own
      // context-length error says so in its own words.
      if (reported !== undefined && projected >= ceiling) {
        throw new ContextWindowExceededError(
          `This conversation no longer fits in ${opts.modelRef}'s context ` +
            `window (about ${contextWindowTokens.toLocaleString('en-US')} tokens), ` +
            `even after dropping older tool output. Starting a new conversation ` +
            `is the way forward — this one stays here, it just can't take ` +
            `another turn.`,
        );
      }

      // Nothing left to reclaim: hand back the original array rather than an
      // identical copy, so the step carries forward unchanged.
      if (estimatedAfter >= estimatedBefore) {
        lastSentEstimate = estimatedBefore;
        return undefined;
      }
      lastSentEstimate = estimatedAfter;

      // One line per compacting step, on stderr. Names WHICH signal fired,
      // because "the estimate said so" and "the provider said so" are very
      // different claims when someone is reading back why a session lost its
      // older tool output.
      log(
        `[aisdk-runner] compaction: ${rungs.join('+')} — ` +
          `${Math.round(used).toLocaleString('en-US')} of ` +
          `${contextWindowTokens.toLocaleString('en-US')} tokens used ` +
          `(${reported === undefined ? 'estimated' : 'reported'}), ` +
          `~${Math.round(projected).toLocaleString('en-US')} after; ` +
          `${messages.length} messages in, ${compacted.length} out`,
      );
      return { messages: compacted };
    },

    // ---- rung 3, at the turn boundary ------------------------------------
    //
    // The ladder is cheapest-first, and this is where that ordering is
    // enforced across the boundary between the two entry points: rung 3 does
    // not fire because the conversation is big, it fires because the
    // conversation is big AFTER rungs 1-2 have already had their turn. The
    // hypothetical mask+prune below is the same pair of pure functions
    // `step()` will run on this list a moment later, so "what will the send
    // site manage on its own?" is answered by asking it, not by guessing.
    async turn({ messages }) {
      if (opts.summarizeText === undefined) {
        return { summarized: false, reason: 'below-threshold' };
      }

      const asStored = calibrated(overhead + estimateMessageTokens(messages));
      if (asStored < summarizeThreshold) {
        return { summarized: false, reason: 'below-threshold' };
      }

      const floor = calibrated(
        overhead +
          estimateMessageTokens(pruneOldToolCalls(maskStaleToolOutputs(messages))),
      );
      if (floor < summarizeThreshold) {
        return { summarized: false, reason: 'below-threshold' };
      }

      // §7's no-thrashing rule, in its cross-turn form. A summarizer that fails
      // deterministically would otherwise be re-invoked at the top of every
      // remaining turn, spending real money to produce the same failure.
      if (
        lastSummarizeFailureAt > 0 &&
        messages.length < lastSummarizeFailureAt * RETRY_AFTER_GROWTH
      ) {
        return { summarized: false, reason: 'backoff' };
      }

      const result = await summarizeConversation({
        messages,
        summarizeText: opts.summarizeText,
      });

      if (!result.ok) {
        lastSummarizeFailureAt = messages.length;
        // Loud, because this is the rung that was supposed to save the
        // conversation and did not. The turn continues on rungs 1-2 and, if
        // they are not enough, ends at the ceiling with a message that tells
        // the user to start a new conversation — so silence here would leave
        // nobody able to explain why compaction "didn't work".
        log(
          `[aisdk-runner] compaction: summarize FAILED (${result.reason}` +
            `${result.detail === undefined ? '' : `: ${result.detail}`}) — ` +
            `continuing without it; masking and pruning still apply`,
        );
        return { summarized: false, reason: result.reason };
      }

      lastSummarizeFailureAt = 0;
      // The next `step()` will be handed this list (post-`messagesForProvider`),
      // so seed the pairing with it rather than leaving the previous turn's
      // much larger figure to be divided into this turn's report.
      const after = calibrated(overhead + estimateMessageTokens(result.messages));
      lastSentEstimate = undefined;
      log(
        `[aisdk-runner] compaction: summarize — ` +
          `~${Math.round(asStored).toLocaleString('en-US')} of ` +
          `${contextWindowTokens.toLocaleString('en-US')} tokens before, ` +
          `~${Math.round(after).toLocaleString('en-US')} after; ` +
          `${messages.length} messages in, ${result.messages.length} out`,
      );
      return { summarized: true, messages: result.messages };
    },
  };

  /** The estimator's number, scaled by what the provider has taught us. */
  function calibrated(estimated: number): number {
    return estimated * calibration;
  }
}

/**
 * Scale an authoritative token count by the estimator's before/after ratio.
 *
 * Guards a zero `before`, which can only happen for an empty message list —
 * and an empty list is never over the threshold, so the guard is unreachable
 * rather than load-bearing.
 */
function project(used: number, before: number, after: number): number {
  if (before <= 0) return used;
  return used * (after / before);
}
