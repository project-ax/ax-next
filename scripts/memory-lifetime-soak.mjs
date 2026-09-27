// Rung-6 lifetime soak (TASK-520): recall latency, store size and rank displacement as one
// agent's `@ax/memory-facts-sqlite` store grows to 500k rows, on the providers the memory
// preset ships (OpenRouter gemini-embedding-001 @384 + voyage rerank-2.5), plus a closure
// audit of the rung-4 banks. Design: docs/plans/2026-09-18-dem-first-memory-design.md §7/§8.
//
//   pnpm build   # the harness imports packages' dist/
//   pnpm exec tsx scripts/memory-lifetime-soak.mjs --env <path>/.env.walk                 # the paid run
//   pnpm exec tsx scripts/memory-lifetime-soak.mjs --fake-providers --scale 20 --probes 5 # free smoke
//
// `tsx`, not bare `node`: the pinned-probe loader is TASK-497's, which imports the Strata
// bench's TypeScript (parameter properties), and Node's strip-only mode rejects those.
//
// Every run gets a NEW run id and directory. The rung-4 banks are copied, hashed and read
// from the copy; the originals are opened by nothing. Spend goes through TASK-497's
// reserve-before-request Ledger with a hard cap; disk growth is guarded so a full volume
// stops the run at the largest checkpoint that fits instead of breaking the machine.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { HookBus, bootstrap, makeAgentContext } from '../packages/core/dist/index.js';
import { createMemoryPlugins, MEMORY_EMBED_MODEL, MEMORY_RERANK_MODEL } from '../presets/memory/dist/index.js';
import { agentScopeKey } from '../packages/memory-facts-sqlite/dist/agent-scope-key.js';
import { CHANNEL_LIMIT, buildFtsMatchQuery, denseChannel, reciprocalRankFusion, rowsInRankOrder, sparseChannel, temporalChannel } from '../packages/memory-facts-sqlite/dist/recall.js';
import { FTS_TABLE, INFINITY_SENTINEL, TABLE, VEC_TABLE } from '../packages/memory-facts-sqlite/dist/schema.js';
import { BudgetExceeded, Ledger } from './memory-product-e2e-lib.mjs';
import { loadEnvironment, makeMeteredProviderFetch, pinnedSamples } from './memory-product-e2e.mjs';
import { sanitizeError } from './memory-product-e2e-trace.mjs';
import { SOAK_SEED, buildVocabulary, diskAllows, goldIds, hitRate, linearFit, mulberry32, randomUnitVector, rankOfFirstGold, seededShuffle, summarize, syntheticStatement } from './memory-lifetime-soak-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const requireFromStore = createRequire(join(HERE, '../packages/memory-facts-sqlite/package.json'));
const Database = requireFromStore('better-sqlite3');
const sqliteVec = requireFromStore('sqlite-vec');

export const SOAK = Object.freeze({
  capUsd: 10,
  owner: 'memory-benchmark-owner', // rung 4's owner, so `user:<owner>` statements read the same
  agentId: 'lifetime-soak',
  // 'all' = every real fact (~32.5k); the synthetic segment starts after it.
  checkpoints: [10_000, 25_000, 'all', 50_000, 130_000, 250_000, 500_000],
  probeSizes: [1_000, 2_000, 4_000, 8_000, 16_000],
  latencyLimit: 15, // `memory_recall`'s default limit
  rankLimit: 200, // the store's MAX_LIMIT: ranks past the 40-row rerank pool are RRF order
  warmups: 3,
  dims: 384,
  diskReserveBytes: 1024 ** 3,
  insertBatch: 5_000,
});

const HARNESS_FILES = Object.freeze(['memory-lifetime-soak.mjs', 'memory-lifetime-soak-lib.mjs']);
const hash = value => createHash('sha256').update(value).digest('hex');
function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

