import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HookBus, createLogger, makeAgentContext } from '@ax/core';
import type { ToolDescriptor } from '@ax/core';
import { writeNewDoc } from '../doc-store.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { docFile, mapFile } from '../paths.js';
import type { OrchestratorClient } from '../orchestrator.js';
import { registerMemorySearch, MEMORY_SEARCH_DESCRIPTOR } from '../tools/memory-search.js';
import type { RetrievalResult } from '../retriever.js';
import type { MemoryFrontmatter } from '../types.js';

/** Minimal fixture result for happy-path tests. */
const FIXTURE_RESULTS: RetrievalResult[] = [
  {
    docId: 'doc-1',
    category: 'preference',
    slug: 'react',
    summary: 'User prefers React',
    snippet: 'the user said they prefer React over Vue',
    score: 0.9,
  },
];

function makeCtx() {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
  });
}

/**
 * Wrap a bare tool input in the host-execution `ToolCall` envelope
 * `{ id, name, input }` — the exact shape the `tool.execute-host` IPC handler
 * forwards to the `tool:execute:<name>` service hook (see ipc-core
 * `tool-execute-host.ts`). Calling the hook with bare input would mask the
 * `call.input` extraction bug this suite is meant to catch.
 */
function asToolCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'memory_search', input };
}

/**
 * Build a bus wired with:
 *  - a stub `tool:register` that records the last registered descriptor
 *  - a stub `memory:index:search` that records captured inputs and returns
 *    the provided results array (default: FIXTURE_RESULTS)
 */
function makeWiredBus(opts: {
  searchResults?: RetrievalResult[];
} = {}) {
  const bus = new HookBus();
  const searchResults = opts.searchResults ?? FIXTURE_RESULTS;

  let registeredDescriptor: ToolDescriptor | undefined;
  const capturedSearchInputs: unknown[] = [];

  bus.registerService<ToolDescriptor, { ok: true }>(
    'tool:register',
    'test-tool-dispatcher',
    async (_ctx, input) => {
      registeredDescriptor = input;
      return { ok: true };
    },
  );

  bus.registerService(
    'memory:index:search',
    'test-indexer',
    async (_ctx, input) => {
      capturedSearchInputs.push(input);
      return { results: searchResults };
    },
  );

  return { bus, getRegisteredDescriptor: () => registeredDescriptor, capturedSearchInputs };
}

