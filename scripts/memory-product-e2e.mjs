import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { HookBus, PluginError, bootstrap, makeAgentContext } from '../packages/core/dist/index.js';
import { createMemoryPlugins } from '../presets/memory/dist/index.js';
import { EXTRACTION_PROMPT_FINGERPRINT, EXTRACTION_PROMPT_MODEL_FINGERPRINT } from '../packages/memory/dist/index.js';
import { BenchCache } from '../packages/memory-strata/test/bench/cache.ts';
import { loadLongMemEvalSSamples } from '../packages/memory-strata/test/bench/corpora/longmemeval-s.ts';
import { parseCorpusDate } from '../packages/memory-strata/test/bench/e2e-driver.ts';
import { judgeAnswer } from '../packages/memory-strata/test/bench/judge.ts';
import { CONFIG, ANSWER_PREAMBLE, BudgetExceeded, ProviderError, Ledger, aggregate, buildSystem, makeClients, readJsonl } from './memory-product-e2e-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = 'memory-benchmark-owner';
const ARMS = ['sonnet', 'glm'];
const SUPPORTED_ENV = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'COHERE_API_KEY', 'VERTEX_ACCESS_TOKEN', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS'];
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
function readOptional(path) { return existsSync(path) ? json(path) : undefined; }

export function loadEnvironment(files) {
  const merged = {};
  for (const file of [...files].reverse()) Object.assign(merged, parseEnv(readFileSync(resolve(file), 'utf8')));
  Object.assign(merged, process.env);
  return Object.fromEntries(SUPPORTED_ENV.filter(key => typeof merged[key] === 'string' && merged[key].trim()).map(key => [key, merged[key]]));
}

function gcloud(args, env) {
  return execFileSync('gcloud', args, {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(env.GOOGLE_APPLICATION_CREDENTIALS ? { GOOGLE_APPLICATION_CREDENTIALS: env.GOOGLE_APPLICATION_CREDENTIALS } : {}), CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
  }).trim();
}

export async function withCorpusClock(instant, work) {
  const original = globalThis.Date;
  const ms = original.parse(instant);
  if (!Number.isFinite(ms)) throw new Error('Invalid corpus clock');
  globalThis.Date = new Proxy(original, {
    construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [ms], newTarget); },
    apply() { return new original(ms).toString(); },
    get(target, key, receiver) { return key === 'now' ? () => ms : Reflect.get(target, key, receiver); },
  });
  try { return await work(); } finally { globalThis.Date = original; }
}

export async function pinnedSamples() {
  const pinned = json(join(HERE, 'memory-product-e2e-inputs.json'));
  const cache = new BenchCache();
  const corpus = await loadLongMemEvalSSamples(cache);
  const raw = await cache.readIfHit('longmemeval-s', 'longmemeval_s_cleaned.json');
  if (!raw || hash(raw) !== pinned.corpusSha256 || corpus.length !== pinned.corpusQuestions) throw new Error('Corpus does not match the pinned input artifact');
  const byId = new Map(corpus.map(sample => [sample.question_id, sample]));
  if (byId.size !== corpus.length || new Set(pinned.questionIds).size !== CONFIG.sample) throw new Error('Duplicate or incomplete question identifiers');
  const selected = pinned.questionIds.map(id => {
    const s = byId.get(id);
    if (!s || typeof s.question !== 'string' || !['string', 'number'].includes(typeof s.answer)) throw new Error('Malformed pinned sample');
    if (!parseCorpusDate(s.question_date) || s.haystack_sessions.length !== s.haystack_session_ids.length || s.haystack_sessions.length !== s.haystack_dates?.length) throw new Error('Incomplete corpus dates or sessions');
    for (let i = 0; i < s.haystack_sessions.length; i++) {
      if (!parseCorpusDate(s.haystack_dates[i]) || !Array.isArray(s.haystack_sessions[i]) || s.haystack_sessions[i].some(t => !['user', 'assistant'].includes(t.role) || typeof t.content !== 'string')) throw new Error('Malformed corpus dialogue');
    }
    return { ...s, answer: String(s.answer) };
  });
  return { pinned, samples: selected };
}

