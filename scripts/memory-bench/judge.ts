// Moved from the deleted `@ax/memory-strata` package's bench harness (TASK-608
// deleted packages/memory-strata; trimmed copy of the old
// `packages/memory-strata/test/bench/judge.ts`, prompt text byte-identical).
// Used by `scripts/memory-product-e2e.mjs` and `scripts/memory-lifetime-soak.mjs`
// to LLM-judge an agent's answer against a LongMemEval-S gold answer. Dropped
// `makeOpenRouterJudgeClient` and its `openai` import/`withRetry` dependency —
// both harnesses already build and pass their own `JudgeClient`, so this file
// pulls in no new dependency.

export type Verdict =
  | 'correct'
  | 'incorrect'
  | 'abstained-correctly'
  | 'abstained-incorrectly'
  | 'uncertain';

export interface JudgeClient {
  complete(args: { system: string; user: string }): Promise<{ text: string; usage: { in: number; out: number } }>;
}

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
  usage: { in: number; out: number };
}

const SYSTEM = `You are an evaluation judge. Score whether an answer matches the gold answer.

Respond in EXACTLY this format on two lines:
VERDICT: <correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain>
REASON: <one short sentence>

Scoring rules:
- "correct": the agent's answer matches the gold answer.
- "incorrect": the agent's answer contradicts the gold or is materially wrong.
- "abstained-correctly": the question is marked Unanswerable (gold is an "I don't know"-style refusal) AND the agent refused to answer (e.g., "I don't know" or "the memory does not contain this").
- "abstained-incorrectly": the agent refused to answer ("I don't know"-style) but the question is answerable (Unanswerable: false) — a missed retrieval.
- "uncertain": you cannot tell from the gold whether the agent is right (partial answers, ambiguous gold).`;

const VERDICT_RE = /VERDICT:\s*(correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain)/i;

export async function judgeAnswer(
  client: JudgeClient,
  question: string,
  goldAnswer: string,
  agentAnswer: string,
  opts: { unanswerable: boolean } = { unanswerable: false },
): Promise<JudgeResult> {
  const user = `Unanswerable: ${opts.unanswerable}\nQuestion: ${question}\nGold answer: ${goldAnswer}\nAgent answer: ${agentAnswer}`;
  const resp = await client.complete({ system: SYSTEM, user });
  const verdictMatch = resp.text.match(VERDICT_RE);
  const reasonMatch = resp.text.match(/REASON:\s*(.+)/i);
  const verdict: Verdict = verdictMatch ? (verdictMatch[1]!.toLowerCase() as Verdict) : 'uncertain';
  const reason = reasonMatch ? reasonMatch[1]!.trim() : resp.text.trim();
  return { verdict, reason, usage: resp.usage };
}
