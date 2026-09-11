#!/usr/bin/env tsx
// Latency probe for the Strata orchestrator call path.
//
// The Phase 3C n=500 runs measured the Grok 4.1 Fast orchestrator at
// p50 ~7s / p95 ~20s via OpenRouter — much slower than c137's reported ~1.6s.
// This script runs N=20 sequential orchestrator calls per configuration
// against a real LongMemEval-S map+question, times each call, and prints a
// p50/p95 comparison so we can locate where the latency is coming from.
//
// Run with:
//   pnpm --filter @ax/memory-strata bench:latency
//
// Requires ANTHROPIC_API_KEY + OPENROUTER_API_KEY in the env.
// XAI_API_KEY is optional; if absent, the grok-xai-direct config is skipped.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { requireKeys } from './env.js';
import { BenchCache } from './cache.js';
import { loadLongMemEvalS } from './corpora/longmemeval-s.js';
import { generateMap } from './map.js';
import {
  makeOpenRouterOrchestratorClient,
  makeXaiOrchestratorClient,
  runOrchestrator,
  type OrchestratorClient,
} from './orchestrator.js';

const N = 20;

interface ProbeConfig {
  name: string;
  client: OrchestratorClient;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function summarize(samples: number[]): {
  n: number;
  min: number;
  p50: number;
  mean: number;
  p95: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, v) => acc + v, 0);
  return {
    n: samples.length,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 0.5),
    mean: samples.length > 0 ? sum / samples.length : Number.NaN,
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fmt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toString() : '-';
}

async function probeConfig(
  config: ProbeConfig,
  map: string,
  query: string,
): Promise<number[]> {
  const samples: number[] = [];
  console.log(`\n[${config.name}] running ${N} calls (first is warmup)...`);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    try {
      await runOrchestrator(config.client, map, query);
    } catch (err) {
      const t1 = performance.now();
      const ms = t1 - t0;
      console.warn(`  [${config.name}] call ${i + 1}/${N} FAILED after ${Math.round(ms)}ms: ${(err as Error)?.message ?? String(err)}`);
      // Skip failed calls — we don't want to pollute the latency stats.
      continue;
    }
    const t1 = performance.now();
    const ms = t1 - t0;
    if (i === 0) {
      console.log(`  [${config.name}] warmup: ${Math.round(ms)}ms (excluded)`);
    } else {
      samples.push(ms);
      console.log(`  [${config.name}] call ${i + 1}/${N}: ${Math.round(ms)}ms`);
    }
  }
  return samples;
}

