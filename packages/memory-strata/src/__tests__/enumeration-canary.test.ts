import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext } from '@ax/core';
import type { ToolDescriptor } from '@ax/core';
import { writeNewDoc } from '../doc-store.js';
import { registerMemorySearch } from '../tools/memory-search.js';
import type { RetrievalResult } from '../retriever.js';

// The multi-session e2e failure mode: instances of one class (weddings
// attended) scattered across separate docs/subjects. A single memory_search
// must surface ALL of them via matchedFacts across the result rows — this is
// a regression net for Task 1 (dated facts) + Task 3 (matchedFacts
// enrichment), not TDD. It must pass immediately.
describe('enumeration canary', () => {
  it('surfaces every scattered wedding instance in matchedFacts across hits', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'enum-canary-'));
    const now = new Date('2026-01-10T00:00:00.000Z');
    const docs = [
      { slug: 'emily-and-sarah', fact: "(2026-01-05) User attended Emily and Sarah's wedding." },
      { slug: 'jen-and-tom', fact: "(2026-03-02) User attended Jen and Tom's barn wedding." },
      { slug: 'rachel-and-mike', fact: "(2026-06-20) User attended Rachel and Mike's beach wedding." },
    ];

    for (const d of docs) {
      await writeNewDoc({
        workspaceRoot,
        category: 'episode',
        slug: d.slug,
        summary: 'a wedding',
        subject: d.slug,
        factType: 'episode',
        confidence: 0.9,
        sourceObservationIds: ['obs-1'],
        now,
        facts: [d.fact],
      });
    }

    const bus = new HookBus();

    bus.registerService<ToolDescriptor, { ok: true }>(
      'tool:register',
      'test-tool-dispatcher',
      async () => ({ ok: true }),
    );

    const searchResults: RetrievalResult[] = docs.map((d, i) => ({
      docId: `episode/${d.slug}`,
      category: 'episode',
      slug: d.slug,
      summary: 'a wedding',
      snippet: '',
      score: 1 - i * 0.1,
    }));
    bus.registerService('memory:index:search', 'test-indexer', async (_ctx, _input) => ({
      results: searchResults,
    }));

    await registerMemorySearch(bus);

    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u',
      workspace: { rootPath: workspaceRoot },
    });

    const out = (await bus.call('tool:execute:memory_search', ctx, {
      id: 'call-1',
      name: 'memory_search',
      input: { query: 'weddings attended', topK: 5 },
    })) as { results: Array<{ matchedFacts: string[] }> };

    const allFacts = out.results.flatMap((r) => r.matchedFacts);
    expect(allFacts.some((f) => f.includes('Emily'))).toBe(true);
    expect(allFacts.some((f) => f.includes('Jen'))).toBe(true);
    expect(allFacts.some((f) => f.includes('Rachel'))).toBe(true);
  });
});
