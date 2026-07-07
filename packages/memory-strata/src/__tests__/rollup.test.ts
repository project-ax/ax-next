import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext } from '@ax/core';
import type { ToolDescriptor } from '@ax/core';
import {
  DEFAULT_ROLLUP_CONFIG,
  buildRollup,
  deleteRollupDoc,
  detectClasses,
  runRollupPass,
  writeRollupDoc,
  type DetectedClass,
  type RollupConfig,
  type RollupLogger,
} from '../rollup.js';
import { writeNewDoc, readDoc, listDocs } from '../doc-store.js';
import { registerReindexer } from '../reindex.js';
import { regenerateMap } from '../map.js';
import { docFile } from '../paths.js';
import { registerMemorySearch } from '../tools/memory-search.js';
import type { DocFile } from '../types.js';
import type { RetrievalResult } from '../retriever.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

/** Build an in-memory DocFile with controlled tokens (subject + summary + facts). */
function mkDoc(
  category: string,
  slug: string,
  opts: { summary?: string; subject?: string; facts?: string[]; updated?: string },
): DocFile {
  const facts = opts.facts ?? [];
  return {
    path: `permanent/memory/docs/${category}/${slug}.md`,
    frontmatter: {
      id: `${category}/${slug}`,
      type: `docs/${category}` as DocFile['frontmatter']['type'],
      created: '2026-01-01T00:00:00.000Z',
      updated: opts.updated ?? '2026-01-01T00:00:00.000Z',
      confidence: 0.9,
      pinned: false,
      summary: opts.summary ?? '',
      subject: opts.subject ?? slug,
      factType: category,
      source_observations: ['obs-1'],
    },
    body: ['# Doc', '', '## Facts', ...facts.map((f) => `- ${f}`), ''].join('\n'),
  };
}

function collectLog(): { log: RollupLogger; events: Array<{ event: string; fields: Record<string, unknown> }> } {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return {
    events,
    log: {
      info: (event, fields) => events.push({ event, fields }),
      warn: (event, fields) => events.push({ event, fields }),
    },
  };
}

// Filler episodes with distinct tokens so they never form an accidental class.
const FILLERS: Array<{ slug: string; summary: string }> = [
  { slug: 'hiking-trip', summary: 'a hiking excursion in the mountains' },
  { slug: 'concert', summary: 'a jazz concert downtown' },
  { slug: 'museum', summary: 'a modern art museum tour' },
  { slug: 'road', summary: 'a coastal driving journey' },
  { slug: 'garden', summary: 'a botanical garden afternoon' },
];