async function main(): Promise<number> {
  const env = requireKeys({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  });
  const xaiKey = process.env.XAI_API_KEY;

  const cache = new BenchCache();
  console.log('Loading LongMemEval-S corpus...');
  const corpus = await loadLongMemEvalS(cache);
  const question = corpus.questions[0];
  if (!question) {
    console.error('No questions in corpus.');
    return 1;
  }
  const haystackPaths = (question.metadata?.haystackPaths as string[] | undefined) ?? undefined;
  if (!haystackPaths || haystackPaths.length === 0) {
    console.error(`Question ${question.id} has no haystackPaths metadata; cannot build a subset map.`);
    return 1;
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'ax-strata-latency-'));
  const mapCacheDir = join(tempDir, 'maps');

  let exitCode = 0;
  try {
    console.log(`Generating map for question ${question.id} (${haystackPaths.length} docs in subset)...`);
    const map = await generateMap(corpus, { cacheDir: mapCacheDir, subsetPaths: haystackPaths });
    console.log(`Map: ${map.length} chars across ${haystackPaths.length} docs.`);
    console.log(`Query: ${question.text}`);

    // 2026-09-10 re-point. The three arms below used to measure
    // `x-ai/grok-4.1-fast`, which this probe's own 2026-05-14 run found was
    // already deprecated on OpenRouter (the force-xai arm FAILED for that
    // reason, so provider-forcing was never actually measured). Quoting that
    // run's 11s p50 as a standing fact about OpenRouter outlived its subject.
    //
    // The first arm is now the model production actually ships
    // (DEFAULT_ORCHESTRATOR_MODEL), through OpenRouter's DEFAULT routing,
    // which is what the orchestrator gets when routed through
    // `llm:call:openrouter`. The other two are reference points.
    // 2026-09-10 re-point. These arms used to measure `x-ai/grok-4.1-fast`,
    // which this probe's own 2026-05-14 run had ALREADY found deprecated on
    // OpenRouter (the force-xai arm FAILED for that reason, so provider-forcing
    // was never actually measured). Quoting that run's 11s p50 as a standing
    // fact about OpenRouter outlived its subject by four months.
    //
    // `x-ai/grok-4-fast` — the first replacement tried — turned out to be
    // deprecated too, 404 on every call. So the arms below are taken from a
    // live `GET /api/v1/models`, not from memory, and the point of the probe is
    // to pick the production default on evidence rather than on a name that
    // sounds current.
    // `:nitro` sorts the provider pool by throughput. `reasoning.enabled=false`
    // is OpenRouter's unified switch for models that think before answering —
    // worth trying here because the orchestrator emits a short op list under a
    // 5s budget, so any thinking is budget spent on tokens the parser throws
    // away. The client warns if `reasoning_tokens` comes back non-zero, so a
    // provider that ignores the flag is visible rather than assumed.
    // OpenRouter's unified reasoning control. Worth setting for this role: the
    // orchestrator emits a short op list under a 5s budget, so thinking is
    // budget spent on tokens the parser discards. NOT every model allows it —
    // gemini-3.8-flash and glm-5.3-flash both 400 on `enabled:false`
    // ("Reasoning is mandatory for this endpoint"); all three accept
    // `effort:'minimal'`. The client warns when `reasoning_tokens` comes back
    // non-zero, so a silently-ignored flag is visible.
    //
    // NOTE these flags are NOT reachable from production: `LlmCallInput` has
    // no reasoning field, so a model that needs one measures better here than
    // it can possibly behave when deployed. See the 2026-09-10 addendum in
    // docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md.
    const NO_REASONING = { reasoning: { enabled: false } };
    const MIN_REASONING = { reasoning: { effort: 'minimal' } };
    const orCandidates: Array<{
      label: string;
      model: string;
      body?: Record<string, unknown>;
    }> = [
      { label: 'haiku-4.5 (DEFAULT, deployable as-is)', model: 'anthropic/claude-haiku-4.5' },
      { label: 'glm-5.3-flash:nitro min-reason', model: 'z-ai/glm-5.3-flash:nitro', body: MIN_REASONING },
      { label: 'deepseek-v4.1-flash:nitro no-reason', model: 'deepseek/deepseek-v4.1-flash:nitro', body: NO_REASONING },
      { label: 'gemini-3.8-flash:nitro min-reason', model: 'google/gemini-3.8-flash:nitro', body: MIN_REASONING },
    ];
    const configs: ProbeConfig[] = orCandidates.map(({ label, model, body }) => ({
      name: `openrouter/${label}`,
      client: makeOpenRouterOrchestratorClient(
        env.OPENROUTER_API_KEY,
        model,
        undefined,
        body,
      ),
    }));

    if (xaiKey) {
      configs.push({
        name: 'grok-xai-direct',
        client: makeXaiOrchestratorClient(xaiKey),
      });
    } else {
      console.log('\nNote: XAI_API_KEY not set; skipping grok-xai-direct config.');
    }

    const results = new Map<string, number[]>();
    for (const config of configs) {
      const samples = await probeConfig(config, map, question.text);
      results.set(config.name, samples);
    }

    // Comparison table.
    console.log('\n' + '='.repeat(80));
    console.log('Summary (latencies in ms; warmup call excluded):');
    console.log('='.repeat(80));
    const header = `${pad('config', 30)}${pad('n', 5)}${pad('min', 8)}${pad('p50', 8)}${pad('mean', 8)}${pad('p95', 8)}${pad('max', 8)}`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const config of configs) {
      const samples = results.get(config.name) ?? [];
      const s = summarize(samples);
      console.log(
        `${pad(config.name, 30)}${pad(String(s.n), 5)}${pad(fmt(s.min), 8)}${pad(fmt(s.p50), 8)}${pad(fmt(s.mean), 8)}${pad(fmt(s.p95), 8)}${pad(fmt(s.max), 8)}`,
      );
    }

    // CSV-style per-call dump for audit.
    console.log('\nper-call latencies (ms):');
    for (const config of configs) {
      const samples = results.get(config.name) ?? [];
      console.log(`${config.name},${samples.map((v) => Math.round(v)).join(',')}`);
    }
  } catch (err) {
    console.error(`Latency probe aborted: ${(err as Error)?.message ?? String(err)}`);
    exitCode = 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
