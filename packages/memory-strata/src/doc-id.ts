// Shared docId traversal guard (CLAUDE.md invariant 4 — one source of truth
// per concept). `memory_read_section` (a tool-level read of a caller-supplied
// docId) and the retrieval orchestrator (TASK-191 — an LLM-proposed `<load
// doc="..."/>` op) both need to validate a docId BEFORE it touches any I/O.
// This used to be a private copy inside tools/memory-read-section.ts; it
// moved here so both call sites share one regex/logic instead of risking the
// two copies drifting (exactly the hazard invariant 4 calls out).
//
// WHY this matters for the orchestrator specifically: the `load` op is model
// output riding on map summaries that ultimately derive from prior — possibly
// untrusted — conversation content. This guard is the traversal defense:
// closed category set, single slash, `^[a-z0-9-]+$` slug, no `..`, no
// leading/trailing slash. Run it before ANY lookup, host or agent-tier.

import { DOC_CATEGORIES, type DocCategory } from './paths.js';

// TASK-367: derived from `DOC_CATEGORIES` rather than hand-listed. This is the
// copy it was most dangerous to leave behind: `parseDocId` is the TRAVERSAL
// GUARD above, so a category present on the type but missing here does not
// merely no-op — it rejects legitimate docIds of the new category on the
// `<load>` path, the orchestrator map menu, `memory_read_section`, AND
// matchedFacts enrichment (tools/memory-search.ts). That is the TASK-200
// lesson (rollups had to be added here or a retrieved rollup surfaced with no
// instance lines) generalized: the list is now impossible to forget, because
// `paths.ts`'s `_everyDocCategoryIsListed` fails the build if a union member
// is missing from the one array both files read.
const VALID_CATEGORIES = new Set<DocCategory>(DOC_CATEGORIES);
const SLUG_RE = /^[a-z0-9-]+$/;

export function parseDocId(docId: string): { category: DocCategory; slug: string } | null {
  // Reject empty, no slash, multiple slashes, leading/trailing slash, '..'
  if (docId.length === 0) return null;
  if (docId.includes('..')) return null;
  const idx = docId.indexOf('/');
  if (idx <= 0 || idx === docId.length - 1) return null;
  if (docId.indexOf('/', idx + 1) !== -1) return null; // second slash → reject
  const category = docId.slice(0, idx);
  const slug = docId.slice(idx + 1);
  if (!VALID_CATEGORIES.has(category as DocCategory)) return null;
  if (!SLUG_RE.test(slug)) return null;
  return { category: category as DocCategory, slug };
}
