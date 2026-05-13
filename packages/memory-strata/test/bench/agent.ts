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

const MAX_INJECTED_BODY_CHARS = 2000;

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