describe('tools/memory-search', () => {
  describe('descriptor registration', () => {
    it('registers the MEMORY_SEARCH_DESCRIPTOR via tool:register', async () => {
      const { bus, getRegisteredDescriptor } = makeWiredBus();
      await registerMemorySearch(bus);

      const desc = getRegisteredDescriptor();
      expect(desc).toBeDefined();
      expect(desc?.name).toBe('memory_search');
      expect(desc?.executesIn).toBe('host');
      expect(desc?.inputSchema).toMatchObject({
        type: 'object',
        required: ['query'],
      });
    });

    it('registered descriptor matches MEMORY_SEARCH_DESCRIPTOR exactly', async () => {
      const { bus, getRegisteredDescriptor } = makeWiredBus();
      await registerMemorySearch(bus);

      expect(getRegisteredDescriptor()).toEqual(MEMORY_SEARCH_DESCRIPTOR);
    });
  });

  describe('tool:execute:memory_search', () => {
    it('happy path: returns {results: [...]} shape', async () => {
      const { bus } = makeWiredBus();
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      const out = await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'react' }));

      // Each row now carries matchedFacts (Task 3, enumeration design). FIXTURE_RESULTS'
      // docId ('doc-1') doesn't parse as <category>/<slug>, so enrichment can't read a
      // body and every row gets matchedFacts: [] — the same best-effort empty result a
      // real doc-read failure would produce.
      expect(out).toEqual({
        results: FIXTURE_RESULTS.map((r) => ({ ...r, matchedFacts: [] })),
      });
    });

    it('default topK = 5 when not supplied', async () => {
      const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo' }));

      expect(capturedSearchInputs).toHaveLength(1);
      expect((capturedSearchInputs[0] as Record<string, unknown>).topK).toBe(5);
    });

    it('explicit topK passes through', async () => {
      const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo', topK: 10 }));

      expect(capturedSearchInputs).toHaveLength(1);
      expect((capturedSearchInputs[0] as Record<string, unknown>).topK).toBe(10);
    });

    describe('topK clamping', () => {
      it.each([
        { input: 0, expected: 1, label: 'topK: 0 → 1' },
        { input: -5, expected: 1, label: 'topK: -5 → 1' },
        { input: 100, expected: 20, label: 'topK: 100 → 20' },
      ])('$label', async ({ input, expected }) => {
        const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
        await registerMemorySearch(bus);

        const ctx = makeCtx();
        await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo', topK: input }));

        expect((capturedSearchInputs[0] as Record<string, unknown>).topK).toBe(expected);
      });

      it('topK: non-numeric string → default 5', async () => {
        const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
        await registerMemorySearch(bus);

        const ctx = makeCtx();
        await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo', topK: 'banana' }));

        expect((capturedSearchInputs[0] as Record<string, unknown>).topK).toBe(5);
      });
    });

    it('categoryFilter passes through when provided', async () => {
      const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      await bus.call('tool:execute:memory_search', ctx, asToolCall({
        query: 'foo',
        categoryFilter: 'preference',
      }));

      expect(capturedSearchInputs).toHaveLength(1);
      expect((capturedSearchInputs[0] as Record<string, unknown>).categoryFilter).toBe(
        'preference',
      );
    });

    it('categoryFilter is omitted when not provided', async () => {
      const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo' }));

      expect(capturedSearchInputs).toHaveLength(1);
      expect(
        'categoryFilter' in (capturedSearchInputs[0] as Record<string, unknown>),
      ).toBe(false);
    });

    it('includes the body snippet in each result (memory-search-snippet design)', async () => {
      const snippetFixture: RetrievalResult[] = [
        {
          docId: 'decision/user',
          category: 'decision',
          slug: 'user',
          summary: "User's decisions",
          snippet: 'graduated with a B.A. in Business Administration',
          score: 1,
        },
      ];
      const { bus } = makeWiredBus({ searchResults: snippetFixture });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      const out = (await bus.call(
        'tool:execute:memory_search',
        ctx,
        asToolCall({ query: 'degree', topK: 5 }),
      )) as { results: Array<{ docId: string; snippet: string }> };

      expect(out.results[0]!.snippet).toContain('Business Administration');
    });
  });
});