export function makeMeteredProviderFetch(ledger, tags, fetchImpl = fetch) {
  const metered = async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Unexpected provider transport');
    const request = JSON.parse(String(init?.body ?? '{}'));
    const vertex = url.hostname === 'us-central1-aiplatform.googleapis.com' && url.pathname.endsWith('/text-embedding-005:predict');
    const cohere = url.hostname === 'api.cohere.com' && url.pathname === '/v2/rerank';
    if (!vertex && !cohere) throw new Error('Unexpected embedding/reranking endpoint');
    const characters = vertex ? request.instances.reduce((n, item) => n + [...item.content].length, 0) : 0;
    const unitsUpper = cohere ? Math.max(1, Math.ceil(request.documents.reduce((n, doc) => n + Math.ceil((Buffer.byteLength(doc) + Buffer.byteLength(request.query) + 512) / 500), 0) / 100)) : 0;
    const upper = vertex ? characters * CONFIG.vertexPerThousandCharacters / 1000 : unitsUpper * CONFIG.coherePerSearchUnit;
    const id = ledger.reserve(upper, { ...tags(), provider: vertex ? 'vertex' : 'cohere' });
    let settled = false;
    try {
      const response = await fetchImpl(input, { ...init, redirect: 'error' });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) metered.fatalError = new ProviderError(vertex ? 'vertex' : 'cohere', response.status);
        ledger.settle(id, vertex ? 0 : upper, vertex ? 'http-error-not-billed' : 'uncertain-upper-bound', { status: response.status });
        settled = true;
        return response;
      }
      const body = await response.clone().json();
      const actualUnits = vertex ? body.metadata?.billableCharacterCount : body.meta?.billed_units?.search_units;
      const measured = typeof actualUnits === 'number' && Number.isFinite(actualUnits) && actualUnits >= 0;
      const quantity = measured ? actualUnits : vertex ? characters : unitsUpper;
      ledger.settle(id, quantity * (vertex ? CONFIG.vertexPerThousandCharacters / 1000 : CONFIG.coherePerSearchUnit),
        measured ? 'published-rate-estimate' : 'quantity-upper-bound-estimate', { quantity, unit: vertex ? 'characters' : 'search_units' });
      settled = true;
      return response;
    } finally {
      if (!settled && !ledger.settlements.has(id)) ledger.settle(id, upper, 'uncertain-upper-bound');
    }
  };
  return metered;
}

