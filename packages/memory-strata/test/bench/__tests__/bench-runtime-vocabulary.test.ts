// Pins the ONE place the bench's document vocabulary deliberately diverges from
// the runtime's, so the next person to notice it does not "fix" it.
//
// The bench labels every corpus document `episodes/<slug>` (plural). The
// runtime's `parseDocId` allow-list has `episode` (singular) and would reject
// every one of them. That is the same bench-vs-runtime drift class that cost a
// paid n=500 run when the bench rendered the orchestrator a map in the storage
// format instead of the runtime's — see `map-matches-runtime.test.ts`.
//
// It is harmless HERE, and the reason is worth writing down: the bench resolves
// paths against its own `memoryTree`, never through `parseDocId`. Renaming to
// singular would cost real money for no measurement gain — all 19,195 keys in
// `~/.cache/ax-memory-bench/longmemeval-s/map-rewrites.json` are `episodes/…`,
// so a rename silently invalidates the whole map-rewrite cache and forces a
// paid regeneration.
//
// So: the divergence stays, and this test is the guard. It fails if the bench
// starts feeding its paths through the runtime parser (which would drop every
// document in silence — the bench's favourite failure mode), or if someone
// renames one side without the other.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDocId } from '../../../src/doc-id.js';

describe('bench vs runtime document vocabulary', () => {
  it('the bench category is NOT addressable by the runtime parser', () => {
    // If this ever starts passing, the two vocabularies have converged and the
    // comment above (plus the cache warning) is stale — update both.
    expect(parseDocId('episodes/s-001')).toBeNull();
    expect(parseDocId('episode/s-001')).toEqual({ category: 'episode', slug: 's-001' });
  });

  it('is the only divergence — the runtime allow-list is otherwise singular', () => {
    for (const c of ['entity', 'preference', 'decision', 'episode', 'general', 'rollup']) {
      expect(parseDocId(`${c}/x`)).toEqual({ category: c, slug: 'x' });
    }
    // The plural forms a bench author might reach for, none of them runtime ids.
    for (const c of ['entities', 'preferences', 'decisions', 'episodes', 'rollups']) {
      expect(parseDocId(`${c}/x`)).toBeNull();
    }
  });

  it('the corpus loaders still emit the plural form the map cache is keyed by', () => {
    // Guards the CACHE, not the parser. Every key in the on-disk map-rewrite
    // cache is `episodes/<slug>`; flipping this literal to the singular makes
    // all 19,195 of them miss, and a miss is not an error — the run just
    // silently falls back to `doc.summary` and measures a different arm than
    // the report claims. Asserted against source text because calling the
    // loader means reading a 277MB corpus.
    for (const f of ['longmemeval-s.ts', 'locomo.ts']) {
      const src = readFileSync(
        fileURLToPath(new URL(`../corpora/${f}`, import.meta.url)),
        'utf8',
      );
      expect(src, `${f} must keep category 'episodes'`).toContain("category: 'episodes'");
    }
  });
});