// ─── Orchestrator path (TASK-191 Task 3) ─────────────────────────────────────
//
// registerMemorySearch's optional second arg wires the retrieval orchestrator
// in front of the existing BM25 executor. These tests use a REAL temp
// workspace (not a stub) so `readInjectedMapBody` reads an actual
// `system/map.md` off disk — the same file the auto-injected system prompt
// block is built from (inject.ts).
describe('orchestrator path', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'memory-search-orchestrator-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  /** Write `permanent/memory/system/map.md` with canonical frontmatter. */
  async function writeMapFile(root: string, body: string): Promise<void> {
    const abs = join(root, mapFile());
    await mkdir(dirname(abs), { recursive: true });
    const fm: MemoryFrontmatter = {
      id: 'map',
      type: 'system/map',
      created: '2026-05-11T00:00:00.000Z',
      confidence: 1.0,
      pinned: true,
      summary: 'map system file',
      event_time: '2026-05-11T00:00:00.000Z',
      recorded_at: '2026-05-11T00:00:00.000Z',
    };
    await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
  }

  const MAP_BODY = [
    '# Memory Map',
    '',
    '## preference/',
    '- coffee: User prefers cortados over drip',
  ].join('\n');

  /** Distinct from the orchestrator's `<load>` row so the two paths are unambiguous in assertions. */
  const BM25_FIXTURE: RetrievalResult[] = [
    {
      docId: 'general/bm25-fallback',
      category: 'general',
      slug: 'bm25-fallback',
      summary: 'BM25 fallback fixture',
      snippet: 'bm25 fallback excerpt',
      score: 0.5,
    },
  ];

  function makeOrchestratorCtx() {
    return makeAgentContext({
      sessionId: 'orch-session',
      agentId: 'orch-agent',
      userId: 'orch-user',
      workspace: { rootPath: workspaceRoot },
    });
  }

  /** Wires tool:register + a memory:index:search stub that records calls. */
  function makeOrchestratorBus(opts: { searchResults?: RetrievalResult[] } = {}) {
    const bus = new HookBus();
    const searchResults = opts.searchResults ?? BM25_FIXTURE;
    const capturedSearchInputs: unknown[] = [];

    bus.registerService<ToolDescriptor, { ok: true }>(
      'tool:register',
      'test-tool-dispatcher',
      async () => ({ ok: true }),
    );
    bus.registerService(
      'memory:index:search',
      'test-indexer',
      async (_ctx, input) => {
        capturedSearchInputs.push(input);
        return { results: searchResults };
      },
    );

    return { bus, capturedSearchInputs };
  }

  it('orchestrator resolves a <load> op → returns the mapped map row; BM25 index never called', async () => {
    await writeMapFile(workspaceRoot, MAP_BODY);
    const { bus, capturedSearchInputs } = makeOrchestratorBus();
    const client: OrchestratorClient = {
      complete: vi.fn(async () => ({
        text: '<load doc="preference/coffee"/>',
        usage: { in: 1, out: 1 },
      })),
    };
    await registerMemorySearch(bus, { orchestrator: { client } });

    const ctx = makeOrchestratorCtx();
    const out = await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'what coffee do I like?' }),
    );

    // matchedFacts: [] here — 'preference/coffee' has no doc file on disk in this
    // fixture's temp workspace (only system/map.md was written), so best-effort
    // enrichment reads nothing back (Task 3, enumeration design).
    expect(out).toEqual({
      results: [
        {
          docId: 'preference/coffee',
          category: 'preference',
          slug: 'coffee',
          summary: 'User prefers cortados over drip',
          snippet: '',
          score: 1,
          matchedFacts: [],
        },
      ],
    });
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(capturedSearchInputs).toHaveLength(0);
  });

  it('orchestrator miss (junk/empty response) → falls back to BM25', async () => {
    await writeMapFile(workspaceRoot, MAP_BODY);
    const { bus, capturedSearchInputs } = makeOrchestratorBus();
    const client: OrchestratorClient = {
      complete: vi.fn(async () => ({ text: 'not a recognized op, just prose', usage: { in: 1, out: 1 } })),
    };
    await registerMemorySearch(bus, { orchestrator: { client } });

    const ctx = makeOrchestratorCtx();
    const out = await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'what coffee do I like?' }),
    );

    // matchedFacts: [] — 'general/bm25-fallback' has no doc file on disk in this
    // fixture's temp workspace, so best-effort enrichment yields [] (Task 3).
    expect(out).toEqual({
      results: BM25_FIXTURE.map((r) => ({ ...r, matchedFacts: [] })),
    });
    expect(capturedSearchInputs).toHaveLength(1);
  });

  it("retrievalMode: 'bm25' forces BM25 even with an orchestrator client configured", async () => {
    await writeMapFile(workspaceRoot, MAP_BODY);
    const { bus, capturedSearchInputs } = makeOrchestratorBus();
    const client: OrchestratorClient = {
      complete: vi.fn(async () => ({
        text: '<load doc="preference/coffee"/>',
        usage: { in: 1, out: 1 },
      })),
    };
    await registerMemorySearch(bus, { retrievalMode: 'bm25', orchestrator: { client } });

    const ctx = makeOrchestratorCtx();
    const out = await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'what coffee do I like?' }),
    );

    expect(client.complete).not.toHaveBeenCalled();
    // matchedFacts: [] — 'general/bm25-fallback' has no doc file on disk in this
    // fixture's temp workspace, so best-effort enrichment yields [] (Task 3).
    expect(out).toEqual({
      results: BM25_FIXTURE.map((r) => ({ ...r, matchedFacts: [] })),
    });
    expect(capturedSearchInputs).toHaveLength(1);
  });

  it('categoryFilter set → orchestrator skipped; BM25 used with categoryFilter passthrough', async () => {
    await writeMapFile(workspaceRoot, MAP_BODY);
    const { bus, capturedSearchInputs } = makeOrchestratorBus();
    const client: OrchestratorClient = {
      complete: vi.fn(async () => ({
        text: '<load doc="preference/coffee"/>',
        usage: { in: 1, out: 1 },
      })),
    };
    await registerMemorySearch(bus, { orchestrator: { client } });

    const ctx = makeOrchestratorCtx();
    const out = await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'what coffee do I like?', categoryFilter: 'preference' }),
    );

    expect(client.complete).not.toHaveBeenCalled();
    // matchedFacts: [] — 'general/bm25-fallback' has no doc file on disk in this
    // fixture's temp workspace, so best-effort enrichment yields [] (Task 3).
    expect(out).toEqual({
      results: BM25_FIXTURE.map((r) => ({ ...r, matchedFacts: [] })),
    });
    expect(capturedSearchInputs).toHaveLength(1);
    expect((capturedSearchInputs[0] as Record<string, unknown>).categoryFilter).toBe('preference');
  });

  it('orchestrator read throws (unreadable map.md) → degrades to BM25, does NOT fail the tool call (review #1)', async () => {
    // Regression for the review's Important finding: the BM25 fallback is the
    // whole contract, so the orchestrator attempt must never throw OUT of the
    // executor. Make `system/map.md` a DIRECTORY so readFile() throws EISDIR — a
    // non-ENOENT fs error that `readInjectedMapBody` re-throws (ENOENT / no map
    // yet already returns '' and is covered by the "miss → BM25" test above;
    // this is the harder escape path). Before the executor's outer try/catch
    // this surfaced as a FAILED tool call to the agent; now it must degrade to
    // BM25 — a case where BM25 would have worked.
    const mapAbs = join(workspaceRoot, mapFile());
    await mkdir(mapAbs, { recursive: true }); // create map.md AS A DIRECTORY → readFile → EISDIR
    const { bus, capturedSearchInputs } = makeOrchestratorBus();
    const client: OrchestratorClient = {
      complete: vi.fn(async () => ({
        text: '<load doc="preference/coffee"/>',
        usage: { in: 1, out: 1 },
      })),
    };
    await registerMemorySearch(bus, { orchestrator: { client } });

    const ctx = makeOrchestratorCtx();
    const out = await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'what coffee do I like?' }),
    );

    // Degraded cleanly to BM25 — did NOT throw/return an error out of the tool.
    // matchedFacts: [] — 'general/bm25-fallback' has no doc file on disk in this
    // fixture's temp workspace, so best-effort enrichment yields [] (Task 3).
    expect(out).toEqual({
      results: BM25_FIXTURE.map((r) => ({ ...r, matchedFacts: [] })),
    });
    expect(capturedSearchInputs).toHaveLength(1);
  });
});

