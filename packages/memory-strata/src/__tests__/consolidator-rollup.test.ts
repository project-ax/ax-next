// Layer 6 — consolidator ↔ rollup-pass integration (TASK-200):
// the per-category dirty gate (skip vs run) and the ordering guarantee
// (rollup pass runs AFTER promotion/merge, BEFORE map regen — so a fresh
// rollup gets a map line in the same pass).

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConsolidation } from '../consolidator.js';
import { verifyStageBClasses, type StageBNamer } from '../rollup.js';
import { writeNewDoc, readDoc } from '../doc-store.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { INBOX_DIR, docFile, mapFile } from '../paths.js';
import type { MemoryFrontmatter } from '../types.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const FILLERS = ['hiking-trip', 'concert', 'museum', 'road', 'garden'];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'consol-rollup-'));
});

/** Seed a qualifying `weddings` class on disk (3 weddings + 5 fillers = 8 episodes,
 *  weddings 3/8 = 0.375 ≤ 0.4). */
async function seedWeddingCorpus(): Promise<void> {
  // Verbs vary so "wedding" is the ONLY token shared across all three — a shared
  // verb ("attended") would itself form a spurious `attendeds` rollup.
  const verbs = ['Attended', 'Danced at', 'Toasted at'];
  const wslugs = ['emily-and-sarah', 'jen-and-tom', 'rachel-and-mike'];
  for (let i = 0; i < wslugs.length; i++) {
    const s = wslugs[i]!;
    await writeNewDoc({
      workspaceRoot: root, category: 'episode', slug: s,
      summary: 'a wedding', subject: s, factType: 'episode', confidence: 0.9,
      sourceObservationIds: ['o'], now: NOW, facts: [`(2026-01-05) ${verbs[i]} a ${s} wedding`],
    });
  }
  for (const f of FILLERS) {
    await writeNewDoc({
      workspaceRoot: root, category: 'episode', slug: f,
      summary: `a ${f} outing`, subject: f, factType: 'episode', confidence: 0.9,
      sourceObservationIds: ['o'], now: NOW, facts: [`(2026-01-06) a ${f} outing`],
    });
  }
}

async function writeInbox(filename: string, fm: MemoryFrontmatter, body: string): Promise<void> {
  const dir = join(root, INBOX_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), buildMarkdownFile(fm, body), 'utf8');
}

function inboxFm(id: string, subject: string, factType: string, summary: string): MemoryFrontmatter {
  return {
    id, type: 'inbox/observation', created: NOW.toISOString(), confidence: 0.9,
    pinned: false, summary, subject, factType,
    event_time: NOW.toISOString(), recorded_at: NOW.toISOString(),
  };
}

describe('consolidator rollup dirty gate + ordering', () => {
  it('a pass with NO enumerable-category write SKIPS the rollup pass', async () => {
    // A qualifying weddings class already exists on disk...
    await seedWeddingCorpus();
    // ...but this pass promotes ONLY a preference (non-enumerable) observation.
    await writeInbox(
      '2026-06-01T00-00-00.000Z-coffee.md',
      inboxFm('obs-coffee', 'coffee', 'preference', 'User prefers pour-over coffee'),
      '# Observation\n\nUser prefers pour-over coffee\n',
    );

    const result = await runConsolidation({ workspaceRoot: root, now: NOW });
    // Dirty gate held: rollup pass skipped despite a qualifying class on disk.
    expect(result.rollupsWritten).toBe(0);
    await expect(access(join(root, docFile('rollup', 'weddings')))).rejects.toThrow();
  });

  it('a promoting (enumerable) pass RUNS the rollup pass and the rollup lands in the map', async () => {
    await seedWeddingCorpus();
    // Promote an EPISODE observation → enumerableWrite → rollup pass runs.
    await writeInbox(
      '2026-06-01T00-00-00.000Z-picnic.md',
      inboxFm('obs-picnic', 'picnic', 'episode', 'A lakeside picnic'),
      '# Observation\n\nA lakeside picnic\n',
    );

    const result = await runConsolidation({ workspaceRoot: root, now: NOW });
    // Exactly ONE rollup — `weddings`. Asserting the exact set (not just ≥1)
    // catches spurious verb/adjective rollups (e.g. a junk `attendeds`) that a
    // loose ≥1 check would silently write to disk on the tuned counting path.
    expect(result.rollupsWritten).toBe(1);
    await access(join(root, docFile('rollup', 'weddings'))); // rollup materialized
    const rollupDir = await readdir(join(root, 'permanent/memory/docs/rollup'));
    expect(rollupDir.filter((f) => f.endsWith('.md'))).toEqual(['weddings.md']);

    // Ordering: the rollup pass ran BEFORE regenerateMap, so map.md carries the
    // rollup line (it wouldn't if the pass ran after map regen).
    const map = await readFile(join(root, mapFile()), 'utf8');
    expect(map).toContain('rollup/');
    expect(map).toContain('weddings');
  });
});

// TASK-201 — Stage B (bounded LLM naming) threads through the SAME dirty gate:
// no extra LLM call on a clean/non-enumerable pass; a promoting pass runs it and
// a Stage-B rollup materializes through the unchanged writer.
describe('consolidator Stage-B rollup wiring (TASK-201)', () => {
  /** Seed 3 furniture docs that share NO surface token — Stage A cannot group
   *  them, so they only ever materialize via Stage B. */
  async function seedFurniture(): Promise<void> {
    for (const it of [
      { slug: 'couch', summary: 'bought a leather couch' },
      { slug: 'dining-table', summary: 'refinished the oak dining table' },
      { slug: 'standing-desk', summary: 'assembled a standing desk' },
    ]) {
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: it.slug,
        summary: it.summary, subject: it.slug, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [`(2026-02-01) ${it.summary}`],
      });
    }
  }

  it('a non-enumerable pass does NOT invoke Stage B (no extra LLM call)', async () => {
    await seedFurniture();
    // Promote ONLY a preference (non-enumerable) → dirty gate skips the rollup
    // pass entirely, so the Stage-B namer must never be called.
    await writeInbox(
      '2026-06-01T00-00-00.000Z-coffee.md',
      inboxFm('obs-coffee', 'coffee', 'preference', 'User prefers pour-over coffee'),
      '# Observation\n\nUser prefers pour-over coffee\n',
    );
    let called = false;
    const stageB: StageBNamer = async () => { called = true; return []; };
    const result = await runConsolidation({ workspaceRoot: root, now: NOW, rollupStageB: stageB });
    expect(called).toBe(false);
    expect(result.rollupsWritten).toBe(0);
  });

  it('a promoting pass invokes Stage B and materializes the Stage-B rollup', async () => {
    await seedFurniture();
    // Promote an EPISODE observation → enumerableWrite → rollup pass runs → Stage B.
    await writeInbox(
      '2026-06-01T00-00-00.000Z-picnic.md',
      inboxFm('obs-picnic', 'picnic', 'episode', 'A lakeside picnic'),
      '# Observation\n\nA lakeside picnic\n',
    );
    const stageB: StageBNamer = async (residue, config) =>
      verifyStageBClasses(
        [{ class: 'furniture', members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] }],
        residue, config,
      );
    const result = await runConsolidation({ workspaceRoot: root, now: NOW, rollupStageB: stageB });
    expect(result.rollupsWritten).toBe(1);
    const doc = await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'furniture' });
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter.rollup_count).toBe(3);
  });
});
