import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORCHESTRATOR_TIMEOUT_MS,
  parseMapEntries,
  parseOrchestratorPlan,
  renderMapForOrchestrator,
  runOrchestratedRetrieve,
  type MapEntry,
  type OrchestratorClient,
} from '../orchestrator.js';
import type { RetrievalResult } from '../retriever.js';

// ─── parseOrchestratorPlan ───────────────────────────────────────────────────

describe('parseOrchestratorPlan', () => {
  it('parses a single <load> op', () => {
    const plan = parseOrchestratorPlan('<load doc="preference/coffee"/>');
    expect(plan).toEqual({
      ops: [{ kind: 'load', docId: 'preference/coffee' }],
      followupNeeded: false,
    });
  });

  it('parses a <load> op with a section attribute', () => {
    const plan = parseOrchestratorPlan('<load doc="preference/coffee" section="Facts"/>');
    expect(plan.ops).toEqual([
      { kind: 'load', docId: 'preference/coffee', section: 'Facts' },
    ]);
  });

  it('parses a single <fts> op', () => {
    const plan = parseOrchestratorPlan('<fts query="coffee preference"/>');
    expect(plan.ops).toEqual([{ kind: 'fts', query: 'coffee preference' }]);
  });

  it('parses mixed <load> and <fts> ops — all <load>s before <fts>s (matches the bench parser)', () => {
    // The parser (ported byte-for-byte from the bench's parseOrchestratorXml)
    // collects all <load> matches in one matchAll pass, then all <fts>
    // matches in a second pass — so ops come back grouped by tag, not in
    // original document order. runOrchestratedRetrieve relies on exactly
    // this: load ops always resolve (and dedup-win) before fts ops run.
    const plan = parseOrchestratorPlan(
      '<load doc="entity/luna"/>\n<fts query="pets"/>\n<load doc="preference/coffee"/>',
    );
    expect(plan.ops).toEqual([
      { kind: 'load', docId: 'entity/luna' },
      { kind: 'load', docId: 'preference/coffee' },
      { kind: 'fts', query: 'pets' },
    ]);
  });

  it('strips a surrounding code fence', () => {
    const plan = parseOrchestratorPlan('```xml\n<load doc="entity/luna"/>\n```');
    expect(plan.ops).toEqual([{ kind: 'load', docId: 'entity/luna' }]);
  });

  it('decodes XML entities in attribute values', () => {
    const plan = parseOrchestratorPlan('<fts query="cats &amp; dogs &lt;3&gt;"/>');
    expect(plan.ops).toEqual([{ kind: 'fts', query: 'cats & dogs <3>' }]);
  });

  it('ignores unknown tags and stray prose', () => {
    const plan = parseOrchestratorPlan(
      'Sure, here is the plan:\n<thinking>let me consider</thinking>\n<load doc="entity/luna"/>\nDone.',
    );
    expect(plan.ops).toEqual([{ kind: 'load', docId: 'entity/luna' }]);
  });

  it('detects a <followup needed="true"/> marker', () => {
    const plan = parseOrchestratorPlan('<load doc="entity/luna"/>\n<followup needed="true"/>');
    expect(plan.followupNeeded).toBe(true);
  });

  it('followupNeeded is false when no followup tag is present', () => {
    const plan = parseOrchestratorPlan('<load doc="entity/luna"/>');
    expect(plan.followupNeeded).toBe(false);
  });

  it('returns no ops for empty/prose-only text', () => {
    const plan = parseOrchestratorPlan('I cannot help with that.');
    expect(plan).toEqual({ ops: [], followupNeeded: false });
  });
});

// ─── parseMapEntries ──────────────────────────────────────────────────────

const SAMPLE_MAP = `# Memory Map

## entity/
- luna: User's cat named Luna
## preference/
- coffee: User prefers cortados over drip
- tea: User dislikes green tea
`;

describe('parseMapEntries', () => {
  it('parses multi-category entries into a flat list', () => {
    const entries = parseMapEntries(SAMPLE_MAP);
    expect(entries).toEqual([
      { docId: 'entity/luna', category: 'entity', slug: 'luna', summary: "User's cat named Luna" },
      {
        docId: 'preference/coffee',
        category: 'preference',
        slug: 'coffee',
        summary: 'User prefers cortados over drip',
      },
      {
        docId: 'preference/tea',
        category: 'preference',
        slug: 'tea',
        summary: 'User dislikes green tea',
      },
    ]);
  });

  it('skips the heading and blank lines', () => {
    const entries = parseMapEntries('# Memory Map\n\n\n## entity/\n- luna: User\'s cat\n\n');
    expect(entries).toEqual([
      { docId: 'entity/luna', category: 'entity', slug: 'luna', summary: "User's cat" },
    ]);
  });

  it('returns [] for an empty map', () => {
    const entries = parseMapEntries('# Memory Map\n\n_No memory yet._\n');
    expect(entries).toEqual([]);
  });

  it('skips an entry whose docId fails the traversal guard', () => {
    const entries = parseMapEntries('## bogus-category/\n- foo: should be skipped\n');
    expect(entries).toEqual([]);
  });

  it('skips an entry with an invalid slug', () => {
    const entries = parseMapEntries('## entity/\n- Has Space: bad slug\n');
    expect(entries).toEqual([]);
  });
});

// ─── renderMapForOrchestrator ─────────────────────────────────────────────

describe('renderMapForOrchestrator', () => {
  it('renders a flat listing with docId + summary', () => {
    const entries: MapEntry[] = [
      { docId: 'entity/luna', category: 'entity', slug: 'luna', summary: "User's cat" },
      { docId: 'preference/coffee', category: 'preference', slug: 'coffee', summary: 'Likes cortados' },
    ];
    expect(renderMapForOrchestrator(entries)).toBe(
      "- entity/luna: User's cat\n- preference/coffee: Likes cortados",
    );
  });

  it('renders empty string for no entries', () => {
    expect(renderMapForOrchestrator([])).toBe('');
  });
});