export async function createBank({ sample, directory, env, projectId, clients, providerFetch, ledger, storage }) {
  mkdirSync(directory, { recursive: true });
  const bus = new HookBus();
  const rawCalls = new Set();
  const register = bus.registerService.bind(bus);
  bus.registerService = (hook, plugin, handler, options) => register(hook, plugin, (...args) => {
    const promise = Promise.resolve().then(() => handler(...args)).then(result => {
      const capture = storage?.getStore()?.recallCapture;
      if (hook === 'memory:recall' && capture) capture.degraded = [...result.degraded];
      return result;
    });
    rawCalls.add(promise);
    void promise.then(() => rawCalls.delete(promise), () => rawCalls.delete(promise));
    return promise;
  }, options);
  const drain = async () => {
    do {
      await Promise.allSettled([...rawCalls]);
      await new Promise(resolveTick => setImmediate(resolveTick));
    } while (rawCalls.size);
  };
  const agentId = `lme-${hash(sample.question_id).slice(0, 24)}`;
  const detached = [];
  const failures = [];
  const logger = {
    debug() {}, info() {},
    warn(event) { if (event.startsWith('memory_')) failures.push(event); },
    error(event) { if (event.startsWith('memory_')) failures.push(event); },
    child() { return this; },
  };
  const ctx = conversationId => makeAgentContext({ sessionId: `bench-${agentId}`, agentId, userId: OWNER, logger,
    workspace: { rootPath: directory }, ...(conversationId ? { conversationId } : {}) });
  let vertexToken;
  let tokenAt = -Infinity;
  const support = {
    manifest: { name: '@ax/benchmark-support', version: '0.0.0', registers: ['agents:resolve', 'credentials:get', 'llm:call:openrouter'], calls: [], subscribes: [] },
    init({ bus: b }) {
      b.registerService('agents:resolve', '@ax/benchmark-support', async (_ctx, input) => {
        if (input.agentId !== agentId || input.userId !== OWNER) throw new PluginError({ code: 'forbidden', plugin: '@ax/benchmark-support', message: 'Wrong benchmark owner or bank' });
        return { agent: { id: agentId, ownerId: OWNER, ownerType: 'user', visibility: 'personal' } };
      });
      b.registerService('credentials:get', '@ax/benchmark-support', async (_ctx, input) => {
        if (input.userId !== OWNER) throw new Error('Wrong benchmark credential owner');
        if (input.ref === 'provider:cohere') return env.COHERE_API_KEY;
        if (input.ref !== 'provider:vertex') throw new Error('Unknown benchmark credential reference');
        if (env.VERTEX_ACCESS_TOKEN) return env.VERTEX_ACCESS_TOKEN;
        if (!vertexToken || performance.now() - tokenAt > 45 * 60_000) {
          vertexToken = gcloud(['auth', 'application-default', 'print-access-token'], env);
          tokenAt = performance.now();
        }
        return vertexToken;
      });
      b.registerService('llm:call:openrouter', '@ax/benchmark-support', async (_ctx, input) => {
        if (input.model !== CONFIG.extractionModel || input.reasoningEffort !== 'minimal') throw new Error('Unexpected extraction configuration');
        const request = { model: input.model, max_tokens: input.maxTokens, temperature: input.temperature,
          reasoning: { effort: input.reasoningEffort }, messages: [{ role: 'system', content: input.system }, ...input.messages] };
        const cacheDir = join(directory, 'extraction-cache');
        mkdirSync(cacheDir, { recursive: true });
        const cachePath = join(cacheDir, `${hash(JSON.stringify(request))}.json`);
        const cached = readOptional(cachePath);
        if (cached) return cached;
        const response = await clients.openrouter(request);
        const output = {
          text: response.choices?.[0]?.message?.content ?? '',
          stopReason: response.choices?.[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
          usage: { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens },
        };
        if (typeof output.text !== 'string') throw new Error('Invalid extraction text');
        save(cachePath, output);
        return output;
      }, { timeoutMs: 300_000 });
    },
  };
  const plugins = createMemoryPlugins({
    database: { connectionString: 'postgres://unused' }, eventbus: { connectionString: 'postgres://unused' }, session: { connectionString: 'postgres://unused' },
    workspace: { backend: 'local', repoRoot: join(directory, 'workspace') },
    ipc: { hostIpcUrl: 'http://127.0.0.1:1' },
    http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
    factsDatabasePath: join(directory, 'facts.db'),
    memoryExportVolume: { hostRoot: join(directory, 'exports'), backing: { server: 'benchmark.invalid', exportPath: '/benchmark-memory' } },
    memoryEmbeddings: { projectId, fetchImpl: providerFetch },
    onObserverDetached: promise => detached.push(promise),
  });
  const keep = new Set(['@ax/memory', '@ax/memory-facts-sqlite', '@ax/embeddings', '@ax/workspace-git', '@ax/tool-dispatcher']);
  const selected = plugins.filter(p => keep.has(p.manifest.name));
  if (selected.length !== keep.size) throw new Error('Preset memory slice changed');
  const kernel = await bootstrap({ bus, plugins: [support, ...selected], config: {} });
  const listed = await bus.call('tool:list', ctx(), {});
  const descriptor = listed.tools.find(t => t.name === 'memory_recall');
  if (!descriptor || descriptor.executesIn !== 'host') throw new Error('Agent-facing recall tool unavailable');
  return {
    bus, ctx, descriptor, failures, drain,
    async observe(sessionId, messages) {
      await bus.fire('chat:end', ctx(sessionId), { outcome: { kind: 'complete', messages } });
      while (detached.length) await Promise.all(detached.splice(0));
      await drain();
      if (ledger.exhausted) throw new BudgetExceeded();
      if (clients.fatalError || providerFetch.fatalError) throw clients.fatalError ?? providerFetch.fatalError;
    },
    async injected() {
      await bus.call('memory:export:flush', ctx(), {});
      const result = await bus.call('system-prompt:augment', ctx(), {});
      return result.contributions.map(part => part.body).join('\n\n');
    },
    async close() { await drain(); await kernel.shutdown(); await drain(); },
  };
}

export function renderReport(manifest, results, money, cap, charged, abort) {
  const ids = manifest.input.questionIds;
  const shared = money.filter(r => r.phase === 'ingest' || r.phase === 'preflight').reduce((n, r) => n + r.usd, 0);
  const summaries = Object.fromEntries(ARMS.map(arm => [arm, aggregate(results.filter(r => r.arm === arm), ids)]));
  const lines = [
    '# Facts-memory product e2e measurement', '',
    `Run: ${manifest.runId}. Corpus SHA-256: ${manifest.input.corpusSha256}.`,
    `Source revision: ${manifest.sourceRevision}. n=100 pinned stratified questions per arm.`,
    'Real preset-selected memory product: historical sessions → observer → normalization/storage/export → injected block → model-selected memory_recall → answer. No direct retrieval answers.',
    'Control plane is a fixed personal-agent/credential fixture; no HTTP UI or live NFS/kind performance is claimed. Each question has one isolated bank shared by its two read-only answer arms.',
    'Strata corpus/date parsing/judge are reused. Its answer instructions are adapted only for the single statement tool; its common search/abstention/counting guidance is retained. No extra scaffold or adaptive-thinking treatment.',
    'Corpus time is simulated sequentially; latency uses the independent monotonic clock. Six tool-bearing rounds plus a final no-tools round; 512 answer tokens. GLM uses minimal reasoning.',
    '', '| Arm | n | Correct | Accuracy | Tool-call rate | Calls/q | Recall p95 (ms) | Estimated incremental $/100q | Cold standalone $/100q |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const fmt = (value, scale = 1) => value === null ? 'n/a' : (value * scale).toFixed(3);
  for (const arm of ARMS) {
    const s = summaries[arm];
    const spend = money.filter(r => r.phase === arm).reduce((n, r) => n + r.usd, 0);
    lines.push(`| ${arm} (${CONFIG.answerModels[arm]}) | ${s.n} | ${s.correct} | ${fmt(s.accuracy, 100)}% | ${fmt(s.toolCallRate, 100)}% | ${fmt(s.callsPerQuestion)} | ${fmt(s.p95Ms)} | ${s.complete ? spend.toFixed(4) : 'incomplete'} | ${s.complete ? (shared + spend).toFixed(4) : 'incomplete'} |`);
  }
  lines.push('');
  for (const arm of ARMS) {
    const s = summaries[arm];
    lines.push(`${arm}: ${s.recallErrors}/${s.recallCalls} recall calls failed; ${s.degradedCalls} calls degraded; ${s.uncertain} uncertain verdicts; ${s.errors} run errors. Accuracy gate: ${s.complete ? s.accuracyPassed ? 'PASS' : 'FAIL' : 'INCOMPLETE'}. Latency <1600ms: ${s.complete ? s.latencyPassed ? 'PASS' : 'FAIL' : 'INCOMPLETE'}.`);
  }
  lines.push('', `Replicated accuracy gate: ${!abort && ARMS.every(a => summaries[a].complete) ? ARMS.every(a => summaries[a].accuracyPassed) ? 'PASS' : 'FAIL' : 'INCOMPLETE'}.`,
    `Shared ingestion/preflight cost: $${shared.toFixed(4)}. Task ledger charge: $${charged.toFixed(4)} / $${cap.toFixed(2)} cap.`,
    'Shared ingestion is counted once in actual experiment spend, but included in each standalone-arm estimate; do not add the two standalone columns to estimate the paid total.',
    'Costs combine OpenRouter reported USD and published-rate estimates (Anthropic tokens/cache, Vertex $0.000025/1000 non-Gemini embedding characters, Cohere $0.0025/search unit). Missing billing quantities use conservative upper bounds, never zero. Unknown failed-request charges retain the reservation. Taxes/credit-purchase fees are not included.',
    `Upper-bound/uncertain cost entries: ${money.filter(r => r.basis.includes('upper')).length}. OpenRouter provider price ceilings: $10/M input, $20/M output, $0/request; :nitro routing remains enabled.`,
    'Identical-code noise floor from the design: total 1.6pp, multi-session 5.3pp, hallucination 13.4pp. A one-point difference is not a difference. Per-type n is small; report both arms, not a best-of.',
    '', '| Type | Arm | n | Correct | Accuracy |', '|---|---|---:|---:|---:|');
  for (const type of Object.keys(manifest.input.counts)) for (const arm of ARMS) {
    const rows = results.filter(r => r.arm === arm && r.questionType === type);
    const count = rows.filter(r => ['correct', 'abstained-correctly'].includes(r.verdict)).length;
    lines.push(`| ${type} | ${arm} | ${rows.length} | ${count} | ${rows.length ? (100 * count / rows.length).toFixed(1) : 'n/a'}% |`);
  }
  lines.push('', '| Unanswerable subset | n | Correct refusals | Hallucinated answers | Other outcomes | False refusals on answerable |', '|---|---:|---:|---:|---:|---:|');
  for (const arm of ARMS) {
    const s = summaries[arm];
    lines.push(`| ${arm} | ${s.unanswerable} | ${s.correctRefusals} | ${s.hallucinations} | ${s.unanswerable - s.correctRefusals - s.hallucinations} | ${s.falseRefusals} |`);
  }
  const observedBanks = new Map(results.map(row => [row.questionId, row.observerFailures ?? []]));
  lines.push('', `Observer/export failure events across the ${observedBanks.size} captured question banks: ${[...observedBanks.values()].flat().length}.`,
    'The pinned unanswerable subset contains only five questions; one answer moves that row by 20 percentage points. Hallucination classification matches the existing Strata report.',
    `Abort/status: ${abort ?? 'none'}. No decision about replacing Strata is made by this report.`, '');
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'run-dir': { type: 'string' }, 'credentials-file': { type: 'string', multiple: true },
    cap: { type: 'string', default: '25' }, ledger: { type: 'string' },
    'stop-after': { type: 'string' },
    preflight: { type: 'boolean', default: false },
  } });
  if (!values['run-dir']) throw new Error('--run-dir is required');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Benchmark requires TLS certificate verification');
  const directory = resolve(values['run-dir']);
  const cap = Number(values.cap);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('Spending cap must be positive and finite');
  const stopAfter = values['stop-after'] === undefined ? Infinity : Number(values['stop-after']);
  if (stopAfter !== Infinity && (!Number.isSafeInteger(stopAfter) || stopAfter < 1)) throw new Error('stop-after must be a positive integer');
  const { pinned, samples } = await pinnedSamples();
  const env = loadEnvironment(values['credentials-file'] ?? []);
  for (const key of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'COHERE_API_KEY']) if (!env[key]) throw new Error(`Missing ${key}; configure an approved env file`);
  const projectId = env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT ?? gcloud(['config', 'get-value', 'project'], env);
  if (!projectId || projectId === '(unset)') throw new Error('Vertex project is not configured');
  if (!env.VERTEX_ACCESS_TOKEN) gcloud(['auth', 'application-default', 'print-access-token'], env);
  if (values.preflight) {
    console.log(JSON.stringify({ pinnedQuestions: samples.length, credentialsConfigured: true, vertexProjectConfigured: true, capUsd: cap, paidCalls: 0 }));
    return 0;
  }
  const worktree = resolve(HERE, '..');
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd: worktree }).trim()) throw new Error('Commit the exact harness and product tree before a paid run');
  const manifestPath = join(directory, 'manifest.json');
  if (existsSync(directory) && !existsSync(manifestPath) && readdirSync(directory).length) throw new Error('Refusing a nonempty unowned run directory');
  mkdirSync(directory, { recursive: true });
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: resolve(HERE, '..') }).trim();
  const sourceDigest = hash(JSON.stringify([hash(readFileSync(fileURLToPath(import.meta.url))), hash(readFileSync(join(HERE, 'memory-product-e2e-lib.mjs')))]));
  const identity = { input: pinned, configuration: CONFIG, sourceRevision, sourceDigest, preambleSha256: hash(ANSWER_PREAMBLE), extractionFingerprint: EXTRACTION_PROMPT_FINGERPRINT, extractionModelFingerprint: EXTRACTION_PROMPT_MODEL_FINGERPRINT };
  const previous = readOptional(manifestPath);
  if (previous && JSON.stringify(previous.identity) !== JSON.stringify(identity)) throw new Error('Run identity changed; do not mix samples, prompts, models or harness versions');
  const manifest = previous ?? { runId: randomUUID(), sourceRevision, input: pinned, identity };
  if (!previous) save(manifestPath, manifest);
  const ledger = new Ledger(resolve(values.ledger ?? join(directory, 'costs.jsonl')), cap);
  const storage = new AsyncLocalStorage();
  const tags = () => { const scope = storage.getStore(); return { runId: manifest.runId, questionId: scope?.questionId ?? 'setup', phase: scope?.phase ?? 'preflight' }; };
  const clients = makeClients({ env, ledger, tags });
  const providerFetch = makeMeteredProviderFetch(ledger, tags);
  const resultsPath = join(directory, 'results.jsonl');
  const results = readJsonl(resultsPath);
  if (results.some(row => !ARMS.includes(row.arm))) throw new Error('Unknown arm in captured results');
  for (const arm of ARMS) aggregate(results.filter(r => r.arm === arm), pinned.questionIds);
  let abort;
  let preflightChecked = false;
  let processed = 0;
  try {
    for (const sample of samples) {
      const remaining = ARMS.filter(arm => !results.some(r => r.questionId === sample.question_id && r.arm === arm));
      if (!remaining.length) continue;
      const bankRoot = join(directory, `bank-${hash(sample.question_id).slice(0, 24)}`);
      const progressPath = join(bankRoot, 'progress.json');
      mkdirSync(bankRoot, { recursive: true });
      const progress = readOptional(progressPath) ?? { through: 0, observerFailures: [], budgetInvalid: false, generation: randomUUID() };
      if (!existsSync(progressPath)) save(progressPath, progress);
      if (!Number.isSafeInteger(progress.through) || progress.through < 0 || progress.through > sample.haystack_sessions.length || typeof progress.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(progress.generation)) throw new Error('Invalid bank checkpoint');
      if (progress.budgetInvalid) throw new Error('This bank was interrupted by the budget; preserve artifacts and explicitly rebuild it before resuming');
      const bank = await createBank({ sample, directory: join(bankRoot, progress.generation), env, projectId, clients, providerFetch, ledger, storage });
      try {
        if (!preflightChecked) {
          const embedded = await bank.bus.call('embeddings:embed', bank.ctx(), { texts: ['Benchmark provider preflight'], task: 'query' });
          const ranked = await bank.bus.call('embeddings:rerank', bank.ctx(), { query: 'preflight', documents: ['Benchmark provider preflight'] });
          await bank.drain();
          if (providerFetch.fatalError) throw providerFetch.fatalError;
          if (embedded?.vectors?.length !== 1 || embedded.vectors[0]?.length !== 384 || ranked?.scores?.length !== 1) throw new Error('Remote embedding/reranking preflight failed');
          preflightChecked = true;
          manifest.remotePreflightPassed = true;
          save(manifestPath, manifest);
        }
        await storage.run({ questionId: sample.question_id, phase: 'ingest' }, async () => {
          for (let i = progress.through; i < sample.haystack_sessions.length; i++) {
            const before = bank.failures.length;
            await withCorpusClock(parseCorpusDate(sample.haystack_dates[i]).toISOString(), () => bank.observe(sample.haystack_session_ids[i], sample.haystack_sessions[i]));
            progress.observerFailures.push(...bank.failures.slice(before));
            progress.through = i + 1;
            save(progressPath, progress);
          }
        });
        const questionInstant = parseCorpusDate(sample.question_date).toISOString();
        await withCorpusClock(questionInstant, async () => {
          const memory = await storage.run({ questionId: sample.question_id, phase: 'ingest' }, () => bank.injected());
          for (const arm of remaining) {
            await storage.run({ questionId: sample.question_id, phase: arm }, async () => {
              const answerPath = join(bankRoot, `answer-${arm}.json`);
              const captured = readOptional(answerPath);
              if (captured && (captured.questionId !== sample.question_id || captured.arm !== arm || typeof captured.answer !== 'string' || !Array.isArray(captured.recalls))) throw new Error('Invalid captured answer');
              const recalls = captured?.recalls ?? [];
              const recall = async input => {
                const start = performance.now();
                try {
                  const recallCapture = { degraded: [] };
                  const text = await storage.run({ ...storage.getStore(), recallCapture }, () => bank.bus.call('tool:execute:memory_recall', bank.ctx(), { input }));
                  recalls.push({ ms: performance.now() - start, ok: true, degraded: recallCapture.degraded });
                  return { ok: true, text };
                } catch {
                  recalls.push({ ms: performance.now() - start, ok: false });
                  if (ledger.exhausted) throw new BudgetExceeded();
                  return { ok: false, text: 'Memory tool failed; check the arguments or memory availability.' };
                }
              };
              const answer = captured?.answer ?? await clients.answer({ arm, system: buildSystem(memory, sample.question_date), question: sample.question, descriptor: bank.descriptor, recall });
              await bank.drain();
              if (ledger.exhausted) throw new BudgetExceeded();
              if (clients.fatalError || providerFetch.fatalError) throw clients.fatalError ?? providerFetch.fatalError;
              if (!captured) save(answerPath, { questionId: sample.question_id, arm, answer, recalls });
              const judge = await judgeAnswer({ complete: async ({ system, user }) => {
                const response = await clients.openrouter({ model: CONFIG.judgeModel, max_tokens: 120, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
                const text = response.choices?.[0]?.message?.content;
                if (typeof text !== 'string' || !/VERDICT:\s*(correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain)\b/i.test(text) || !/REASON:\s*\S/i.test(text)) throw new Error('Judge returned no usable verdict; do not score a parse failure as uncertainty');
                return { text, usage: { in: response.usage.prompt_tokens, out: response.usage.completion_tokens } };
              } }, sample.question, sample.answer, answer, { unanswerable: sample.question_id.endsWith('_abs') });
              const row = { questionId: sample.question_id, questionType: sample.question_type, arm, unanswerable: sample.question_id.endsWith('_abs'), answer, verdict: judge.verdict, reason: judge.reason, recalls, sessionsAttempted: progress.through, observerFailures: progress.observerFailures };
              appendFileSync(resultsPath, JSON.stringify(row) + '\n');
              results.push(row);
              console.log(JSON.stringify({ questionId: row.questionId, arm, verdict: row.verdict, recalls: recalls.length, chargedUsd: ledger.chargedUsd() }));
              writeFileSync(join(directory, 'report.md'), renderReport(manifest, results, ledger.rows(manifest.runId), cap, ledger.chargedUsd(), undefined));
            });
          }
        });
      } catch (error) {
        if (error instanceof BudgetExceeded || ledger.exhausted) { progress.budgetInvalid = true; save(progressPath, progress); }
        throw error;
      } finally { await bank.close(); }
      processed += 1;
      if (processed >= stopAfter) break;
    }
  } catch (error) {
    abort = error instanceof BudgetExceeded || ledger.exhausted ? 'budget-exhausted' : error instanceof ProviderError ? `${error.provider}-http-${error.status}` : 'run-error; inspect the failing stage without publishing provider response bodies';
    process.exitCode = 1;
  } finally {
    writeFileSync(join(directory, 'report.md'), renderReport(manifest, results, ledger.rows(manifest.runId), cap, ledger.chargedUsd(), abort));
  }
  return !abort && ARMS.every(arm => aggregate(results.filter(r => r.arm === arm), pinned.questionIds).complete) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Benchmark setup failed; no credential values are printed. Check required env files, Vertex ADC/project, built packages and pinned inputs.'); process.exitCode = 1; });
}
