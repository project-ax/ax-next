import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG, BudgetExceeded, Ledger, aggregate, percentile95, makeClients } from '../memory-product-e2e-lib.mjs';
import { createBank, withCorpusClock, renderReport, makeMeteredProviderFetch } from '../memory-product-e2e.mjs';

const dirs = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'ax-product-eval-')); dirs.push(path); return path; };
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const tags = () => ({ runId: 'test-run', questionId: 'q', phase: 'sonnet' });
const descriptor = { name: 'memory_recall', description: 'Recall', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
const result = (id, verdict = 'correct', recalls = [{ ms: 100, ok: true }]) => ({ questionId: id, arm: 'sonnet', questionType: 'type', unanswerable: false, verdict, recalls });

describe('measurement arithmetic and gates', () => {
  it('pins 100 unique stratified IDs and the captured corpus hash', () => {
    const pinned = JSON.parse(readFileSync(new URL('../memory-product-e2e-inputs.json', import.meta.url), 'utf8'));
    expect(pinned.questionIds).toHaveLength(100);
    expect(new Set(pinned.questionIds).size).toBe(100);
    expect(pinned.corpusSha256).toBe('d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442');
    expect(Object.values(pinned.counts).reduce((a, b) => a + b, 0)).toBe(100);
    expect(pinned.questionIds.filter(id => id.endsWith('_abs'))).toHaveLength(5);
  });
  it('uses nearest-rank p95 without inventing a zero for no calls', () => {
    expect(percentile95([])).toBeNull();
    expect(percentile95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(percentile95([42])).toBe(42);
    expect(() => percentile95([NaN])).toThrow();
  });
  it('requires all pinned questions and at least 76 correct per arm', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `q${i}`);
    const rows = ids.map((id, i) => result(id, i < 76 ? 'correct' : 'incorrect'));
    expect(aggregate(rows, ids)).toMatchObject({ complete: true, accuracy: 0.76, accuracyPassed: true, latencyPassed: true });
    expect(aggregate(rows.slice(0, 76), ids)).toMatchObject({ accuracy: 1, complete: false, accuracyPassed: false });
    rows[75].verdict = 'uncertain';
    expect(aggregate(rows, ids).accuracyPassed).toBe(false);
  });
  it('counts correct refusal, includes failed calls in p95, and measures search per question', () => {
    const rows = [result('a', 'abstained-correctly', [{ ms: 5, ok: true }, { ms: 1700, ok: false }]), result('b', 'incorrect', [])];
    rows[0].unanswerable = true;
    expect(aggregate(rows, ['a', 'b'])).toMatchObject({ correct: 1, toolCallRate: 0.5, callsPerQuestion: 1, recallErrors: 1, p95Ms: 1700, latencyPassed: false, correctRefusals: 1 });
    expect(aggregate([result('a', 'correct', [])], ['a'])).toMatchObject({ p95Ms: null, latencyPassed: false });
  });
  it('refuses duplicate or foreign rows rather than inflating the numerator', () => {
    expect(() => aggregate([result('a'), result('a')], ['a', 'b'])).toThrow();
    expect(() => aggregate([result('x')], ['a'])).toThrow();
    expect(() => aggregate([result('a', 'made-up-verdict')], ['a'])).toThrow();
  });
  it('does not report replicated success from one arm or an aborted run', () => {
    const manifest = { runId: 'test', sourceRevision: 'fixture', input: { questionIds: ['a'], corpusSha256: 'fixture', counts: { type: 1 } } };
    expect(renderReport(manifest, [result('a')], [], 25, 0)).toContain('Replicated accuracy gate: INCOMPLETE');
    const both = [result('a'), { ...result('a'), arm: 'glm' }];
    expect(renderReport(manifest, both, [], 25, 0)).toContain('Replicated accuracy gate: PASS');
    expect(renderReport(manifest, both, [], 25, 0, 'budget-exhausted')).toContain('Replicated accuracy gate: INCOMPLETE');
  });
});

