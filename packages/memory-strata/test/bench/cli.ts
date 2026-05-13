#!/usr/bin/env tsx
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';

// pnpm runs scripts with cwd set to the package dir, but the regen globs
// and the report output path are relative to the workspace root. Derive
// it from this file's location: cli.ts is at packages/memory-strata/test/bench/cli.ts,
// so the workspace root is four levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
import { requireKeys } from './env.js';
import { CostMeter, type Pricing } from './meter.js';
import { BenchCache } from './cache.js';
import { loadLongMemEvalS } from './corpora/longmemeval-s.js';
import { loadLoCoMo } from './corpora/locomo.js';
import { loadInternalCorpus } from './corpora/internal.js';
import { createConfigA } from './configs/a-bm25.js';
import { createConfigB, makeZeroEntropyRerankClient } from './configs/b-rerank.js';
import { createConfigC, makeZeroEntropyEmbedClient } from './configs/c-rrf.js';
import { createConfigD } from './configs/d-map.js';
import { createConfigE } from './configs/e-map-fts.js';
import { makeAnthropicOrchestratorClient } from './orchestrator.js';
import { runAgent, makeAnthropicAgentClient, type AgentClient } from './agent.js';
import { judgeAnswer, makeOpenRouterJudgeClient, type JudgeClient } from './judge.js';
import { renderReport } from './report.js';
import type { BenchCorpus, ConfigName, ConfigDriver, QuestionResult } from './types.js';

const PRICING: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'claude-haiku-4-5-20251001': { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
  'zembed-1': { in: 0.05 / 1_000_000, out: 0 },
  'zerank-2': { in: 0.1 / 1_000_000, out: 0 },
};

