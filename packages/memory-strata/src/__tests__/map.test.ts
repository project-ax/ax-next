// Tests for map.ts — the `system/map.md` regenerator (TASK-190).
//
// map.md is the always-injected hierarchical index. It is a DERIVED, cached
// view of `docs/<category>/<slug>.md`: one densified one-liner per doc,
// grouped by category. Key behaviours under test:
//   1. Determinism (like recent.md / I13): delete + re-run with the same
//      densifier produces byte-for-byte identical output.
//   2. Incremental densification: a doc whose facts are unchanged is NOT
//      re-densified (the cache supplies the prior summary); a changed doc IS.
//   3. Graceful degradation: with NO densifier (CI / no keys / LLM down) the
//      map still generates, falling back to the doc's frontmatter summary.
//   4. Sensitive content never reaches the densifier (defence in depth — docs
//      are already gated, but the map must not widen the trust boundary).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regenerateMap, makeLlmDensifier, type MapDensifier } from '../map.js';
import { writeNewDoc } from '../doc-store.js';
import { mapFile, mapCacheFile } from '../paths.js';
import type { LlmCallInput, LlmCallOutput } from '@ax/core';

const NOW = new Date('2026-05-20T12:00:00Z');

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-map-'));
});
afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** Densifier that prepends "DENSE:" so we can tell densified from raw. */
function makeCountingDensifier(): MapDensifier & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input) => {
    calls.push(input.docId);
    return `DENSE: ${input.facts.join('; ')}`;
  }) as MapDensifier & { calls: string[] };
  fn.calls = calls;
  return fn;
}

async function seedDoc(opts: {
  category: 'entity' | 'preference' | 'decision' | 'episode' | 'general';
  slug: string;
  summary: string;
  facts: string[];
  now?: Date;
}): Promise<void> {
  await writeNewDoc({
    workspaceRoot,
    category: opts.category,
    slug: opts.slug,
    summary: opts.summary,
    subject: opts.slug,
    factType: opts.category,
    confidence: 0.9,
    sourceObservationIds: ['obs-1'],
    now: opts.now ?? NOW,
    facts: opts.facts,
  });
}

describe('regenerateMap', () => {
  it('writes map.md grouped by category with densified one-liners', async () => {
    await seedDoc({
      category: 'preference',
      slug: 'cars',
      summary: 'first sentence chitchat about a morning',
      facts: ['User prefers Tesla over BMW', 'Commutes 45 min to Boston'],
    });
    await seedDoc({
      category: 'entity',
      slug: 'employer',
      summary: 'good morning I was wondering',
      facts: ['Works at Canopy Works as an engineer'],
    });

    const densify = makeCountingDensifier();
    const result = await regenerateMap({ workspaceRoot, now: NOW, densify });

    expect(result.path).toBe(mapFile());
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');

    // Grouped by category, categories sorted.
    expect(content).toContain('## entity/');
    expect(content).toContain('## preference/');
    expect(content.indexOf('## entity/')).toBeLessThan(content.indexOf('## preference/'));

    // Densified one-liners, NOT the chitchat frontmatter summary.
    expect(content).toContain('DENSE: User prefers Tesla over BMW; Commutes 45 min to Boston');
    expect(content).toContain('DENSE: Works at Canopy Works as an engineer');
    expect(content).not.toContain('chitchat');
    expect(content).not.toContain('good morning');

    // Densifier was called once per doc.
    expect(densify.calls.sort()).toEqual(['entity/employer', 'preference/cars']);

    // Frontmatter sanity — pinned system file.
    expect(content).toContain('type: system/map');
    expect(content).toContain('pinned: true');
    expect(content).toContain('id: map');
  });

  it('falls back to the frontmatter summary when no densifier is provided', async () => {
    await seedDoc({
      category: 'preference',
      slug: 'cars',
      summary: 'User prefers Tesla over BMW',
      facts: ['User prefers Tesla over BMW'],
    });

    const result = await regenerateMap({ workspaceRoot, now: NOW });
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');

    expect(content).toContain('## preference/');
    expect(content).toContain('User prefers Tesla over BMW');
    expect(content).not.toContain('DENSE:');
  });

  it('empty workspace: writes a placeholder map (always present for inject)', async () => {
    const result = await regenerateMap({ workspaceRoot, now: NOW });
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');
    expect(content).toContain('# Memory Map');
    expect(content).toContain('_No memory yet._');
  });

  it('determinism: delete + re-run with same densifier produces identical output', async () => {
    await seedDoc({
      category: 'entity',
      slug: 'employer',
      summary: 'Works at Canopy',
      facts: ['Works at Canopy Works'],
    });
    const densify = makeCountingDensifier();

    const rel = (await regenerateMap({ workspaceRoot, now: NOW, densify })).path;
    const first = await readFile(join(workspaceRoot, rel), 'utf8');
    await rm(join(workspaceRoot, rel));
    await regenerateMap({ workspaceRoot, now: NOW, densify });
    const second = await readFile(join(workspaceRoot, rel), 'utf8');

    expect(second).toBe(first);
  });

  it('incremental: an unchanged doc is NOT re-densified on the next pass', async () => {
    await seedDoc({
      category: 'entity',
      slug: 'employer',
      summary: 'Works at Canopy',
      facts: ['Works at Canopy Works'],
    });
    const densify = makeCountingDensifier();

    await regenerateMap({ workspaceRoot, now: NOW, densify });
    expect(densify.calls).toEqual(['entity/employer']);

    // Second pass, same docs, same densifier instance fresh call-log.
    const densify2 = makeCountingDensifier();
    await regenerateMap({ workspaceRoot, now: NOW, densify: densify2 });
    // Cache hit — densifier NOT called again.
    expect(densify2.calls).toEqual([]);

    // The densified one-liner is still in the map (served from cache).
    const content = await readFile(join(workspaceRoot, mapFile()), 'utf8');
    expect(content).toContain('DENSE: Works at Canopy Works');
  });

  it('incremental: a doc whose facts changed IS re-densified', async () => {
    await seedDoc({
      category: 'entity',
      slug: 'employer',
      summary: 'Works at Canopy',
      facts: ['Works at Canopy Works'],
    });
    const densify = makeCountingDensifier();
    await regenerateMap({ workspaceRoot, now: NOW, densify });

    // Mutate the doc body (a new fact appended).
    await seedDoc({
      category: 'entity',
      slug: 'employer',
      summary: 'Works at Canopy',
      facts: ['Works at Canopy Works', 'Promoted to staff engineer'],
    });
    const densify2 = makeCountingDensifier();
    await regenerateMap({ workspaceRoot, now: NOW, densify: densify2 });
    expect(densify2.calls).toEqual(['entity/employer']);
    const content = await readFile(join(workspaceRoot, mapFile()), 'utf8');
    expect(content).toContain('Promoted to staff engineer');
  });

  it('a densifier that throws degrades to the frontmatter summary (does not abort the pass)', async () => {
    await seedDoc({
      category: 'preference',
      slug: 'cars',
      summary: 'User prefers Tesla over BMW',
      facts: ['User prefers Tesla over BMW'],
    });
    await seedDoc({
      category: 'entity',
      slug: 'employer',
      summary: 'Works at Canopy',
      facts: ['Works at Canopy Works'],
    });

    const densify: MapDensifier = async (input) => {
      if (input.docId === 'entity/employer') throw new Error('LLM exploded');
      return `DENSE: ${input.facts.join('; ')}`;
    };

    // Must not throw — a single doc's densification failure degrades to its
    // raw summary, the other doc still densifies.
    const result = await regenerateMap({ workspaceRoot, now: NOW, densify });
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');
    expect(content).toContain('DENSE: User prefers Tesla over BMW');
    expect(content).toContain('Works at Canopy'); // fallback to summary
  });

  it('writes the densify cache sidecar so a later pass can reuse it', async () => {
    await seedDoc({
      category: 'entity',
      slug: 'employer',
      summary: 'Works at Canopy',
      facts: ['Works at Canopy Works'],
    });
    const densify = makeCountingDensifier();
    await regenerateMap({ workspaceRoot, now: NOW, densify });

    const cacheRaw = await readFile(join(workspaceRoot, mapCacheFile()), 'utf8');
    const cache = JSON.parse(cacheRaw) as Record<string, { hash: string; summary: string }>;
    expect(cache['entity/employer']).toBeDefined();
    expect(cache['entity/employer']!.summary).toContain('DENSE: Works at Canopy Works');
  });
});