// ---------------------------------------------------------------------------
// Layer 1 — Stage A deterministic class detection
// ---------------------------------------------------------------------------
describe('detectClasses (Stage A, no LLM)', () => {
  it('≥K docs sharing a rare token → one class; singularizes plural surface forms', () => {
    // 3 weddings (summary carries "wedding"/"weddings") + 5 fillers = 8 episodes.
    // "wedding" df=3 → 3/8 = 0.375 ≤ 0.4 → qualifies.
    const docs: DocFile[] = [
      mkDoc('episode', 'emily-sarah', { summary: 'weddings', subject: 'emily-sarah' }),
      mkDoc('episode', 'jen-tom', { summary: 'a wedding', subject: 'jen-tom' }),
      mkDoc('episode', 'rachel-mike', { summary: 'wedding day', subject: 'rachel-mike' }),
      ...FILLERS.map((f) => mkDoc('episode', f.slug, { summary: f.summary })),
    ];
    const { classes } = detectClasses(docs, DEFAULT_ROLLUP_CONFIG);
    const weddings = classes.find((c) => c.slug === 'weddings');
    expect(weddings).toBeDefined();
    expect(weddings!.members).toHaveLength(3);
    expect(weddings!.token).toBe('wedding'); // singularized grouping token
  });

  it('below K → no class', () => {
    const docs: DocFile[] = [
      mkDoc('episode', 'a', { summary: 'wedding' }),
      mkDoc('episode', 'b', { summary: 'wedding' }),
      ...FILLERS.map((f) => mkDoc('episode', f.slug, { summary: f.summary })),
    ];
    const { classes } = detectClasses(docs, DEFAULT_ROLLUP_CONFIG);
    expect(classes.find((c) => c.slug === 'weddings')).toBeUndefined();
  });

  it('generic token over SALIENCE_MAX_FRACTION is excluded, rare token kept', () => {
    // 8 episodes: "kite" in 3 (0.375 → kept), "park" in 4 (0.5 → dropped).
    const docs: DocFile[] = [
      mkDoc('episode', 'k1', { summary: 'kite at the park' }),
      mkDoc('episode', 'k2', { summary: 'kite flying park' }),
      mkDoc('episode', 'k3', { summary: 'new kite bought' }),
      mkDoc('episode', 'p1', { summary: 'walk in the park' }),
      mkDoc('episode', 'p5', { summary: 'jogging park loop' }),
      mkDoc('episode', 'x1', { summary: 'a quiet library evening' }),
      mkDoc('episode', 'x2', { summary: 'a busy grocery run' }),
      mkDoc('episode', 'x3', { summary: 'a long dentist appointment' }),
    ];
    const { classes } = detectClasses(docs, DEFAULT_ROLLUP_CONFIG);
    expect(classes.find((c) => c.slug === 'kites')).toBeDefined();
    expect(classes.find((c) => c.slug === 'parks')).toBeUndefined();
  });

  it('a doc may belong to multiple classes', () => {
    // 3 docs each mention BOTH "wedding" and "maui"; 5 fillers. Both qualify
    // (df 3/8), and the 3 docs are members of BOTH classes.
    const docs: DocFile[] = [
      mkDoc('episode', 'w1', { summary: 'a wedding in maui' }),
      mkDoc('episode', 'w2', { summary: 'wedding trip to maui' }),
      mkDoc('episode', 'w3', { summary: 'maui beach wedding' }),
      ...FILLERS.map((f) => mkDoc('episode', f.slug, { summary: f.summary })),
    ];
    const { classes } = detectClasses(docs, DEFAULT_ROLLUP_CONFIG);
    const weddings = classes.find((c) => c.slug === 'weddings');
    const mauis = classes.find((c) => c.slug === 'mauis');
    expect(weddings?.members).toHaveLength(3);
    expect(mauis?.members).toHaveLength(3);
    const w1InBoth =
      weddings!.members.some((m) => m.frontmatter.id === 'episode/w1') &&
      mauis!.members.some((m) => m.frontmatter.id === 'episode/w1');
    expect(w1InBoth).toBe(true);
  });

  it('cross-category slug collision UNIONs members (not the larger set) — count is not an undercount', () => {
    // 3 entity "doctor" docs + 3 episode "doctor visit" docs → both singularize
    // to `doctor` → slug `doctors`. The count must be 6 (union), not 3 (larger
    // set) — the count rides the authoritative summary the model trusts.
    // salience 1 isolates this from the generic filter (tiny homogeneous corpus).
    const cfg: RollupConfig = { ...DEFAULT_ROLLUP_CONFIG, salienceMaxFraction: 1 };
    const docs: DocFile[] = [
      mkDoc('entity', 'dr-smith', { summary: 'doctor' }),
      mkDoc('entity', 'dr-jones', { summary: 'doctor' }),
      mkDoc('entity', 'dr-lee', { summary: 'doctor' }),
      mkDoc('episode', 'checkup-1', { summary: 'doctor appointment' }),
      mkDoc('episode', 'checkup-2', { summary: 'doctor appointment' }),
      mkDoc('episode', 'checkup-3', { summary: 'doctor appointment' }),
    ];
    const { classes } = detectClasses(docs, cfg);
    const doctors = classes.find((c) => c.slug === 'doctors');
    expect(doctors).toBeDefined();
    expect(doctors!.members).toHaveLength(6); // union, not 3
    const ids = new Set(doctors!.members.map((m) => m.frontmatter.id));
    expect(ids.has('entity/dr-smith')).toBe(true);
    expect(ids.has('episode/checkup-1')).toBe(true);
  });

  it('preference/decision categories are NOT enumerable (no class)', () => {
    const docs: DocFile[] = [
      mkDoc('preference', 'a', { summary: 'wedding' }),
      mkDoc('preference', 'b', { summary: 'wedding' }),
      mkDoc('preference', 'c', { summary: 'wedding' }),
    ];
    const { classes } = detectClasses(docs, DEFAULT_ROLLUP_CONFIG);
    expect(classes).toHaveLength(0);
  });

  it('per-pass cap is enforced and logged (no silent truncation)', () => {
    // Two distinct classes, cap=1 → one dropped + rollup_cap_exceeded logged.
    const docs: DocFile[] = [
      mkDoc('episode', 'w1', { summary: 'wedding' }),
      mkDoc('episode', 'w2', { summary: 'wedding' }),
      mkDoc('episode', 'w3', { summary: 'wedding' }),
      mkDoc('episode', 'c1', { summary: 'concert' }),
      mkDoc('episode', 'c2', { summary: 'concert' }),
      mkDoc('episode', 'c3', { summary: 'concert' }),
    ];
    const cfg: RollupConfig = { ...DEFAULT_ROLLUP_CONFIG, salienceMaxFraction: 1, cap: 1 };
    const { log, events } = collectLog();
    const { classes, capExceeded } = detectClasses(docs, cfg, log);
    expect(capExceeded).toBe(true);
    expect(classes).toHaveLength(1);
    expect(events.some((e) => e.event === 'memory_strata_rollup_cap_exceeded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — rollup-doc materialization
// ---------------------------------------------------------------------------
describe('writeRollupDoc materialization', () => {
  function weddingClass(): DetectedClass {
    return {
      slug: 'weddings',
      token: 'wedding',
      category: 'episode',
      members: [
        mkDoc('episode', 'emily-and-sarah', {
          summary: "Emily and Sarah's wedding",
          facts: ["(2026-01-05) Attended Emily and Sarah's wedding"],
        }),
        mkDoc('episode', 'jen-and-tom', {
          summary: "Jen and Tom's wedding",
          facts: ["(2026-03-02) Went to Jen and Tom's barn wedding"],
        }),
        mkDoc('episode', 'rachel-and-mike', {
          summary: "Rachel and Mike's wedding",
          facts: ["(2026-06-20) Celebrated Rachel and Mike's beach wedding"],
        }),
      ],
    };
  }

  it('correct frontmatter + Count/Instances body with dated [[links]]; fires memory:doc:written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollup-write-'));
    const bus = new HookBus();
    const written: Array<Record<string, unknown>> = [];
    bus.subscribe('memory:doc:written', 'test', async (_ctx, p) => {
      written.push(p as Record<string, unknown>);
      return undefined;
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

    const content = buildRollup(weddingClass());
    const res = await writeRollupDoc({ workspaceRoot: root, content, now: NOW, bus, ctx });
    expect(res.wrote).toBe(true);
    expect(res.kind).toBe('created');

    const doc = await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'weddings' });
    expect(doc).not.toBeNull();
    const fm = doc!.frontmatter;
    expect(fm.type).toBe('docs/rollup');
    expect(fm.factType).toBe('rollup');
    expect(fm.origin).toBe('reflect');
    expect(fm.rollup_count).toBe(3);
    expect(fm.rollup_members).toHaveLength(3);
    expect(fm.summary).toContain('3'); // count rides the summary (D5)
    // Body: Count + Instances with dated, linked bullets.
    expect(doc!.body).toContain('## Count');
    expect(doc!.body).toContain('3 distinct weddings.');
    expect(doc!.body).toContain('## Instances');
    expect(doc!.body).toContain('(2026-01-05)');
    expect(doc!.body).toContain('[[episode/emily-and-sarah]]');
    expect(doc!.body).toContain('[[episode/rachel-and-mike]]');
    // Event fired by writeRollupDoc itself (not a bare file write).
    expect(written).toHaveLength(1);
    expect(written[0]!.docId).toBe('rollup/weddings');
    expect(written[0]!.kind).toBe('created');
    await rm(root, { recursive: true, force: true });
  });

  it('instance line falls back to summary (dated by updated) when no dated fact matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollup-fallback-'));
    const cls: DetectedClass = {
      slug: 'weddings',
      token: 'wedding',
      category: 'episode',
      members: [
        mkDoc('episode', 'a', { summary: 'a wedding', updated: '2026-02-02T00:00:00.000Z' }),
        mkDoc('episode', 'b', { summary: 'a wedding', updated: '2026-02-03T00:00:00.000Z' }),
        mkDoc('episode', 'c', { summary: 'a wedding', updated: '2026-02-04T00:00:00.000Z' }),
      ],
    };
    const content = buildRollup(cls);
    await writeRollupDoc({ workspaceRoot: root, content, now: NOW });
    const doc = await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'weddings' });
    expect(doc!.body).toContain('(2026-02-02) a wedding — [[episode/a]]');
    await rm(root, { recursive: true, force: true });
  });
});