// ─── matchedFacts enrichment (multi-session enumeration design, Task 3) ─────
//
// memory_search now attaches every query-matching fact line from each hit's
// OWN doc body, read host-side via readDocBody — no index/contract change.
// These tests use a REAL temp workspace + a REAL doc written via writeNewDoc
// so readDocBody's `readDoc` call hits actual files, not a stub.
describe('matchedFacts enrichment', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'memory-search-matched-facts-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function makeWorkspaceCtx() {
    return makeAgentContext({
      sessionId: 'mf-session',
      agentId: 'mf-agent',
      userId: 'mf-user',
      workspace: { rootPath: workspaceRoot },
    });
  }

  it('attaches every query-matching fact line from the hit doc body', async () => {
    await writeNewDoc({
      workspaceRoot,
      category: 'episode',
      slug: 'weddings',
      summary: 'Weddings attended',
      subject: 'weddings',
      factType: 'episode',
      confidence: 0.9,
      sourceObservationIds: ['obs-1'],
      now: new Date('2026-05-10T12:00:00Z'),
      facts: [
        '(2026-02-01) User attended a wedding in Austin.',
        'User is researching fish stocking levels for a 55-gallon tank.',
        '(2026-03-10) User attended a wedding in Portland.',
      ],
    });

    const searchResults: RetrievalResult[] = [
      {
        docId: 'episode/weddings',
        category: 'episode',
        slug: 'weddings',
        summary: 'Weddings attended',
        snippet: 'User attended a wedding in Austin.',
        score: 0.8,
      },
    ];
    const { bus } = makeWiredBus({ searchResults });
    await registerMemorySearch(bus);

    const ctx = makeWorkspaceCtx();
    const out = (await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'weddings attended' }),
    )) as { results: Array<{ docId: string; matchedFacts: string[] }> };

    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.matchedFacts).toEqual([
      '(2026-02-01) User attended a wedding in Austin.',
      '(2026-03-10) User attended a wedding in Portland.',
    ]);
  });

  it('doc file missing on disk → matchedFacts: [] and the call still succeeds', async () => {
    const searchResults: RetrievalResult[] = [
      {
        docId: 'episode/nonexistent',
        category: 'episode',
        slug: 'nonexistent',
        summary: 'Doc never written',
        snippet: '',
        score: 0.5,
      },
    ];
    const { bus } = makeWiredBus({ searchResults });
    await registerMemorySearch(bus);

    const ctx = makeWorkspaceCtx();
    const out = (await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'weddings attended' }),
    )) as { results: Array<{ docId: string; matchedFacts: string[] }> };

    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.matchedFacts).toEqual([]);
  });

  it('doc read THROWS (EISDIR) → catch logs memory_strata_matched_facts_failed, matchedFacts: [], call still succeeds', async () => {
    // Regression for the best-effort catch in withMatchedFacts. The two tests
    // above only exercise the graceful readDoc→null path (ENOENT / missing
    // file), where readDocBody returns null WITHOUT throwing — so the catch
    // never fires. Here we make readDoc's `fs.readFile` throw a NON-ENOENT
    // error (EISDIR) by creating the doc's `.md` path AS A DIRECTORY (same
    // technique as the "orchestrator read throws" test above). readDoc rethrows
    // any non-ENOENT error, so readDocBody throws, and the enrichment MUST
    // catch it: log + matchedFacts:[] , never a failed tool call.
    const docAbs = join(workspaceRoot, docFile('episode', 'eisdir'));
    await mkdir(docAbs, { recursive: true }); // create the .md path AS A DIRECTORY → readFile → EISDIR

    const searchResults: RetrievalResult[] = [
      {
        docId: 'episode/eisdir',
        category: 'episode',
        slug: 'eisdir',
        summary: 'Doc whose .md path is a directory',
        snippet: '',
        score: 0.5,
      },
    ];
    const { bus } = makeWiredBus({ searchResults });
    await registerMemorySearch(bus);

    // Real logger (writer suppressed so the EISDIR warn doesn't spam the run),
    // with `warn` spied so we can assert the catch fired.
    const logger = createLogger({ reqId: 'mf-eisdir', writer: () => {} });
    const warnSpy = vi.spyOn(logger, 'warn');
    const ctx = makeAgentContext({
      sessionId: 'mf-session',
      agentId: 'mf-agent',
      userId: 'mf-user',
      workspace: { rootPath: workspaceRoot },
      logger,
    });

    const out = (await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'weddings attended' }),
    )) as { results: Array<{ docId: string; matchedFacts: string[] }> };

    // (a) call succeeded (did not reject), (b) row degraded to matchedFacts: [].
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.matchedFacts).toEqual([]);
    // (c) the catch logged the failure with docId + err.
    expect(warnSpy).toHaveBeenCalledWith(
      'memory_strata_matched_facts_failed',
      expect.objectContaining({
        docId: 'episode/eisdir',
        err: expect.any(Error),
      }),
    );
  });

  // ── Per-doc truncation marker (WS-A early-termination fix) ────────────────
  //
  // Diagnosis 2026-07-05: on the orchestrator, a fat first search result (up to
  // 20 fact lines) reads as *exhaustive*, so the answer model stops after 1–2
  // searches and under-samples counting questions. Fix: cap facts per doc at
  // MAX_FACTS_PER_DOC (now 6) AND, when a doc had MORE matching lines than the
  // cap, append an explicit "there are more — go read the whole doc" marker so
  // truncation is legible rather than silently mistaken for completeness.
  it('doc with more matching facts than the per-doc cap → 6 facts + a truncation marker', async () => {
    await writeNewDoc({
      workspaceRoot,
      category: 'episode',
      slug: 'weddings',
      summary: 'Weddings attended',
      subject: 'weddings',
      factType: 'episode',
      confidence: 0.9,
      sourceObservationIds: ['obs-1'],
      now: new Date('2026-05-10T12:00:00Z'),
      facts: Array.from({ length: 8 }, (_, i) => `(2026-0${i + 1}-01) User attended wedding number ${i + 1}.`),
    });

    const searchResults: RetrievalResult[] = [
      {
        docId: 'episode/weddings',
        category: 'episode',
        slug: 'weddings',
        summary: 'Weddings attended',
        snippet: '',
        score: 0.8,
      },
    ];
    const { bus } = makeWiredBus({ searchResults });
    await registerMemorySearch(bus);

    const ctx = makeWorkspaceCtx();
    const out = (await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'weddings attended' }),
    )) as { results: Array<{ matchedFacts: string[] }> };

    const facts = out.results[0]!.matchedFacts;
    // 6 real fact lines (the per-doc cap) + 1 trailing truncation marker.
    expect(facts).toHaveLength(7);
    // The 6 shown are the FIRST 6 in body order (deterministic, not a sample).
    expect(facts.slice(0, 6)).toEqual([
      '(2026-01-01) User attended wedding number 1.',
      '(2026-02-01) User attended wedding number 2.',
      '(2026-03-01) User attended wedding number 3.',
      '(2026-04-01) User attended wedding number 4.',
      '(2026-05-01) User attended wedding number 5.',
      '(2026-06-01) User attended wedding number 6.',
    ]);
    // The marker is legible-to-the-model: it names the doc and the drill-in tool,
    // and it must NOT be counted as another instance (it starts with a non-fact
    // sentinel and mentions memory_read_section).
    const marker = facts[6]!;
    expect(marker).toContain('memory_read_section');
    expect(marker).toContain('episode/weddings');
    // No real wedding-instance text leaked into the marker slot.
    expect(marker).not.toContain('User attended wedding number');
  });

  it('doc with matching facts at or under the cap → no truncation marker', async () => {
    await writeNewDoc({
      workspaceRoot,
      category: 'episode',
      slug: 'weddings',
      summary: 'Weddings attended',
      subject: 'weddings',
      factType: 'episode',
      confidence: 0.9,
      sourceObservationIds: ['obs-1'],
      now: new Date('2026-05-10T12:00:00Z'),
      facts: Array.from({ length: 6 }, (_, i) => `(2026-0${i + 1}-01) User attended wedding number ${i + 1}.`),
    });

    const searchResults: RetrievalResult[] = [
      {
        docId: 'episode/weddings',
        category: 'episode',
        slug: 'weddings',
        summary: 'Weddings attended',
        snippet: '',
        score: 0.8,
      },
    ];
    const { bus } = makeWiredBus({ searchResults });
    await registerMemorySearch(bus);

    const ctx = makeWorkspaceCtx();
    const out = (await bus.call(
      'tool:execute:memory_search',
      ctx,
      asToolCall({ query: 'weddings attended' }),
    )) as { results: Array<{ matchedFacts: string[] }> };

    const facts = out.results[0]!.matchedFacts;
    expect(facts).toHaveLength(6);
    expect(facts.every((f) => f.includes('User attended wedding number'))).toBe(true);
  });
});
