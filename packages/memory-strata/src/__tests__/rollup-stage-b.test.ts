// TASK-201 — Stage B: bounded LLM class naming over the rollup residue.
// Layer 2 (design Testing §2) + the merge/dedup/cap/fault-isolation contract.
//
// Stage B is the LLM half of the reflect-rollup pipeline. The model is STRICTLY a
// namer/clusterer of REAL docs: its output is verified deterministically
// (`verifyStageBClasses`) before anything reaches disk, and it flows through the
// SAME buildRollup/writeRollupDoc/GC contract as Stage A (TASK-200).

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext } from '@ax/core';
import type { LlmCallInput, LlmCallOutput, ToolDescriptor } from '@ax/core';
import {
  DEFAULT_ROLLUP_CONFIG,
  makeStageBNamer,
  runRollupPass,
  verifyStageBClasses,
  type ProposedClass,
  type RollupConfig,
  type RollupLogger,
  type StageBNamer,
} from '../rollup.js';
import { writeNewDoc, readDoc } from '../doc-store.js';
import { docFile } from '../paths.js';
import { registerMemorySearch } from '../tools/memory-search.js';
import type { DocFile } from '../types.js';
import type { RetrievalResult } from '../retriever.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function mkDoc(
  category: string,
  slug: string,
  opts: { summary?: string; facts?: string[]; updated?: string },
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
      subject: slug,
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

