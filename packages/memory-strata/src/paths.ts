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
//     system/rules.md           ← TASK-234: the HUMAN-owned tier. No automatic
//                                  writer may touch it. See human-tier.ts.
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

export type SystemFileName = 'agent' | 'rules' | 'user' | 'session';

/**
 * Where the memory subtree lives inside the per-agent `/agent` git tier
 * (TASK-182). The FS pipeline uses `permanent/memory/**` (MEMORY_ROOT) under a
 * local scratch; the tier drops the `permanent/` host-layout prefix so the
 * runner reads `/agent/memory/system/recent.md`.
 *
 * Lives here rather than in `agent-tier-sync.ts` so `human-tier.ts` — which
 * every writer in the package imports — can derive the tier-side path of the
 * human tier without importing the sync module and making a cycle out of the
 * guard. `agent-tier-sync.ts` re-exports it, so its importers are unchanged.
 */
export const AGENT_TIER_MEMORY_ROOT = 'memory';

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

/**
 * All `DocCategory` values, ordered canonically (TASK-367). The source of truth
 * for every RUNTIME use of the category set. Two callers read it directly —
 * `doc-store.ts`'s `listDocs` walk and `doc-id.ts`'s `VALID_CATEGORIES`
 * traversal guard — and a third, the consolidator's cross-category slug
 * adoption, reaches it through `SUBJECT_DOC_CATEGORIES` below (it MUST use the
 * subset: scanning this list would include `docs/rollup/`, which is the whole
 * point of the subset). `.claude/memory/decisions.md` (2026-07-07) records that
 * a hand-maintained copy is a silent no-op waiting to happen when a category is
 * added.
 *
 * SCOPE: this is the `DocCategory` axis — where a doc LIVES. The parallel
 * `factType` axis (what KIND of fact an observation carries) is a different
 * enumeration that happens to share five of these names while adding `answer`
 * and omitting `rollup`: `observer.ts`'s extraction enum, `types.ts`'s
 * `Observation.factType`, and `tools/memory-note.ts`'s `VALID_FACT_TYPES`.
 * Those are deliberately NOT unified with this list — `cluster.ts` maps between
 * the two axes (`FACT_TYPE_TO_CATEGORY`, `pickCategory`) precisely because they
 * are different concepts.
 *
 * Two enumerations on THIS axis deliberately remain separate — neither is a
 * stale copy:
 *
 *   - `cluster.ts`'s `KNOWN_CATEGORIES` enumerates `ClusterCategory`, a
 *     different type with different semantics ("what kind of fact dominated
 *     this batch" vs "where the file lives"). That file's header explains why
 *     collapsing them would be wrong.
 *   - `types.ts`'s `DocFileType` / `MemoryFileType` are TYPE-level
 *     `docs/<category>` literal unions, not a runtime list. They could be
 *     derived (`` `docs/${DocCategory}` ``) and arguably should be — left
 *     alone here to keep this change scoped; see the TASK-367 follow-up.
 *
 * `ENUMERABLE_CATEGORIES` (consolidator.ts / rollup.ts) is a SUBSET
 * ({episode, entity, general}), not the category set, so it is not a copy of
 * this list — but it is its own hand-maintained mirror pair. Same follow-up.
 *
 * TWO separate guards, because they catch opposite mistakes and neither one
 * covers both:
 *
 *   - `satisfies` below rejects an entry that is NOT a `DocCategory` (a typo,
 *     a removed category left behind).
 *   - `_everyDocCategoryIsListed` rejects a `DocCategory` that is MISSING from
 *     this array. `satisfies` does NOT do this — measured: a list of `['a','b']`
 *     `satisfies readonly ('a'|'b'|'c')[]` compiles clean. Without the second
 *     guard, adding a 7th category to the union and forgetting this array is
 *     exactly the silent no-op the 2026-07-07 entry warns about.
 */
export const DOC_CATEGORIES = [
  'entity', 'preference', 'decision', 'episode', 'general', 'rollup',
] as const satisfies readonly DocCategory[];

/**
 * Compile-time exhaustiveness for `DOC_CATEGORIES` (see above). If a
 * `DocCategory` union member is not listed, `Exclude<...>` is non-`never`, the
 * conditional resolves to `never`, and assigning `true` fails to compile with
 * "Type 'true' is not assignable to type 'never'" — pointing here. Lives in
 * `paths.ts` rather than a test because `pnpm build` does not type-check
 * `__tests__` (see `.claude/memory/` — tsc excludes test files).
 */
const _everyDocCategoryIsListed: [Exclude<DocCategory, (typeof DOC_CATEGORIES)[number]>] extends [never]
  ? true
  : never = true;
void _everyDocCategoryIsListed;

/**
 * `DOC_CATEGORIES` minus `rollup` — the categories a promoted SUBJECT doc can
 * live in. `rollup` docs are synthesized from other docs (write-time, hash-GC'd,
 * unlink-guarded — see `rollup.ts`), not a destination a subject cluster ever
 * elects, so callers that scan "where could this subject's doc already live"
 * (the consolidator's cross-category slug adoption) use this list, not
 * `DOC_CATEGORIES`.
 */
export const SUBJECT_DOC_CATEGORIES = DOC_CATEGORIES.filter(
  (c): c is Exclude<DocCategory, 'rollup'> => c !== 'rollup',
);

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

/**
 * The HUMAN-owned tier (TASK-234). Written only by a person, through
 * `memory:rules:write`; read by `inject.ts`, which puts it FIRST in the
 * injected block. Every automatic writer in this package is forbidden to touch
 * it — see `human-tier.ts` for how that is enforced rather than merely stated.
 *
 * Deliberately NOT seeded by `bootstrap.ts`: an absent rules file and an empty
 * one mean the same thing, and the only writer of this path should be the one
 * a human reaches.
 */
export function rulesFile(): string {
  return systemFile('rules');
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
