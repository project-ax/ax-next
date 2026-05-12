import type { QuestionResult, ConfigName, BenchCorpus } from './types.js';

export interface ReportInput {
  results: QuestionResult[];
  cap: number;
  totalSpent: number;
  capExceeded: boolean;
  runDate: Date;
}

type CorpusName = BenchCorpus['name'];

interface Aggregate {
  total: number;
  correct: number;
  uncertain: number;
  latencyP50: number;
  latencyP95: number;
  totalDollars: number;
  totalAgentInTokens: number;
  totalAgentOutTokens: number;
  recallAt5: number;
}

function aggregateByConfig(
  results: QuestionResult[],
): Map<CorpusName, Map<ConfigName, Aggregate>> {
  const byCorpus = new Map<CorpusName, Map<ConfigName, Aggregate>>();
  for (const r of results) {
    if (!byCorpus.has(r.corpus)) byCorpus.set(r.corpus, new Map());
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const cm = byCorpus.get(r.corpus)!;
    if (!cm.has(r.config))
      cm.set(r.config, {
        total: 0,
        correct: 0,
        uncertain: 0,
        latencyP50: 0,
        latencyP95: 0,
        totalDollars: 0,
        totalAgentInTokens: 0,
        totalAgentOutTokens: 0,
        recallAt5: 0,
      });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const a = cm.get(r.config)!;
    a.total += 1;
    if (r.verdict === 'correct') a.correct += 1;
    if (r.verdict === 'uncertain') a.uncertain += 1;
    a.totalDollars += r.totalDollars;
    a.totalAgentInTokens += r.agentTokens.in;
    a.totalAgentOutTokens += r.agentTokens.out;
    if (r.question.goldDocIds && r.question.goldDocIds.length > 0) {
      const top5 = r.retrieval.retrievedDocs.slice(0, 5).map((d) => d.path);
      const hit = r.question.goldDocIds.some((g) => top5.includes(g));
      if (hit) a.recallAt5 += 1;
    }
  }
  for (const [corpus, cm] of byCorpus) {
    for (const [config, a] of cm) {
      const latencies = results
        .filter((r) => r.corpus === corpus && r.config === config)
        .map((r) => r.retrieval.latencyMs)
        .sort((x, y) => x - y);
      a.latencyP50 = percentile(latencies, 0.5);
      a.latencyP95 = percentile(latencies, 0.95);
      a.recallAt5 = a.recallAt5 / Math.max(a.total, 1);
    }
  }
  return byCorpus;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return sorted[i]!;
}

const CONFIG_LABELS: Record<ConfigName, string> = {
  'a-bm25': 'A: BM25-only',
  'b-rerank': 'B: BM25 + zerank-2',
  'c-rrf': 'C: BM25 + zembed-1 + RRF',
};

export function renderReport(input: ReportInput): string {
  const date = input.runDate.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Strata vector-vs-no-vector spike report`);
  lines.push(``);
  lines.push(`**Date:** ${date}`);
  lines.push(`**Cap:** $${input.cap}`);
  lines.push(`**Total spent:** $${input.totalSpent.toFixed(4)}`);
  if (input.capExceeded) {
    lines.push(``);
    lines.push(`> **Aborted: cost cap exceeded.** Report reflects partial results.`);
  }
  lines.push(``);
  const agg = aggregateByConfig(input.results);
  lines.push(`## Results`);
  lines.push(``);
  lines.push(`| corpus | Config | n | accuracy | recall@5 | uncertain% | p50 ms | p95 ms | $ |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const [corpus, cm] of agg) {
    for (const [config, a] of cm) {
      lines.push(
        `| ${corpus} | ${CONFIG_LABELS[config]} | ${a.total} | ${((100 * a.correct) / a.total).toFixed(1)}% | ${(100 * a.recallAt5).toFixed(1)}% | ${((100 * a.uncertain) / a.total).toFixed(1)}% | ${a.latencyP50} | ${a.latencyP95} | $${a.totalDollars.toFixed(4)} |`,
      );
    }
  }
  lines.push(``);
  lines.push(`## Binding decision`);
  lines.push(``);
  lines.push(`Apply the roadmap's >= 3-point LongMemEval-S accuracy threshold:`);
  lines.push(`- If C beats both A and B by >= 3 points -> Level 3 stays IN.`);
  lines.push(`- If A or B comes within 3 points of C -> Level 3 is OUT.`);
  lines.push(`- If B beats A by a clear margin but C does not beat B -> Level 3 OUT, prioritise reranker (Level 6) in Phase 4.`);
  lines.push(``);
  lines.push(`> _Phase 3B PR author fills in the explicit decision based on the LongMemEval-S row above._`);
  lines.push(``);
  lines.push(`## Caveats`);
  lines.push(``);
  lines.push(`- Internal corpus is synthetic; treat as directional, not authoritative.`);
  lines.push(`- Judge is Grok 4.3 (cross-family with Sonnet 4.6 agent under test), but still a large model with its own biases. Cross-judge sweep is a Phase 5+ follow-up if the decision is close.`);
  lines.push(`- LongMemEval and LoCoMo are research-licensed datasets; results are not redistributed.`);
  lines.push(`- zeroentropy@0.1.0-alpha.10 (alpha SDK) — re-runs may need to re-pin if the SDK changes.`);
  return lines.join('\n') + '\n';
}
