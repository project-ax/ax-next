/**
 * Build one facts-memory bank per LongMemEval-S question — all 500 — through the product's
 * own memory slice: each haystack session is played into `chat:end` at its corpus date, so
 * the preset's observer extracts, normalizes and stores exactly as rung 4 did
 * (`memory-product-e2e.mjs`), minus the answering.
 *
 *   pnpm exec tsx scripts/memory-bench-build-banks.mjs --out ~/ax-bench-data/dem-lme500 \
 *     --shard 0/12 --cap 5 --credentials-file .env.walk
 *
 * Layout matches rung 4's run directory, so `memory-fact-links-e2e.mjs --source` and
 * `dem-memory/bench/fact-links-eval.ts --banks` read it unchanged:
 *   <out>/bank-<sha256(questionId)[:24]>/<generation>/facts.db …
 *   <out>/bank-…/progress.json   (resume point: sessions ingested so far)
 *   <out>/bank-…/question.json   (id and type — written when the bank is complete)
 *
 * Resumable per session; shards are separate processes because `withCorpusClock` patches
 * the global `Date`. Each shard has its own cost ledger and cap.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { BenchCache } from './memory-bench/cache.ts';
import { loadLongMemEvalSSamples } from './memory-bench/longmemeval-s.ts';
import { parseCorpusDate } from './memory-bench/corpus-date.ts';
import { Ledger, makeClients } from './memory-product-e2e-lib.mjs';
import { createBank, makeMeteredProviderFetch, withCorpusClock } from './memory-product-e2e.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined);

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    out: { type: 'string' }, shard: { type: 'string', default: '0/1' }, cap: { type: 'string', default: '5' },
    'credentials-file': { type: 'string', multiple: true }, only: { type: 'string' },
  } });
  if (!values.out) throw new Error('--out is required');
  const out = resolve(values.out.replace(/^~(?=\/)/, process.env.HOME));
  const [shardIndex, shardCount] = values.shard.split('/').map(Number);
  const env = {};
  for (const file of values['credentials-file'] ?? []) Object.assign(env, parseEnv(readFileSync(resolve(file), 'utf8')));
  if (process.env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');

  const pinned = JSON.parse(readFileSync(new URL('./memory-product-e2e-inputs.json', import.meta.url), 'utf8'));
  const cache = new BenchCache();
  const corpus = await loadLongMemEvalSSamples(cache);
  const raw = await cache.readIfHit('longmemeval-s', 'longmemeval_s_cleaned.json');
  if (!raw || hash(raw) !== pinned.corpusSha256) throw new Error('Corpus does not match the pinned corpus digest');
  const only = values.only ? new Set(values.only.split(',')) : null;
  const mine = corpus.filter((_, i) => i % shardCount === shardIndex).filter((s) => !only || only.has(s.question_id));

  mkdirSync(out, { recursive: true });
  const ledger = new Ledger(join(out, `costs-build-${shardIndex}.jsonl`), Number(values.cap));
  const storage = new AsyncLocalStorage();
  const tags = () => { const s = storage.getStore(); return { questionId: s?.questionId ?? 'setup', phase: s?.phase ?? 'ingest' }; };
  const clients = makeClients({ env, ledger, tags });
  const providerFetch = makeMeteredProviderFetch(ledger, tags);

  for (const sample of mine) {
    const bankRoot = join(out, `bank-${hash(sample.question_id).slice(0, 24)}`);
    if (existsSync(join(bankRoot, 'question.json'))) continue;
    mkdirSync(bankRoot, { recursive: true });
    const progressPath = join(bankRoot, 'progress.json');
    const progress = readJson(progressPath) ?? { through: 0, observerFailures: [], generation: randomUUID() };
    writeFileSync(progressPath, JSON.stringify(progress));
    const bank = await createBank({ sample, directory: join(bankRoot, progress.generation), env, clients, providerFetch, ledger, storage });
    const started = Date.now();
    try {
      await storage.run({ questionId: sample.question_id, phase: 'ingest' }, async () => {
        for (let i = progress.through; i < sample.haystack_sessions.length; i += 1) {
          const before = bank.failures.length;
          await withCorpusClock(parseCorpusDate(sample.haystack_dates[i]).toISOString(), () =>
            bank.observe(sample.haystack_session_ids[i], sample.haystack_sessions[i]));
          progress.observerFailures.push(...bank.failures.slice(before));
          progress.through = i + 1;
          writeFileSync(progressPath, JSON.stringify(progress));
        }
      });
    } finally { await bank.close(); }
    writeFileSync(join(bankRoot, 'question.json'), JSON.stringify({ questionId: sample.question_id, questionType: sample.question_type, sessions: sample.haystack_sessions.length, observerFailures: progress.observerFailures.length }));
    console.log(JSON.stringify({ q: sample.question_id, sessions: progress.through, failures: progress.observerFailures.length, secs: Math.round((Date.now() - started) / 1000), spent: ledger.chargedUsd().toFixed(4) }));
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