function stubLlm(text: string): (input: LlmCallInput) => Promise<LlmCallOutput> {
  return async () => ({ text, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
}

// ---------------------------------------------------------------------------
// Layer 2a — verifyStageBClasses: the deterministic bound (the LLM is NOT trusted)
// ---------------------------------------------------------------------------
describe('verifyStageBClasses (deterministic bound)', () => {
  const residue: DocFile[] = [
    mkDoc('episode', 'couch', { summary: 'bought a new leather couch' }),
    mkDoc('episode', 'dining-table', { summary: 'refinished the oak dining table' }),
    mkDoc('episode', 'standing-desk', { summary: 'assembled a standing desk' }),
  ];

  it('verified membership against real doc ids → one class of the cited members', () => {
    const proposed: ProposedClass[] = [
      { class: 'furniture', members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
    ];
    const out = verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe('furniture');
    expect(out[0]!.members.map((m) => m.frontmatter.id).sort()).toEqual([
      'episode/couch', 'episode/dining-table', 'episode/standing-desk',
    ]);
  });

  it('hallucinated doc ids are dropped; a class that falls below K after the drop is discarded', () => {
    const proposed: ProposedClass[] = [
      // 2 real + 1 invented → 2 verified < K=3 → discarded.
      { class: 'furniture', members: ['episode/couch', 'episode/dining-table', 'episode/ghost-doc'] },
    ];
    const out = verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG);
    expect(out).toHaveLength(0);
  });

  it('a class the model returns with fewer than K members is discarded', () => {
    const proposed: ProposedClass[] = [
      { class: 'furniture', members: ['episode/couch', 'episode/dining-table'] },
    ];
    expect(verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG)).toHaveLength(0);
  });

  it('members are deduped by docId (a repeated id does not inflate the count)', () => {
    const proposed: ProposedClass[] = [
      { class: 'furniture', members: ['episode/couch', 'episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
    ];
    const out = verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]!.members).toHaveLength(3);
  });

  it('a blank/missing label is dropped (no rollup the model never named)', () => {
    const proposed = [
      { class: '   ', members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
      { members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
    ] as unknown as ProposedClass[];
    expect(verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG)).toHaveLength(0);
  });

  it('a non-empty garbage label collapses to slugify\'s traversal-safe fallback (no arbitrary path)', () => {
    const proposed: ProposedClass[] = [
      { class: '!!!', members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
    ];
    const out = verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe('general'); // slugify FALLBACK — never a raw model path
  });

  it('an overlong label is dropped (slug length is bounded, not just its charset)', () => {
    // slugify sanitizes charset but never caps length; an ~1KB label would become
    // a filename that throws ENAMETOOLONG on write and abort the pass.
    const proposed: ProposedClass[] = [
      { class: 'a'.repeat(500), members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
    ];
    expect(verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG)).toHaveLength(0);
  });

  it('a duplicate class label is ignored (first wins)', () => {
    const proposed: ProposedClass[] = [
      { class: 'furniture', members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
      { class: 'Furniture', members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
    ];
    expect(verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG)).toHaveLength(1);
  });

  it('malformed proposal entries (non-object, missing fields, non-string ids) are tolerated', () => {
    const proposed = [
      null,
      'garbage',
      { members: ['episode/couch'] }, // no class label
      { class: 'furniture' }, // no members
      { class: 'furniture', members: [1, 2, 3] }, // non-string ids
      { class: 'furniture', members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
    ] as unknown as ProposedClass[];
    const out = verifyStageBClasses(proposed, residue, DEFAULT_ROLLUP_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe('furniture');
  });
});

// ---------------------------------------------------------------------------
// Layer 2b — makeStageBNamer: the LLM round-trip (stubbed), best-effort posture
// ---------------------------------------------------------------------------
describe('makeStageBNamer (stubbed LLM)', () => {
  const residue: DocFile[] = [
    mkDoc('episode', 'couch', { summary: 'bought a leather couch' }),
    mkDoc('episode', 'dining-table', { summary: 'oak dining table' }),
    mkDoc('episode', 'standing-desk', { summary: 'standing desk' }),
  ];

  it('parses the proposal and verifies membership against the residue', async () => {
    const namer = makeStageBNamer({
      llmCall: stubLlm(JSON.stringify([
        { class: 'furniture', members: ['episode/couch', 'episode/dining-table', 'episode/standing-desk'] },
      ])),
      model: 'claude-haiku-4-5',
      timeoutMs: 1000,
    });
    const { log, events } = collectLog();
    const out = await namer(residue, DEFAULT_ROLLUP_CONFIG, log);
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe('furniture');
    expect(events.some((e) => e.event === 'memory_strata_rollup_stage_b_named')).toBe(true);
  });

  it('tolerates prose wrapping the JSON array (hunts for the top-level array)', async () => {
    const namer = makeStageBNamer({
      llmCall: stubLlm('Sure! Here are the classes:\n[{ "class": "furniture", "members": ["episode/couch","episode/dining-table","episode/standing-desk"] }]\nHope that helps.'),
      model: 'claude-haiku-4-5',
      timeoutMs: 1000,
    });
    const out = await namer(residue, DEFAULT_ROLLUP_CONFIG, collectLog().log);
    expect(out).toHaveLength(1);
  });

  it('unparseable output → [] (logged), Stage A still ships', async () => {
    const namer = makeStageBNamer({ llmCall: stubLlm('not json at all'), model: 'm', timeoutMs: 1000 });
    const { log, events } = collectLog();
    expect(await namer(residue, DEFAULT_ROLLUP_CONFIG, log)).toEqual([]);
    expect(events.some((e) => e.event === 'memory_strata_rollup_stage_b_parse_error')).toBe(true);
  });

  it('an LLM call that throws → [] (logged), never propagates', async () => {
    const namer = makeStageBNamer({
      llmCall: async () => { throw new Error('provider down'); },
      model: 'm',
      timeoutMs: 1000,
    });
    const { log, events } = collectLog();
    expect(await namer(residue, DEFAULT_ROLLUP_CONFIG, log)).toEqual([]);
    expect(events.some((e) => e.event === 'memory_strata_rollup_stage_b_llm_failed')).toBe(true);
  });

  it('an LLM call that never resolves → timeout → [] (timeout:true logged)', async () => {
    const namer = makeStageBNamer({
      llmCall: () => new Promise<LlmCallOutput>(() => { /* never resolves */ }),
      model: 'm',
      timeoutMs: 1,
    });
    const { log, events } = collectLog();
    expect(await namer(residue, DEFAULT_ROLLUP_CONFIG, log)).toEqual([]);
    const evt = events.find((e) => e.event === 'memory_strata_rollup_stage_b_llm_failed');
    expect(evt).toBeDefined();
    expect(evt!.fields.timeout).toBe(true);
  });

  it('passes the configured model verbatim to the LLM call (pins the id contract)', async () => {
    let seenModel: string | undefined;
    const namer = makeStageBNamer({
      llmCall: async (input) => {
        seenModel = input.model;
        return { text: '[]', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
      },
      model: 'claude-haiku-4-5-20251001',
      timeoutMs: 1000,
    });
    await namer(residue, DEFAULT_ROLLUP_CONFIG, collectLog().log);
    expect(seenModel).toBe('claude-haiku-4-5-20251001');
  });

  it('caps the residue shown to the LLM (bounded single call) and validates ids against the shown subset', async () => {
    // 250 residue docs; only STAGE_B_MAX_RESIDUE_DOCS (200) are shown. A verified
    // furniture class over 3 shown ids still lands; residue_capped is logged.
    const big: DocFile[] = Array.from({ length: 250 }, (_, i) =>
      mkDoc('episode', `d${String(i).padStart(3, '0')}`, { summary: `misc item ${i}` }));
    let shownCount = 0;
    const namer = makeStageBNamer({
      llmCall: async (input) => {
        // The prompt body is one "<id>: <summary>" line per shown doc.
        shownCount = input.messages[0]!.content.split('\n').filter((l) => l.includes(': ')).length;
        return {
          text: JSON.stringify([{ class: 'items', members: ['episode/d000', 'episode/d001', 'episode/d002'] }]),
          stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      model: 'm',
      timeoutMs: 1000,
    });
    const { log, events } = collectLog();
    const out = await namer(big, DEFAULT_ROLLUP_CONFIG, log);
    expect(shownCount).toBe(200); // capped
    expect(out).toHaveLength(1); // d000..d002 are in the first-200 (sorted by id)
    expect(events.some((e) => e.event === 'memory_strata_rollup_stage_b_residue_capped')).toBe(true);
  });

  it('residue smaller than K → no LLM call at all (returns [])', async () => {
    let called = false;
    const namer = makeStageBNamer({
      llmCall: async () => { called = true; return { text: '[]', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }; },
      model: 'm',
      timeoutMs: 1000,
    });
    const out = await namer(residue.slice(0, 2), DEFAULT_ROLLUP_CONFIG, collectLog().log);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2c — runRollupPass wiring: residue-only, merge/dedup, cap, fault isolation
// ---------------------------------------------------------------------------
describe('runRollupPass with Stage B', () => {
  const FURNITURE = ['couch', 'dining-table', 'standing-desk'] as const;
  const FURNITURE_IDS = FURNITURE.map((s) => `episode/${s}`);
  // Distinct-token fillers keep the 3 weddings a MINORITY under the DEFAULT
  // salience (0.4) — the same posture as rollup.test.ts. Default salience also
  // correctly drops the shared date token (`2026`, in 100% of dated facts) that
  // salience=1 would let form a spurious class.
  const FILLERS = ['hiking-trip', 'concert', 'museum', 'road', 'garden'];

  // Verbs vary so "wedding" is the only shared token across the 3 weddings.
  const WEDDING_VERBS = ['Attended', 'Danced at', 'Toasted at'];
  async function seedWeddings(root: string): Promise<void> {
    const wslugs = ['emily', 'jen', 'rachel'];
    for (let i = 0; i < wslugs.length; i++) {
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: wslugs[i]!,
        summary: 'a wedding', subject: wslugs[i]!, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [`(2026-01-0${i + 1}) ${WEDDING_VERBS[i]} a wedding`],
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
  // Furniture: 3 docs sharing NO surface token → Stage A can't group them.
  async function seedFurniture(root: string): Promise<void> {
    const items = [
      { slug: 'couch', summary: 'bought a leather couch' },
      { slug: 'dining-table', summary: 'refinished the oak dining table' },
      { slug: 'standing-desk', summary: 'assembled a standing desk' },
    ];
    for (const it of items) {
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: it.slug,
        summary: it.summary, subject: it.slug, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [`(2026-02-01) ${it.summary}`],
      });
    }
  }

  /** Stage-B stub: proposes `slug` claiming an EXPLICIT set of member ids, run
   *  through the REAL verification path (so ids absent from the residue are
   *  dropped), and records the residue it was handed. */
  function stubStageB(slug: string, memberIds: string[], seen: { residue: DocFile[] }): StageBNamer {
    return async (residue, config) => {
      seen.residue = residue;
      return verifyStageBClasses([{ class: slug, members: memberIds }], residue, config);
    };
  }

  it('a semantically-named class (furniture, no shared token) materializes via Stage B', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stageb-furniture-'));
    await seedFurniture(root);
    const seen = { residue: [] as DocFile[] };
    const r = await runRollupPass({
      workspaceRoot: root, now: NOW, log: collectLog().log, stageB: stubStageB('furniture', FURNITURE_IDS, seen),
    });
    expect(r.written).toBe(1);
    const doc = await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'furniture' });
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter.rollup_count).toBe(3);
    expect(doc!.frontmatter.summary).toContain('3');
    expect(doc!.body).toContain('## Instances');
    expect(doc!.body).toContain('[[episode/couch]]');
    expect(doc!.body).toContain('[[episode/standing-desk]]');
    await rm(root, { recursive: true, force: true });
  });

  it('Stage B input is the RESIDUE only — docs a Stage-A class claimed are excluded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stageb-residue-'));
    await seedWeddings(root);   // Stage A claims these 3 (weddings)
    await seedFurniture(root);  // residue (no shared token)
    const seen = { residue: [] as DocFile[] };
    await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log, stageB: stubStageB('furniture', FURNITURE_IDS, seen) });
    const residueIds = new Set(seen.residue.map((d) => d.frontmatter.id));
    // Wedding docs were claimed by Stage A → absent from the residue handed to B.
    expect(residueIds.has('episode/emily')).toBe(false);
    expect(residueIds.has('episode/jen')).toBe(false);
    // Furniture docs are in the residue.
    expect(residueIds.has('episode/couch')).toBe(true);
    expect(residueIds.has('episode/standing-desk')).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('both stages run: Stage A weddings + Stage B furniture both materialize', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stageb-both-'));
    await seedWeddings(root);
    await seedFurniture(root);
    const seen = { residue: [] as DocFile[] };
    const r = await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log, stageB: stubStageB('furniture', FURNITURE_IDS, seen) });
    expect(r.written).toBe(2);
    expect(await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'weddings' })).not.toBeNull();
    expect(await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'furniture' })).not.toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  it('slug collision with Stage A UNIONs members deduped by docId (no double-write, count correct)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stageb-collide-'));
    await seedWeddings(root);   // Stage A → weddings (3 members)
    await seedFurniture(root);  // residue
    // Stage B (over the residue) also proposes the slug "weddings", claiming the
    // 3 furniture docs (disjoint from Stage A's weddings, since residue excludes
    // claimed docs) → union → count 6, written ONCE.
    const seen = { residue: [] as DocFile[] };
    const r = await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log, stageB: stubStageB('weddings', FURNITURE_IDS, seen) });
    expect(r.written).toBe(1); // one weddings.md, not two
    const doc = await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'weddings' });
    expect(doc!.frontmatter.rollup_count).toBe(6); // 3 Stage-A + 3 Stage-B, deduped
    await rm(root, { recursive: true, force: true });
  });

  it('shared per-pass cap spans BOTH stages + logs rollup_cap_exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stageb-cap-'));
    await seedWeddings(root);   // Stage A → weddings
    await seedFurniture(root);  // residue → Stage B furniture
    const cfg: RollupConfig = { ...DEFAULT_ROLLUP_CONFIG, cap: 1 };
    const seen = { residue: [] as DocFile[] };
    const { log, events } = collectLog();
    const r = await runRollupPass({ workspaceRoot: root, now: NOW, log, config: cfg, stageB: stubStageB('furniture', FURNITURE_IDS, seen) });
    // 2 detected (weddings + furniture), cap 1 → one written, cap logged.
    expect(r.written).toBe(1);
    expect(events.some((e) => e.event === 'memory_strata_rollup_cap_exceeded')).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('a Stage-B throw does NOT abort the pass — Stage A rollups still ship', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stageb-throw-'));
    await seedWeddings(root);
    const throwing: StageBNamer = async () => { throw new Error('stage B blew up'); };
    const { log, events } = collectLog();
    const r = await runRollupPass({ workspaceRoot: root, now: NOW, log, stageB: throwing });
    expect(r.written).toBe(1); // Stage A weddings survived
    expect(await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'weddings' })).not.toBeNull();
    expect(events.some((e) => e.event === 'memory_strata_rollup_stage_b_failed')).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('no Stage B wired → Stage A only (unchanged from TASK-200)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stageb-none-'));
    await seedWeddings(root);
    await seedFurniture(root);
    const r = await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log });
    expect(r.written).toBe(1); // only Stage A weddings; furniture never named
    await expect(access(join(root, docFile('rollup', 'furniture')))).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Layer 2d — surfacing: a Stage-B rollup is retrievable via memory_search
