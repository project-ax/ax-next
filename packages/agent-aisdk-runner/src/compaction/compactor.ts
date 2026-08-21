// ---------------------------------------------------------------------------
// Compaction policy: when to run the ladder, and when to stop trying.
//
// Wired as `prepareStep` on the `ToolLoopAgent` (design §7), which is the one
// hook that gets to rewrite the message list per step and have the rewrite
// carry forward to later steps of the same turn.
//
// WHAT IT DOES NOT DO, and why:
//
//   - It does not write to the transcript. Compaction is a SEND-SITE
//     transform, exactly like the reasoning prune in provider.ts. The
//     transcript's bytes are the host's source of truth (`prefixHash`, resume,
//     the display history the UI renders); rewriting them to save room in one
//     request would trade a recoverable context problem for an unrecoverable
//     history one. The consequence is that the stored conversation keeps
//     growing while the SENT one does not, which is fine and intended — the
//     ladder is deterministic, so the same stored messages compact the same way
//     on every step and every resume.
//   - It does not retry. Design §7 is explicit that the failure mode to avoid
//     is thrashing: each step applies the ladder once, and if the fully
//     compacted prompt is still over the ceiling the turn fails with a message
//     a person can act on.
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
// ---------------------------------------------------------------------------

import type { ModelMessage } from 'ai';
import { contextWindowFor } from './context-window.js';
import {
  estimateMessageTokens,
  estimatePromptOverheadTokens,
} from './estimate.js';
import { maskStaleToolOutputs, pruneOldToolCalls } from './ladder.js';

/**
 * Fraction of the window at which the ladder starts running. Design §7 says
 * 0.5-0.7; Gemini CLI uses 0.5 for the same decision. 0.6 leaves headroom for
 * one more large tool result plus the response, without spending fidelity on
 * conversations that were never going to get close.
 */
const COMPACT_AT = 0.6;

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

export interface Compactor {
  /** `prepareStep` body. Returns `undefined` to leave the step untouched. */
  step(input: CompactStepInput): { messages: ModelMessage[] } | undefined;
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
  const ceiling = contextWindowTokens * CEILING_AT;

  return {
    contextWindowTokens,

    step({ steps, messages }) {
      const reported = steps[steps.length - 1]?.usage.inputTokens;
      const estimatedBefore = overhead + estimateMessageTokens(messages);
      const used = reported ?? estimatedBefore;
      if (used < compactThreshold) return undefined;

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
      if (estimatedAfter >= estimatedBefore) return undefined;

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
  };
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
