import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { HookBus, PluginError, bootstrap, makeAgentContext } from '../packages/core/dist/index.js';
import { createMemoryPlugins } from '../presets/memory/dist/index.js';
import { EXTRACTION_PROMPT_FINGERPRINT, EXTRACTION_PROMPT_MODEL_FINGERPRINT } from '../packages/memory/dist/index.js';
import { BenchCache } from '../packages/memory-strata/test/bench/cache.ts';
import { loadLongMemEvalSSamples } from '../packages/memory-strata/test/bench/corpora/longmemeval-s.ts';
import { parseCorpusDate } from '../packages/memory-strata/test/bench/e2e-driver.ts';
import { judgeAnswer } from '../packages/memory-strata/test/bench/judge.ts';
import { CONFIG, ANSWER_PREAMBLE, BudgetExceeded, ProviderError, Ledger, aggregate, buildSystem, makeClients, readJsonl } from './memory-product-e2e-lib.mjs';
import { PROVIDER_HOSTS, attemptStats, latencyBreakdown, makeDiagnosticsSinks, makeTokenSource, monoNow, openAttemptLog, realNow, sanitizeError, startEnvironmentMonitor, tlsProbe } from './memory-product-e2e-trace.mjs';

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

const gcloudOptions = env => ({
  encoding: 'utf8', timeout: 30_000,
  env: { ...process.env, ...(env.GOOGLE_APPLICATION_CREDENTIALS ? { GOOGLE_APPLICATION_CREDENTIALS: env.GOOGLE_APPLICATION_CREDENTIALS } : {}), CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
});
function gcloud(args, env) {
  return execFileSync('gcloud', args, { ...gcloudOptions(env), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
// Asynchronous, so minting a token never blocks the event loop (TASK-521).
async function gcloudAsync(args, env) {
  const { stdout } = await promisify(execFile)('gcloud', args, gcloudOptions(env));
  return stdout.trim();
}

/** Every file whose content defines a run. A change to any of them is a new run identity. */
export const HARNESS_FILES = Object.freeze(['memory-product-e2e.mjs', 'memory-product-e2e-lib.mjs', 'memory-product-e2e-trace.mjs']);
export const sourceDigestOf = read => hash(JSON.stringify(HARNESS_FILES.map(name => hash(read(name)))));
export function checkResumeIdentity(previous, identity) {
  if (previous && JSON.stringify(previous.identity) !== JSON.stringify(identity)) throw new Error('Run identity changed; do not mix samples, prompts, models or harness versions');
}

/**
 * One failure record per abort, numbered and never overwritten: the stage it happened
 * in and an allowlisted error class. TASK-497's interruptions kept neither, so their
 * cause could not be established afterwards.
 */
export function recordFailure(directory, { stage, questionId, arm, error }) {
  const taken = readdirSync(directory).map(name => /^failure-(\d+)\.json$/.exec(name)?.[1]).filter(Boolean).map(Number);
  const n = String((taken.length ? Math.max(...taken) : 0) + 1).padStart(2, '0');
  writeFileSync(join(directory, `failure-${n}.json`), JSON.stringify({ stage, questionId, ...(arm ? { arm } : {}), at: realNow(), error: sanitizeError(error) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
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

// `observe` receives one span per provider request: status, time to headers, total time,
// the ledger reservation it belongs to, and a sanitized error class on failure.
export function makeMeteredProviderFetch(ledger, tags, fetchImpl = fetch, observe = () => {}) {
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
    const scope = tags();
    const id = ledger.reserve(upper, { ...scope, provider: vertex ? 'vertex' : 'cohere' });
    let settled = false;
    const span = { provider: vertex ? 'vertex' : 'cohere', questionId: scope.questionId, phase: scope.phase, reservation: id, at: realNow() };
    const start = monoNow();
    try {
      const response = await fetchImpl(input, { ...init, redirect: 'error' });
      span.headersMs = monoNow() - start;
      span.status = response.status;
      span.ok = response.ok;
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
    } catch (error) {
      span.ok = false;
      span.error = sanitizeError(error);
      throw error;
    } finally {
      if (!settled && !ledger.settlements.has(id)) ledger.settle(id, upper, 'uncertain-upper-bound');
      span.ms = monoNow() - start;
      observe(span);
    }
  };
  return metered;
}

// Hooks timed inside a recall. Each span ends when the handler actually settles — for a
// producer that lost the product's budget race that is AFTER the recall returned, which
// is how late the provider really was. The harness drains before saving, so late spans
// still land in the capture.
const SPAN_HOOKS = new Set(['credentials:get', 'embeddings:embed', 'embeddings:rerank', 'memory:facts:recall', 'memory:recall']);

export async function createBank({ sample, directory, env, projectId, clients, providerFetch, ledger, storage, vertexToken }) {
  mkdirSync(directory, { recursive: true });
  const bus = new HookBus();
  const rawCalls = new Set();
  const register = bus.registerService.bind(bus);
  bus.registerService = (hook, plugin, handler, options) => register(hook, plugin, (...args) => {
    const capture = storage?.getStore()?.recallCapture;
    const started = monoNow();
    const promise = Promise.resolve().then(() => handler(...args)).then(result => {
      if (hook === 'memory:recall' && capture) capture.degraded = [...result.degraded];
      return result;
    });
    if (capture && SPAN_HOOKS.has(hook)) {
      const span = extra => capture.spans.push({ hook, startMs: started - capture.start, ms: monoNow() - started, ...extra });
      promise.then(() => span({ ok: true }), error => span({ ok: false, error: sanitizeError(error) }));
    }
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
        // Never mint here: this runs inside timed recalls (TASK-521). The caller mints
        // between sessions and before each answer attempt.
        if (!vertexToken) throw new Error('Vertex credential was not minted before the timed region');
        return vertexToken();
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

/**
 * The recall tool as the answer loop sees it, timed end to end. Each entry carries its
 * wall-clock start, the stage spans recorded under it, and — on failure — a sanitized
 * error class instead of the silent `ok: false` the frozen harness kept.
 */
export function makeRecall({ bank, storage, recalls, ledger, onRecall = () => {} }) {
  return async input => {
    const at = realNow();
    const start = monoNow();
    const recallCapture = { degraded: [], spans: [], start };
    try {
      const text = await storage.run({ ...storage.getStore(), recallCapture }, () => bank.bus.call('tool:execute:memory_recall', bank.ctx(), { input }));
      const entry = { at, ms: monoNow() - start, ok: true, degraded: recallCapture.degraded, spans: recallCapture.spans };
      recalls.push(entry);
      onRecall(entry);
      return { ok: true, text };
    } catch (error) {
      const entry = { at, ms: monoNow() - start, ok: false, error: sanitizeError(error), spans: recallCapture.spans };
      recalls.push(entry);
      onRecall(entry);
      if (ledger.exhausted) throw new BudgetExceeded();
      return { ok: false, text: 'Memory tool failed; check the arguments or memory availability.' };
    }
  };
}

export function renderReport(manifest, results, money, cap, charged, abort, diagnostics = {}) {
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
  lines.push('', 'Diagnostics (descriptive only; the gates above are unchanged and still cover every completed recall):');
  for (const arm of ARMS) {
    const a = diagnostics.attempts?.[arm] ?? { attempts: 0, failed: 0, interrupted: 0, toolCallsOutsideCompleted: 0 };
    lines.push(`${arm}: ${a.interrupted} interrupted and ${a.failed} failed answer attempts (of ${a.attempts}); ${a.toolCallsOutsideCompleted} tool calls in them are not in the recall metrics above${a.unreadableLines ? `; ${a.unreadableLines} torn log lines (a process killed mid-write)` : ''}.`);
  }
  for (const arm of ARMS) {
    const b = latencyBreakdown(results.filter(r => r.arm === arm));
    const stages = Object.entries(b.stages).map(([hook, st]) => `; ${hook} p95 ${fmt(st.p95Ms)} (n=${st.n})`).join('');
    lines.push(`${arm}: clean p95 ${fmt(b.cleanP95Ms)} (${b.cleanCalls} calls), degraded p95 ${fmt(b.degradedP95Ms)} (${b.degradedCalls} calls)${stages}.`);
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
  const sourceDigest = sourceDigestOf(name => readFileSync(join(HERE, name)));
  const identity = { input: pinned, configuration: CONFIG, sourceRevision, sourceDigest, preambleSha256: hash(ANSWER_PREAMBLE), extractionFingerprint: EXTRACTION_PROMPT_FINGERPRINT, extractionModelFingerprint: EXTRACTION_PROMPT_MODEL_FINGERPRINT };
  const previous = readOptional(manifestPath);
  checkResumeIdentity(previous, identity);
  const manifest = previous ?? { runId: randomUUID(), sourceRevision, input: pinned, identity };
  if (!previous) save(manifestPath, manifest);
  const ledger = new Ledger(resolve(values.ledger ?? join(directory, 'costs.jsonl')), cap);
  const storage = new AsyncLocalStorage();
  const tags = () => { const scope = storage.getStore(); return { runId: manifest.runId, questionId: scope?.questionId ?? 'setup', phase: scope?.phase ?? 'preflight' }; };
  const clients = makeClients({ env, ledger, tags });
  // Diagnostics sinks (TASK-521): run-level, append-only, wall-clock stamped. Events are
  // buffered and flushed only at untimed boundaries, so no diagnostic write lands inside
  // a timed recall.
  const diagnostics = makeDiagnosticsSinks(directory);
  const { recordEnvironment } = diagnostics;
  const providerFetch = makeMeteredProviderFetch(ledger, tags, fetch, diagnostics.recordProviderSpan);
  const tokenSource = env.VERTEX_ACCESS_TOKEN ? undefined : makeTokenSource({
    mint: () => gcloudAsync(['auth', 'application-default', 'print-access-token'], env),
    onStale: event => recordEnvironment(event),
  });
  // Called only at untimed boundaries: before the preflight, each ingestion session and each answer attempt.
  const refreshCredential = async () => { await tokenSource?.ensureFresh(); };
  const monitor = startEnvironmentMonitor({ emit: recordEnvironment });
  let stage = 'setup';
  let where = {};
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
      where = { questionId: sample.question_id };
      stage = 'bank-start';
      const bank = await createBank({ sample, directory: join(bankRoot, progress.generation), env, projectId, clients, providerFetch, ledger, storage, vertexToken: tokenSource && (() => tokenSource.current()) });
      try {
        for (const host of PROVIDER_HOSTS) recordEnvironment({ questionId: sample.question_id, ...(await tlsProbe(host)) });
        diagnostics.flush();
        if (!preflightChecked) {
          stage = 'preflight';
          await refreshCredential();
          const embedded = await bank.bus.call('embeddings:embed', bank.ctx(), { texts: ['Benchmark provider preflight'], task: 'query' });
          const ranked = await bank.bus.call('embeddings:rerank', bank.ctx(), { query: 'preflight', documents: ['Benchmark provider preflight'] });
          await bank.drain();
          if (providerFetch.fatalError) throw providerFetch.fatalError;
          if (embedded?.vectors?.length !== 1 || embedded.vectors[0]?.length !== 384 || ranked?.scores?.length !== 1) throw new Error('Remote embedding/reranking preflight failed');
          preflightChecked = true;
          manifest.remotePreflightPassed = true;
          save(manifestPath, manifest);
        }
        stage = 'ingest';
        await storage.run({ questionId: sample.question_id, phase: 'ingest' }, async () => {
          for (let i = progress.through; i < sample.haystack_sessions.length; i++) {
            await refreshCredential();
            const before = bank.failures.length;
            await withCorpusClock(parseCorpusDate(sample.haystack_dates[i]).toISOString(), () => bank.observe(sample.haystack_session_ids[i], sample.haystack_sessions[i]));
            progress.observerFailures.push(...bank.failures.slice(before));
            progress.through = i + 1;
            save(progressPath, progress);
            diagnostics.flush();
          }
        });
        const questionInstant = parseCorpusDate(sample.question_date).toISOString();
        stage = 'inject';
        await withCorpusClock(questionInstant, async () => {
          const memory = await storage.run({ questionId: sample.question_id, phase: 'ingest' }, () => bank.injected());
          for (const arm of remaining) {
            where = { questionId: sample.question_id, arm };
            stage = `${arm}-answer`;
            await storage.run({ questionId: sample.question_id, phase: arm }, async () => {
              const answerPath = join(bankRoot, `answer-${arm}.json`);
              const captured = readOptional(answerPath);
              if (captured && (captured.questionId !== sample.question_id || captured.arm !== arm || typeof captured.answer !== 'string' || !Array.isArray(captured.recalls))) throw new Error('Invalid captured answer');
              const recalls = captured?.recalls ?? [];
              let answer = captured?.answer;
              let attempt;
              if (!captured) {
                await refreshCredential();
                monitor.loopDelay();
                attempt = openAttemptLog(bankRoot, arm, { runId: manifest.runId, questionId: sample.question_id });
                // Written after the recall's `ms` is computed and before the next recall
                // starts, so these writes sit between timed windows, never inside one.
                const recall = makeRecall({ bank, storage, recalls, ledger, onRecall: entry => { attempt.write({ type: 'recall', ...entry }); diagnostics.flush(); } });
                try {
                  answer = await clients.answer({ arm, system: buildSystem(memory, sample.question_date), question: sample.question, descriptor: bank.descriptor, recall, onTurn: event => attempt.write(event) });
                  await bank.drain();
                  if (ledger.exhausted) throw new BudgetExceeded();
                  if (clients.fatalError || providerFetch.fatalError) throw clients.fatalError ?? providerFetch.fatalError;
                } catch (error) {
                  attempt.write({ type: 'attempt-failed', error: sanitizeError(error), loopDelay: monitor.loopDelay() });
                  throw error;
                }
                // Each `recall` event above was written when its recall returned, before
                // the drain, so it omits spans of producers that settled later. This is
                // the complete post-drain list, matching the answer file.
                attempt.write({ type: 'recall-spans', spans: recalls.map(r => r.spans ?? []) });
                save(answerPath, { questionId: sample.question_id, arm, answer, recalls, attempt: attempt.attempt });
                attempt.write({ type: 'attempt-complete', loopDelay: monitor.loopDelay() });
                diagnostics.flush();
              }
              stage = `${arm}-judge`;
              const judge = await judgeAnswer({ complete: async ({ system, user }) => {
                const response = await clients.openrouter({ model: CONFIG.judgeModel, max_tokens: 120, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
                const text = response.choices?.[0]?.message?.content;
                if (typeof text !== 'string' || !/VERDICT:\s*(correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain)\b/i.test(text) || !/REASON:\s*\S/i.test(text)) throw new Error('Judge returned no usable verdict; do not score a parse failure as uncertainty');
                return { text, usage: { in: response.usage.prompt_tokens, out: response.usage.completion_tokens } };
              } }, sample.question, sample.answer, answer, { unanswerable: sample.question_id.endsWith('_abs') });
              const row = { questionId: sample.question_id, questionType: sample.question_type, arm, unanswerable: sample.question_id.endsWith('_abs'), answer, verdict: judge.verdict, reason: judge.reason, recalls, sessionsAttempted: progress.through, observerFailures: progress.observerFailures, at: realNow(), answerAttempt: captured?.attempt ?? attempt?.attempt ?? null };
              appendFileSync(resultsPath, JSON.stringify(row) + '\n');
              results.push(row);
              console.log(JSON.stringify({ questionId: row.questionId, arm, verdict: row.verdict, recalls: recalls.length, chargedUsd: ledger.chargedUsd() }));
              writeFileSync(join(directory, 'report.md'), renderReport(manifest, results, ledger.rows(manifest.runId), cap, ledger.chargedUsd(), undefined, { attempts: attemptStats(directory) }));
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
    // Best-effort: a failure record that cannot be written must not replace the abort itself.
    try { recordFailure(directory, { stage, ...where, error }); } catch { abort += '; the failure record could not be written'; }
  } finally {
    monitor.stop();
    try { diagnostics.flush(); } catch { abort = `${abort ?? 'run-error'}; buffered diagnostics could not be written`; }
    writeFileSync(join(directory, 'report.md'), renderReport(manifest, results, ledger.rows(manifest.runId), cap, ledger.chargedUsd(), abort, { attempts: attemptStats(directory) }));
  }
  return !abort && ARMS.every(arm => aggregate(results.filter(r => r.arm === arm), pinned.questionIds).complete) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Benchmark setup failed; no credential values are printed. Check required env files, Vertex ADC/project, built packages and pinned inputs.'); process.exitCode = 1; });
}
