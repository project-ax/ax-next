/**
 * Fact links, answer-level arm: does annotating `memory_recall`'s evidence table with Jev
 * fact links ("later updated", "same event as") change answers on the rung-4 questions?
 *
 * Paired, per question: the SAME rung-4 bank (copied, so nothing mutates the capture), the
 * same injected memory, the same recall tool and the same answer model — once with the
 * tool result as the product renders it (`off`), once with link notes added (`on`). The
 * links come from `dem-memory/bench/fact-links-eval.ts --write-links` (Jev, threshold 0.8,
 * measured 28/28 on a labelled sample). Nothing under `packages/` changes: the treatment
 * is applied to the tool result inside this harness.
 *
 *   pnpm exec tsx scripts/memory-fact-links-e2e.mjs --run-dir <dir> --source /tmp/task497-live \
 *     --links dem-memory/bench/fact-links.json --shard 0/4 --cap 5 --credentials-file .env.walk
 *   pnpm exec tsx scripts/memory-fact-links-e2e.mjs --run-dir <dir> --report
 *
 * Runs are resumable per (question, model, condition). Shards are separate processes because
 * `withCorpusClock` patches the global `Date` — two questions must never share a process's
 * clock at once. Ingestion is not re-run: the banks already hold the rung-4 facts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { judgeAnswer } from './memory-bench/judge.ts';
import { parseCorpusDate } from './memory-bench/corpus-date.ts';
import { CONFIG, BudgetExceeded, Ledger, buildSystem, makeClients, readJsonl } from './memory-product-e2e-lib.mjs';
import { createBank, makeMeteredProviderFetch, makeRecall, pinnedSamples, withCorpusClock } from './memory-product-e2e.mjs';
import { annotateEvidence, isCorrect, mcnemarExact, pairOutcomes } from './memory-fact-links-lib.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

/**
 * The two answer models. GLM keeps rung-4's exact answer configuration; DeepSeek runs at
 * MINIMAL reasoning (max effort averaged ~2,800 reasoning tokens an answer — too slow for a
 * chat turn; its partial run is archived beside the results), pinned to its first-party
 * provider so every call is the same weights and price. Minimal still spends ~170 reasoning
 * tokens, which count against `max_tokens`, hence 2,048 rather than GLM's 512.
 */
export const MODELS = Object.freeze({
  glm: { id: CONFIG.answerModels.glm, effort: 'minimal', maxTokens: CONFIG.answerMaxTokens },
  deepseek: {
    id: 'deepseek/deepseek-v4.1-flash', effort: 'minimal', maxTokens: 2048,
    provider: { order: ['DeepSeek'], allow_fallbacks: false },
    // First-party list price, USD per million tokens; for reservations only.
    price: { input: 0.15, output: 0.6 },
  },
});
const CONDITIONS = ['off', 'on'];

function openRouterClient({ env, ledger, tags }) {
  async function once(body, upper) {
    if (ledger.exhausted) throw new BudgetExceeded();
    const id = ledger.reserve(upper, { ...tags(), provider: 'openrouter' });
    let settled = false;
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Object.assign(new Error(`openrouter ${response.status}`), { status: response.status });
      const json = await response.json();
      const cost = json.usage?.cost;
      ledger.settle(id, typeof cost === 'number' && cost >= 0 ? cost : upper, typeof cost === 'number' ? 'provider-reported' : 'missing-cost-upper-bound', { model: body.model, provider: json.provider });
      settled = true;
      return json;
    } finally {
      if (!settled && !ledger.settlements.has(id)) ledger.settle(id, upper, 'uncertain-upper-bound');
    }
  }
  return async function request(body, upper) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await once(body, upper); }
      catch (error) {
        if (attempt >= 4 || ![429, 500, 502, 503, 504, undefined].includes(error.status) || error instanceof BudgetExceeded) throw error;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  };
}

