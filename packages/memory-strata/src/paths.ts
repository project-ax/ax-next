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
//     system/recent.md          ← Phase 2A: cached consolidation view
//     system/map.md             ← TASK-190: always-injected hierarchical index
//     inbox/<ISO-8601>.md
//     docs/<category>/<slug>.md ← Phase 2A: promoted fact pages
//
// Phase 1 wrote system/* and inbox/*. Phase 2A adds docs/ and recent.md.
// See docs/plans/memory-strata-design.md and the Phase 2A plan.

export const MEMORY_ROOT = 'permanent/memory';
export const SYSTEM_DIR = `${MEMORY_ROOT}/system`;
export const INBOX_DIR = `${MEMORY_ROOT}/inbox`;
export const DOCS_DIR = `${MEMORY_ROOT}/docs`;

export type SystemFileName = 'agent' | 'user' | 'session';

export type DocCategory =
  | 'entity'
  | 'preference'
  | 'decision'
  | 'episode'
  | 'general'
  // Synthesized write-time rollup docs (TASK-200): one `docs/rollup/<class>.md`
  // per recurring instance-class (≥K member docs), materializing a count + the
  // enumerated instance list so "how many X" reads a precomputed answer. A
  // first-class category so `listDocs`/`parseDocId`/the map menu treat rollups
  // as ordinary docs; excluded from `recent.md` (search-time accelerator, not
  // hot-tier content).
  | 'rollup';

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

/**
 * `docs/<category>/<slug>.md`. Caller is responsible for slugifying the
 * subject; `slugify()` enforces no path traversal so a malformed slug
 * here is a programming error, not a security one.
 */
export function docFile(category: DocCategory, slug: string): string {
  return `${DOCS_DIR}/${category}/${slug}.md`;
}

export function categoryDir(category: DocCategory): string {
  return `${DOCS_DIR}/${category}`;
}

/** Cached view; regenerated end-to-end on every consolidation pass. */
export function recentFile(): string {
  return `${SYSTEM_DIR}/recent.md`;
}

/**
 * The hierarchical memory index (TASK-190). A derived, always-injected file —
 * one densified one-liner per doc, grouped by category. Regenerated each
 * consolidation pass alongside `recent.md`; deleting it loses nothing.
 */
export function mapFile(): string {
  return `${SYSTEM_DIR}/map.md`;
}

/**
 * Sidecar cache for LLM-densified map summaries (TASK-190). Keyed by doc id,
 * each entry stores a hash of the doc's source facts + the densified one-liner,
 * so an unchanged doc is never re-densified (the bench rewrite was
 * ~$0.0002/session). Lives under `system/` next to the map it feeds. The
 * leading dot keeps it out of casual `docs/` listings; it is NOT a doc and is
 * never injected.
 */
export function mapCacheFile(): string {
  return `${SYSTEM_DIR}/.map-cache.json`;
}
