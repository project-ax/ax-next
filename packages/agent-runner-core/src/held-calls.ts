/**
 * Which of this turn's tool calls are waiting on a human.
 *
 * PER TURN, and that is the whole design. The registry is written when a
 * `hold` verdict lands and read when the turn's results publish, then cleared
 * at the turn boundary — exactly the lifetime, and exactly the ordering
 * hazard, that `drainHoldLatch` in `hold-latch.ts` exists to make
 * un-mis-writable. A hold that survived into the next turn would quietly mark
 * some later call's real output as waiting, and nothing would throw.
 *
 * Ids only. Nothing model-authored ever enters this set: it is populated
 * solely from the host's own `hold` verdict, so a call that genuinely failed
 * cannot be dressed up as waiting. (Moved here from the claude-sdk runner in
 * TASK-270 so both runners share one record — invariant 2 forbids the aisdk
 * runner importing it from its sibling.)
 */
export interface HeldCallRegistry {
  record(toolCallId: string): void;
  has(toolCallId: string): boolean;
  clear(): void;
}

export function createHeldCallRegistry(): HeldCallRegistry {
  const ids = new Set<string>();
  return {
    record(toolCallId: string): void {
      ids.add(toolCallId);
    },
    has(toolCallId: string): boolean {
      return ids.has(toolCallId);
    },
    clear(): void {
      ids.clear();
    },
  };
}