/** The rung-4 OpenRouter answer loop, parameterised by model: six tool rounds, then a final no-tools round. */
async function answerWith({ request, model, system, question, descriptor, recall }) {
  const config = MODELS[model];
  const messages = [{ role: 'user', content: question }];
  const tool = { type: 'function', function: { name: descriptor.name, description: descriptor.description, parameters: descriptor.inputSchema } };
  let reasoningTokens = 0;
  for (let turn = 0; turn <= CONFIG.maxToolTurns; turn += 1) {
    const toolsAllowed = turn < CONFIG.maxToolTurns;
    const body = {
      model: config.id, max_tokens: config.maxTokens, reasoning: { effort: config.effort },
      provider: { ...(config.provider ?? {}), max_price: CONFIG.openRouterMaxPrice },
      messages: [{ role: 'system', content: system }, ...messages],
      ...(toolsAllowed ? { tools: [tool] } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    const upper = config.price
      ? (bytes * config.price.input + config.maxTokens * config.price.output) / 1e6
      : (bytes * 10 + config.maxTokens * 20) / 1e6;
    const response = await request(body, upper);
    reasoningTokens += response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const message = response.choices?.[0]?.message;
    if (!message || typeof message !== 'object') throw new Error('Invalid OpenRouter message');
    const uses = message.tool_calls ?? [];
    const text = typeof message.content === 'string' ? message.content : '';
    if (!toolsAllowed || !uses.length) return { answer: text, reasoningTokens };
    // Reasoning text is not echoed back: the next round sees the tool calls and results only.
    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: uses });
    for (const use of uses) {
      let content = 'Unknown tool';
      if (use.function?.name === descriptor.name) {
        let input;
        try { input = JSON.parse(use.function.arguments); } catch { input = undefined; }
        content = input === undefined ? 'Invalid tool arguments' : (await recall(input)).text;
      }
      messages.push({ role: 'tool', tool_call_id: use.id, content });
    }
  }
  return { answer: '', reasoningTokens };
}

function bankSource(source, questionId) {
  const bankDir = join(source, `bank-${hash(questionId).slice(0, 24)}`);
  const generations = readdirSync(bankDir).filter((name) => statSync(join(bankDir, name)).isDirectory());
  if (generations.length !== 1) throw new Error(`expected one generation under ${bankDir}`);
  return join(bankDir, generations[0]);
}

/**
 * One re-embedded copy of a rung-4 bank per question, made once and then copied per arm.
 *
 * The rung-4 banks hold Vertex `text-embedding-005` vectors; the product now embeds through
 * OpenRouter (TASK-523), and `memory-facts-sqlite` DELETES vectors whose recipe differs the
 * moment the store opens. Without this step the dense channel would be silently empty in
 * every arm. `memory:facts:reindex` with no slots is a status read plus an awaited vector
 * backfill of up to 200 rows, so it is called until nothing is missing.
 */
async function prepareBank({ sample, source, prepared, env, clients, providerFetch, ledger, storage }) {
  if (existsSync(join(prepared, 'READY'))) return;
  cpSync(bankSource(source, sample.question_id), prepared, { recursive: true });
  const bank = await createBank({ sample, directory: prepared, env, clients, providerFetch, ledger, storage });
  try {
    await storage.run({ questionId: sample.question_id, phase: 'reembed' }, async () => {
      for (let round = 0; round < 10; round += 1) {
        await bank.bus.call('memory:facts:reindex', bank.ctx(), {});
        await bank.drain();
      }
    });
  } finally { await bank.close(); }
  // vec0's row-id shadow table is a plain table, so the sqlite3 CLI can count it.
  const count = (sql) => Number(execFileSync('sqlite3', [join(prepared, 'facts.db'), sql], { encoding: 'utf8' }).trim());
  const facts = count('SELECT count(*) FROM memory_facts_v1');
  const vectors = count('SELECT count(*) FROM memory_facts_v1_vec_rowids');
  if (vectors < facts) throw new Error(`re-embed incomplete for ${sample.question_id}: ${vectors}/${facts}`);
  writeFileSync(join(prepared, 'READY'), `${vectors}/${facts}\n`);
}

