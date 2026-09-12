import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMapForOrchestrator, type MapEntry } from '../../../src/orchestrator.js';
import { generateMap } from '../map.js';
import { makeDoc } from '../corpora/shared.js';
import type { BenchCorpus, MarkdownDoc } from '../types.js';

/**
 * The bench must show its planner the map the RUNTIME shows its planner.
 *
 * These drifted, silently, and it invalidated a paid n=500 model comparison.
 * The runtime stores `system/map.md` as `## <category>/` + `- <slug>: ...` and
 * never shows that form to the planner — `renderMapForOrchestrator` re-renders
 * it flat and fully qualified, which is what `<load doc="...">` is matched
 * against. The bench's map string IS its prompt, and it imitated the STORAGE
 * form, so the planner was shown ids it could not successfully copy.
 *
 * Nothing failed loudly: an unresolvable `<load>` is dropped and the BM25
 * fallback covers for it, so the arm still produced a number. It just measured
 * which model guesses an undocumented prefix. At n=40 on 2026-09-11, haiku lost
 * 80% of its plans to this, and its recall@5 went 40.0% -> 92.5% once the
 * prompt was faithful.
 *
 * The fix is delegation, not imitation — the bench calls the runtime's
 * renderer. This test fails if someone re-inlines a lookalike.
 */
describe('bench map is rendered by the runtime renderer', () => {
  const corpus = (): BenchCorpus => {
    const docs = new Map<string, MarkdownDoc>();
    for (const slug of ['alpha-one', 'beta-two']) {
      const d = makeDoc({ category: 'episode', slug, summary: `summary for ${slug}`, body: 'b' });
      docs.set(d.path, d);
    }
    return { name: 'internal', memoryTree: docs, questions: [] };
  };

  it('emits exactly what renderMapForOrchestrator emits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-parity-'));
    try {
      const c = corpus();
      const map = await generateMap(c, { cacheDir: dir });
      const expected: MapEntry[] = [...c.memoryTree.values()]
        .map((d) => ({ docId: d.path, category: d.category, slug: d.slug, summary: d.summary }))
        .sort((a, b) => a.docId.localeCompare(b.docId));
      expect(map).toContain(renderMapForOrchestrator(expected));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('offers only ids that resolve to a real corpus doc', async () => {
    // The property that actually protects a run: every id the planner can copy
    // off the map must come back as a document. A bare slug does not.
    const dir = mkdtempSync(join(tmpdir(), 'map-parity-'));
    try {
      const c = corpus();
      const map = await generateMap(c, { cacheDir: dir });
      const ids = [...map.matchAll(/^-\s+([^:]+):/gm)].map((m) => m[1]!.trim());
      expect(ids.length).toBe(c.memoryTree.size);
      for (const id of ids) {
        expect(c.memoryTree.has(id), `map offered "${id}", which resolves to nothing`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fall back to the storage form (bare slug under a header)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-parity-'));
    try {
      const map = await generateMap(corpus(), { cacheDir: dir });
      expect(map).not.toMatch(/^##\s/m);
      expect(map).not.toMatch(/^-\s+alpha-one:/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
