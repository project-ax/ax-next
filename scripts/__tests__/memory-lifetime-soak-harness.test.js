import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetExceeded, Ledger } from '../memory-product-e2e-lib.mjs';
import { makeMeteredProviderFetch } from '../memory-product-e2e.mjs';
import { copyAndReadBanks, fakeProviderFetch, openStore, summarizeRun } from '../memory-lifetime-soak.mjs';
import { mulberry32, randomUnitVector } from '../memory-lifetime-soak-lib.mjs';

const Database = createRequire(new URL('../../packages/memory-facts-sqlite/package.json', import.meta.url))('better-sqlite3');
const ACTIVE = '9999-12-31T23:59:59.999Z';
const dirs = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'ax-soak-')); dirs.push(path); return path; };
const stores = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const fact = (id, value) => ({
  id, about: 'user:memory-benchmark-owner', relation: 'likes', value, slot: null, provenance: 'extracted',
  owner_user_id: 'memory-benchmark-owner', conversation_id: 's1', kind: null, valid_start: '2023-05-01T00:00:00.000Z',
  valid_end: ACTIVE, transaction_time: '2023-05-01T00:00:00.000Z', closed_by: null, batch_key: null, batch_seq: null,
});
const withVector = (row, seed) => ({ row, vector: Buffer.from(randomUnitVector(mulberry32(seed)).buffer) });
const env = { OPENROUTER_API_KEY: 'test-key' };

describe('soak store', () => {
  it('recalls bulk-loaded rows through the product hook and times every stage', async () => {
    const store = await openStore({ directory: temporary(), env, providerFetch: fakeProviderFetch() });
    stores.push(store);
    store.insert([withVector(fact('a', 'hiking in the alps'), 1), withVector(fact('b', 'baking sourdough bread'), 2)]);
    expect(store.size()).toMatchObject({ rows: 2, active: 2, closed: 0 });
    expect(store.missingVectors()).toBe(0);

    const r = await store.recall('sourdough bread', 15);
    expect(r.error).toBeUndefined();
    expect(r.degraded).toEqual([]);
    expect(r.ids[0]).toBe('b');
    expect(r.embed.ok).toBe(true);
    expect(r.rerank.ok).toBe(true);
    expect(r.queryVector).toHaveLength(384);
    expect(r.localMs).toBeCloseTo(r.ms - r.embed.ms - r.rerank.ms, 9);

    const t = store.channelTimings('sourdough bread', r.queryVector);
    for (const key of ['sparseMs', 'denseMs', 'temporalMs', 'fusionMs']) expect(Number.isFinite(t[key])).toBe(true);
    expect(t.candidates).toBe(2);
  });

  it('re-embeds vector-less rows through memory:facts:reindex', async () => {
    const store = await openStore({ directory: temporary(), env, providerFetch: fakeProviderFetch() });
    stores.push(store);
    store.insert(Array.from({ length: 250 }, (_, i) => ({ row: fact(`r${i}`, `statement number ${i}`) })));
    expect(store.missingVectors()).toBe(250);
    await store.reembedAll(); // > one BACKFILL_LIMIT (200) of rows: must loop
    expect(store.missingVectors()).toBe(0);
    expect(store.vectors().size).toBe(250);
  });

  it('stops LOUDLY at the spend cap instead of measuring degraded recalls', async () => {
    const dir = temporary();
    const ledger = new Ledger(join(dir, 'costs.jsonl'), 0.000001);
    const providerFetch = makeMeteredProviderFetch(ledger, () => ({ runId: 't', phase: 'p' }), fakeProviderFetch());
    const assertBudget = () => { if (ledger.exhausted) throw new BudgetExceeded(); };
    const store = await openStore({ directory: join(dir, 'store'), env, providerFetch, assertBudget });
    stores.push(store);
    store.insert([withVector(fact('a', 'hiking'), 1)]);
    await expect(store.recall('hiking', 15)).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

describe('bank copy', () => {
  it('copies and hashes the bank without writing the source', () => {
    const source = temporary();
    const bankDir = join(source, 'bank-aaa', '11111111-1111-1111-1111-111111111111');
    mkdirSync(bankDir, { recursive: true });
    writeFileSync(join(source, 'bank-aaa', 'progress.json'), JSON.stringify({ generation: '11111111-1111-1111-1111-111111111111' }));
    const db = new Database(join(bankDir, 'facts.db'));
    db.exec('CREATE TABLE memory_facts_v1 (id TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO memory_facts_v1 VALUES (?, ?)').run('x', 'y');
    db.close();
    const before = statSync(join(bankDir, 'facts.db')).mtimeMs;
    const bytes = readFileSync(join(bankDir, 'facts.db'));

    const target = temporary();
    const first = copyAndReadBanks(source, join(target, 'one'));
    const second = copyAndReadBanks(source, join(target, 'two'));
    expect(first.banks.get('bank-aaa')).toEqual([{ id: 'x', value: 'y' }]);
    expect(first.bankCopySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.bankCopySha256).toBe(first.bankCopySha256);
    expect(statSync(join(bankDir, 'facts.db')).mtimeMs).toBe(before);
    expect(readFileSync(join(bankDir, 'facts.db')).equals(bytes)).toBe(true);
    // Never overwrite an existing copy.
    expect(() => copyAndReadBanks(source, join(target, 'one'))).toThrow();
  });
});

describe('summary', () => {
  it('fits per-stage growth per 100k rows and summarizes displacement by step', () => {
    const checkpoint = (rows, localMs) => ({
      checkpoint: rows, rows, realRows: rows, syntheticRows: 0, active: rows, closed: 0, bytes: rows * 3000,
      recalls: [{ ms: 1000 + localMs, embedMs: 400, rerankMs: 600, localMs, degraded: [] }, { ms: 1, embedMs: 1, rerankMs: 1, localMs, degraded: ['semantic'] }],
      channels: [{ sparseMs: localMs / 2, denseMs: localMs / 2, temporalMs: 0.1, fusionMs: 1 }],
      ranks: [{ rank: 1 }, { rank: null }],
    });
    const summary = summarizeRun({
      checkpoints: [checkpoint(100_000, 50), checkpoint(300_000, 150)],
      perProbe: [{ points: [{ size: 300, rank: 1 }, { size: 1000, rank: 20 }] }, { points: [{ size: 320, rank: 3 }, { size: 1000, rank: null }] }],
    });
    expect(summary.growthP50.local.msPer100kRows).toBeCloseTo(50, 9);
    expect(summary.growthP50.sparse.msPer100kRows).toBeCloseTo(25, 9);
    expect(summary.perCheckpoint[0].degradedCalls).toBe(1);
    expect(summary.perCheckpoint[0].rank).toMatchObject({ probes: 2, hitAt1: 0.5, absent: 1 });
    expect(summary.perProbeBySize).toEqual([
      expect.objectContaining({ step: 0, meanRows: 310, hitAt5: 1, absent: 0 }),
      expect.objectContaining({ step: 1, meanRows: 1000, hitAt15: 0, absent: 1 }),
    ]);
  });
});
