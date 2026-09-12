#!/usr/bin/env tsx
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { createConfigF } from './configs/f-fair-rerank.js';
import {
  makeLocalCrossEncoderRerankClient,
  DEFAULT_RERANK_MODEL,
  type ClosableRerankClient,
} from './rerank-local.js';
import {
  DEFAULT_BENCH_ORCHESTRATOR_MODEL,
  MINIMAL_REASONING,
  makeAnthropicOrchestratorClient,
  makeOpenRouterOrchestratorClient,
} from './orchestrator.js';
import { runAgent, makeAnthropicAgentClient, type AgentClient } from './agent.js';
import { judgeAnswer, makeOpenRouterJudgeClient, type JudgeClient } from './judge.js';
import { renderReport } from './report.js';
import { renderFairRerankReport } from './fair-reranker-report.js';
import { runE2EMode } from './e2e-cli.js';
import { parseCsvFlag } from './e2e-select.js';
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

/**
 * Exported so a test can assert every selectable orchestrator arm has a row:
 * `CostMeter.record` THROWS on an unknown key, deep inside a paid run.
 */
export const PRICING: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'claude-haiku-4-5-20251001': { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
  // Base glm-5.3-flash rates from a live GET /api/v1/models. `:nitro` re-sorts
  // the provider pool by throughput and can route to a pricier one, so treat
  // this row as a floor on real spend rather than an exact figure. The KEY
  // must keep the `:nitro` spelling: CostMeter.record looks up by exact key
  // and that is the string the run records.
  'z-ai/glm-5.3-flash:nitro': { in: 0.15 / 1_000_000, out: 0.5 / 1_000_000 },
  'zembed-1': { in: 0.05 / 1_000_000, out: 0 },
  'zerank-2': { in: 0.1 / 1_000_000, out: 0 },
};

export interface CliArgs {
  mode: 'bench' | 'e2e';
  corpus: 'longmemeval-s' | 'locomo' | 'internal' | 'all';
  config: ConfigName | 'all';
  sample?: number;
  smoke: boolean;
  liveSmoke: boolean;
  regenInternal: boolean;
  rewriteMap: boolean;
  topK: number;
  /**
   * Which model runs the retrieval orchestrator. `glm` was `grok` until
   * 2026-09-11, when its model id turned out to have been 404ing for
   * months; the flag was renamed with it rather than left pointing at a
   * vendor it no longer selects.
   */
  orchestratorModel: 'haiku' | 'glm';
  /** e2e mode: opt in to the full n=500 run (default is the n=100 sample). */
  full: boolean;
  /** e2e mode: cost cap in dollars (default 25). */
  cap?: number;
  /** e2e mode: resume JSONL run id (defaults to a date-stamped id). */
  resume?: string;
  /** e2e mode: produce a representative report from the fixture (no keys, no spend). */
  fixture: boolean;
  /** e2e mode: only run questions of these `question_type`s (opt-in; unioned with --ids). */
  types?: string[];
  /** e2e mode: only run these `question_id`s (opt-in; unioned with --types). */
  ids?: string[];
  /**
   * Report output path, overriding the date-stamped default.
   *
   * The default path is derived from the run DATE alone, so two arms of the
   * same day overwrite each other — which makes arms that differ only by
   * `--orchestrator-model` impossible to run concurrently, and silently
   * destroys the first arm's report when run back to back. Absolute paths are
   * used as-is; relative ones resolve against the workspace root, like the
   * default.
   */
  out?: string;
}

/** Arms `--orchestrator-model` accepts. See {@link CliArgs.orchestratorModel}. */
const ORCHESTRATOR_ARMS = ['haiku', 'glm'] as const;

/**
 * REJECTS an unknown arm rather than defaulting to one.
 *
 * `--mode` next door defaults on a bad value, and that is fine — it picks
 * between two things you can see in the output. This flag picks which model
 * spends the money, and a wrong pick is only visible if you go looking at the
 * cost table afterwards. Quietly remapping `--orchestrator-model grok` (the arm
 * retired when its model id turned out to be 404ing) onto haiku would produce a
 * full paid run measuring a model nobody asked for, and report success — which
 * is the exact silent-degradation this card exists to remove.
 */
