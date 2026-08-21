// ---------------------------------------------------------------------------
// Scoring and rendering a bench run.
//
// THE GATE IS A DELTA, NOT AN ABSOLUTE. Design §7 asks that a question stay
// answerable AFTER compaction fires — which is a claim about what compaction
// COST, not about how good the model is at reading a long transcript. Some
// needles the model gets wrong from the full conversation too; charging those
// to compaction would make the gate a measure of the filler's difficulty.
//
// So the number that gates is `recallLoss`: answerable needles the verbatim arm
// got right and the compacted arm did not, as a fraction of what verbatim got
// right. A run with no verbatim arm cannot compute it and says so rather than
// falling back to the absolute — a gate that silently changes meaning is worse
// than no gate.
//
// CONFABULATION IS REPORTED SEPARATELY and is not folded into recall. A summary
// that loses a fact and admits it (`abstained-incorrectly`) is a much better
// failure than one that loses a fact and invents a replacement (`incorrect`),
// and the two call for opposite fixes.
// ---------------------------------------------------------------------------

import type { Arm, ConversationResult, NeedleResult } from './driver.js';

export interface ArmScore {
  answerable: number;
  recalled: number;
  lost: number;
  confabulated: number;
  uncertain: number;
  unanswerable: number;
  abstainedCorrectly: number;
}

export interface BenchScore {
  byArm: Record<Arm, ArmScore>;
  /**
   * Answerable needles verbatim recalled and compacted did not, over what
   * verbatim recalled. `null` when the verbatim arm did not run.
   */
  recallLoss: number | null;
  /** Compacted-arm confabulations on answerable needles, as a fraction. */
  confabulationRate: number;
  /** Compacted-arm abstention on questions with no answer, as a fraction. */
  abstentionRate: number;
  tokenReduction: number;
  skipped: string[];
}

const EMPTY: ArmScore = {
  answerable: 0,
  recalled: 0,
  lost: 0,
  confabulated: 0,
  uncertain: 0,
  unanswerable: 0,
  abstainedCorrectly: 0,
};

export function score(results: readonly ConversationResult[]): BenchScore {
  const byArm: Record<Arm, ArmScore> = {
    compacted: { ...EMPTY },
    verbatim: { ...EMPTY },
  };
  const recalledByArm: Record<Arm, Set<string>> = {
    compacted: new Set(),
    verbatim: new Set(),
  };

  let tokensBefore = 0;
  let tokensAfter = 0;
  const skipped: string[] = [];

  for (const conv of results) {
    if (conv.skipped !== undefined) skipped.push(`${conv.conversation}: ${conv.skipped}`);
    tokensBefore += conv.tokensBefore;
    tokensAfter += conv.tokensAfter;
    for (const r of conv.results) {
      const arm = byArm[r.arm];
      const key = `${r.conversation}/${r.needleId}`;
      // Whether a needle is answerable is a property of the CORPUS, and the
      // judge is told which it is — so the verdict names it back rather than
      // this having to thread the needle definition through the results.
      if (r.verdict === 'abstained-correctly') {
        arm.unanswerable++;
        arm.abstainedCorrectly++;
        continue;
      }
      if (isUnanswerableVerdict(r)) {
        arm.unanswerable++;
        continue;
      }
      arm.answerable++;
      if (r.verdict === 'correct') {
        arm.recalled++;
        recalledByArm[r.arm].add(key);
      } else if (r.verdict === 'abstained-incorrectly') arm.lost++;
      else if (r.verdict === 'incorrect') arm.confabulated++;
      else arm.uncertain++;
    }
  }

  const verbatimRecalled = recalledByArm.verbatim;
  const compactedRecalled = recalledByArm.compacted;
  const recallLoss =
    verbatimRecalled.size === 0
      ? null
      : [...verbatimRecalled].filter((k) => !compactedRecalled.has(k)).length /
        verbatimRecalled.size;

  const c = byArm.compacted;
  return {
    byArm,
    recallLoss,
    confabulationRate: c.answerable === 0 ? 0 : c.confabulated / c.answerable,
    abstentionRate: c.unanswerable === 0 ? 1 : c.abstainedCorrectly / c.unanswerable,
    tokenReduction: tokensBefore === 0 ? 0 : 1 - tokensAfter / tokensBefore,
    skipped,
  };
}

/**
 * Whether a result is for an unanswerable needle.
 *
 * `abstained-incorrectly` is the judge's word for "declined, but it WAS
 * answerable", so the only unanswerable verdicts are the correct abstention and
 * — when the model invented an answer to a question with none — `incorrect` on
 * a needle whose id says so. Corpus ids carry that, which keeps this from
 * needing the needle definitions.
 */
