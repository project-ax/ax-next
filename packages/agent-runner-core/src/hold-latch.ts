// A one-shot latch a runner's loop reads to stop after a hold.
//
// Both runners have a clean stop mechanism, and both need to know a hold
// happened somewhere inside a tool call they do not otherwise inspect:
//   - claude-sdk: the PreToolUse hook returns `{ continue: false, stopReason }`
//     directly, so the latch is only bookkeeping for the shell.
//   - aisdk: `ToolLoopAgent`'s `stopWhen` is `Arrayable<StopCondition>`, so the
//     latch composes with `stepCountIs(MAX_STEPS_PER_TURN)`. The tool's
//     `execute` cannot stop the loop by itself; it trips the latch and the
//     condition ends the turn after that step.
//
// Reset per turn by the shell. Not exported across the IPC boundary.
export interface HoldLatch {
  trip(decisionId: string): void;
  readonly tripped: boolean;
  readonly decisionId: string | null;
  reset(): void;
}

export function createHoldLatch(): HoldLatch {
  let id: string | null = null;
  return {
    trip(decisionId: string): void {
      // First hold wins. A turn that holds twice is still one stopped turn,
      // and the FIRST decision is the one the user was told about.
      if (id === null) id = decisionId;
    },
    get tripped(): boolean {
      return id !== null;
    },
    get decisionId(): string | null {
      return id;
    },
    reset(): void {
      id = null;
    },
  };
}

/**
 * Read the latch and clear it in one step, returning the decision id the turn
 * held on (or `null` if it did not).
 *
 * This exists as a named function rather than two lines at the call site
 * because the ORDER is the whole point and the wrong order is silent: reset
 * first and the caller always reads `null`, the hold is never recorded, and
 * every test still passes. A turn-boundary drain is exactly where that gets
 * written the wrong way round.
 */
export function drainHoldLatch(latch: HoldLatch): string | null {
  const decisionId = latch.decisionId;
  latch.reset();
  return decisionId;
}