describe('makeLlmDensifier', () => {
  function makeLlm(
    fn: (input: LlmCallInput) => Promise<LlmCallOutput>,
  ): (input: LlmCallInput) => Promise<LlmCallOutput> {
    return fn;
  }

  it('sends only the doc FACTS (never the raw body) and cleans the LLM output', async () => {
    let seenUser = '';
    const llmCall = makeLlm(async (input) => {
      seenUser = input.messages.map((m) => m.content).join('\n');
      return {
        text: '```\nSummary: User commutes 45 min to Boston; prefers Tesla over BMW\n```',
        stopReason: 'end_turn',
        usage: { inputTokens: 30, outputTokens: 12 },
      };
    });
    const densify = makeLlmDensifier({ llmCall, model: 'claude-haiku-4-5' });

    const summary = await densify({
      docId: 'preference/cars',
      category: 'preference',
      facts: ['User prefers Tesla over BMW', 'Commutes 45 min to Boston'],
      fallbackSummary: 'raw summary',
    });

    // Fences + "Summary:" prefix stripped.
    expect(summary).toBe('User commutes 45 min to Boston; prefers Tesla over BMW');
    // The prompt carried the facts, not a doc body / frontmatter.
    expect(seenUser).toContain('User prefers Tesla over BMW');
    expect(seenUser).toContain('Commutes 45 min to Boston');
  });

  it('a slow call throws TimeoutError, which regenerateMap degrades to the raw summary', async () => {
    await seedDoc({
      category: 'preference',
      slug: 'cars',
      summary: 'fallback car summary',
      facts: ['User prefers Tesla over BMW'],
    });
    // An llmCall that never resolves within the timeout.
    const llmCall = makeLlm(
      () => new Promise<LlmCallOutput>(() => {/* never resolves */}),
    );
    const densify = makeLlmDensifier({ llmCall, model: 'm', timeoutMs: 10 });

    const result = await regenerateMap({ workspaceRoot, now: NOW, densify });
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');
    // Degraded to the doc's frontmatter summary; the pass did not throw.
    expect(content).toContain('fallback car summary');

    // Timed-out doc was NOT cached, so a later (working) pass retries it.
    const cacheRaw = await readFile(join(workspaceRoot, mapCacheFile()), 'utf8').catch(() => '{}');
    const cache = JSON.parse(cacheRaw) as Record<string, unknown>;
    expect(cache['preference/cars']).toBeUndefined();
  });

  it('caps an over-long densified line at ~120 chars', async () => {
    const long = 'x'.repeat(400);
    const llmCall = makeLlm(async () => ({
      text: long,
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const densify = makeLlmDensifier({ llmCall, model: 'm' });
    const summary = await densify({
      docId: 'entity/x',
      category: 'entity',
      facts: ['fact'],
      fallbackSummary: 'fallback',
    });
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.endsWith('…')).toBe(true);
  });
});
