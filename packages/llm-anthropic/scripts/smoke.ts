// Manual smoke test — NOT wired into `pnpm test` or CI.
//
// Makes one real call to api.anthropic.com. Requires ANTHROPIC_API_KEY to be
// set in the environment. Burns a tiny number of tokens. Run:
//
//   ANTHROPIC_API_KEY=sk-ant-... pnpm tsx packages/llm-anthropic/scripts/smoke.ts
//
// If this starts silently running in CI, something is wrong.

import { HookBus, makeChatContext, type LlmRequest, type LlmResponse } from '@ax/core';
import { llmAnthropicPlugin } from '../src/plugin.js';

async function main(): Promise<void> {
  const bus = new HookBus();
  const plugin = llmAnthropicPlugin();
  await plugin.init({ bus, config: {} });

  const res = await bus.call<LlmRequest, LlmResponse>(
    'llm:call',
    makeChatContext({ sessionId: 'smoke', agentId: 'smoke', userId: 'smoke', workspaceRoot: process.cwd() }),
    { messages: [{ role: 'user', content: 'Say hi in one word.' }] },
  );

  process.stdout.write(`assistant: ${res.assistantMessage.content}\n`);
  process.stdout.write(`toolCalls: ${JSON.stringify(res.toolCalls)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`smoke failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