describe('rollup robustness (fault isolation inputs)', () => {
  it('buildRollup tolerates a member missing `updated` (no throw; epoch-dated fallback)', () => {
    const m = mkDoc('episode', 'a', { summary: 'a wedding' });
    // Simulate a hand-edited / externally-written doc that passes parseDoc
    // (only source_observations is guarded) but lacks `updated`.
    delete (m.frontmatter as { updated?: string }).updated;
    delete (m.frontmatter as { created?: string }).created;
    const cls: DetectedClass = {
      slug: 'weddings', token: 'wedding', category: 'episode',
      members: [m, mkDoc('episode', 'b', { summary: 'a wedding' }), mkDoc('episode', 'c', { summary: 'a wedding' })],
    };
    expect(() => buildRollup(cls)).not.toThrow();
    const content = buildRollup(cls);
    expect(content.instanceLines.some((l) => l.includes('[[episode/a]]'))).toBe(true);
  });

  it('deleteRollupDoc rejects a malformed slug (returns false, unlinks nothing, fires nothing)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollup-badslug-'));
    const bus = new HookBus();
    const fired: string[] = [];
    bus.subscribe('memory:doc:deleted', 'test', async (_ctx, p) => {
      fired.push((p as { docId: string }).docId);
      return undefined;
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    const acted = await deleteRollupDoc({ workspaceRoot: root, slug: '../evil', bus, ctx });
    expect(acted).toBe(false);
    expect(fired).toHaveLength(0);
    await rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — idempotence
// ---------------------------------------------------------------------------
describe('rollup idempotence', () => {
  // Verbs vary per member so the ONLY token shared across all weddings is
  // "wedding" — otherwise a shared verb (e.g. "attended") would itself form a
  // spurious class and inflate the written count. This is faithful to real
  // data, where the class word is the shared token and verbs vary.
  const VERBS = ['Attended', 'Danced at', 'Toasted at', 'Photographed', 'Sang at'];
  async function seedWeddings(root: string, weddingSlugs: string[]): Promise<void> {
    for (let i = 0; i < weddingSlugs.length; i++) {
      const s = weddingSlugs[i]!;
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: s,
        summary: 'a wedding', subject: s, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW,
        facts: [`(2026-01-05) ${VERBS[i % VERBS.length]} a ${s} wedding`],
      });
    }
    for (const f of FILLERS) {
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: f.slug,
        summary: f.summary, subject: f.slug, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [`(2026-01-06) ${f.summary}`],
      });
    }
  }

  it('unchanged content → no write (rollup_skipped_unchanged); changed member → rewrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollup-idem-'));
    await seedWeddings(root, ['w1', 'w2', 'w3']);

    const first = collectLog();
    const r1 = await runRollupPass({ workspaceRoot: root, now: NOW, log: first.log });
    expect(r1.written).toBe(1);

    const second = collectLog();
    const r2 = await runRollupPass({ workspaceRoot: root, now: NOW, log: second.log });
    expect(r2.written).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(second.events.some((e) => e.event === 'memory_strata_rollup_skipped_unchanged')).toBe(true);

    // Edit a member's representative fact → hash changes → rewrite.
    await writeNewDoc({
      workspaceRoot: root, category: 'episode', slug: 'w1',
      summary: 'a wedding', subject: 'w1', factType: 'episode', confidence: 0.9,
      sourceObservationIds: ['o'], now: NOW,
      facts: ['(2026-01-05) Attended the lakeside wedding of w1 with fireworks'],
    });
    const third = collectLog();
    const r3 = await runRollupPass({ workspaceRoot: root, now: NOW, log: third.log });
    expect(r3.written).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  it('an added member → count+1 rewrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollup-add-'));
    // One extra filler so a 4th wedding stays a MINORITY (4/10 = 0.4 ≤ 0.4) with
    // the DEFAULT salience — otherwise 4/9 would de-qualify the class (a
    // separately-tested behavior) and mask the count+1 rewrite this asserts.
    await seedWeddings(root, ['w1', 'w2', 'w3']);
    await writeNewDoc({
      workspaceRoot: root, category: 'episode', slug: 'aquarium',
      summary: 'an ocean aquarium visit', subject: 'aquarium', factType: 'episode',
      confidence: 0.9, sourceObservationIds: ['o'], now: NOW, facts: ['(2026-01-07) an ocean aquarium visit'],
    });
    await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log });

    await writeNewDoc({
      workspaceRoot: root, category: 'episode', slug: 'w4',
      summary: 'a wedding', subject: 'w4', factType: 'episode', confidence: 0.9,
      sourceObservationIds: ['o'], now: NOW, facts: ['(2026-07-01) Sang at the w4 wedding'],
    });
    const r = await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log });
    expect(r.written).toBe(1);
    const doc = await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'weddings' });
    expect(doc!.frontmatter.rollup_count).toBe(4);
    await rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — GC + index-staleness regression