/** Deterministic, offline stand-ins for the two OpenRouter endpoints — smoke runs only. */
export function fakeProviderFetch() {
  return async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.pathname === '/api/v1/embeddings') {
      const data = body.input.map((text, index) => {
        const rand = mulberry32(Number.parseInt(hash(text).slice(0, 8), 16));
        return { index, embedding: Array.from(randomUnitVector(rand, body.dimensions ?? SOAK.dims)) };
      });
      return Response.json({ data, usage: { total_tokens: 1, cost: 0 } });
    }
    if (url.pathname === '/api/v1/rerank') {
      const terms = new Set(String(body.query).toLowerCase().split(/\W+/).filter(Boolean));
      const results = body.documents.map((doc, index) => ({
        index,
        relevance_score: String(doc).toLowerCase().split(/\W+/).filter(w => terms.has(w)).length,
      }));
      return Response.json({ results, usage: { total_tokens: 1, cost: 0 } });
    }
    return new Response('not found', { status: 404 });
  };
}

/** Copy every rung-4 bank's facts.db (+ WAL/SHM) into the run, hash the copy, read rows from it. */
export function copyAndReadBanks(sourceRoot, targetRoot) {
  const banks = new Map();
  const fileHashes = [];
  for (const name of readdirSync(sourceRoot).filter(n => n.startsWith('bank-')).sort()) {
    const { generation } = JSON.parse(readFileSync(join(sourceRoot, name, 'progress.json'), 'utf8'));
    if (typeof generation !== 'string' || !/^[0-9a-f-]{36}$/.test(generation)) throw new Error(`Bank ${name} has no generation`);
    const target = join(targetRoot, name);
    mkdirSync(target, { recursive: true });
    for (const file of ['facts.db', 'facts.db-wal', 'facts.db-shm']) {
      const from = join(sourceRoot, name, generation, file);
      if (!existsSync(from)) continue;
      copyFileSync(from, join(target, file), fsConstants.COPYFILE_EXCL);
      fileHashes.push([`${name}/${file}`, hash(readFileSync(join(target, file)))]);
    }
    const db = new Database(join(target, 'facts.db'), { fileMustExist: true });
    try {
      banks.set(name, db.prepare(`SELECT * FROM ${TABLE}`).all());
    } finally {
      db.close();
    }
  }
  return { banks, bankCopySha256: hash(JSON.stringify(fileHashes)), files: fileHashes.length };
}

function dbBytes(path) {
  return ['', '-wal', '-shm'].reduce((n, suffix) => n + (existsSync(path + suffix) ? statSync(path + suffix).size : 0), 0);
}