function isUnanswerableVerdict(r: NeedleResult): boolean {
  return r.needleId.startsWith('absent-');
}

export interface Gates {
  /** Maximum fraction of verbatim-recalled facts compaction may lose. */
  maxRecallLoss: number;
  /** Maximum fraction of answerable questions answered with an invention. */
  maxConfabulation: number;
  /** Minimum fraction of unanswerable questions correctly declined. */
  minAbstention: number;
}

export const DEFAULT_GATES: Gates = {
  // Some loss is the deal compaction makes — the alternative to losing a
  // quarter of the older facts is a conversation that cannot take another turn
  // at all. Past this, the summary is not carrying its weight.
  maxRecallLoss: 0.25,
  // Confabulation is judged much harder than loss, because a wrong answer
  // delivered confidently is worse for the user than a missing one.
  maxConfabulation: 0.1,
  minAbstention: 0.75,
};

export function checkGates(
  s: BenchScore,
  gates: Gates = DEFAULT_GATES,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (s.recallLoss === null) {
    failures.push(
      'recall loss could not be computed (the verbatim control arm did not run) — ' +
        'the gate is a delta and cannot be evaluated without it',
    );
  } else if (s.recallLoss > gates.maxRecallLoss) {
    failures.push(
      `recall loss ${pct(s.recallLoss)} exceeds ${pct(gates.maxRecallLoss)}`,
    );
  }
  if (s.confabulationRate > gates.maxConfabulation) {
    failures.push(
      `confabulation ${pct(s.confabulationRate)} exceeds ${pct(gates.maxConfabulation)}`,
    );
  }
  if (s.abstentionRate < gates.minAbstention) {
    failures.push(
      `abstention ${pct(s.abstentionRate)} is below ${pct(gates.minAbstention)}`,
    );
  }
  return { passed: failures.length === 0, failures };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function renderReport(input: {
  results: readonly ConversationResult[];
  score: BenchScore;
  gates?: Gates;
  model: string;
  judgeModel: string;
  runDate: string;
}): string {
  const { score: s, results } = input;
  const gate = checkGates(s, input.gates);
  const out: string[] = [];

  out.push('# Compaction rung 3 — post-compaction answerability');
  out.push('');
  out.push(`Run ${input.runDate} · model \`${input.model}\` · judge \`${input.judgeModel}\``);
  out.push('');
  out.push('| arm | answerable | recalled | lost | confabulated | uncertain | abstained ok |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const arm of ['verbatim', 'compacted'] as const) {
    const a = s.byArm[arm];
    out.push(
      `| ${arm} | ${a.answerable} | ${a.recalled} | ${a.lost} | ${a.confabulated} | ${a.uncertain} | ${a.abstainedCorrectly}/${a.unanswerable} |`,
    );
  }
  out.push('');
  out.push(
    `**Recall loss vs verbatim:** ${s.recallLoss === null ? 'n/a (no control arm)' : pct(s.recallLoss)} ` +
      `· **confabulation:** ${pct(s.confabulationRate)} ` +
      `· **abstention:** ${pct(s.abstentionRate)} ` +
      `· **tokens saved:** ${pct(s.tokenReduction)}`,
  );
  out.push('');
  out.push(gate.passed ? '**GATE: PASS**' : `**GATE: FAIL** — ${gate.failures.join('; ')}`);

  if (s.skipped.length > 0) {
    out.push('');
    out.push('## Skipped');
    // Never silent: a conversation rung 3 declined is not a conversation that
    // passed, and a bench that omits them reads as broader coverage than it had.
    for (const skip of s.skipped) out.push(`- ${skip}`);
  }

  out.push('');
  out.push('## Misses');
  const misses = results.flatMap((c) =>
    c.results.filter((r) => r.arm === 'compacted' && r.verdict !== 'correct' && r.verdict !== 'abstained-correctly'),
  );
  if (misses.length === 0) out.push('_None._');
  for (const m of misses) {
    out.push(`- **${m.needleId}** (${m.verdict}) — ${m.question}`);
    out.push(`  - answered: ${truncate(m.answer, 200)}`);
    out.push(`  - judge: ${m.reason}`);
  }

  out.push('');
  out.push('## Summaries produced');
  for (const c of results) {
    if (c.summary.length === 0) continue;
    out.push('');
    out.push(
      `### ${c.conversation} — ${c.messagesBefore}→${c.messagesAfter} messages, ` +
        `~${c.tokensBefore.toLocaleString('en-US')}→${c.tokensAfter.toLocaleString('en-US')} tokens`,
    );
    out.push('');
    out.push('```');
    out.push(truncate(c.summary, 4_000));
    out.push('```');
  }

  return `${out.join('\n')}\n`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
