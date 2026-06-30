// E2E report renderer (TASK-189). Standalone from the spike's `report.ts`
// (which is welded to the A–E config labels + the Level-3 binding decision +
// recall@5). This renders the SHIPPED-runtime end-to-end result: an absolute
// LongMemEval-S accuracy plus the abstention split (correct-refusal /
// false-refusal / hallucination), with the answer-LLM + extraction-LLM + judge
// NAMED so the number is apples-to-apples against a published baseline.

import type { Verdict } from './types.js';

export interface E2EReportRow {
  questionId: string;
  questionType: string | undefined;
  unanswerable: boolean;
  verdict: Verdict;
  judgeReason: string;
  sessionsIngested: number;
  toolCalls: number;
  dollars: number;
}

export interface E2EReportInput {
  rows: E2EReportRow[];
  runDate: Date;
  /** Sample size requested (e.g. 100). */
  requestedSample: number;
  /** Cost cap in dollars. */
  cap: number;
  totalSpent: number;
  capExceeded: boolean;
  /** Model ids, named in the report for reproducibility. */
  answerModel: string;
  extractionModel: string;
  judgeModel: string;
  /** The exact command that produced this report. */
  command: string;
  abortError?: string | null;
  skipped?: Array<{ questionId: string; reason: string }>;
  /** When true, the report was produced from the deterministic test fixture, not a live paid run. */
  fixtureMode?: boolean;
}

interface Accuracy {
  total: number;
  /** correct + abstained-correctly (the LongMemEval-S accuracy numerator). */
  correct: number;
  uncertain: number;
}