// ---------------------------------------------------------------------------
describe('rollup GC fires memory:doc:deleted → index:delete', () => {
  it('class drops below K → file unlinked + memory:index:delete called + map line gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollup-gc-'));
    const gcVerbs = ['Attended', 'Danced at', 'Toasted at'];
    const gcSlugs = ['w1', 'w2', 'w3'];
    for (let i = 0; i < gcSlugs.length; i++) {
      const s = gcSlugs[i]!;
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: s,
        summary: 'a wedding', subject: s, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [`(2026-01-05) ${gcVerbs[i]} a ${s} wedding`],
      });
    }
    for (const f of FILLERS) {
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: f.slug,
        summary: f.summary, subject: f.slug, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [`(2026-01-06) ${f.summary}`],
      });
    }

    const bus = new HookBus();
    const deleted: string[] = [];
    bus.registerService('memory:index:upsert', 'stub', async () => ({ ok: true }));
    bus.registerService('memory:index:delete', 'stub', async (_ctx, p) => {
      deleted.push((p as { docId: string }).docId);
      return { ok: true };
    });
    registerReindexer(bus);
    const ctx = makeAgentContext({
      sessionId: 's', agentId: 'a', userId: 'u', workspace: { rootPath: root },
    });

    // First pass: weddings class qualifies → rollup written.
    await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log, bus, ctx });
    await access(join(root, docFile('rollup', 'weddings'))); // exists

    // Drop below K: remove one wedding member from disk (2 left < 3).
    await rm(join(root, docFile('episode', 'w1')));

    const gc = collectLog();
    const r = await runRollupPass({ workspaceRoot: root, now: NOW, log: gc.log, bus, ctx });
    expect(r.deletedDocIds).toContain('rollup/weddings');
    expect(gc.events.some((e) => e.event === 'memory_strata_rollup_gc_deleted')).toBe(true);
    // memory:index:delete fired for the stale rollup (via reindex.ts, TASK-199).
    expect(deleted).toContain('rollup/weddings');
    // File unlinked.
    await expect(access(join(root, docFile('rollup', 'weddings')))).rejects.toThrow();

    // Map line gone.
    await regenerateMap({ workspaceRoot: root, now: NOW });
    const map = await readFile(join(root, 'permanent/memory/system/map.md'), 'utf8');
    expect(map).not.toContain('weddings');
    await rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Layer 7 — retrieval surfacing (direct/CLI path); parseDocId accepts rollup
