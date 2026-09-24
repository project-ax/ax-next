import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG, BudgetExceeded, Ledger, aggregate, percentile95, makeClients } from '../memory-product-e2e-lib.mjs';
import { createBank, withCorpusClock, renderReport, makeMeteredProviderFetch, makeRecall, recordFailure, sourceDigestOf, checkResumeIdentity, HARNESS_FILES } from '../memory-product-e2e.mjs';

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
    const fetcher = makeMeteredProviderFetch(ledger, tags, async (url, init) => {
      expect(init.redirect).toBe('error');
      return new Response(JSON.stringify(String(url).includes(':predict') ? { metadata: { billableCharacterCount: 3 } } : { meta: { billed_units: { search_units: 2 } } }), { status: 200 });
    });
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
  it.each(['sonnet', 'glm'])('%s reports every round, tool call and final answer as it happens', async arm => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    let requests = 0;
    const clients = makeClients({ env: {}, ledger, tags, fetchImpl: async () => {
      const first = ++requests === 1;
      const response = arm === 'sonnet'
        ? { content: first ? [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't1', name: 'memory_recall', input: { query: 'home' } }] : [{ type: 'text', text: 'Osaka' }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { choices: [{ message: first ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'memory_recall', arguments: '{"query":"home"}' } }] } : { role: 'assistant', content: 'Osaka' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } };
      return new Response(JSON.stringify(response), { status: 200 });
    } });
    const events = [];
    const seenAtRecall = [];
    await clients.answer({ arm, system: 's', question: 'Where?', descriptor, onTurn: e => events.push(e), recall: async () => {
      seenAtRecall.push(events.map(e => e.type));
      return { ok: true, text: 'FACT | Osaka' };
    } });
    // The request and response are durable BEFORE the recall runs, so an attempt that
    // dies inside recall still shows what the model asked for.
    expect(seenAtRecall).toEqual([['request', 'response']]);
    expect(events).toEqual([
      { type: 'request', round: 0, tools: true },
      expect.objectContaining({ type: 'response', round: 0, toolUses: 1 }),
      { type: 'tool', round: 0, name: 'memory_recall', input: { query: 'home' }, ok: true, resultChars: 12 },
      { type: 'request', round: 1, tools: true },
      expect.objectContaining({ type: 'response', round: 1, toolUses: 0 }),
      { type: 'final', round: 1, answer: 'Osaka' },
    ]);
  });
  it('reports a GLM argument parse failure as a tool event without calling recall', async () => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    let requests = 0;
    const clients = makeClients({ env: {}, ledger, tags, fetchImpl: async () => {
      const message = ++requests === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'memory_recall', arguments: '{' } }] }
        : { role: 'assistant', content: 'none' };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }), { status: 200 });
    } });
    const events = [];
    await clients.answer({ arm: 'glm', system: 's', question: 'Q', descriptor, onTurn: e => events.push(e), recall: async () => { throw new Error('must not recall'); } });
    expect(events).toContainEqual({ type: 'tool', round: 0, name: 'memory_recall', argumentsError: true });
  });
  it('reports a GLM call to an unknown tool as a tool event too', async () => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    let requests = 0;
    const clients = makeClients({ env: {}, ledger, tags, fetchImpl: async () => {
      const message = ++requests === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'other_tool', arguments: '{}' } }] }
        : { role: 'assistant', content: 'none' };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }), { status: 200 });
    } });
    const events = [];
    await clients.answer({ arm: 'glm', system: 's', question: 'Q', descriptor, onTurn: e => events.push(e), recall: async () => { throw new Error('must not recall'); } });
    expect(events).toContainEqual({ type: 'tool', round: 0, name: 'other_tool', ok: false, resultChars: 12 });
  });
  it.each([['budget', () => new BudgetExceeded()], ['lifecycle', () => new Error('fixture lifecycle failure')]])('propagates GLM recall %s errors instead of treating them as argument errors', async (_name, makeError) => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    const error = makeError();
    let requests = 0;
    const clients = makeClients({ env: {}, ledger, tags, fetchImpl: async () => {
      requests++;
      const message = requests === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: descriptor.name, arguments: '{"query":"home"}' } }] }
        : { role: 'assistant', content: 'Should not answer after lifecycle failure' };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }), { status: 200 });
    } });
    await expect(clients.answer({ arm: 'glm', system: 'fixture', question: 'Home?', descriptor, recall: async () => { throw error; } })).rejects.toBe(error);
    expect(requests).toBe(1);
  });
  it.each([['memory_recall', '{', 'Invalid tool arguments'], ['unknown_tool', '{', 'Unknown tool']])('returns a tool error for %s without calling recall', async (name, args, expected) => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    const requests = [];
    let recalls = 0;
    const clients = makeClients({ env: {}, ledger, tags, fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const message = requests.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: args } }] }
        : { role: 'assistant', content: 'No usable recall' };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }), { status: 200 });
    } });
    const answer = await clients.answer({ arm: 'glm', system: 'fixture', question: 'Home?', descriptor, recall: async () => { recalls++; return { ok: true, text: 'unexpected' }; } });
    expect(answer).toBe('No usable recall');
    expect(recalls).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 't1', content: expected });
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

