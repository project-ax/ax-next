import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// I9 from the plan: Phase 1 ships ONLY Level 0 (hot tier markdown) +
// Level 1 (Observer to inbox/). Explicitly NOT shipping: the
// Consolidator (inbox→docs merge), the Retriever (FTS5 / vector / RRF),
// recent.md regeneration, the eval harness.
//
// This test fails loudly if a future change accidentally pulls one of
// those subsystems in via a copy-paste or premature wiring. The check
// is on src/, not src/__tests__/ — the test file itself necessarily
// names these strings to assert their absence.
//
// Entries are removed from FORBIDDEN at the same time their real
// implementation lands, so the audit trail in git history shows exactly
// when each capability shipped.
//
// Phase 2A (Task 2A.2) landed: docs/ + recent.md path helpers + doc types.
// `recent.md` was removed from FORBIDDEN because recentFile() necessarily
// exposes that literal path.
// Phase 2A (Task 2A.5) landed: cluster.ts — `Consolidator` removed from
// FORBIDDEN because the Phase 2A inbox→docs pipeline is now actively shipping.
// Phase 2B will remove Retriever / FTS5 / RRF when the retrieval interface ships.

const FORBIDDEN: ReadonlyArray<{ token: string; reason: string }> = [
  { token: 'FTS5', reason: 'Phase 2B Retriever — keyword index not yet shipped' },
  { token: 'RRF', reason: 'Phase 2B Retriever — reciprocal rank fusion not yet shipped' },
  { token: 'Retriever', reason: 'Phase 2B — retrieval interface not yet shipped' },
  { token: 'hnswlib', reason: 'Phase 3 — vector index not yet shipped' },
  { token: 'embeddings', reason: 'Phase 3 — vector index not yet shipped' },
];

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

describe('Phase 1 ship-list (I9)', () => {
  it('does not reference Phase 2+ subsystems anywhere in src/', async () => {
    const offenses: string[] = [];
    for await (const file of walkSource(SRC_DIR)) {
      const content = await readFile(file, 'utf8');
      for (const { token, reason } of FORBIDDEN) {
        if (content.includes(token)) {
          offenses.push(
            `${file.replace(SRC_DIR, '')} references "${token}" — ${reason}`,
          );
        }
      }
    }
    expect(offenses, offenses.join('\n')).toEqual([]);
  });
});
