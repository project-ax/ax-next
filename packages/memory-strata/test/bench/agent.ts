import type { BenchQuestion, RetrievedDoc } from './types.js';
import Anthropic from '@anthropic-ai/sdk';

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

export async function runAgent(
  client: AgentClient,
  question: BenchQuestion,
  retrieved: RetrievedDoc[],
): Promise<AgentResponse> {
  const memoryBlock = retrieved
    .map((d, i) => `[${i + 1}] (${d.path}) ${d.summary}`)
    .join('\n');
  const system = `${SYSTEM_PROMPT_PREAMBLE}\n\n## Memory snippets\n${memoryBlock}`;
  const user = question.text;
  return client.complete({ system, user });
}

export function makeAnthropicAgentClient(apiKey: string, model = 'claude-sonnet-4-6'): AgentClient {
  const a = new Anthropic({ apiKey });
  return {
    async complete({ system, user }) {
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
  };
}
