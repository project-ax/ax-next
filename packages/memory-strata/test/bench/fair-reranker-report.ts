// Fair-reranker report renderer (TASK-192).
//
// Standalone from the spike's `report.ts` (welded to the Level-3 "binding decision"
// narrative) and the e2e `e2e-report.ts`. This renders the head-to-head the card
// asks for: config A (BM25-only) vs E (orchestrator + map) vs F (the FAIR reranker —
// local cross-encoder + query expansion + full bodies + wide pool), on accuracy +
// recall@5 + abstention + latency, with the cross-encoder per-query inference latency
// ISOLATED (from `rerankMs`), and a single explicit VERDICT:
//
//   does the fair local-cross-encoder reranker beat BM25-only by >= 5pp accuracy?
//
// If yes → file a follow-up to wire it. If no → record it so the reranker question is
// finally closed. The prior unfair test (config B, zerank-2) lost by 2.4pp; this report
// is the fair re-test that settles it.
//
// `verdictMode: 'needs-local-run'` renders a clearly-labelled STUB with the exact
// command, for when this build env has no answer/judge API keys (full accuracy +
// abstention require them; recall@5 + cross-encoder latency can be measured key-free).

import type { QuestionResult, ConfigName } from './types.js';

export type VerdictMode = 'measured' | 'needs-local-run';

export interface FairRerankReportInput {
  results: QuestionResult[];
  verdictMode: VerdictMode;
  runDate: Date;
  /** Models named for reproducibility. */
  answerModel: string;
  judgeModel: string;
  rerankModel: string;
  /** The exact command that produced (or would produce) this report. */
  command: string;
  /** Wide BM25 candidate pool fed to the reranker. */
  bm25CandidateCount: number;
  abortError?: string | null;
}

const WIN_THRESHOLD_PP = 5;

const CONFIG_LABELS: Partial<Record<ConfigName, string>> = {
  'a-bm25': 'A: BM25-only',
  'e-map-fts': 'E: Orchestrator + BM25 fallback',
  'f-fair-rerank': 'F: Fair reranker (local cross-encoder + query expansion + full bodies)',
};
const REPORTED_CONFIGS: ConfigName[] = ['a-bm25', 'e-map-fts', 'f-fair-rerank'];

