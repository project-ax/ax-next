import type { TurnUsage } from '@ax/agent-runner-core';

// ---------------------------------------------------------------------------
// Per-turn token accounting for the AI SDK loop (TASK-692, per-user spend
// limits).
//
// The loop reports what a turn cost through `EndTurnInput.usage`. This module
// is the pure part of producing that number: it sums the `usage` of every model
// step of the turn (a tool-using turn is several round trips, each billed).
//
// `ai@7`'s `LanguageModelUsage` is a TOTAL-plus-breakdown shape, and the wire
// wants DISJOINT buckets, so the input side needs care:
//
//   inputTokens                     total input, cache reads + writes INCLUDED
//   inputTokenDetails.noCacheTokens the standard-rate part (when reported)
//   inputTokenDetails.cacheRead/... cached input read / written
//   outputTokens                    total output, reasoning INCLUDED
//
// Summing `inputTokens` as-is would bill every cached token at the full input
// rate on top of its cache rate. So standard input is `noCacheTokens` when the
// provider reports it, else `inputTokens - cacheRead - cacheWrite` (floored at
// 0). Output is used as-is: `outputTokenDetails.reasoningTokens` is already
// inside `outputTokens`, so adding it would double-charge thinking.
// ---------------------------------------------------------------------------

/**
 * The slice of `ai@7`'s `LanguageModelUsage` this module reads, typed
 * structurally so the module needs nothing from `ai` and the unit tests need
 * not fabricate a whole `StepResult`. Every field may be missing: providers
 * report what they report.
 */
export interface StepUsageLike {
  inputTokens?: number | undefined;
  inputTokenDetails?:
    | {
        noCacheTokens?: number | undefined;
        cacheReadTokens?: number | undefined;
        cacheWriteTokens?: number | undefined;
      }
    | undefined;
  outputTokens?: number | undefined;
}

/** A token figure a provider actually reported, or `undefined` if it did not. */
function reported(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : undefined;
}

/**
 * Sum a turn's step usage into the wire's disjoint buckets.
 *
 * `null` means "cannot tell": there are no steps, or no step carried any usage
 * figure at all (a provider that streams none). The host then charges a flat
 * assumed cost. That is deliberately not a zero-filled result, which would tell
 * the host the turn was free.
 */
export function sumStepUsage(
  model: string,
  steps: ReadonlyArray<{ usage: StepUsageLike }> | undefined,
): TurnUsage | null {
  if (steps === undefined || steps.length === 0) return null;

  const total: TurnUsage = {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let sawAnyFigure = false;

  for (const { usage } of steps) {
    const details = usage.inputTokenDetails;
    const inputTotal = reported(usage.inputTokens);
    const noCache = reported(details?.noCacheTokens);
    const cacheRead = reported(details?.cacheReadTokens);
    const cacheWrite = reported(details?.cacheWriteTokens);
    const output = reported(usage.outputTokens);

    if (
      inputTotal !== undefined ||
      noCache !== undefined ||
      cacheRead !== undefined ||
      cacheWrite !== undefined ||
      output !== undefined
    ) {
      sawAnyFigure = true;
    }

    const read = cacheRead ?? 0;
    const write = cacheWrite ?? 0;
    total.cacheReadTokens += read;
    total.cacheWriteTokens += write;
    total.inputTokens += noCache ?? Math.max(0, (inputTotal ?? 0) - read - write);
    total.outputTokens += output ?? 0;
  }

  return sawAnyFigure ? total : null;
}
