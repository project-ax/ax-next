/**
 * THROWAWAY (spike, 2026-09-16). Re-scores a hindsight LongMemEval results.json with
 * dem-memory's OWN judge — same model, same prompt, same verdict vocabulary as
 * bench/run.ts — so hindsight's rows drop straight into the HANDOFF.md table.
 *
 * Hindsight judges with category-specific prompts and a bare correct/incorrect bool,
 * which is not comparable to our five-way verdict (it has no abstained-correctly), so
 * its own is_correct is recorded for reference but never used for scoring.
 *
 *   npx tsx bench/rejudge-hindsight.ts <results.json> --out <rows.jsonl>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { OpenRouterLlm } from "./llm.js";
import { loadCorpus, parseArgs } from "./harness.js";

const JUDGE_SYSTEM = `You are an evaluation judge. Score whether an answer matches the gold answer.

Respond in EXACTLY this format on two lines:
VERDICT: <correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain>
REASON: <one short sentence>

Scoring rules:
- "correct": the agent's answer matches the gold answer.
- "incorrect": the agent's answer contradicts the gold or is materially wrong.
- "abstained-correctly": the question is marked Unanswerable (gold is an "I don't know"-style refusal) AND the agent refused to answer (e.g., "I don't know" or "the memory does not contain this").
- "abstained-incorrectly": the agent refused to answer ("I don't know"-style) but the question is answerable (Unanswerable: false) — a missed retrieval.
- "uncertain": you cannot tell from the gold whether the agent is right (partial answers, ambiguous gold).`;

const VERDICT_RE =
  /VERDICT:\s*(correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain)/i;

interface HindsightDetail {
  question: string;
  correct_answer: string;
  predicted_answer: string;
  is_correct?: boolean | null;
  correctness_reasoning?: string;
}
interface HindsightItem {
  item_id: string;
  metrics?: { detailed_results?: HindsightDetail[] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = process.argv[2];
  if (!path || path.startsWith("--")) throw new Error("usage: rejudge-hindsight.ts <results.json> --out <rows.jsonl>");
  const out = args.out ?? path.replace(/\.json$/, "") + ".rejudged.jsonl";

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const judge = new OpenRouterLlm({ apiKey, model: args["judge-model"] ?? "x-ai/grok-4.3", reasoningEffort: "low" });

  // question_type lives in the corpus, not in hindsight's results file.
  const byId = new Map(loadCorpus().map((s) => [s.question_id, s]));

  const parsed = JSON.parse(readFileSync(path, "utf8")) as { item_results?: HindsightItem[] };
  const items = parsed.item_results ?? [];
  const rows: unknown[] = [];

  for (const item of items) {
    const detail = item.metrics?.detailed_results?.[0];
    const sample = byId.get(item.item_id);
    if (!detail || !sample) {
      console.warn(`skip ${item.item_id}: ${!detail ? "no detailed_results" : "not in corpus"}`);
      continue;
    }
    const unanswerable = item.item_id.endsWith("_abs");
    const judged = await judge.chat({
      system: JUDGE_SYSTEM,
      user: `Unanswerable: ${unanswerable}\nQuestion: ${sample.question}\nGold answer: ${sample.answer}\nAgent answer: ${detail.predicted_answer}`,
      maxTokens: 120,
    });
    const verdict = judged.text.match(VERDICT_RE)?.[1]?.toLowerCase() ?? "uncertain";
    const row = {
      question_id: item.item_id,
      question_type: sample.question_type,
      verdict,
      reason: (judged.text.match(/REASON:\s*(.+)/i)?.[1] ?? judged.text.trim()).slice(0, 200),
      answer: detail.predicted_answer,
      hindsight_is_correct: detail.is_correct ?? null,
      hindsight_reasoning: (detail.correctness_reasoning ?? "").slice(0, 200),
    };
    rows.push(row);
    console.log(`${item.item_id.padEnd(20)} ${String(sample.question_type).padEnd(26)} ${verdict.padEnd(22)} (hindsight said ${detail.is_correct})`);
  }

  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nwrote ${rows.length} rows -> ${out}`);
}

void main();