function report(runDir) {
  const rows = readdirSync(runDir).filter((n) => /^results-\d+\.jsonl$/.test(n)).flatMap((n) => readJsonl(join(runDir, n)));
  const costs = readdirSync(runDir).filter((n) => /^costs-\d+\.jsonl$/.test(n)).flatMap((n) => readJsonl(join(runDir, n)));
  const spent = costs.filter((e) => e.type === 'settle').reduce((s, e) => s + e.usd, 0);
  const lines = [`rows ${rows.length}; spend $${spent.toFixed(4)}`, ''];
  for (const model of Object.keys(MODELS)) {
    lines.push(`## ${model} (${MODELS[model].id})`);
    for (const condition of CONDITIONS) {
      const r = rows.filter((x) => x.model === model && x.condition === condition);
      lines.push(`  ${condition}: ${r.filter((x) => isCorrect(x.verdict)).length}/${r.length} correct`);
    }
    const touched = new Set(rows.filter((x) => x.model === model && x.condition === 'on' && x.notes > 0).map((x) => x.questionId));
    for (const [label, keep] of [['all', () => true], ['touched (a note reached the model)', (id) => touched.has(id)], ['untouched', (id) => !touched.has(id)]]) {
      const p = pairOutcomes(rows.filter((x) => keep(x.questionId)), model);
      lines.push(`  paired, ${label}: n=${p.pairs}, both right ${p.bothRight}, both wrong ${p.bothWrong}, ` +
        `gained ${p.gained.length} [${p.gained.join(' ')}], lost ${p.lost.length} [${p.lost.join(' ')}], McNemar p=${mcnemarExact(p.gained.length, p.lost.length).toFixed(3)}`);
    }
    const types = [...new Set(rows.map((x) => x.questionType))].sort();
    for (const type of types) {
      const cell = (condition) => {
        const r = rows.filter((x) => x.model === model && x.condition === condition && x.questionType === type);
        return `${r.filter((x) => isCorrect(x.verdict)).length}/${r.length}`;
      };
      lines.push(`  ${type.padEnd(26)} off ${cell('off').padStart(6)}   on ${cell('on').padStart(6)}`);
    }
    lines.push('');
  }
  const text = lines.join('\n');
  writeFileSync(join(runDir, 'report.txt'), text + '\n');
  console.log(text);
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'run-dir': { type: 'string' }, source: { type: 'string' }, links: { type: 'string' },
    shard: { type: 'string', default: '0/1' }, cap: { type: 'string', default: '5' },
    'credentials-file': { type: 'string', multiple: true }, models: { type: 'string', default: 'glm,deepseek' },
    report: { type: 'boolean', default: false }, only: { type: 'string' },
  } });
  if (!values['run-dir']) throw new Error('--run-dir is required');
  const runDir = resolve(values['run-dir']);
  if (values.report) return report(runDir);
  if (!values.source || !values.links) throw new Error('--source and --links are required');
  const [shardIndex, shardCount] = values.shard.split('/').map(Number);
  const models = values.models.split(',');
  for (const m of models) if (!MODELS[m]) throw new Error(`unknown model ${m}`);

  const env = {};
  for (const file of values['credentials-file'] ?? []) Object.assign(env, parseEnv(readFileSync(resolve(file), 'utf8')));
  if (process.env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');

  mkdirSync(runDir, { recursive: true });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifestPath = join(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify({ revision, models: MODELS, judge: CONFIG.judgeModel, links: values.links, source: values.source }, null, 2));

  const { samples } = await pinnedSamples();
  const linkFile = JSON.parse(readFileSync(resolve(values.links), 'utf8'));
  const linksFor = (qid) => linkFile.links.filter((l) => l.qid === qid);
  const only = values.only ? new Set(values.only.split(',')) : null;
  const mine = samples.filter((_, i) => i % shardCount === shardIndex).filter((s) => !only || only.has(s.question_id));

  const ledger = new Ledger(join(runDir, `costs-${shardIndex}.jsonl`), Number(values.cap));
  const storage = new AsyncLocalStorage();
  const tags = () => { const s = storage.getStore(); return { questionId: s?.questionId ?? 'setup', phase: s?.phase ?? 'setup' }; };
  const clients = makeClients({ env, ledger, tags });
  const providerFetch = makeMeteredProviderFetch(ledger, tags);
  const request = openRouterClient({ env, ledger, tags });
  const resultsPath = join(runDir, `results-${shardIndex}.jsonl`);
  const done = new Set(readJsonl(resultsPath).map((r) => `${r.questionId}|${r.model}|${r.condition}`));

  for (const sample of mine) {
    const questionInstant = parseCorpusDate(sample.question_date).toISOString();
    const links = linksFor(sample.question_id);
    for (const model of models) for (const condition of CONDITIONS) {
      const key = `${sample.question_id}|${model}|${condition}`;
      if (done.has(key)) continue;
      const prepared = join(runDir, 'banks', `${hash(sample.question_id).slice(0, 12)}-prepared`);
      await prepareBank({ sample, source: values.source, prepared, env, clients, providerFetch, ledger, storage });
      const directory = join(runDir, 'banks', `${hash(sample.question_id).slice(0, 12)}-${model}-${condition}`);
      if (!existsSync(join(directory, 'facts.db'))) cpSync(prepared, directory, { recursive: true });
      const bank = await createBank({ sample, directory, env, clients, providerFetch, ledger, storage });
      try {
        await storage.run({ questionId: sample.question_id, phase: `${model}-${condition}` }, () => withCorpusClock(questionInstant, async () => {
          const memory = await bank.injected();
          const recalls = [];
          const base = makeRecall({ bank, storage, recalls, ledger });
          let notes = 0;
          const recall = async (input) => {
            const result = await base(input);
            if (condition !== 'on' || !result.ok) return result;
            const annotated = annotateEvidence(result.text, links);
            notes += annotated.notes;
            recalls[recalls.length - 1].notes = annotated.notes;
            return { ok: true, text: annotated.text };
          };
          const { answer, reasoningTokens } = await answerWith({ request, model, system: buildSystem(memory, sample.question_date), question: sample.question, descriptor: bank.descriptor, recall });
          await bank.drain();
          const judge = await judgeAnswer({ complete: async ({ system, user }) => {
            const response = await clients.openrouter({ model: CONFIG.judgeModel, max_tokens: 120, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
            const text = response.choices?.[0]?.message?.content;
            if (typeof text !== 'string' || !/VERDICT:\s*\S/i.test(text)) throw new Error('Judge returned no usable verdict');
            return { text, usage: { in: response.usage.prompt_tokens, out: response.usage.completion_tokens } };
          } }, sample.question, sample.answer, answer, { unanswerable: sample.question_id.endsWith('_abs') });
          const row = { questionId: sample.question_id, questionType: sample.question_type, model, condition, verdict: judge.verdict, reason: judge.reason,
            answer, notes, linksInBank: links.length, recalls: recalls.map(({ ok, ms, notes: n }) => ({ ok, ms, notes: n ?? 0 })), reasoningTokens };
          appendFileSync(resultsPath, JSON.stringify(row) + '\n');
          console.log(JSON.stringify({ q: row.questionId, model, condition, verdict: row.verdict, notes, spent: ledger.chargedUsd().toFixed(4) }));
        }));
      } finally { await bank.close(); }
    }
  }
  return 0;
}

main().then((code) => { process.exitCode = code ?? 0; }).catch((error) => {
  console.error(error instanceof BudgetExceeded ? 'Budget exhausted for this shard' : (error?.stack ?? String(error)));
  process.exitCode = 1;
});