interface CliArgs {
  corpus: 'longmemeval-s' | 'locomo' | 'internal' | 'all';
  config: ConfigName | 'all';
  sample?: number;
  smoke: boolean;
  liveSmoke: boolean;
  regenInternal: boolean;
  topK: number;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string', default: 'all' },
      config: { type: 'string', default: 'all' },
      sample: { type: 'string' },
      smoke: { type: 'boolean', default: false },
      'live-smoke': { type: 'boolean', default: false },
      'regen-internal': { type: 'boolean', default: false },
      'top-k': { type: 'string', default: '10' },
    },
  });
  const base = {
    corpus: values.corpus as CliArgs['corpus'],
    config: values.config as CliArgs['config'],
    smoke: values.smoke === true,
    liveSmoke: values['live-smoke'] === true,
    regenInternal: values['regen-internal'] === true,
    topK: Number(values['top-k']),
  };
  return values.sample
    ? { ...base, sample: Number(values.sample) }
    : base;
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.smoke) {
    console.log('Run "pnpm --filter @ax/memory-strata test -- test/bench/__tests__/smoke.test.ts" for the smoke suite.');
    return 0;
  }

  if (args.regenInternal) {
    const env2 = requireKeys({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });
    // regenerateInternalCorpus is added in Task 3A.16; lazy import so this CLI
    // still typechecks/runs before that task lands.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = await import('./corpora/internal.js') as any;
    if (typeof internal.regenerateInternalCorpus !== 'function') {
      console.error('--regen-internal is not available in this build (Task 3A.16 has not landed yet).');
      return 2;
    }
    const result = await internal.regenerateInternalCorpus({
      agentClient: makeAnthropicAgentClient(env2.ANTHROPIC_API_KEY),
      repoRoot: REPO_ROOT,
    }) as { docCount: number; questionCount: number; outputPath: string };
    console.log(`Regenerated internal corpus: ${result.docCount} docs, ${result.questionCount} questions -> ${result.outputPath}`);
    return 0;
  }

  if (args.liveSmoke) {
    if (process.env.BENCH_LIVE !== '1') {
      console.error('--live-smoke requires BENCH_LIVE=1 in the environment. Aborting.');
      return 2;
    }
  }

  const env = requireKeys({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ZEROENTROPY_API_KEY: process.env.ZEROENTROPY_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  });

  const cache = new BenchCache();
  const cap = args.liveSmoke ? 0.5 : 50;
  const meter = new CostMeter({ capDollars: cap, pricing: PRICING });
  const tempDir = mkdtempSync(join(tmpdir(), 'ax-bench-'));
  const mapCacheDir = join(tempDir, 'maps');
  const orchestratorClient = makeAnthropicOrchestratorClient(env.ANTHROPIC_API_KEY);

  const agentClient: AgentClient = makeAnthropicAgentClient(env.ANTHROPIC_API_KEY);
  const judgeClient: JudgeClient = makeOpenRouterJudgeClient(env.OPENROUTER_API_KEY);
  const rerankClient = makeZeroEntropyRerankClient(env.ZEROENTROPY_API_KEY);
  const embedClient = makeZeroEntropyEmbedClient(env.ZEROENTROPY_API_KEY);

  const corpora: BenchCorpus[] = [];
  const want = (name: BenchCorpus['name']) => args.corpus === 'all' || args.corpus === name;
  if (want('longmemeval-s')) corpora.push(await loadLongMemEvalS(cache));
  if (want('locomo')) corpora.push(await loadLoCoMo(cache));
  if (want('internal')) corpora.push(loadInternalCorpus());

  if (args.sample !== undefined) {
    for (const c of corpora) c.questions = c.questions.slice(0, args.sample);
  }

  const wantCfg = (n: ConfigName) => args.config === 'all' || args.config === n;
  const driverFactories: Array<() => ConfigDriver> = [];
  if (wantCfg('a-bm25')) driverFactories.push(() => createConfigA({ tempDir }));
  if (wantCfg('b-rerank')) driverFactories.push(() => createConfigB({ tempDir, rerankClient }));
  if (wantCfg('c-rrf')) driverFactories.push(() => createConfigC({ tempDir, embedClient }));
  if (wantCfg('d-map')) driverFactories.push(() => createConfigD({ tempDir, orchestratorClient, mapCacheDir }));
  if (wantCfg('e-map-fts')) driverFactories.push(() => createConfigE({ tempDir, orchestratorClient, mapCacheDir }));

  const results: QuestionResult[] = [];
  const skipped: Array<{ corpus: string; config: string; questionId: string; reason: string }> = [];
  const configFailures: Array<{ corpus: string; config: string; phase: 'build' | 'unknown'; reason: string }> = [];
  let capExceeded = false;
  let abortError: unknown = null;

  try {
    outer: for (const corpus of corpora) {
      for (const factory of driverFactories) {
        const driver = factory();
        let buildOk = false;
        try {
          try {
            await driver.build(corpus);
            buildOk = true;
          } catch (err) {
            const reason = (err as Error)?.message ?? String(err);
            configFailures.push({ corpus: corpus.name, config: driver.name, phase: 'build', reason });
            console.warn(`Build failed for ${corpus.name}/${driver.name}; skipping config. Reason: ${reason}`);
            continue;
          }
          for (const question of corpus.questions) {
            if (meter.projectWouldExceedCap('claude-sonnet-4-6', { in: 4000, out: 512 })) {
              capExceeded = true;
              break outer;
            }
            try {
              const before = meter.totalDollars();
              const retrieval = await driver.retrieve(question, args.topK, new AbortController().signal);
              if (retrieval.embeddingTokens > 0) meter.record('zembed-1', { in: retrieval.embeddingTokens, out: 0 });
              if (retrieval.rerankTokens > 0) meter.record('zerank-2', { in: retrieval.rerankTokens, out: 0 });
              if (retrieval.orchestratorTokens) meter.record('claude-haiku-4-5-20251001', retrieval.orchestratorTokens);
              const agentResp = await runAgent(agentClient, question, retrieval.retrievedDocs, corpus.memoryTree);
              meter.record('claude-sonnet-4-6', agentResp.usage);
              const verdict = await judgeAnswer(
                judgeClient,
                question.text,
                question.goldAnswer,
                agentResp.text,
                { unanswerable: question.metadata?.unanswerable === true },
              );
              meter.record('x-ai/grok-4.3', verdict.usage);
              results.push({
                corpus: corpus.name,
                config: driver.name,
                question,
                retrieval,
                agentAnswer: agentResp.text,
                verdict: verdict.verdict,
                judgeReason: verdict.reason,
                agentTokens: agentResp.usage,
                judgeTokens: verdict.usage,
                totalDollars: meter.totalDollars() - before,
              });
              if (results.length % 50 === 0) {
                console.log(`Progress: ${results.length} questions evaluated, $${meter.totalDollars().toFixed(2)} spent.`);
              }
            } catch (err) {
              const reason = (err as Error)?.message ?? String(err);
              skipped.push({ corpus: corpus.name, config: driver.name, questionId: question.id, reason });
              console.warn(`Skipped ${corpus.name}/${driver.name}/${question.id}: ${reason}`);
            }
          }
        } finally {
          if (buildOk) await driver.teardown();
        }
      }
    }
  } catch (err) {
    abortError = err;
    console.error(`Aborted after ${results.length} results; writing partial report. Reason: ${(err as Error)?.message ?? String(err)}`);
  }

  const date = new Date();
  const md = renderReport({
    results,
    cap,
    totalSpent: meter.totalDollars(),
    capExceeded,
    runDate: date,
    abortError: abortError ? ((abortError as Error)?.message ?? String(abortError)) : null,
    skipped,
    configFailures,
  });
  const outPath = join(REPO_ROOT, 'docs/plans', `${date.toISOString().slice(0, 10)}-memory-strata-vector-spike-report.md`);
  writeFileSync(outPath, md);
  console.log(`Report written to ${outPath}. Total spend: $${meter.totalDollars().toFixed(2)}.`);
  rmSync(tempDir, { recursive: true, force: true });
  return capExceeded || abortError ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
