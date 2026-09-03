// ---------------------------------------------------------------------------
// activity-phrase-map — runner-side name → activityPhrase lookup (TASK-271).
//
// Both runners receive the full `tool.list` catalog (whose descriptors carry
// the host-authored `activityPhrase`) and attach the phrase when emitting
// tool-use chunks/blocks, so the transcript can render it. This module builds
// the bare-name-keyed map; SDK wire-name normalization stays runner-local
// (the claude-sdk runner strips its `mcp__<server>__` prefix via
// `classifySdkToolName`, the aisdk runner's tool names are already bare).
//
// Only non-blank phrases enter the map. The host re-fences at the IPC
// ingress (`sanitizeActivityPhrase`), so this is a best-effort attach, not a
// trust decision.
// ---------------------------------------------------------------------------

interface PhraseCarrier {
  name: string;
  activityPhrase?: string | undefined;
}

/** Build a bare-tool-name → activityPhrase map from a tool catalog. */
export function buildActivityPhraseMap(
  tools: readonly PhraseCarrier[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    const phrase = tool.activityPhrase;
    if (typeof phrase === 'string' && phrase.trim().length > 0) {
      map.set(tool.name, phrase);
    }
  }
  return map;
}