// ─── runOrchestratedRetrieve ──────────────────────────────────────────────

function makeStubClient(text: string): OrchestratorClient {
  return {
    complete: vi.fn(async () => ({ text, usage: { in: 10, out: 5 } })),
  };
}

describe('runOrchestratedRetrieve', () => {
  it('resolves a load op to the mapped row with score 1', async () => {
    const client = makeStubClient('<load doc="preference/coffee"/>');
    const ftsSearch = vi.fn(async (): Promise<RetrievalResult[]> => []);

    const result = await runOrchestratedRetrieve({
      client,
      mapBody: SAMPLE_MAP,
      query: 'what coffee does the user like?',
      topK: 5,
      timeoutMs: 1000,
      ftsSearch,
    });

    expect(result).toEqual([
      {
        docId: 'preference/coffee',
        category: 'preference',
        slug: 'coffee',
        summary: 'User prefers cortados over drip',
        score: 1,
      },
    ]);
    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.stringContaining('preference/coffee: User prefers cortados over drip'),
      }),
    );
  });

  it('drops a hallucinated docId not present in the map', async () => {
    const client = makeStubClient('<load doc="preference/nonexistent"/>');
    const ftsSearch = vi.fn(async (): Promise<RetrievalResult[]> => []);

    const result = await runOrchestratedRetrieve({
      client,
      mapBody: SAMPLE_MAP,
      query: 'q',
      topK: 5,
      timeoutMs: 1000,
      ftsSearch,
    });

    // zero resolved ops ⇒ null (caller falls back to BM25)
    expect(result).toBeNull();
  });

  it('merges an fts op and dedups against an already-loaded doc', async () => {
    const client = makeStubClient(
      '<load doc="preference/coffee"/>\n<fts query="drinks"/>',
    );
    const ftsHit: RetrievalResult = {
      docId: 'preference/coffee',
      category: 'preference',
      slug: 'coffee',
      summary: 'duplicate — should be deduped',
      score: 0.5,
    };
    const ftsHit2: RetrievalResult = {
      docId: 'preference/tea',
      category: 'preference',
      slug: 'tea',
      summary: 'User dislikes green tea',
      score: 0.4,
    };
    const ftsSearch = vi.fn(async (): Promise<RetrievalResult[]> => [ftsHit, ftsHit2]);

    const result = await runOrchestratedRetrieve({
      client,
      mapBody: SAMPLE_MAP,
      query: 'drinks',
      topK: 5,
      timeoutMs: 1000,
      ftsSearch,
    });

    expect(result).toEqual([
      {
        docId: 'preference/coffee',
        category: 'preference',
        slug: 'coffee',
        summary: 'User prefers cortados over drip',
        score: 1,
      },
      ftsHit2,
    ]);
  });

  it('caps the result at topK', async () => {
    const client = makeStubClient(
      '<load doc="entity/luna"/>\n<load doc="preference/coffee"/>\n<load doc="preference/tea"/>',
    );
    const ftsSearch = vi.fn(async (): Promise<RetrievalResult[]> => []);

    const result = await runOrchestratedRetrieve({
      client,
      mapBody: SAMPLE_MAP,
      query: 'q',
      topK: 2,
      timeoutMs: 1000,
      ftsSearch,
    });

    expect(result).toHaveLength(2);
  });

  it('returns null on an empty map', async () => {
    const client = makeStubClient('<load doc="entity/luna"/>');
    const ftsSearch = vi.fn(async (): Promise<RetrievalResult[]> => []);

    const result = await runOrchestratedRetrieve({
      client,
      mapBody: '# Memory Map\n\n_No memory yet._\n',
      query: 'q',
      topK: 5,
      timeoutMs: 1000,
      ftsSearch,
    });

    expect(result).toBeNull();
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns null when the client throws', async () => {
    const client: OrchestratorClient = {
      complete: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const ftsSearch = vi.fn(async (): Promise<RetrievalResult[]> => []);
    const warn = vi.fn();

    const result = await runOrchestratedRetrieve({
      client,
      mapBody: SAMPLE_MAP,
      query: 'q',
      topK: 5,
      timeoutMs: 1000,
      ftsSearch,
      logger: { warn },
    });

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith('memory_strata_orchestrator_failed', expect.anything());
  });

  it('returns null on timeout', async () => {
    const client: OrchestratorClient = {
      // Never resolves — forces the raceTimeout to fire.
      complete: vi.fn(() => new Promise(() => {})),
    };
    const ftsSearch = vi.fn(async (): Promise<RetrievalResult[]> => []);

    const result = await runOrchestratedRetrieve({
      client,
      mapBody: SAMPLE_MAP,
      query: 'q',
      topK: 5,
      timeoutMs: 10,
      ftsSearch,
    });

    expect(result).toBeNull();
  });

  it('returns null when zero ops resolve to anything', async () => {
    const client = makeStubClient('I cannot help with that.');
    const ftsSearch = vi.fn(async (): Promise<RetrievalResult[]> => []);

    const result = await runOrchestratedRetrieve({
      client,
      mapBody: SAMPLE_MAP,
      query: 'q',
      topK: 5,
      timeoutMs: 1000,
      ftsSearch,
    });

    expect(result).toBeNull();
  });

  it('exports a default timeout constant', () => {
    expect(DEFAULT_ORCHESTRATOR_TIMEOUT_MS).toBe(5000);
  });
});