describe('spending ledger', () => {
  it('reserves before spending and retains unknown in-flight charges across restart', () => {
    const path = join(temporary(), 'costs.jsonl');
    const ledger = new Ledger(path, 25);
    const a = ledger.reserve(10, tags());
    ledger.reserve(12, tags());
    expect(() => ledger.reserve(4, tags())).toThrow(BudgetExceeded);
    ledger.settle(a, 2, 'provider-reported');
    const resumed = new Ledger(path, 25);
    expect(resumed.chargedUsd()).toBe(14);
    expect(resumed.rows('test-run').filter(r => r.basis === 'unsettled-upper-bound')).toHaveLength(1);
  });
  it('does not corrupt the ledger with a duplicate settlement', () => {
    const path = join(temporary(), 'costs.jsonl');
    const ledger = new Ledger(path, 25);
    const id = ledger.reserve(1, tags());
    ledger.settle(id, 0.1, 'estimate');
    expect(() => ledger.settle(id, 0.2, 'estimate')).toThrow();
    expect(new Ledger(path, 25).chargedUsd()).toBe(0.1);
  });
  it('never starts a provider request that cannot fit the conservative reservation', async () => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 0.001);
    let calls = 0;
    const client = makeClients({ env: {}, ledger, tags, fetchImpl: async () => { calls++; throw new Error('must not call'); } });
    await expect(client.openrouter({ model: CONFIG.extractionModel, max_tokens: 4096, messages: [] })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(calls).toBe(0);
  });
  it('bounds the embedding transport before sending credentials', async () => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    let calls = 0;
    const fetcher = makeMeteredProviderFetch(ledger, tags, async () => { calls++; throw new Error('not reached'); });
    for (const url of ['http://api.cohere.com/v2/rerank', 'https://api.cohere.com:8443/v2/rerank', 'https://elsewhere.invalid/v2/rerank', 'https://api.cohere.com/v2/rerank?redirect=x']) {
      await expect(fetcher(url, { body: '{}' })).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it('meters Vertex characters and Cohere billed search units, not guessed zeros', async () => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    const fetcher = makeMeteredProviderFetch(ledger, tags, async url => new Response(JSON.stringify(String(url).includes(':predict') ? { metadata: { billableCharacterCount: 3 } } : { meta: { billed_units: { search_units: 2 } } }), { status: 200 }));
    await fetcher('https://us-central1-aiplatform.googleapis.com/v1/projects/test/locations/us-central1/publishers/google/models/text-embedding-005:predict', { body: JSON.stringify({ instances: [{ content: 'a bé' }] }) });
    await fetcher('https://api.cohere.com/v2/rerank', { body: JSON.stringify({ query: 'x', documents: Array.from({ length: 101 }, () => 'a') }) });
    expect(ledger.chargedUsd()).toBeCloseTo(3 * 0.000025 / 1000 + 2 * 0.0025, 12);
    expect(ledger.rows('test-run').map(r => r.quantity)).toEqual([3, 2]);
  });
});

