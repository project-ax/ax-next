import type { BenchQuestion, MarkdownDoc, RetrievedDoc } from './types.js';
import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './retry.js';

export interface AgentClient {
  complete(args: { system: string; user: string }): Promise<{ text: string; usage: { in: number; out: number } }>;
}

export interface AgentResponse {
  text: string;
  usage: { in: number; out: number };
}

const SYSTEM_PROMPT_PREAMBLE = `You are an assistant answering a question using ONLY the provided memory snippets.
If the snippets do not contain the answer, say "I don't know."
Be concise.`;

/**
 * Per-doc character budget for bodies injected into the answer prompt.
 *
 * Was 2000, which was starving the measurement. The median LongMemEval-S gold
 * document is 14,424 chars, so the agent was answering from the first ~14% of
 * it: 99.6% of gold docs were cut, and on 17.0% of questions EVERY token of
 * the gold answer sat past the cut (`pnpm bench:diag-truncation`).
 *
 * Measured 2026-09-12, control vs treatment on the same stratified n=150:
 * accuracy 36.7% -> 60.7% (+24.0pp, z=4.16) and false-refusal 51.0% -> 19.6%
 * (z=-5.56), with recall@5 flat at ~90% because retrieval never changed. The
 * agent was not failing to reason; it was saying "I don't know" about evidence
 * that had been cut off.
 *
 * 20000 clears p99 (22,431) for most docs and the corpus max is 28,167 — a cap
 * still exists so one pathological document cannot blow up a prompt. The cost
 * is real: answer-model input tokens rise ~6x, and a full n=500 run goes from
 * roughly $5 to roughly $18. `AX_BENCH_MAX_BODY_CHARS` buys the old behaviour
 * back for a cheap run, and the cap is stamped into every report so two
 * numbers measured under different caps can never be silently compared.
 *
 * This is a BENCH property, not a product one. Production does not inject
 * fixed-size truncated bodies: `memory_search` returns snippets plus
 * matchedFacts and the agent drills in with `memory_read_section`. Bench
 * accuracy is a floor on product quality; `--mode e2e` is the faithful path.
 */
export const MAX_INJECTED_BODY_CHARS = Number(
  process.env.AX_BENCH_MAX_BODY_CHARS ?? 20000,
);

export function truncateBody(body: string, maxChars: number = MAX_INJECTED_BODY_CHARS): string {
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars) + '\n…[truncated]';
}

export async function runAgent(
  client: AgentClient,
  question: BenchQuestion,
  retrieved: RetrievedDoc[],
  memoryTree?: Map<string, MarkdownDoc>,
): Promise<AgentResponse> {
  const memoryBlock = retrieved
    .map((d, i) => {
      const doc = memoryTree?.get(d.path);
      const body = doc ? truncateBody(doc.body) : d.summary;
      return `[${i + 1}] (${d.path})\n${body}`;
    })
    .join('\n\n');
  const system = `${SYSTEM_PROMPT_PREAMBLE}\n\n## Memory snippets\n${memoryBlock}`;
  const user = question.text;
  return client.complete({ system, user });
}

export function makeAnthropicAgentClient(apiKey: string, model = 'claude-sonnet-4-6'): AgentClient {
  const a = new Anthropic({ apiKey });
  return {
    async complete({ system, user }) {
      return withRetry(
        async () => {
          const resp = await a.messages.create({
            model,
            max_tokens: 512,
            system,
            messages: [{ role: 'user', content: user }],
          });
          const text = resp.content
            .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('');
          return { text, usage: { in: resp.usage.input_tokens, out: resp.usage.output_tokens } };
        },
        { attempts: 4, baseDelayMs: 1000, label: 'anthropic-agent' },
      );
    },
  };
}
