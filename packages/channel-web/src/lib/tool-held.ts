/**
 * tool-held — client-side "waiting on a human" marks for tool calls (TASK-270).
 *
 * The twin of `tool-phrase.ts`: the assistant-ui bridge rebuilds tool-call
 * parts from a fixed field set, so the persisted `held` bit cannot ride in
 * the part itself. Both `transport.ts` (live `tool-result` frames) and
 * `history-adapter.ts` (stored `tool_result` blocks) stash the mark here
 * keyed by the call id, and `ToolFallback` resolves it through `isToolHeld`.
 *
 * Write-once per call id: a result that arrives without the flag never
 * clears a mark (a replay writes no new block for the same call — the
 * transcript is a record, and a resolved hold keeps its Waiting treatment as
 * the statement of what was true at that point). Same bounded FIFO posture
 * as the phrase map; an evicted entry degrades to the completed rendering,
 * never to a blank.
 */

import { MAX_TOOL_PHRASES } from './tool-phrase';

const heldByCallId = new Map<string, true>();

/**
 * Remember that a call is waiting on a human. No-ops unless `held` is
 * exactly `true`, so callers need no guard — and so a later non-held frame
 * for the same id can never clear the mark.
 */
export function rememberToolHeld(
  toolCallId: string,
  held: boolean | undefined,
): void {
  if (held !== true) return;
  // Refresh recency: delete-then-set keeps the FIFO eviction order honest
  // for ids that re-arrive (replays).
  if (heldByCallId.has(toolCallId)) heldByCallId.delete(toolCallId);
  heldByCallId.set(toolCallId, true);
  while (heldByCallId.size > MAX_TOOL_PHRASES) {
    const oldest = heldByCallId.keys().next();
    if (oldest.done) break;
    heldByCallId.delete(oldest.value);
  }
}

/** Whether the call is waiting on a human. Exported for `ToolUse.tsx`. */
export function isToolHeld(toolCallId: string): boolean {
  return heldByCallId.has(toolCallId);
}

/** Test seam: clear remembered marks between cases. */
export function clearToolHeld(): void {
  heldByCallId.clear();
}