describe('model-driven tool loop', () => {
  it.each(['sonnet', 'glm'])('%s chooses memory_recall; the harness does not pre-retrieve', async arm => {
    const requests = [];
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    const clients = makeClients({ env: {}, ledger, tags, fetchImpl: async (_url, init) => {
      expect(init.redirect).toBe('error');
      const body = JSON.parse(init.body); requests.push(body);
      const first = requests.length === 1;
      const response = arm === 'sonnet'
        ? { content: first ? [{ type: 'tool_use', id: 't1', name: 'memory_recall', input: { query: 'home' } }] : [{ type: 'text', text: 'Osaka' }], usage: { input_tokens: 20, output_tokens: 5 } }
        : { choices: [{ message: first ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'memory_recall', arguments: '{"query":"home"}' } }] } : { role: 'assistant', content: 'Osaka' } }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.001 } };
      return new Response(JSON.stringify(response), { status: 200 });
    } });
    let called = 0;
    const answer = await clients.answer({ arm, system: 'test system', question: 'Where do I live?', descriptor, recall: async input => {
      expect(requests).toHaveLength(1);
      expect(input).toEqual({ query: 'home' }); called++;
      return { ok: true, text: 'Network | When | Statement\nFACT | 2023-01-01 | Osaka' };
    } });
    expect(answer).toBe('Osaka');
    expect(called).toBe(1);
    expect(JSON.stringify(requests[0])).not.toContain('Osaka');
    expect(JSON.stringify(requests[1])).toContain('Network | When | Statement');
    expect(requests.every(r => r.max_tokens === 512)).toBe(true);
  });
  it('keeps the corpus clock separate from latency and restores it on error', async () => {
    const original = Date;
    const start = performance.now();
    await expect(withCorpusClock('2023-01-01T12:00:00Z', async () => {
      expect(new Date().toISOString()).toBe('2023-01-01T12:00:00.000Z');
      expect(Date.now()).toBe(original.parse('2023-01-01T12:00:00Z'));
      await new Promise(done => setTimeout(done, 5));
      throw new Error('fixture');
    })).rejects.toThrow('fixture');
    expect(Date).toBe(original);
    expect(performance.now() - start).toBeGreaterThan(0);
  });
});

describe('actual preset memory slice', () => {
  it('ingests through the observer, exposes the real tool, isolates banks and drains timed-out producer work', async () => {
    const root = temporary();
    const ledger = new Ledger(join(root, 'costs.jsonl'), 25);
    const storage = new AsyncLocalStorage();
    const options = {
      env: { VERTEX_ACCESS_TOKEN: 'test-token', COHERE_API_KEY: 'test-token' }, projectId: 'memory-canary', ledger, storage,
      clients: { async openrouter(body) {
        expect(body.model).toBe(CONFIG.extractionModel);
        expect(body.reasoning).toEqual({ effort: 'minimal' });
        return { choices: [{ message: { content: JSON.stringify({ facts: [{ network: 'world', subject: 'user', predicate: 'lives in', object: 'Osaka', validStart: '2023-01-01T00:00:00Z' }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      } },
      providerFetch: async (url, init) => {
        const b = JSON.parse(init.body);
        return new Response(JSON.stringify(String(url).includes(':predict') ? { predictions: b.instances.map(() => ({ embeddings: { values: new Array(384).fill(0.01) } })) } : { results: b.documents.map((_, index) => ({ index, relevance_score: 1 })) }), { status: 200 });
      },
    };
    const a = await createBank({ ...options, sample: { question_id: 'bank-a' }, directory: join(root, 'a') });
    const b = await createBank({ ...options, sample: { question_id: 'bank-b' }, directory: join(root, 'b') });
    try {
      await withCorpusClock('2023-01-01T12:00:00Z', () => a.observe('session-a', [{ role: 'user', content: 'I live in Osaka' }, { role: 'assistant', content: 'Noted.' }]));
      const injected = await a.injected();
      expect(injected).toContain('Osaka');
      expect(a.descriptor.name).toBe('memory_recall');
      const table = await a.bus.call('tool:execute:memory_recall', a.ctx(), { input: { query: 'home' } });
      const other = await b.bus.call('tool:execute:memory_recall', b.ctx(), { input: { query: 'home' } });
      expect(table).toContain('Osaka');
      expect(other).not.toContain('Osaka');
      let finished = false;
      a.bus.registerService('probe:slow', 'test', async () => { await new Promise(done => setTimeout(done, 20)); finished = true; }, { timeoutMs: 1 });
      await expect(a.bus.call('probe:slow', a.ctx(), {})).rejects.toThrow();
      await a.drain();
      expect(finished).toBe(true);
    } finally { await a.close(); await b.close(); }
  });
});