// ---------------------------------------------------------------------------
describe('Stage-B rollup surfaces via memory_search', () => {
  it('furniture rollup returned with count in summary + instances in matchedFacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stageb-surf-'));
    for (const it of [
      { slug: 'couch', summary: 'a leather couch' },
      { slug: 'dining-table', summary: 'an oak dining table' },
      { slug: 'standing-desk', summary: 'a standing desk' },
    ]) {
      await writeNewDoc({
        workspaceRoot: root, category: 'episode', slug: it.slug,
        summary: it.summary, subject: it.slug, factType: 'episode', confidence: 0.9,
        sourceObservationIds: ['o'], now: NOW, facts: [`(2026-02-01) ${it.summary}`],
      });
    }
    const seen = { residue: [] as DocFile[] };
    const stageB: StageBNamer = async (residue, config) => {
      seen.residue = residue;
      return verifyStageBClasses([{ class: 'furniture', members: residue.map((d) => d.frontmatter.id) }], residue, config);
    };
    await runRollupPass({ workspaceRoot: root, now: NOW, log: collectLog().log, stageB });
    const doc = await readDoc({ workspaceRoot: root, category: 'rollup', slug: 'furniture' });
    expect(doc).not.toBeNull();

    const bus = new HookBus();
    bus.registerService<ToolDescriptor, { ok: true }>('tool:register', 'stub', async () => ({ ok: true }));
    const results: RetrievalResult[] = [
      { docId: 'rollup/furniture', category: 'rollup', slug: 'furniture', summary: doc!.frontmatter.summary, snippet: '', score: 2 },
    ];
    bus.registerService('memory:index:search', 'stub', async () => ({ results }));
    await registerMemorySearch(bus);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', workspace: { rootPath: root } });
    // Count rides the summary (the reliable channel, D5). Instances ride
    // matchedFacts, which are query-overlap filtered (matched-facts.ts) — so the
    // query must mention an instance word (a "furniture" rollup's bullets say
    // couch/table/desk, not "furniture").
    const out = (await bus.call('tool:execute:memory_search', ctx, {
      id: 'c', name: 'memory_search', input: { query: 'couch table desk furniture', topK: 5 },
    })) as { results: Array<{ docId: string; summary: string; matchedFacts: string[] }> };
    const hit = out.results.find((r) => r.docId === 'rollup/furniture');
    expect(hit).toBeDefined();
    expect(hit!.summary).toContain('3'); // count in summary (primary channel)
    expect(hit!.matchedFacts.some((f) => f.includes('couch'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
