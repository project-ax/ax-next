import type { QuestionResult, ConfigName, BenchCorpus } from './types.js';
import type { ModelSnapshot } from './meter.js';

export interface ReportInput {
  results: QuestionResult[];
  cap: number;
  totalSpent: number;
  capExceeded: boolean;
  runDate: Date;
  abortError?: string | null;
  skipped?: Array<{ corpus: string; config: string; questionId: string; reason: string }>;
  configFailures?: Array<{ corpus: string; config: string; phase: 'build' | 'unknown'; reason: string }>;
  /**
   * Which model ran the retrieval orchestrator, stamped into the header so two
   * arms of the same config are tellable apart AFTER the run.
   *
   * Config D and E differ between arms ONLY by this model, and the config label
   * ("E: Orchestrator + BM25 fallback") is identical in both reports — so an
   * unstamped report is a number with no provenance. That is how a headline
   * measured against `x-ai/grok-4.1-fast` survived four months past the id's
   * deprecation (#515).
   *
   * Rendered only when an orchestrator config actually ran: stamping a model on
   * a pure-BM25 run would claim a dependency the numbers do not have.
   */
  orchestratorModel?: string;
  /**
   * Per-model tokens and dollars, straight from `CostMeter.snapshot()`.
   *
   * The meter has always tracked this; the report threw it away and printed
   * only the total, which invites the total to be read as if the one role that
   * DIFFERS between arms explains the whole gap. It does not: an arm's bill is
   * dominated by the answer model, which is the same model doing the same job
   * in every arm. Without this table you cannot tell a cheaper planner from a
   * planner that simply hands the answer model less to read.
   */
  spendByModel?: Record<string, ModelSnapshot>;
  /**
   * How the question set was drawn. Stamped because a prefix of a type-ordered
   * corpus is not a sample of it, and a report that does not say which one it
   * used invites its number to be compared against one that used the other.
   */
  sampleNote?: string;
  /**
   * Per-doc body cap the answer stage ran under. Stamped because changing it
   * moved accuracy 24 points without touching retrieval — two reports measured
   * under different caps are not comparable, and nothing else on the page says
   * so.
   */
  bodyCharCap?: number;
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
  recallAt5Eligible: number;
}

function aggregateByConfig(
  results: QuestionResult[],
): Map<CorpusName, Map<ConfigName, Aggregate>> {
  const byCorpus = new Map<CorpusName, Map<ConfigName, Aggregate>>();
  for (const r of results) {
    if (!byCorpus.has(r.corpus)) byCorpus.set(r.corpus, new Map());
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
        recallAt5Eligible: 0,
      });
    const a = cm.get(r.config)!;
    a.total += 1;
    if (r.verdict === 'correct' || r.verdict === 'abstained-correctly') a.correct += 1;
    if (r.verdict === 'uncertain') a.uncertain += 1;
    a.totalDollars += r.totalDollars;
    a.totalAgentInTokens += r.agentTokens.in;
    a.totalAgentOutTokens += r.agentTokens.out;
    if (r.question.goldDocIds && r.question.goldDocIds.length > 0) {
      a.recallAt5Eligible += 1;
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
      a.recallAt5 = a.recallAt5Eligible > 0 ? a.recallAt5 / a.recallAt5Eligible : 0;
    }
  }
  return byCorpus;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i]!;
}

const CONFIG_LABELS: Record<ConfigName, string> = {
  'a-bm25': 'A: BM25-only',
  'b-rerank': 'B: BM25 + zerank-2',
  'c-rrf': 'C: BM25 + zembed-1 + RRF',
  'd-map': 'D: Retrieval Orchestrator (c137-style)',
  'e-map-fts': 'E: Orchestrator + BM25 fallback',
  'f-fair-rerank': 'F: BM25 + local cross-encoder (fair)',
};

/** Configs whose numbers depend on {@link ReportInput.orchestratorModel}. */
const ORCHESTRATOR_CONFIGS: ReadonlySet<ConfigName> = new Set<ConfigName>(['d-map', 'e-map-fts']);

