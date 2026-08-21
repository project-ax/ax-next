// ---------------------------------------------------------------------------
// Grading one post-compaction answer.
//
// Same shape as the memory-strata bench's judge, and for the same reason: a
// string comparison against the gold answer scores paraphrase as failure, and
// paraphrase is what a model recalling a fact from a summary actually produces.
//
// FIVE VERDICTS, NOT TWO. The distinction that earns its keep is between
// "answered wrongly" and "declined to answer": a compaction that quietly drops
// a fact should show up as `abstained-incorrectly`, and a compaction that
// causes CONFABULATION should show up as `incorrect`. Collapsing them into one
// number would hide which of those two happened, and they call for opposite
// fixes — the first says preserve more, the second says say less confidently.
// ---------------------------------------------------------------------------

export type Verdict =
  | 'correct'
  | 'incorrect'
  | 'abstained-correctly'
  | 'abstained-incorrectly'
  | 'uncertain';

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
}

/** Completes a prompt. Injected so the judge can be tested without a network. */
export type CompletionClient = (input: {
  instructions: string;
  prompt: string;
}) => Promise<string>;

export const JUDGE_INSTRUCTIONS = `You are an evaluation judge scoring whether an answer matches a gold answer.

Respond in EXACTLY this format, on two lines:
VERDICT: <correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain>
REASON: <one short sentence>

Scoring rules:
- "correct": the answer conveys the same fact as the gold answer. Paraphrase, extra detail, and different wording are all fine.
- "incorrect": the answer contradicts the gold answer or states something materially wrong. An answer that confidently invents a specific value is incorrect, not uncertain.
- "abstained-correctly": the question is marked Unanswerable AND the answer declines to answer (says it does not know, or that the conversation does not contain it).
- "abstained-incorrectly": the answer declines, but the question is answerable. This is a fact that was lost.
- "uncertain": the answer is too partial or ambiguous to score either way.`;

const VERDICT_RE =
  /VERDICT:\s*(correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain)/i;
const REASON_RE = /REASON:\s*(.+)/i;

/** Parse a judge completion. Unparseable output is `uncertain`, never a throw. */
export function parseVerdict(text: string): JudgeResult {
  const verdict = VERDICT_RE.exec(text);
  const reason = REASON_RE.exec(text);
  return {
    // An unparseable judgement is NOT scored as a failure of the thing being
    // judged. Counting judge flakiness as a compaction regression is how a
    // bench stops being trusted.
    verdict: verdict === null ? 'uncertain' : (verdict[1]!.toLowerCase() as Verdict),
    reason: reason === null ? text.trim().slice(0, 200) : reason[1]!.trim(),
  };
}

export async function judgeAnswer(input: {
  client: CompletionClient;
  question: string;
  gold: string;
  answer: string;
  unanswerable: boolean;
}): Promise<JudgeResult> {
  const text = await input.client({
    instructions: JUDGE_INSTRUCTIONS,
    prompt:
      `Unanswerable: ${input.unanswerable}\n` +
      `Question: ${input.question}\n` +
      `Gold answer: ${input.gold}\n` +
      `Answer: ${input.answer}`,
  });
  return parseVerdict(text);
}
