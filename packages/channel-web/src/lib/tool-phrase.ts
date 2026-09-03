/**
 * tool-phrase — client-side display labels for tool calls (TASK-271).
 *
 * The transcript's tool-call message parts carry `toolName` as the STABLE
 * stripped identifier (renderer dispatch in `Thread.tsx`, artifact pairing in
 * `MarkdownText.tsx`, and the `mcp__` fallback all key on it) — and the
 * assistant-ui bridge rebuilds tool-call parts from a fixed field set, so a
 * side field would not survive anyway (verified against its `convertMessage`).
 * The host-authored `activityPhrase` therefore rides OUTSIDE the part: both
 * `transport.ts` (live SSE frames) and `history-adapter.ts` (stored blocks)
 * stash it here keyed by the call id, and `ToolFallback` resolves the display
 * label through `toolDisplayName`.
 *
 * Plain module state, no subscription: writers always stash before the part
 * they describe enters the message store (transport stashes on frame arrival
 * before enqueue; history stashes while building parts during load), so a
 * synchronous read at render time sees the phrase. Bounded (FIFO eviction)
 * so a long session cannot grow it without limit; an evicted entry degrades
 * to the stripped-name fallback, never to a blank.
 */

/** Cap on remembered call ids. Eviction degrades to the name fallback. */
export const MAX_TOOL_PHRASES = 1000;

const phraseByCallId = new Map<string, string>();

/**
 * Remember a call's display phrase. No-ops on missing/blank input so callers
 * need no guard. Exported for `transport.ts` and `history-adapter.ts`.
 */
export function rememberToolPhrase(
  toolCallId: string,
  phrase: string | undefined,
): void {
  if (typeof phrase !== 'string' || phrase.trim().length === 0) return;
  // Refresh recency: delete-then-set keeps the FIFO eviction order honest
  // for ids that re-arrive (replays).
  if (phraseByCallId.has(toolCallId)) phraseByCallId.delete(toolCallId);
  phraseByCallId.set(toolCallId, phrase);
  while (phraseByCallId.size > MAX_TOOL_PHRASES) {
    const oldest = phraseByCallId.keys().next();
    if (oldest.done) break;
    phraseByCallId.delete(oldest.value);
  }
}

/**
 * Resolve the label `ToolFallback` renders: the remembered phrase where one
 * exists, else the (already stripped) tool name. Exported for `ToolUse.tsx`
 * and unit tests.
 */
export function toolDisplayName(
  toolCallId: string,
  toolName: string,
): string {
  return phraseByCallId.get(toolCallId) ?? toolName;
}

/** Test seam: clear remembered phrases between cases. */
export function clearToolPhrases(): void {
  phraseByCallId.clear();
}
