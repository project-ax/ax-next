#!/usr/bin/env tsx
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
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
import { makeAnthropicOrchestratorClient, makeOpenRouterOrchestratorClient } from './orchestrator.js';
import { runAgent, makeAnthropicAgentClient, type AgentClient } from './agent.js';
import { judgeAnswer, makeOpenRouterJudgeClient, type JudgeClient } from './judge.js';
import { renderReport } from './report.js';
import {
  rewriteMapSummaries,
  loadMapRewriteCache,
  cacheToOverrideMap,
} from './map-rewrite.js';
import type { BenchCorpus, ConfigName, ConfigDriver, QuestionResult } from './types.js';

const BENCH_CACHE_ROOT = join(homedir(), '.cache', 'ax-memory-bench');

function mapRewriteCachePath(corpusName: BenchCorpus['name']): string {
  return join(BENCH_CACHE_ROOT, corpusName, 'map-rewrites.json');
}

const PRICING: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'claude-haiku-4-5-20251001': { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
  'x-ai/grok-4.1-fast': { in: 0.2 / 1_000_000, out: 0.5 / 1_000_000 },
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
  rewriteMap: boolean;
  topK: number;
  orchestratorModel: 'haiku' | 'grok';
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
      'rewrite-map': { type: 'boolean', default: false },
      'top-k': { type: 'string', default: '10' },
      'orchestrator-model': { type: 'string', default: 'haiku' },
    },
  });
  const base = {
    corpus: values.corpus as CliArgs['corpus'],
    config: values.config as CliArgs['config'],
    smoke: values.smoke === true,
    liveSmoke: values['live-smoke'] === true,
    regenInternal: values['regen-internal'] === true,
    rewriteMap: values['rewrite-map'] === true,
    topK: Number(values['top-k']),
    orchestratorModel: (values['orchestrator-model'] === 'grok' ? 'grok' : 'haiku') as 'haiku' | 'grok',
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

  if (args.rewriteMap) {
    const env3 = requireKeys({ OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY });
    if (args.corpus === 'all') {
      console.error('--rewrite-map requires a specific --corpus (e.g. longmemeval-s).');
      return 2;
    }
    const cache3 = new BenchCache();
    let corpusForRewrite: BenchCorpus;
    if (args.corpus === 'longmemeval-s') corpusForRewrite = await loadLongMemEvalS(cache3);
    else if (args.corpus === 'locomo') corpusForRewrite = await loadLoCoMo(cache3);
    else if (args.corpus === 'internal') corpusForRewrite = loadInternalCorpus();
    else {
      console.error(`Unknown corpus: ${args.corpus as string}`);
      return 2;
    }
    const grokClient = makeOpenRouterOrchestratorClient(env3.OPENROUTER_API_KEY);
    const cachePath = mapRewriteCachePath(corpusForRewrite.name);
    console.log(
      `Rewriting map summaries for ${corpusForRewrite.name} (${corpusForRewrite.memoryTree.size} docs) -> ${cachePath}`,
    );
    let lastLogged = 0;
    const result = await rewriteMapSummaries({
      corpus: corpusForRewrite,
      grokClient,
      cachePath,
      concurrency: 10,
      onProgress: (done, total) => {
        if (done - lastLogged >= 100 || done === total) {
          lastLogged = done;
          console.log(`  rewrite progress: ${done}/${total}`);
        }
      },
    });
    console.log(`Done. ${result.size} summaries in cache at ${cachePath}.`);
    return 0;
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
  const orchestratorModelKey = args.orchestratorModel === 'grok'
    ? 'x-ai/grok-4.1-fast'
    : 'claude-haiku-4-5-20251001';
  const orchestratorClient = args.orchestratorModel === 'grok'
    ? makeOpenRouterOrchestratorClient(env.OPENROUTER_API_KEY)
    : makeAnthropicOrchestratorClient(env.ANTHROPIC_API_KEY);

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

  // Per-corpus map-summary rewrite cache: if a `--rewrite-map` pass has been
  // run for this corpus, load it and feed it into configs D + E so the
  // orchestrator sees the denser one-liners. Falls back to `doc.summary` when
  // absent. Opt-in: A's behavior is unchanged in either case.
  const rewriteOverridesByCorpus = new Map<BenchCorpus['name'], ReadonlyMap<string, string>>();
  for (const c of corpora) {
    const p = mapRewriteCachePath(c.name);
    if (existsSync(p)) {
      const cache = loadMapRewriteCache(p);
      const overrides = cacheToOverrideMap(cache);
      if (overrides.size > 0) {
        rewriteOverridesByCorpus.set(c.name, overrides);
        console.log(`Loaded ${overrides.size} map-rewrite overrides for ${c.name} from ${p}.`);
      }
    }
  }

  const wantCfg = (n: ConfigName) => args.config === 'all' || args.config === n;
  type DriverFactory = (corpus: BenchCorpus) => ConfigDriver;
  const driverFactories: DriverFactory[] = [];
  if (wantCfg('a-bm25')) driverFactories.push(() => createConfigA({ tempDir }));
  if (wantCfg('b-rerank')) driverFactories.push(() => createConfigB({ tempDir, rerankClient }));
  if (wantCfg('c-rrf')) driverFactories.push(() => createConfigC({ tempDir, embedClient }));
  if (wantCfg('d-map')) {
    driverFactories.push((corpus) => {
      const overrides = rewriteOverridesByCorpus.get(corpus.name);
      return createConfigD({
        tempDir,
        orchestratorClient,
        mapCacheDir,
        ...(overrides ? { mapSummaryOverrides: overrides } : {}),
      });
    });
  }
  if (wantCfg('e-map-fts')) {
    driverFactories.push((corpus) => {
      const overrides = rewriteOverridesByCorpus.get(corpus.name);
      return createConfigE({
        tempDir,
        orchestratorClient,
        mapCacheDir,
        ...(overrides ? { mapSummaryOverrides: overrides } : {}),
      });
    });
  }

  const results: QuestionResult[] = [];
  const skipped: Array<{ corpus: string; config: string; questionId: string; reason: string }> = [];
  const configFailures: Array<{ corpus: string; config: string; phase: 'build' | 'unknown'; reason: string }> = [];
  let capExceeded = false;
  let abortError: unknown = null;

  try {
    outer: for (const corpus of corpora) {
      for (const factory of driverFactories) {
        const driver = factory(corpus);
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
              if (retrieval.orchestratorTokens) meter.record(orchestratorModelKey, retrieval.orchestratorTokens);
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