const fakeProviderFetch = (delays = {}) => async (url, init) => {
  const b = JSON.parse(init.body);
  const embed = String(url).includes(':predict');
  const wait = embed ? delays.embed : delays.rerank;
  if (wait) await new Promise(done => setTimeout(done, wait));
  return new Response(JSON.stringify(embed ? { predictions: b.instances.map(() => ({ embeddings: { values: new Array(384).fill(0.01) } })) } : { results: b.documents.map((_, index) => ({ index, relevance_score: 1 })) }), { status: 200 });
};
const extractionClient = { async openrouter() {
  return { choices: [{ message: { content: JSON.stringify({ facts: [{ network: 'world', subject: 'user', predicate: 'lives in', object: 'Osaka', validStart: '2023-01-01T00:00:00Z' }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
} };

describe('TASK-521 instrumentation', () => {
  it('never mints a Vertex credential inside credentials:get; it only reads a pre-minted one', async () => {
    const root = temporary();
    const storage = new AsyncLocalStorage();
    const savedPath = process.env.PATH;
    // With no gcloud on PATH, the frozen harness's lazy spawn throws here instead of
    // returning the pre-minted token — which is what makes this test fail before the fix.
    process.env.PATH = root;
    let bank;
    try {
      bank = await createBank({ sample: { question_id: 'token' }, directory: join(root, 'a'), env: { COHERE_API_KEY: 'c' }, projectId: 'memory-canary',
        ledger: new Ledger(join(root, 'costs.jsonl'), 25), storage, clients: extractionClient, providerFetch: fakeProviderFetch(), vertexToken: () => 'minted-token' });
      await expect(bank.bus.call('credentials:get', bank.ctx(), { userId: 'memory-benchmark-owner', ref: 'provider:vertex' })).resolves.toBe('minted-token');
    } finally { process.env.PATH = savedPath; await bank?.close(); }
  });
  it('records per-stage spans for each recall, including a provider that answered after losing the budget race', async () => {
    const root = temporary();
    const storage = new AsyncLocalStorage();
    const ledger = new Ledger(join(root, 'costs.jsonl'), 25);
    let slowEmbed = false;
    const bank = await createBank({ sample: { question_id: 'spans' }, directory: join(root, 'a'), env: { VERTEX_ACCESS_TOKEN: 't', COHERE_API_KEY: 'c' }, projectId: 'memory-canary', ledger, storage, clients: extractionClient,
      providerFetch: async (url, init) => { if (slowEmbed && String(url).includes(':predict')) await new Promise(done => setTimeout(done, 1700)); return fakeProviderFetch()(url, init); } });
    try {
      await withCorpusClock('2023-01-01T12:00:00Z', () => bank.observe('s1', [{ role: 'user', content: 'I live in Osaka' }, { role: 'assistant', content: 'Noted.' }]));
      const recalls = [];
      const recall = makeRecall({ bank, storage, recalls, ledger });
      await storage.run({ questionId: 'spans', phase: 'sonnet' }, () => recall({ query: 'home' }));
      slowEmbed = true;
      await storage.run({ questionId: 'spans', phase: 'sonnet' }, () => recall({ query: 'where' }));
      await bank.drain();
      const [fast, slow] = recalls;
      expect(fast).toMatchObject({ ok: true, degraded: [] });
      expect(Number.isFinite(fast.at)).toBe(true);
      const hooks = fast.spans.map(span => span.hook);
      for (const hook of ['credentials:get', 'embeddings:embed', 'embeddings:rerank', 'memory:facts:recall', 'memory:recall']) expect(hooks).toContain(hook);
      expect(fast.spans.every(span => span.ok && span.ms >= 0 && span.startMs >= 0)).toBe(true);
      expect(slow.degraded).toContain('semantic');
      const lateEmbed = slow.spans.find(span => span.hook === 'embeddings:embed');
      // The embed handler kept running past the product's 1.5s budget; its span ends
      // after the recall returned, which is exactly the "how late was the provider" number.
      expect(lateEmbed.ms).toBeGreaterThanOrEqual(1650);
      expect(lateEmbed.startMs + lateEmbed.ms).toBeGreaterThan(slow.ms);
    } finally { await bank.close(); }
  }, 20_000);
  it('keeps a sanitized failure class on a failed recall, never the message', async () => {
    const recalls = [];
    const storage = new AsyncLocalStorage();
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    const bank = { ctx: () => ({}), bus: { call: async () => { throw Object.assign(new TypeError('fetch failed Bearer sk-secret'), { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }); } } };
    const out = await storage.run({}, () => makeRecall({ bank, storage, recalls, ledger })({ query: 'q' }));
    expect(out.ok).toBe(false);
    expect(recalls[0]).toMatchObject({ ok: false, error: { name: 'TypeError', cause: { name: 'Error', code: 'ECONNRESET' } } });
    expect(JSON.stringify(recalls)).not.toContain('sk-secret');
  });
  it('reports provider request spans with status and timing, and stamps ledger rows with wall time', async () => {
    const ledger = new Ledger(join(temporary(), 'costs.jsonl'), 25);
    const spans = [];
    const fetcher = makeMeteredProviderFetch(ledger, tags, async url => {
      if (String(url).includes('rerank')) throw Object.assign(new TypeError('fetch failed sk-secret'), { cause: Object.assign(new Error('y'), { code: 'UND_ERR_SOCKET' }) });
      return new Response(JSON.stringify({ metadata: { billableCharacterCount: 3 } }), { status: 200 });
    }, span => spans.push(span));
    await fetcher('https://us-central1-aiplatform.googleapis.com/v1/projects/test/locations/us-central1/publishers/google/models/text-embedding-005:predict', { body: JSON.stringify({ instances: [{ content: 'abc' }] }) });
    await expect(fetcher('https://api.cohere.com/v2/rerank', { body: JSON.stringify({ query: 'x', documents: ['a'] }) })).rejects.toThrow();
    expect(spans[0]).toMatchObject({ provider: 'vertex', ok: true, status: 200, phase: 'sonnet' });
    expect(spans[0].headersMs).toBeLessThanOrEqual(spans[0].ms);
    expect(spans[0].reservation).toBe(ledger.rows('test-run')[0].id);
    expect(spans[1]).toMatchObject({ provider: 'cohere', ok: false, error: { name: 'TypeError', cause: { code: 'UND_ERR_SOCKET' } } });
    expect(JSON.stringify(spans)).not.toContain('sk-secret');
    expect(ledger.events.every(event => Number.isFinite(event.at))).toBe(true);
  });
  it('writes numbered failure records with a stage and sanitized class', () => {
    const root = temporary();
    recordFailure(root, { stage: 'glm-judge', questionId: 'q1', arm: 'glm', error: Object.assign(new Error('sk-secret'), { status: 502, name: 'ProviderError' }) });
    recordFailure(root, { stage: 'ingest', questionId: 'q2', error: new Error('boom') });
    const files = readdirSync(root).sort();
    expect(files).toEqual(['failure-01.json', 'failure-02.json']);
    const first = JSON.parse(readFileSync(join(root, files[0]), 'utf8'));
    expect(first).toMatchObject({ stage: 'glm-judge', questionId: 'q1', arm: 'glm', error: { name: 'ProviderError', status: 502 } });
    expect(Number.isFinite(first.at)).toBe(true);
    expect(JSON.stringify(first)).not.toContain('sk-secret');
  });
  it('binds run identity to every harness file, so a run captured by the frozen harness cannot resume', () => {
    expect(HARNESS_FILES).toEqual(['memory-product-e2e.mjs', 'memory-product-e2e-lib.mjs', 'memory-product-e2e-trace.mjs']);
    const files = { 'memory-product-e2e.mjs': 'a', 'memory-product-e2e-lib.mjs': 'b', 'memory-product-e2e-trace.mjs': 'c' };
    const digest = sourceDigestOf(name => files[name]);
    expect(sourceDigestOf(name => (name === 'memory-product-e2e-trace.mjs' ? 'changed' : files[name]))).not.toBe(digest);
    const identity = { sourceRevision: 'x', sourceDigest: digest };
    expect(() => checkResumeIdentity({ identity }, identity)).not.toThrow();
    expect(() => checkResumeIdentity(undefined, identity)).not.toThrow();
    // The frozen TASK-497 harness digested TWO files. Even over identical contents that
    // scheme cannot produce the three-file digest, so a manifest it wrote is refused.
    const sha = value => createHash('sha256').update(value).digest('hex');
    const frozenScheme = sha(JSON.stringify([sha(files['memory-product-e2e.mjs']), sha(files['memory-product-e2e-lib.mjs'])]));
    expect(frozenScheme).not.toBe(digest);
    expect(() => checkResumeIdentity({ identity: { ...identity, sourceDigest: frozenScheme } }, identity)).toThrow(/Run identity changed/);
  });
  it('reports interrupted attempts and the latency breakdown separately, leaving the gate line unchanged', () => {
    const manifest = { runId: 'test', sourceRevision: 'fixture', input: { questionIds: ['a'], corpusSha256: 'fixture', counts: { type: 1 } } };
    const rows = [result('a', 'correct', [{ ms: 3500, ok: true, degraded: ['semantic'], spans: [{ hook: 'embeddings:embed', ms: 2000 }] }]), { ...result('a', 'correct', [{ ms: 400, ok: true, degraded: [] }]), arm: 'glm' }];
    const report = renderReport(manifest, rows, [], 25, 0, undefined, { attempts: { sonnet: { attempts: 2, complete: 1, failed: 0, interrupted: 1, toolCallsOutsideCompleted: 3 } } });
    expect(report).toContain('sonnet: 1 interrupted and 0 failed answer attempts (of 2); 3 tool calls in them');
    expect(report).toContain('glm: 0 interrupted and 0 failed answer attempts (of 0)');
    expect(report).toContain('sonnet: clean p95 n/a (0 calls), degraded p95 3500.000 (1 calls); embeddings:embed p95 2000.000 (n=1)');
    expect(report).toContain('sonnet: 0/1 recall calls failed; 1 calls degraded; 0 uncertain verdicts; 0 run errors. Accuracy gate: PASS. Latency <1600ms: FAIL.');
  });
});