// ---------------------------------------------------------------------------
describe('rollup surfacing via memory_search', () => {
  it('count rides summary; instances ride matchedFacts (parseDocId accepts rollup)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollup-surf-'));
    // Materialize the rollup on disk directly.
    const content = buildRollup({
      slug: 'weddings', token: 'wedding', category: 'episode',
      members: [
        mkDoc('episode', 'emily-and-sarah', { summary: "Emily's wedding", facts: ['(2026-01-05) Attended Emily and Sarah wedding'] }),
        mkDoc('episode', 'jen-and-tom', { summary: "Jen's wedding", facts: ['(2026-03-02) Went to Jen and Tom wedding'] }),
        mkDoc('episode', 'rachel-and-mike', { summary: "Rachel's wedding", facts: ['(2026-06-20) Rachel and Mike wedding'] }),
      ],
    });
    await writeRollupDoc({ workspaceRoot: root, content, now: NOW });

    const bus = new HookBus();
    bus.registerService<ToolDescriptor, { ok: true }>('tool:register', 'stub', async () => ({ ok: true }));
    const searchResults: RetrievalResult[] = [
      { docId: 'rollup/weddings', category: 'rollup', slug: 'weddings', summary: content.summary, snippet: '', score: 2 },
    ];
    bus.registerService('memory:index:search', 'stub', async () => ({ results: searchResults }));
    await registerMemorySearch(bus);

    const ctx = makeAgentContext({
      sessionId: 's', agentId: 'a', userId: 'u', workspace: { rootPath: root },
    });
    const out = (await bus.call('tool:execute:memory_search', ctx, {
      id: 'c', name: 'memory_search', input: { query: 'how many weddings', topK: 5 },
    })) as { results: Array<{ summary: string; matchedFacts: string[] }> };

    const hit = out.results.find((r) => r.summary.includes('(rollup)'));
    expect(hit).toBeDefined();
    expect(hit!.summary).toContain('3'); // count in summary
    // Instances surface via matchedFacts (parseDocId must accept 'rollup' or
    // this is []). The load-bearing doc-id.ts edit.
    expect(hit!.matchedFacts.some((f) => f.includes('Emily'))).toBe(true);
    expect(hit!.matchedFacts.some((f) => f.includes('Rachel'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Layer 8 — end-to-end enumeration canary
// ---------------------------------------------------------------------------
describe('rollup enumeration canary', () => {
  it('3 weddings across subjects → docs/rollup/weddings.md count 3 + 3 links; memory_search returns it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollup-canary-'));
    const weddings = [
      { slug: 'emily-and-sarah', fact: "(2026-01-05) Attended Emily and Sarah's wedding" },
      { slug: 'jen-and-tom', fact: "(2026-03-02) Danced at Jen and Tom's wedding" },
      { slug: 'rachel-and-mike', fact: "(2026-06-20) Toasted at Rachel and Mike's wedding" },
    ];
    for (const w of weddings) {
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: w.slug,
        summary: 'a wedding', subject: w.slug, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [w.fact],
      });
    }
    // Fillers so weddings are a MINORITY of the episode category (3/8 = 0.375 ≤ 0.4).
    for (const f of FILLERS) {
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: f.slug,
        summary: f.summary, subject: f.slug, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [`(2026-01-06) ${f.summary}`],
      });
    }

    await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log });

    const doc = await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'weddings' });
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter.rollup_count).toBe(3);
    expect(doc!.body).toContain('[[episode/emily-and-sarah]]');
    expect(doc!.body).toContain('[[episode/jen-and-tom]]');
    expect(doc!.body).toContain('[[episode/rachel-and-mike]]');

    // listDocs enumerates docs/rollup/ (D1 doc-store CATEGORIES edit).
    const all = await listDocs({ workspaceRoot: root });
    expect(all.some((d) => d.frontmatter.id === 'rollup/weddings')).toBe(true);

    // memory_search("how many weddings") returns the rollup with count in summary.
    const bus = new HookBus();
    bus.registerService<ToolDescriptor, { ok: true }>('tool:register', 'stub', async () => ({ ok: true }));
    bus.registerService('memory:index:search', 'stub', async () => ({
      results: [{ docId: 'rollup/weddings', category: 'rollup', slug: 'weddings', summary: doc!.frontmatter.summary, snippet: '', score: 2 }],
    }));
    await registerMemorySearch(bus);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', workspace: { rootPath: root } });
    const out = (await bus.call('tool:execute:memory_search', ctx, {
      id: 'c', name: 'memory_search', input: { query: 'how many weddings', topK: 5 },
    })) as { results: Array<{ docId: string; summary: string }> };
    expect(out.results.some((r) => r.docId === 'rollup/weddings' && r.summary.includes('3'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