interface AbstentionAgg {
  unanswerableTotal: number;
  correctRefusal: number;
  hallucinatedOnUnanswerable: number;
  answerableTotal: number;
  falseRefusalOnAnswerable: number;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((100 * n) / d).toFixed(1)}%` : 'n/a';
}

export function renderE2EReport(input: E2EReportInput): string {
  const date = input.runDate.toISOString().slice(0, 10);
  const L: string[] = [];

  L.push('# Strata end-to-end LongMemEval-S report');
  L.push('');
  L.push(
    'Measures the **shipped** `@ax/memory-strata` runtime end-to-end — Observer ' +
      'extraction (`chat:end`) → inbox → consolidator (decay/cluster/dedup/promote) → ' +
      '`docs/` + `system/recent.md` → `system-prompt:augment` injection + `memory_search` → ' +
      'answer — NOT the bench A–E retrieval-config drivers.',
  );
  L.push('');
  L.push(`**Date:** ${date}`);
  L.push(`**Answer LLM (under test):** \`${input.answerModel}\` (Anthropic)`);
  L.push(`**Observer / consolidator extraction LLM:** \`${input.extractionModel}\` (Anthropic)`);
  L.push(`**Judge:** \`${input.judgeModel}\` (via OpenRouter)`);
  L.push(`**Requested sample:** n=${input.requestedSample}`);
  L.push(`**Cost cap:** $${input.cap}`);
  L.push(`**Total spent:** $${input.totalSpent.toFixed(4)}`);
  L.push(`**Command:** \`${input.command}\``);
  if (input.fixtureMode) {
    L.push('');
    L.push(
      '> **Representative report (fixture mode).** No live API keys were present, so ' +
        'this report was produced from the deterministic integration fixture to demonstrate ' +
        'the harness end-to-end. The numbers are illustrative, NOT a measured LongMemEval-S ' +
        'score. Re-run with `ANTHROPIC_API_KEY` + `OPENROUTER_API_KEY` set for real numbers.',
    );
  }
  if (input.capExceeded) {
    L.push('');
    L.push('> **Aborted: cost cap exceeded.** Report reflects partial results.');
  }
  if (input.abortError) {
    L.push('');
    L.push(`> **Aborted: ${input.abortError}.** Report reflects partial results.`);
  }
  L.push('');

  // ── Headline accuracy ──────────────────────────────────────────────────
  const acc: Accuracy = { total: 0, correct: 0, uncertain: 0 };
  for (const r of input.rows) {
    acc.total += 1;
    if (r.verdict === 'correct' || r.verdict === 'abstained-correctly') acc.correct += 1;
    if (r.verdict === 'uncertain') acc.uncertain += 1;
  }
  const avgSessions =
    input.rows.length > 0
      ? input.rows.reduce((s, r) => s + r.sessionsIngested, 0) / input.rows.length
      : 0;
  const avgTools =
    input.rows.length > 0
      ? input.rows.reduce((s, r) => s + r.toolCalls, 0) / input.rows.length
      : 0;

  L.push('## Headline');
  L.push('');
  L.push('| metric | value |');
  L.push('|---|---|');
  L.push(`| questions evaluated | ${acc.total} |`);
  L.push(`| **end-to-end accuracy** (correct + correct-refusal) | **${pct(acc.correct, acc.total)}** |`);
  L.push(`| uncertain (judge couldn't tell) | ${pct(acc.uncertain, acc.total)} |`);
  L.push(`| avg haystack sessions ingested / question | ${avgSessions.toFixed(1)} |`);
  L.push(`| avg memory_search calls / question | ${avgTools.toFixed(1)} |`);
  L.push('');

  // ── Abstention split (the _abs unanswerable questions) ─────────────────
  const abs: AbstentionAgg = {
    unanswerableTotal: 0,
    correctRefusal: 0,
    hallucinatedOnUnanswerable: 0,
    answerableTotal: 0,
    falseRefusalOnAnswerable: 0,
  };
  for (const r of input.rows) {
    if (r.unanswerable) {
      abs.unanswerableTotal += 1;
      if (r.verdict === 'abstained-correctly') abs.correctRefusal += 1;
      else if (r.verdict === 'incorrect' || r.verdict === 'correct') abs.hallucinatedOnUnanswerable += 1;
    } else {
      abs.answerableTotal += 1;
      if (r.verdict === 'abstained-incorrectly') abs.falseRefusalOnAnswerable += 1;
    }
  }
  L.push('## Abstention (the `_abs` unanswerable split)');
  L.push('');
  L.push('| metric | value |');
  L.push('|---|---|');
  L.push(`| unanswerable questions | ${abs.unanswerableTotal} |`);
  L.push(
    `| **correct-refusal rate** (refused when it should) | ${pct(abs.correctRefusal, abs.unanswerableTotal)} |`,
  );
  L.push(
    `| **hallucination rate** (answered an unanswerable) | ${pct(abs.hallucinatedOnUnanswerable, abs.unanswerableTotal)} |`,
  );
  L.push(`| answerable questions | ${abs.answerableTotal} |`);
  L.push(
    `| **false-refusal rate** (refused an answerable — missed retrieval) | ${pct(abs.falseRefusalOnAnswerable, abs.answerableTotal)} |`,
  );
  L.push('');

  // ── Per-question-type breakdown ────────────────────────────────────────
  const byType = new Map<string, Accuracy>();
  for (const r of input.rows) {
    const key = r.questionType ?? 'unknown';
    if (!byType.has(key)) byType.set(key, { total: 0, correct: 0, uncertain: 0 });
    const a = byType.get(key)!;
    a.total += 1;
    if (r.verdict === 'correct' || r.verdict === 'abstained-correctly') a.correct += 1;
    if (r.verdict === 'uncertain') a.uncertain += 1;
  }
  if (byType.size > 0) {
    L.push('## By question type');
    L.push('');
    L.push('| question_type | n | accuracy | uncertain% |');
    L.push('|---|---|---|---|');
    for (const [type, a] of [...byType.entries()].sort()) {
      L.push(`| ${type} | ${a.total} | ${pct(a.correct, a.total)} | ${pct(a.uncertain, a.total)} |`);
    }
    L.push('');
  }

  // ── Skipped ────────────────────────────────────────────────────────────
  const skipped = input.skipped ?? [];
  if (skipped.length > 0) {
    L.push(`## Skipped questions (${skipped.length})`);
    L.push('');
    const byReason = new Map<string, number>();
    for (const s of skipped) {
      const head = s.reason.split('\n')[0]!.slice(0, 120);
      byReason.set(head, (byReason.get(head) ?? 0) + 1);
    }
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      L.push(`- ${count}× — ${reason}`);
    }
    L.push('');
  }

  // ── Interpretation ─────────────────────────────────────────────────────
  L.push('## How to read this number');
  L.push('');
  L.push(
    '- This is the **first** measurement of the shipped product end-to-end. The earlier ' +
      'spike reports (`2026-05-13-…vector-spike-report.md`, `…phase-3c-config-d-report.md`) ' +
      'scored RETRIEVAL CONFIGS (A–E) with a generic agent + a deliberately lightweight ' +
      'injection regime — their absolute 20–28% is **not** comparable to this number.',
  );
  L.push(
    '- The published c137 LongMemEval-S anchor is ~90.4%, measured with a different ' +
      'agent + judge + retrieval stack. Treat the gap as a starting baseline for ' +
      'TASK-190 (map/densified inject) and TASK-191 (retrieval orchestrator), which ' +
      'this report exists to give a real before/after against — NOT as a like-for-like ' +
      'comparison.',
  );
  L.push(
    `- Apples-to-apples requires naming the stack: answer LLM \`${input.answerModel}\`, ` +
      `extraction \`${input.extractionModel}\`, judge \`${input.judgeModel}\`. A different ` +
      'judge or answer model would move the absolute number.',
  );
  L.push('');
  return L.join('\n') + '\n';
}