interface Agg {
  total: number;
  correct: number;
  uncertain: number;
  latencyP50: number;
  latencyP95: number;
  rerankP50: number;
  rerankP95: number;
  recallAt5: number;
  recallAt5Eligible: number;
  unanswerableTotal: number;
  correctRefusal: number;
  hallucinatedOnUnanswerable: number;
  answerableTotal: number;
  falseRefusalOnAnswerable: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function aggregate(results: QuestionResult[]): Map<ConfigName, Agg> {
  const byCfg = new Map<ConfigName, Agg>();
  for (const r of results) {
    if (!byCfg.has(r.config)) {
      byCfg.set(r.config, {
        total: 0, correct: 0, uncertain: 0, latencyP50: 0, latencyP95: 0,
        rerankP50: 0, rerankP95: 0, recallAt5: 0, recallAt5Eligible: 0,
        unanswerableTotal: 0, correctRefusal: 0, hallucinatedOnUnanswerable: 0,
        answerableTotal: 0, falseRefusalOnAnswerable: 0,
      });
    }
    const a = byCfg.get(r.config)!;
    a.total += 1;
    if (r.verdict === 'correct' || r.verdict === 'abstained-correctly') a.correct += 1;
    if (r.verdict === 'uncertain') a.uncertain += 1;
    if (r.question.goldDocIds && r.question.goldDocIds.length > 0) {
      a.recallAt5Eligible += 1;
      const top5 = r.retrieval.retrievedDocs.slice(0, 5).map((d) => d.path);
      if (r.question.goldDocIds.some((g) => top5.includes(g))) a.recallAt5 += 1;
    }
    const unanswerable = r.question.metadata?.unanswerable === true;
    if (unanswerable) {
      a.unanswerableTotal += 1;
      if (r.verdict === 'abstained-correctly') a.correctRefusal += 1;
      else if (r.verdict === 'incorrect' || r.verdict === 'correct') a.hallucinatedOnUnanswerable += 1;
    } else {
      a.answerableTotal += 1;
      if (r.verdict === 'abstained-incorrectly') a.falseRefusalOnAnswerable += 1;
    }
  }
  for (const [config, a] of byCfg) {
    const lat = results.filter((r) => r.config === config).map((r) => r.retrieval.latencyMs).sort((x, y) => x - y);
    a.latencyP50 = percentile(lat, 0.5);
    a.latencyP95 = percentile(lat, 0.95);
    const rer = results
      .filter((r) => r.config === config && typeof r.retrieval.rerankMs === 'number')
      .map((r) => r.retrieval.rerankMs!)
      .sort((x, y) => x - y);
    a.rerankP50 = percentile(rer, 0.5);
    a.rerankP95 = percentile(rer, 0.95);
    a.recallAt5 = a.recallAt5Eligible > 0 ? a.recallAt5 / a.recallAt5Eligible : 0;
  }
  return byCfg;
}

function accPct(a: Agg): number {
  return a.total > 0 ? (100 * a.correct) / a.total : 0;
}

export function renderFairRerankReport(input: FairRerankReportInput): string {
  const date = input.runDate.toISOString().slice(0, 10);
  const L: string[] = [];

  L.push('# Strata fair-reranker re-test report (TASK-192)');
  L.push('');
  L.push(
    'Settles whether a **fair** local-cross-encoder reranker beats BM25-only. The prior ' +
      'reranker test (config B, hosted `zerank-2`) LOST to BM25-only by 2.4pp at ~6× the ' +
      'latency — but it reranked only `topK*3` candidates, over **2000-char-truncated** bodies, ' +
      'with **no query expansion**. Config **F** fixes all four: a wide BM25 pool, **full ' +
      'bodies**, **query expansion** (PRF + entity discovery), and a **local** cross-encoder ' +
      '(`' + input.rerankModel + '`, ~435M) instead of the hosted zerank-2.',
  );
  L.push('');
  L.push(`**Date:** ${date}`);
  L.push(`**Reranker (config F):** \`${input.rerankModel}\` (local cross-encoder)`);
  L.push(`**Answer LLM:** \`${input.answerModel}\` · **Judge:** \`${input.judgeModel}\``);
  L.push(`**BM25 candidate pool fed to F:** ${input.bm25CandidateCount} (vs config B's \`topK*3\`)`);
  L.push(`**Command:** \`${input.command}\``);
  L.push('');

  if (input.verdictMode === 'needs-local-run') {
    L.push(
      '> **VERDICT: needs-local-run.** This report was generated in an environment WITHOUT a ' +
        'local cross-encoder + the answer/judge API keys, so it carries no measured numbers. ' +
        'The full accuracy + abstention verdict requires a keyed end-to-end run; recall@5 + ' +
        'cross-encoder latency need only a local cross-encoder. Reproduce with:',
    );
    L.push('');
    L.push('```bash');
    L.push('# 1. Set up the local cross-encoder (one-time, ~1.7GB model on first run):');
    L.push('python3 -m venv /tmp/rerank-venv');
    L.push('/tmp/rerank-venv/bin/pip install sentence-transformers');
    L.push('');
    L.push('# 2. Run the head-to-head (A vs E vs F) with keys + the local reranker:');
    L.push('export ANTHROPIC_API_KEY=... OPENROUTER_API_KEY=... ZEROENTROPY_API_KEY=...');
    L.push('export AX_BENCH_RERANK_PYTHON=/tmp/rerank-venv/bin/python');
    L.push(`${input.command}`);
    L.push('```');
    L.push('');
    L.push(
      'The run rewrites this file with the measured A/E/F table, recall@5, abstention, the ' +
        'isolated cross-encoder per-query latency, and the WIN / NO-WIN verdict against the ' +
        `${WIN_THRESHOLD_PP}pp bar.`,
    );
    L.push('');
    appendReadingNotes(L, input);
    return L.join('\n') + '\n';
  }

  if (input.abortError) {
    L.push(`> **Aborted: ${input.abortError}.** Report reflects partial results.`);
    L.push('');
  }

  const agg = aggregate(input.results);

  // ── Results table ──────────────────────────────────────────────────────
  L.push('## Results (LongMemEval-S)');
  L.push('');
  L.push('| Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | rerank p50 ms | rerank p95 ms |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const cfg of REPORTED_CONFIGS) {
    const a = agg.get(cfg);
    if (!a) continue;
    const rerankCols = cfg === 'f-fair-rerank' ? `${a.rerankP50} | ${a.rerankP95}` : '— | —';
    L.push(
      `| ${CONFIG_LABELS[cfg]} | ${a.total} | ${accPct(a).toFixed(1)}% | ${(100 * a.recallAt5).toFixed(1)}% | ` +
        `${a.total > 0 ? ((100 * a.uncertain) / a.total).toFixed(1) : '0.0'}% | ${a.latencyP50} | ${a.latencyP95} | ${rerankCols} |`,
    );
  }
  L.push('');

  // ── Abstention split ───────────────────────────────────────────────────
  const hasAbs = [...agg.values()].some((a) => a.unanswerableTotal > 0 || a.falseRefusalOnAnswerable > 0);
  if (hasAbs) {
    L.push('## Abstention (the `_abs` unanswerable split)');
    L.push('');
    L.push('| Config | unanswerable n | correct-refusal | hallucinated | false-refusal (on answerable) |');
    L.push('|---|---|---|---|---|');
    for (const cfg of REPORTED_CONFIGS) {
      const a = agg.get(cfg);
      if (!a) continue;
      const rate = a.unanswerableTotal > 0 ? `${((100 * a.correctRefusal) / a.unanswerableTotal).toFixed(1)}%` : 'n/a';
      L.push(
        `| ${CONFIG_LABELS[cfg]} | ${a.unanswerableTotal} | ${a.correctRefusal} (${rate}) | ` +
          `${a.hallucinatedOnUnanswerable} | ${a.falseRefusalOnAnswerable} / ${a.answerableTotal} |`,
      );
    }
    L.push('');
  }

  // ── Cross-encoder latency ──────────────────────────────────────────────
  const f = agg.get('f-fair-rerank');
  L.push('## Local cross-encoder inference latency (per query)');
  L.push('');
  if (f && (f.rerankP50 > 0 || f.rerankP95 > 0)) {
    L.push(
      `Config F's reranker (\`${input.rerankModel}\`) spent **p50 ${f.rerankP50} ms / p95 ` +
        `${f.rerankP95} ms** per query on cross-encoder inference alone (isolated from BM25 ` +
        'retrieval). This is the candidate runtime cost a wired reranker would add per turn.',
    );
  } else {
    L.push(
      'No isolated cross-encoder latency was captured (config F absent or `rerankMs` unset). ' +
        'Re-run with the local reranker configured to populate this.',
    );
  }
  L.push('');

  // ── Verdict ────────────────────────────────────────────────────────────
  L.push('## VERDICT');
  L.push('');
  const a = agg.get('a-bm25');
  if (!f || !a) {
    L.push(
      '> **Inconclusive.** Both config A (BM25-only) and config F (fair reranker) must be present ' +
        'to compute the head-to-head delta. Re-run `--config all` (or at least `a-bm25` + ' +
        '`f-fair-rerank`).',
    );
  } else {
    const delta = accPct(f) - accPct(a);
    const sign = delta >= 0 ? '+' : '';
    if (delta >= WIN_THRESHOLD_PP) {
      L.push(
        `> **WIN.** The fair reranker (F, ${accPct(f).toFixed(1)}%) beats BM25-only ` +
          `(A, ${accPct(a).toFixed(1)}%) by **${sign}${delta.toFixed(1)}pp** — clearing the ` +
          `${WIN_THRESHOLD_PP}pp bar. File a follow-up to wire a local cross-encoder reranker ` +
          'into the retrieval path (weigh the per-query latency above against the orchestrator ' +
          'path TASK-191).',
      );
    } else {
      L.push(
        `> **NO-WIN. The reranker question is now closed.** The fair reranker (F, ` +
          `${accPct(f).toFixed(1)}%) does NOT beat BM25-only (A, ${accPct(a).toFixed(1)}%) by the ` +
          `${WIN_THRESHOLD_PP}pp bar — the delta is **${sign}${delta.toFixed(1)}pp**. Even with full ` +
          'bodies, query expansion, a wide pool, and a local cross-encoder, the reranker does not ' +
          'earn its latency. Pursue the orchestrator + map path (TASK-191), not a reranker.',
      );
    }
  }
  L.push('');

  appendReadingNotes(L, input);
  return L.join('\n') + '\n';
}

function appendReadingNotes(L: string[], input: FairRerankReportInput): void {
  L.push('## How to read this');
  L.push('');
  L.push(
    `- The bar is **>= ${WIN_THRESHOLD_PP}pp LongMemEval-S accuracy** of fair-F over BM25-only ` +
      '(config A), matching the roadmap threshold used for the orchestrator decision.',
  );
  L.push(
    '- Config B (hosted `zerank-2`, truncated bodies, no expansion) is the prior UNFAIR baseline ' +
      'that lost; config F is this fair re-test. They are different experiments — do not conflate.',
  );
  L.push(
    `- Absolute accuracy here reflects the bench A–E retrieval-config regime (generic agent + ` +
      `\`${input.answerModel}\` + \`${input.judgeModel}\` judge), NOT the shipped product e2e ` +
      'number (see the TASK-189 e2e report). Only the A-vs-F **delta** is the load-bearing signal.',
  );
  L.push(
    '- Out of scope: wiring a reranker into the runtime. This is a measurement spike; promotion ' +
      'is a separate card iff F wins.',
  );
}