export function renderReport(input: ReportInput): string {
  const date = input.runDate.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Strata vector-vs-no-vector spike report`);
  lines.push(``);
  lines.push(`**Date:** ${date}`);
  lines.push(`**Cap:** $${input.cap}`);
  if (input.sampleNote) lines.push(`**Sampling:** ${input.sampleNote}`);
  if (input.bodyCharCap !== undefined) {
    lines.push(`**Answer-stage body cap:** ${input.bodyCharCap.toLocaleString('en-US')} chars/doc`);
  }
  if (input.orchestratorModel && input.results.some((r) => ORCHESTRATOR_CONFIGS.has(r.config))) {
    lines.push(`**Orchestrator model:** \`${input.orchestratorModel}\``);
  }
  lines.push(`**Total spent:** $${input.totalSpent.toFixed(4)}`);
  if (input.capExceeded) {
    lines.push(``);
    lines.push(`> **Aborted: cost cap exceeded.** Report reflects partial results.`);
  }
  if (input.abortError) {
    lines.push(``);
    lines.push(`> **Aborted: ${input.abortError}.** Report reflects partial results captured before the abort.`);
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

  interface AbsAgg {
    unanswerableTotal: number;
    correctRefusal: number;
    hallucinatedOnUnanswerable: number;
    falseRefusalOnAnswerable: number;
    answerableTotal: number;
  }
  const abs = new Map<CorpusName, Map<ConfigName, AbsAgg>>();
  for (const r of input.results) {
    if (!abs.has(r.corpus)) abs.set(r.corpus, new Map());
    const cm = abs.get(r.corpus)!;
    if (!cm.has(r.config))
      cm.set(r.config, {
        unanswerableTotal: 0,
        correctRefusal: 0,
        hallucinatedOnUnanswerable: 0,
        falseRefusalOnAnswerable: 0,
        answerableTotal: 0,
      });
    const a = cm.get(r.config)!;
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
  const hasAbs = [...abs.values()].some((m) =>
    [...m.values()].some((a) => a.unanswerableTotal > 0 || a.falseRefusalOnAnswerable > 0),
  );
  if (hasAbs) {
    lines.push(`## Abstention`);
    lines.push(``);
    lines.push(`| corpus | Config | unanswerable n | correct-refusal | hallucinated | false-refusal (on answerable) |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const [corpus, cm] of abs) {
      for (const [config, a] of cm) {
        const rate = a.unanswerableTotal > 0
          ? `${((100 * a.correctRefusal) / a.unanswerableTotal).toFixed(1)}%`
          : 'n/a';
        lines.push(
          `| ${corpus} | ${CONFIG_LABELS[config]} | ${a.unanswerableTotal} | ${a.correctRefusal} (${rate}) | ${a.hallucinatedOnUnanswerable} | ${a.falseRefusalOnAnswerable} / ${a.answerableTotal} |`,
        );
      }
    }
    lines.push(``);
  }

  const spend = input.spendByModel ?? {};
  const spendRows = Object.entries(spend).filter(([, v]) => v.dollars > 0);
  if (spendRows.length > 0) {
    lines.push(`## Spend by model`);
    lines.push(``);
    lines.push(`| model | tokens in | tokens out | $ | % of run |`);
    lines.push(`|---|---|---|---|---|`);
    const total = spendRows.reduce((acc, [, v]) => acc + v.dollars, 0);
    for (const [model, v] of spendRows.sort((a, b) => b[1].dollars - a[1].dollars)) {
      const pct = total > 0 ? (100 * v.dollars) / total : 0;
      lines.push(
        `| \`${model}\` | ${v.tokensIn.toLocaleString('en-US')} | ${v.tokensOut.toLocaleString('en-US')} | $${v.dollars.toFixed(4)} | ${pct.toFixed(1)}% |`,
      );
    }
    lines.push(``);
  }

  // Plan shape — only meaningful for configs that actually run a planner.
  const planRows = new Map<string, { n: number; docs: number; followup: number; fellBack: number; zero: number }>();
  for (const r of input.results) {
    if (!ORCHESTRATOR_CONFIGS.has(r.config)) continue;
    if (r.retrieval.orchestratorDocCount === undefined) continue;
    const key = `${r.corpus} | ${CONFIG_LABELS[r.config]}`;
    const a = planRows.get(key) ?? { n: 0, docs: 0, followup: 0, fellBack: 0, zero: 0 };
    a.n += 1;
    a.docs += r.retrieval.orchestratorDocCount;
    if (r.retrieval.followupNeeded) a.followup += 1;
    if (r.retrieval.fellBackToBm25) a.fellBack += 1;
    if (r.retrieval.orchestratorDocCount === 0) a.zero += 1;
    planRows.set(key, a);
  }
  if (planRows.size > 0) {
    lines.push(`## Plan shape`);
    lines.push(``);
    lines.push(`How much of the retrieval the PLANNER actually did. An arm that falls back on`);
    lines.push(`most questions is running BM25 under an orchestrator's name — it will score and`);
    lines.push(`cost like BM25 no matter what the config column says.`);
    lines.push(``);
    lines.push(`| corpus | Config | n | mean docs from planner | planner returned nothing | followup requested | fell back to BM25 |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const [key, a] of planRows) {
      lines.push(
        `| ${key} | ${a.n} | ${(a.docs / a.n).toFixed(2)} | ${((100 * a.zero) / a.n).toFixed(1)}% | ${((100 * a.followup) / a.n).toFixed(1)}% | ${((100 * a.fellBack) / a.n).toFixed(1)}% |`,
      );
    }
    lines.push(``);
  }

  lines.push(`## Binding decision`);
  lines.push(``);
  lines.push(`Apply the roadmap's >= 3-point LongMemEval-S accuracy threshold:`);
  lines.push(`- If C beats both A and B by >= 3 points -> Level 3 stays IN.`);
  lines.push(`- If A or B comes within 3 points of C -> Level 3 is OUT.`);
  lines.push(`- If B beats A by a clear margin but C does not beat B -> Level 3 OUT, prioritise reranker (Level 6) in Phase 4.`);
  lines.push(``);
  lines.push(`> _Phase 3B PR author fills in the explicit decision based on the LongMemEval-S row above._`);
  const configFailures = input.configFailures ?? [];
  if (configFailures.length > 0) {
    lines.push(``);
    lines.push(`## Config build failures (${configFailures.length})`);
    lines.push(``);
    for (const f of configFailures) {
      lines.push(`- **${f.corpus} / ${f.config}** (${f.phase}): ${f.reason.split('\n')[0]!.slice(0, 200)}`);
    }
  }

  const skipped = input.skipped ?? [];
  if (skipped.length > 0) {
    lines.push(``);
    lines.push(`## Skipped questions (${skipped.length})`);
    lines.push(``);
    const byReason = new Map<string, number>();
    for (const s of skipped) {
      const head = s.reason.split('\n')[0]!.slice(0, 120);
      byReason.set(head, (byReason.get(head) ?? 0) + 1);
    }
    lines.push(`Reason buckets:`);
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${count}× — ${reason}`);
    }
  }

  lines.push(``);
  lines.push(`## Caveats`);
  lines.push(``);
  lines.push(`- Internal corpus is synthetic; treat as directional, not authoritative.`);
  lines.push(`- Judge is Grok 4.3 (cross-family with Sonnet 4.6 agent under test), but still a large model with its own biases. Cross-judge sweep is a Phase 5+ follow-up if the decision is close.`);
  lines.push(`- LongMemEval and LoCoMo are research-licensed datasets; results are not redistributed.`);
  lines.push(`- zeroentropy@0.1.0-alpha.10 (alpha SDK) — re-runs may need to re-pin if the SDK changes.`);
  return lines.join('\n') + '\n';
}