function parseOrchestratorModel(raw: unknown): CliArgs['orchestratorModel'] {
  if (raw === undefined) return 'haiku';
  if ((ORCHESTRATOR_ARMS as readonly string[]).includes(raw as string)) {
    return raw as CliArgs['orchestratorModel'];
  }
  const retired =
    raw === 'grok'
      ? " The `grok` arm was retired on 2026-09-11: its model id (x-ai/grok-4.1-fast) is deprecated and 404s on every call."
      : '';
  throw new Error(
    `--orchestrator-model: unknown arm ${JSON.stringify(raw)}. Expected one of ${ORCHESTRATOR_ARMS.join(', ')}.${retired}`,
  );
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string', default: 'bench' },
      corpus: { type: 'string', default: 'all' },
      config: { type: 'string', default: 'all' },
      sample: { type: 'string' },
      smoke: { type: 'boolean', default: false },
      'live-smoke': { type: 'boolean', default: false },
      'regen-internal': { type: 'boolean', default: false },
      'rewrite-map': { type: 'boolean', default: false },
      'top-k': { type: 'string', default: '10' },
      'orchestrator-model': { type: 'string', default: 'haiku' },
      full: { type: 'boolean', default: false },
      cap: { type: 'string' },
      resume: { type: 'string' },
      fixture: { type: 'boolean', default: false },
      types: { type: 'string' },
      ids: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const base: CliArgs = {
    mode: values.mode === 'e2e' ? 'e2e' : 'bench',
    corpus: values.corpus as CliArgs['corpus'],
    config: values.config as CliArgs['config'],
    smoke: values.smoke === true,
    liveSmoke: values['live-smoke'] === true,
    regenInternal: values['regen-internal'] === true,
    rewriteMap: values['rewrite-map'] === true,
    topK: Number(values['top-k']),
    orchestratorModel: parseOrchestratorModel(values['orchestrator-model']),
    full: values.full === true,
    fixture: values.fixture === true,
  };
  if (values.sample) base.sample = Number(values.sample);
  if (values.cap) base.cap = Number(values.cap);
  if (values.resume) base.resume = values.resume;
  if (values.out) base.out = values.out;
  const types = parseCsvFlag(values.types as string | undefined);
  if (types !== undefined) base.types = types;
  const ids = parseCsvFlag(values.ids as string | undefined);
  if (ids !== undefined) base.ids = ids;
  return base;
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.mode === 'e2e') {
    // E2E mode (TASK-189): run LongMemEval-S through the REAL shipped plugin.
    // Needs only ANTHROPIC (answer + extraction) + OPENROUTER (judge) — no
    // zeroentropy. The default is the n=100 sample; --full opts into n=500.
    return runE2EMode({
      repoRoot: REPO_ROOT,
      sample: args.sample ?? (args.full ? 500 : 100),
      cap: args.cap ?? 25,
      fixture: args.fixture,
      ...(args.resume !== undefined ? { resumeId: args.resume } : {}),
      ...(args.types !== undefined ? { types: args.types } : {}),
      ...(args.ids !== undefined ? { ids: args.ids } : {}),
    });
  }

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
    const rewriteClient = makeOpenRouterOrchestratorClient(
      env3.OPENROUTER_API_KEY,
      DEFAULT_BENCH_ORCHESTRATOR_MODEL,
      undefined,
      MINIMAL_REASONING,
    );
    const cachePath = mapRewriteCachePath(corpusForRewrite.name);
    console.log(
      `Rewriting map summaries for ${corpusForRewrite.name} (${corpusForRewrite.memoryTree.size} docs) -> ${cachePath}`,
    );
    let lastLogged = 0;
    const result = await rewriteMapSummaries({
      corpus: corpusForRewrite,
      rewriteClient,
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
  const orchestratorModelKey = args.orchestratorModel === 'glm'
    ? DEFAULT_BENCH_ORCHESTRATOR_MODEL
    : 'claude-haiku-4-5-20251001';
  // MINIMAL_REASONING is what production sends (TASK-348). GLM reasons by
  // default, and this arm is measuring retrieval accuracy, not the model's
  // appetite for thinking — an arm without the flag measures a configuration
  // no deployment runs.
  const orchestratorClient = args.orchestratorModel === 'glm'
    ? makeOpenRouterOrchestratorClient(
        env.OPENROUTER_API_KEY,
        DEFAULT_BENCH_ORCHESTRATOR_MODEL,
        undefined,
        MINIMAL_REASONING,
      )
    : makeAnthropicOrchestratorClient(env.ANTHROPIC_API_KEY);

  const agentClient: AgentClient = makeAnthropicAgentClient(env.ANTHROPIC_API_KEY);
  const judgeClient: JudgeClient = makeOpenRouterJudgeClient(env.OPENROUTER_API_KEY);
  const rerankClient = makeZeroEntropyRerankClient(env.ZEROENTROPY_API_KEY);
  const embedClient = makeZeroEntropyEmbedClient(env.ZEROENTROPY_API_KEY);

  // Config F (the FAIR reranker, TASK-192) uses a LOCAL cross-encoder via a Python
  // subprocess. It is opt-in via AX_BENCH_RERANK_PYTHON (path to a venv python with
  // sentence-transformers installed); AX_BENCH_RERANK_MODEL overrides the model id.
  // When unset, config F is skipped with a clear build failure (the run loop catches
  // build failures per-config), so `--config all` without the local model still runs A–E.
  const rerankPythonBin = process.env.AX_BENCH_RERANK_PYTHON;
  const localRerankModel = process.env.AX_BENCH_RERANK_MODEL ?? DEFAULT_RERANK_MODEL;
  const localRerankClients: ClosableRerankClient[] = [];

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
  if (wantCfg('f-fair-rerank')) {
    driverFactories.push(() => {
      if (!rerankPythonBin) {
        // No local cross-encoder configured → return a driver whose build() throws a
        // clear, actionable message. The run loop catches it and skips config F,
        // recording the reason in the report's "Config build failures" section.
        return {
          name: 'f-fair-rerank' as const,
          async build() {
            throw new Error(
              'Config F (fair reranker) requires a local cross-encoder. Set ' +
                'AX_BENCH_RERANK_PYTHON to a venv python with sentence-transformers ' +
                '(see docs/plans/2026-06-29-memory-strata-fair-reranker-report.md).',
            );
          },
          async teardown() {},
          async retrieve() {
            throw new Error('Config F: build() failed (no AX_BENCH_RERANK_PYTHON).');
          },
        };
      }
      const localClient = makeLocalCrossEncoderRerankClient({
        pythonBin: rerankPythonBin,
        model: localRerankModel,
      });
      localRerankClients.push(localClient);
      return createConfigF({ tempDir, rerankClient: localClient });
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
    orchestratorModel: orchestratorModelKey,
    spendByModel: meter.snapshot(),
  });
  const outPath = args.out
    ? resolve(REPO_ROOT, args.out)
    : join(REPO_ROOT, 'docs/plans', `${date.toISOString().slice(0, 10)}-memory-strata-vector-spike-report.md`);
  writeFileSync(outPath, md);
  console.log(`Report written to ${outPath}. Total spend: $${meter.totalDollars().toFixed(2)}.`);

  // TASK-192: when config F (fair reranker) ran, also emit the standalone fair-reranker
  // head-to-head report (A vs E vs F: accuracy + recall@5 + abstention + latency + the
  // isolated cross-encoder per-query latency + the >=5pp verdict).
  const ranFairReranker = results.some((r) => r.config === 'f-fair-rerank');
  if (ranFairReranker) {
    const fairMd = renderFairRerankReport({
      results,
      verdictMode: 'measured',
      runDate: date,
      answerModel: 'claude-sonnet-4-6',
      judgeModel: 'x-ai/grok-4.3',
      rerankModel: localRerankModel,
      command: 'AX_BENCH_RERANK_PYTHON=<venv>/bin/python pnpm --filter @ax/memory-strata bench --corpus longmemeval-s --config all',
      bm25CandidateCount: 50,
      abortError: abortError ? ((abortError as Error)?.message ?? String(abortError)) : null,
    });
    const fairOut = join(REPO_ROOT, 'docs/plans', `${date.toISOString().slice(0, 10)}-memory-strata-fair-reranker-report.md`);
    writeFileSync(fairOut, fairMd);
    console.log(`Fair-reranker report written to ${fairOut}.`);
  }

  // Close any local cross-encoder subprocesses spawned for config F.
  for (const c of localRerankClients) {
    try {
      await c.close();
    } catch {
      /* best-effort */
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
  return capExceeded || abortError ? 1 : 0;
}

// Only run main() when invoked as the entry script (`tsx cli.ts …`), not when
// imported by a test that wants to exercise parseCliArgs in isolation.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
