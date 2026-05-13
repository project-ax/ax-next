import type { Verdict } from './types.js';
import OpenAI from 'openai';
import { withRetry } from './retry.js';

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
VERDICT: <correct|incorrect|uncertain>
REASON: <one short sentence>

Use "correct" only if the answer's meaning matches the gold answer. Use "incorrect" if the answer contradicts gold. Use "uncertain" if you cannot tell from the gold whether the answer is right (e.g., partial answers, ambiguous gold).`;

export async function judgeAnswer(
  client: JudgeClient,
  question: string,
  goldAnswer: string,
  agentAnswer: string,
): Promise<JudgeResult> {
  const user = `Question: ${question}\nGold answer: ${goldAnswer}\nAgent answer: ${agentAnswer}`;
  const resp = await client.complete({ system: SYSTEM, user });
  const verdictMatch = resp.text.match(/VERDICT:\s*(correct|incorrect|uncertain)/i);
  const reasonMatch = resp.text.match(/REASON:\s*(.+)/i);
  const verdict: Verdict = verdictMatch ? (verdictMatch[1]!.toLowerCase() as Verdict) : 'uncertain';
  const reason = reasonMatch ? reasonMatch[1]!.trim() : resp.text.trim();
  return { verdict, reason, usage: resp.usage };
}

export function makeOpenRouterJudgeClient(apiKey: string, model = 'x-ai/grok-4.3'): JudgeClient {
  const o = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1', timeout: 60_000 });
  return {
    async complete({ system, user }) {
      return withRetry(
        async () => {
          const resp = await o.chat.completions.create({
            model,
            max_tokens: 120,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          });
          const text = resp.choices[0]?.message?.content ?? '';
          const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
          return { text, usage: { in: usage.prompt_tokens, out: usage.completion_tokens } };
        },
        { attempts: 4, baseDelayMs: 1000, label: 'openrouter-judge' },
      );
    },
  };
}