function freeBytes(path) {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Boot the memory slice exactly as `presets/memory` configures it, keeping only the store
 * and the embeddings producer, with a benchmark `credentials:get`. Provider spans come
 * from wrapping `registerService` (TASK-521's shim), so no product hook was added.
 */
export async function openStore({ directory, env, providerFetch, assertBudget = () => {} }) {
  mkdirSync(directory, { recursive: true });
  const dbPath = join(directory, 'facts.db');
  const bus = new HookBus();
  const inflight = new Set();
  let capture = null;
  const register = bus.registerService.bind(bus);
  bus.registerService = (hook, plugin, handler, options) => register(hook, plugin, (ctx, input) => {
    const mine = capture;
    const started = performance.now();
    const promise = Promise.resolve().then(() => handler(ctx, input));
    if (mine && (hook === 'embeddings:embed' || hook === 'embeddings:rerank')) {
      const key = hook === 'embeddings:embed' ? 'embed' : 'rerank';
      promise.then(out => {
        mine[key] = { ms: performance.now() - started, ok: true };
        if (key === 'embed' && input?.task === 'query') mine.queryVector = out?.vectors?.[0];
      }, error => { mine[key] = { ms: performance.now() - started, ok: false, error: sanitizeError(error) }; });
    }
    inflight.add(promise);
    void promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
    return promise;
  }, options);
  const drain = async () => {
    while (inflight.size) {
      await Promise.allSettled([...inflight]);
      await new Promise(r => setImmediate(r));
    }
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  const ctx = makeAgentContext({ sessionId: 'lifetime-soak', agentId: SOAK.agentId, userId: SOAK.owner, logger, workspace: { rootPath: directory } });
  const support = {
    manifest: { name: '@ax/benchmark-support', version: '0.0.0', registers: ['credentials:get'], calls: [], subscribes: [] },
    init({ bus: b }) {
      b.registerService('credentials:get', '@ax/benchmark-support', async (_ctx, input) => {
        if (input.userId !== SOAK.owner || input.ref !== 'provider:openrouter') throw new Error('Unexpected benchmark credential request');
        return env.OPENROUTER_API_KEY;
      });
    },
  };
  const plugins = createMemoryPlugins({
    database: { connectionString: 'postgres://unused' }, eventbus: { connectionString: 'postgres://unused' }, session: { connectionString: 'postgres://unused' },
    workspace: { backend: 'local', repoRoot: join(directory, 'workspace') },
    ipc: { hostIpcUrl: 'http://127.0.0.1:1' },
    http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
    factsDatabasePath: dbPath,
    memoryExportVolume: { hostRoot: join(directory, 'exports'), backing: { server: 'benchmark.invalid', exportPath: '/benchmark-memory' } },
    memoryEmbeddings: { fetchImpl: providerFetch },
  });
  const keep = new Set(['@ax/memory-facts-sqlite', '@ax/embeddings']);
  const selected = plugins.filter(p => keep.has(p.manifest.name));
  if (selected.length !== keep.size) throw new Error('Preset memory slice changed');
  const kernel = await bootstrap({ bus, plugins: [support, ...selected], config: {} });

  // A second connection for bulk loads and direct channel timing. Opened AFTER boot, so
  // the store has created the schema and recorded its embedding fingerprint.
  const db = new Database(dbPath, { allowExtension: true });
  sqliteVec.load(db);
  const agentKey = agentScopeKey({ agentId: SOAK.agentId });
  const insertBase = db.prepare(`INSERT INTO ${TABLE} (id, agent_key, about, relation, value, slot, provenance, owner_user_id, conversation_id, kind, valid_start, valid_end, transaction_time, closed_by, batch_key, batch_seq)
    VALUES (@id, @agent_key, @about, @relation, @value, @slot, @provenance, @owner_user_id, @conversation_id, @kind, @valid_start, @valid_end, @transaction_time, @closed_by, @batch_key, @batch_seq)`);
  const insertFts = db.prepare(`INSERT INTO ${FTS_TABLE} (id, about, relation, value) VALUES (?, ?, ?, ?)`);
  const insertVec = db.prepare(`INSERT INTO ${VEC_TABLE} (id, embedding) VALUES (?, ?)`);
  const insertMany = db.transaction(rows => {
    for (const { row, vector } of rows) {
      insertBase.run({ ...row, agent_key: agentKey });
      insertFts.run(row.id, row.about, row.relation, row.value);
      if (vector) insertVec.run(row.id, vector);
    }
  });

  return {
    dbPath,
    agentKey,
    insert(rows) {
      for (let i = 0; i < rows.length; i += SOAK.insertBatch) insertMany(rows.slice(i, i + SOAK.insertBatch));
      db.pragma('wal_checkpoint(TRUNCATE)');
    },
    missingVectors() {
      return db.prepare(`SELECT count(*) AS n FROM ${TABLE} t WHERE NOT EXISTS (SELECT 1 FROM ${VEC_TABLE} v WHERE v.id = t.id)`).get().n;
    },
    /** `memory:facts:reindex` until every row has a vector — the product's own re-embed. */
    async reembedAll() {
      let stalls = 0;
      for (let left = this.missingVectors(); left > 0;) {
        await bus.call('memory:facts:reindex', ctx, {});
        await drain();
        assertBudget();
        const now = this.missingVectors();
        stalls = now < left ? 0 : stalls + 1;
        if (stalls >= 5) throw new Error(`Re-embed stalled with ${now} rows lacking vectors`);
        left = now;
      }
      db.pragma('wal_checkpoint(TRUNCATE)');
    },
    vectors() {
      return new Map(db.prepare(`SELECT id, embedding FROM ${VEC_TABLE}`).all().map(r => [r.id, Buffer.from(r.embedding)]));
    },
    size() {
      const r = db.prepare(`SELECT count(*) AS rows, sum(valid_end = ?) AS active, sum(closed_by IS NOT NULL) AS closedBy FROM ${TABLE} WHERE agent_key = ?`).get(INFINITY_SENTINEL, agentKey);
      return { rows: r.rows, active: r.active ?? 0, closed: r.rows - (r.active ?? 0), closedBy: r.closedBy ?? 0, bytes: dbBytes(dbPath) };
    },
    /** One product recall, timed end to end, with the provider spans inside it. */
    async recall(query, limit) {
      const mine = { embed: null, rerank: null, queryVector: undefined };
      capture = mine;
      const started = performance.now();
      let out;
      let error;
      try {
        out = await bus.call('memory:facts:recall', ctx, { query, ownerUserId: SOAK.owner, limit });
      } catch (e) {
        error = sanitizeError(e);
      }
      const ms = performance.now() - started;
      capture = null;
      await drain(); // untimed: late provider spans land before we read them
      // The producers swallow a refused reservation into a degraded recall, so without
      // this the cap would stop spend silently while the run kept "measuring".
      assertBudget();
      const embedMs = mine.embed?.ms ?? 0;
      const rerankMs = mine.rerank?.ms ?? 0;
      return {
        ms, embed: mine.embed, rerank: mine.rerank, localMs: ms - embedMs - rerankMs,
        ids: out?.statements.map(s => s.id) ?? [], degraded: out?.degraded ?? null, queryVector: mine.queryVector,
        ...(error ? { error } : {}),
      };
    },
    /** The four local stages `fusionRecall` runs, timed one by one on this connection. */
    channelTimings(query, queryVector) {
      const scope = { agentKey, ownerUserId: SOAK.owner, activeOnly: true, limit: CHANNEL_LIMIT };
      let t = performance.now();
      const match = buildFtsMatchQuery(query);
      const sparse = match === null ? [] : sparseChannel(db, { ...scope, match });
      const sparseMs = performance.now() - t;
      t = performance.now();
      const dense = queryVector ? denseChannel(db, scope, queryVector) : [];
      const denseMs = queryVector ? performance.now() - t : null;
      t = performance.now();
      const temporal = temporalChannel(db, scope);
      const temporalMs = performance.now() - t;
      t = performance.now();
      const fused = reciprocalRankFusion([sparse, dense, temporal]);
      rowsInRankOrder(db, agentKey, fused.map(c => c.id), SOAK.owner);
      const fusionMs = performance.now() - t;
      return { sparseMs, denseMs, temporalMs, fusionMs, candidates: fused.length };
    },
    async close() {
      await drain();
      db.close();
      await kernel.shutdown();
    },
  };
}

function gitIdentity(allowDirty) {
  const run = args => execFileSync('git', args, { cwd: HERE, encoding: 'utf8' }).trim();
  const sourceRevision = run(['rev-parse', 'HEAD']);
  const dirty = run(['status', '--porcelain']).length > 0;
  if (dirty && !allowDirty) throw new Error('A paid soak needs a clean tree so its source revision means something');
  return { sourceRevision, dirty };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      env: { type: 'string', multiple: true, default: [] },
      'bank-root': { type: 'string', default: join(homedir(), '.cache/ax-memory-bench/task497-banks') },
      'run-root': { type: 'string', default: join(homedir(), '.cache/ax-memory-bench') },
      'fake-providers': { type: 'boolean', default: false },
      scale: { type: 'string', default: '1' },
      probes: { type: 'string', default: '100' },
    },
  });
  const fake = values['fake-providers'];
  const scale = Number(values.scale);
  const probeLimit = Number(values.probes);
  if (!(scale >= 1) || !(probeLimit >= 1)) throw new Error('--scale and --probes must be ≥ 1');
  if (!fake && (scale !== 1 || probeLimit !== 100)) throw new Error('A paid run is the full run: no --scale or --probes');
  const env = fake ? { OPENROUTER_API_KEY: 'fake-key' } : loadEnvironment(values.env);
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required (from --env files or the environment)');

  const runId = randomUUID();
  const runDir = join(resolve(values['run-root']), `task520-${runId}`);
  mkdirSync(runDir, { recursive: false, mode: 0o700 });
  const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
  log(`run ${runId} → ${runDir}`);

  const { sourceRevision, dirty } = gitIdentity(fake);
  const harnessDigest = hash(JSON.stringify(HARNESS_FILES.map(name => hash(readFileSync(join(HERE, name))))));
  const { pinned, samples } = await pinnedSamples();
  const copied = copyAndReadBanks(resolve(values['bank-root']), join(runDir, 'bank-copy'));
  const manifest = {
    runId, task: 'TASK-520', sourceRevision, dirty, harnessDigest, fake, scale, probeLimit,
    seed: SOAK_SEED, capUsd: SOAK.capUsd,
    models: { embed: MEMORY_EMBED_MODEL, rerank: MEMORY_RERANK_MODEL },
    probeSet: { file: 'scripts/memory-product-e2e-inputs.json', corpusSha256: pinned.corpusSha256, questionIdsSha256: hash(JSON.stringify(pinned.questionIds)) },
    banks: { source: resolve(values['bank-root']), count: copied.banks.size, files: copied.files, bankCopySha256: copied.bankCopySha256 },
    node: process.version, platform: `${process.platform}-${process.arch}`,
    startedAt: new Date().toISOString(),
  };
  save(join(runDir, 'manifest.json'), manifest);
  // The copy was only a read source; the rows are in memory now. Disk is the scarce thing.
  rmSync(join(runDir, 'bank-copy'), { recursive: true, force: true });

  // --- real facts and probes -------------------------------------------------------
  // A smoke run (fewer probes) keeps only its probes' banks, so every size stays small.
  if (probeLimit < 100) {
    const wanted = new Set(samples.slice(0, probeLimit).map(s => `bank-${hash(s.question_id).slice(0, 24)}`));
    for (const name of [...copied.banks.keys()]) if (!wanted.has(name)) copied.banks.delete(name);
  }
  const allReal = [...copied.banks.values()].flat();
  const bankOf = new Map();
  for (const [name, rows] of copied.banks) for (const row of rows) bankOf.set(row.id, name);
  if (bankOf.size !== allReal.length) throw new Error('Fact ids collide across banks');
  const probes = samples.slice(0, probeLimit).map(sample => {
    const bank = `bank-${hash(sample.question_id).slice(0, 24)}`;
    const rows = copied.banks.get(bank);
    if (!rows) throw new Error(`No bank for probe ${sample.question_id}`);
    return { questionId: sample.question_id, questionType: sample.question_type, query: sample.question, bank, gold: goldIds(rows, sample.answer_session_ids ?? [], INFINITY_SENTINEL) };
  });
  const measurable = probes.filter(p => p.gold.size > 0);
  const corpus = {
    banks: copied.banks.size, rows: allReal.length,
    active: allReal.filter(r => r.valid_end === INFINITY_SENTINEL).length,
    closedBy: allReal.filter(r => r.closed_by !== null).length,
    uniqueStatements: new Set(allReal.map(r => `${r.about}\u0000${r.relation}\u0000${r.value}`)).size,
    meanChars: allReal.reduce((n, r) => n + r.about.length + r.relation.length + r.value.length, 0) / allReal.length,
  };
  const results = {
    manifest, corpus,
    probes: { total: probes.length, withGold: measurable.length, withoutGold: probes.filter(p => p.gold.size === 0).map(p => p.questionId) },
    checkpoints: [], perProbe: [], closures: [], stopped: null,
  };
  const persist = () => save(join(runDir, 'results.json'), results);
  log(`corpus: ${corpus.rows} real rows in ${corpus.banks} banks; ${measurable.length}/${probes.length} probes have gold`);

  // --- closure audit: every closed row with its closer, within its own bank ----------
  for (const [bank, rows] of copied.banks) {
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const row of rows.filter(r => r.closed_by !== null)) {
      const closer = byId.get(row.closed_by);
      const statement = r => r && { id: r.id, about: r.about, relation: r.relation, value: r.value, slot: r.slot, validStart: r.valid_start, validEnd: r.valid_end, conversationId: r.conversation_id };
      results.closures.push({ bank, closed: statement(row), closer: statement(closer) ?? { id: row.closed_by, missing: true } });
    }
  }
  persist();

  // --- spend ------------------------------------------------------------------------
  const ledger = new Ledger(join(runDir, 'costs.jsonl'), SOAK.capUsd);
  const tags = { runId, phase: 'setup' };
  const providerSpans = [];
  const providerFetch = makeMeteredProviderFetch(ledger, () => ({ ...tags }), fake ? fakeProviderFetch() : fetch, span => providerSpans.push(span));
  const assertBudget = () => {
    if (providerFetch.fatalError) throw providerFetch.fatalError;
    if (ledger.exhausted) throw new BudgetExceeded();
  };
  const spend = () => {
    const rows = ledger.rows(runId);
    const byBasis = {};
    for (const r of rows) byBasis[r.basis] = (byBasis[r.basis] ?? 0) + r.usd;
    return { chargedUsd: ledger.chargedUsd(), requests: rows.length, byBasis, failedRequests: providerSpans.filter(s => s.ok === false).length };
  };

  // --- synthetic generator ------------------------------------------------------------
  const rand = mulberry32(SOAK_SEED);
  const vocab = buildVocabulary(allReal.map(r => r.value));
  const latestReal = Math.max(...allReal.map(r => Date.parse(r.transaction_time)));
  let syntheticCount = 0;
  const syntheticRows = n => Array.from({ length: n }, () => {
    const s = syntheticStatement(allReal, vocab, rand);
    const i = syntheticCount++;
    // Newer than every real fact: a lifetime grows forward in time, so filler is what a
    // person said AFTER the evidence the probes look for.
    const at = new Date(latestReal + (i + 1) * 60_000).toISOString();
    return {
      row: { id: `syn-${String(i).padStart(7, '0')}`, ...s, slot: null, provenance: 'extracted', owner_user_id: SOAK.owner, conversation_id: null, kind: null, valid_start: at, valid_end: INFINITY_SENTINEL, transaction_time: at, closed_by: null, batch_key: null, batch_seq: null },
      vector: Buffer.from(randomUnitVector(rand, SOAK.dims).buffer),
    };
  });

  const measureLatency = async (store, label) => {
    const recalls = [];
    const channels = [];
    for (const p of probes.slice(0, SOAK.warmups)) await store.recall(p.query, SOAK.latencyLimit);
    for (const p of probes) {
      const r = await store.recall(p.query, SOAK.latencyLimit);
      recalls.push({ questionId: p.questionId, ms: r.ms, embedMs: r.embed?.ms ?? null, embedOk: r.embed?.ok ?? null, rerankMs: r.rerank?.ms ?? null, rerankOk: r.rerank?.ok ?? null, localMs: r.localMs, degraded: r.degraded, ...(r.error ? { error: r.error } : {}) });
      channels.push({ questionId: p.questionId, ...store.channelTimings(p.query, r.queryVector) });
    }
    log(`${label}: latency p95 ${summarize(recalls.map(r => r.ms)).p95?.toFixed(0)} ms, local p95 ${summarize(recalls.map(r => r.localMs)).p95?.toFixed(1)} ms`);
    return { recalls, channels };
  };
  const measureRanks = async store => {
    const ranks = [];
    for (const p of measurable) {
      const r = await store.recall(p.query, SOAK.rankLimit);
      ranks.push({ questionId: p.questionId, rank: rankOfFirstGold(r.ids, p.gold), returned: r.ids.length, degraded: r.degraded, ...(r.error ? { error: r.error } : {}) });
    }
    return ranks;
  };

  // --- shared store: real facts, then synthetic filler ---------------------------------
  const realOrder = seededShuffle(allReal, mulberry32(SOAK_SEED + 1));
  const shared = await openStore({ directory: join(runDir, 'shared'), env, providerFetch, assertBudget });
  let realLoaded = 0;
  let bytesPerRow = null;
  let vectorCache = null;
  try {
    for (const checkpoint of SOAK.checkpoints) {
      const target = checkpoint === 'all' ? allReal.length : Math.max(1, Math.floor(checkpoint / scale));
      // A pre-'all' checkpoint the (smoke-sized) corpus cannot reach is covered by 'all'.
      if (checkpoint !== 'all' && realLoaded < allReal.length && target >= allReal.length) continue;
      if (target <= realLoaded + syntheticCount) continue;
      tags.phase = `load-${checkpoint}`;
      const loadStarted = performance.now();
      if (target <= allReal.length) {
        const add = realOrder.slice(realLoaded, target).map(row => ({ row }));
        shared.insert(add);
        realLoaded = target;
        await shared.reembedAll();
      } else {
        const add = target - realLoaded - syntheticCount;
        if (bytesPerRow !== null) {
          const guard = diskAllows({ freeBytes: freeBytes(runDir), bytesPerRow, addRows: add, reserveBytes: SOAK.diskReserveBytes });
          if (!guard.ok) {
            results.stopped = { reason: 'disk', beforeCheckpoint: checkpoint, freeBytes: freeBytes(runDir), projectedBytes: guard.projectedBytes };
            log(`STOP: disk guard before ${checkpoint} (projected ${(guard.projectedBytes / 1e9).toFixed(2)} GB)`);
            break;
          }
        }
        for (let left = add; left > 0; left -= 50_000) shared.insert(syntheticRows(Math.min(50_000, left)));
      }
      const loadMs = performance.now() - loadStarted;
      const size = shared.size();
      bytesPerRow = size.bytes / size.rows;
      tags.phase = `measure-${checkpoint}`;
      const entry = { checkpoint, realRows: realLoaded, syntheticRows: syntheticCount, ...size, loadMs, loadavg: loadavg(), at: new Date().toISOString() };
      Object.assign(entry, await measureLatency(shared, `checkpoint ${checkpoint} (${size.rows} rows)`));
      if (realLoaded === allReal.length) entry.ranks = await measureRanks(shared);
      entry.spend = spend();
      results.checkpoints.push(entry);
      persist();

      if (checkpoint === 'all') {
        // Real vectors, re-embedded by the product, reused for the per-probe stores.
        vectorCache = shared.vectors();
        await perProbeDisplacement();
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    results.stopped = { reason: 'budget', chargedUsd: ledger.chargedUsd() };
    log('STOP: spend cap reached; partial results kept');
  } finally {
    await shared.close();
    results.spend = spend();
    results.summary = summarizeRun(results);
    results.finishedAt = new Date().toISOString();
    persist();
  }

  async function perProbeDisplacement() {
    tags.phase = 'per-probe';
    const directory = join(runDir, 'probe-store');
    for (const [index, p] of measurable.entries()) {
      rmSync(directory, { recursive: true, force: true });
      const store = await openStore({ directory, env, providerFetch, assertBudget });
      const points = [];
      try {
        const own = copied.banks.get(p.bank);
        const others = seededShuffle(allReal.filter(r => bankOf.get(r.id) !== p.bank), mulberry32(SOAK_SEED + 100 + index));
        const withVector = row => {
          const vector = vectorCache.get(row.id);
          if (!vector) throw new Error(`Real fact ${row.id} has no re-embedded vector`);
          return { row, vector };
        };
        store.insert(own.map(withVector));
        let loaded = own.length;
        const sizes = [own.length, ...SOAK.probeSizes.map(s => Math.floor(s / scale)).filter(s => s > own.length)];
        for (const size of sizes) {
          if (size > loaded) {
            store.insert(others.slice(0, size - own.length).slice(loaded - own.length).map(withVector));
            loaded = size;
          }
          const r = await store.recall(p.query, SOAK.rankLimit);
          points.push({ size: store.size().rows, rank: rankOfFirstGold(r.ids, p.gold), returned: r.ids.length, degraded: r.degraded, ...(r.error ? { error: r.error } : {}) });
        }
      } finally {
        await store.close();
      }
      results.perProbe.push({ questionId: p.questionId, questionType: p.questionType, ownRows: copied.banks.get(p.bank).length, gold: p.gold.size, points });
      if ((index + 1) % 10 === 0) { log(`per-probe ${index + 1}/${measurable.length}`); persist(); }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The numbers the report quotes, derived from the raw captures in `results`. */
export function summarizeRun(results) {
  const perCheckpoint = results.checkpoints.map(c => {
    const channel = key => summarize(c.channels.map(x => x[key]));
    const clean = c.recalls.filter(r => Array.isArray(r.degraded) && r.degraded.length === 0 && !r.error);
    return {
      checkpoint: c.checkpoint, rows: c.rows, realRows: c.realRows, syntheticRows: c.syntheticRows, active: c.active, closed: c.closed, bytes: c.bytes,
      recall: summarize(c.recalls.map(r => r.ms)),
      recallClean: summarize(clean.map(r => r.ms)),
      degradedCalls: c.recalls.length - clean.length,
      embed: summarize(c.recalls.map(r => r.embedMs)),
      rerank: summarize(c.recalls.map(r => r.rerankMs)),
      local: summarize(c.recalls.map(r => r.localMs)),
      sparse: channel('sparseMs'), dense: channel('denseMs'), temporal: channel('temporalMs'), fusion: channel('fusionMs'),
      ...(c.ranks ? { rank: rankSummary(c.ranks.map(r => r.rank)) } : {}),
    };
  });
  const fit = key => {
    const points = perCheckpoint.filter(c => c[key].p50 !== null);
    if (points.length < 2) return null;
    const f = linearFit(points.map(c => c.rows), points.map(c => c[key].p50));
    return { msPer100kRows: f.slope * 100_000, interceptMs: f.intercept, r2: f.r2 };
  };
  const sizes = [...new Set(results.perProbe.flatMap(p => p.points.map((_, i) => i)))];
  const perProbeBySize = sizes.map(i => {
    const at = results.perProbe.map(p => p.points[i]).filter(Boolean);
    return { step: i, meanRows: at.reduce((n, x) => n + x.size, 0) / (at.length || 1), ...rankSummary(at.map(x => x.rank)) };
  });
  return {
    perCheckpoint,
    growthP50: { recall: fit('recall'), local: fit('local'), sparse: fit('sparse'), dense: fit('dense'), temporal: fit('temporal'), fusion: fit('fusion'), embed: fit('embed'), rerank: fit('rerank') },
    perProbeBySize,
  };
}

function rankSummary(ranks) {
  const found = ranks.filter(r => r !== null);
  return { probes: ranks.length, hitAt1: hitRate(ranks, 1), hitAt5: hitRate(ranks, 5), hitAt15: hitRate(ranks, 15), hitAt40: hitRate(ranks, 40), absent: ranks.length - found.length, medianRank: summarize(found).p50 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(() => { process.exitCode = 0; }).catch(error => {
    console.error('Soak failed; no credential values are printed.', sanitizeError(error), error?.message?.slice(0, 300));
    process.exitCode = 1;
  });
}
