import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// I23 from the Phase 2B plan: the ship-list test now defends the
// Phase 2B perimeter. Phase 1 + Phase 2A + Phase 2B have all landed —
// Level 0 hot tier, Observer→inbox, Consolidator inbox→docs, BM25
// retrieval interface, three agent tools, and auto-injected memory
// block. Explicitly NOT shipping in 2B: dense/vector retrieval, RRF
// fusion, LLM rerank, the eval harness.
//
// This test fails loudly if a future change accidentally pulls one
// of those subsystems in via a copy-paste or premature wiring. The
// check is on src/, not src/__tests__/ — the test file itself
// necessarily names these strings to assert their absence.
//
// Entries are removed from FORBIDDEN at the same time their real
// implementation lands, so the audit trail in git history shows
// exactly when each capability shipped.
//
// Phase 2A (Task 2A.2) landed: docs/ + recent.md path helpers + doc types.
// Phase 2A (Task 2A.5) landed: cluster.ts — `Consolidator` cleared.
// Phase 2A (Task 2A.13) added four Phase 2B tool-surface guards.
// Phase 2B (Task 2B.6) landed: re-indexer subscriber — `Retriever` cleared
//   (the retriever helper ships as the retrieve() function).
// Phase 2B (Tasks 2B.8/9/10) landed: three agent tools + tool:register cleared.
// FTS5 stays forbidden in @ax/memory-strata src/ even after Phase 2B because
// FTS5 lives in @ax/memory-strata-index-sqlite, not here — keeping it
// forbidden in this package's src enforces the abstraction boundary (I17).
//
// Phase 3+ tokens (dense/vector/embeddings/rerank) stay forbidden as a
// belt-and-braces guard against premature wiring.
//
// Matching is WHOLE-WORD (case-insensitive `\b<token>\b`), not raw substring:
// TASK-190 legitimately ships LLM-"densified" map summaries (a fact-rewrite, NOT
// dense-vector retrieval), and "densify"/"densified" must not trip the `dense`
// (Phase-3 dense retrieval) guard. A standalone "dense retrieval" reference
// would still match `\bdense\b`, so the guard's real intent is preserved.

const FORBIDDEN: ReadonlyArray<{ token: string; reason: string }> = [
  {
    token: 'FTS5',
    reason:
      'Phase 2B abstraction boundary — FTS5 lives in @ax/memory-strata-index-sqlite, not in @ax/memory-strata src/',
  },
  { token: 'hnswlib', reason: 'Phase 3 — vector index not yet shipped' },
  { token: 'embeddings', reason: 'Phase 3 — vector index not yet shipped' },
  { token: 'vector', reason: 'Phase 3 — vector / dense retrieval not yet shipped' },
  { token: 'dense', reason: 'Phase 3 — vector / dense retrieval not yet shipped' },
  { token: 'rerank', reason: 'Phase 3 / Phase 4 — LLM reranker not yet shipped' },
];

/** Whole-word, case-insensitive match (so "densify" ≠ "dense"). */
function referencesToken(content: string, token: string): boolean {
  const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(content);
}

// fileURLToPath, not URL.pathname: the latter prefixes a leading `/`
// to drive letters on Windows (`/C:/...`), which breaks fs ops. The
// rest of the codebase uses fileURLToPath everywhere — match that.
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

async function* walkSource(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir);
  for (const name of entries) {
    if (name === '__tests__' || name === 'dist' || name === 'node_modules') continue;
    const full = join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) {
      yield* walkSource(full);
    } else if (name.endsWith('.ts')) {
      yield full;
    }
  }
}

describe('Phase 2B ship-list (I23)', () => {
  it('does not reference Phase 3+ subsystems anywhere in src/', async () => {
    const offenses: string[] = [];
    for await (const file of walkSource(SRC_DIR)) {
      const content = await readFile(file, 'utf8');
      for (const { token, reason } of FORBIDDEN) {
        if (referencesToken(content, token)) {
          offenses.push(
            `${file.replace(SRC_DIR, '')} references "${token}" — ${reason}`,
          );
        }
      }
    }
    expect(offenses, offenses.join('\n')).toEqual([]);
  });
});
