// Path helpers for the Strata on-disk layout. Pure string functions —
// no I/O, no filesystem checks. The caller joins these against the
// agent's workspace root.
//
// Why no leading slash: the workspace plugin (when present) rejects
// absolute paths via validatePath(). The CLI fallback joins these
// against AgentContext.workspace.rootPath. Either way, the produced
// strings are relative to the agent's per-workspace root.
//
// Layout (mirrors design doc § "File System Layout"):
//   permanent/memory/
//     system/agent.md
//     system/user.md
//     system/session.md
//     inbox/<ISO-8601>.md
//
// Phase 1 only writes system/* and inbox/*. The full layout (docs/, .strata/)
// arrives with the Consolidator + Retriever in Phase 2.

export const MEMORY_ROOT = 'permanent/memory';
export const SYSTEM_DIR = `${MEMORY_ROOT}/system`;
export const INBOX_DIR = `${MEMORY_ROOT}/inbox`;

export type SystemFileName = 'agent' | 'user' | 'session';

export function workspaceMemoryRoot(): string {
  return MEMORY_ROOT;
}

export function systemFile(name: SystemFileName): string {
  return `${SYSTEM_DIR}/${name}.md`;
}

/**
 * `inbox/<ISO-8601>.md` with `:` swapped for `-` (`:` is illegal on Windows
 * filesystems and unfriendly elsewhere). The ISO-8601 prefix sorts
 * lexicographically — listing the inbox newest-first is just `sort -r`.
 */
export function inboxFile(timestamp: Date, suffix?: string): string {
  const iso = timestamp.toISOString().replace(/:/g, '-');
  const tail = suffix !== undefined ? `-${suffix}` : '';
  return `${INBOX_DIR}/${iso}${tail}.md`;
}
