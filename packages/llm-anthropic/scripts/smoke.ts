// Manual smoke script — NOT run in CI.
//
// Runs one real call against api.anthropic.com using the locally-set
// ANTHROPIC_API_KEY. One-time verification per Week 4-6 PR that the
// plugin's SDK wiring actually produces a usable response against the
// live provider.
//
// Usage:
//   ANTHROPIC_API_KEY=<your-key> \
//     node --import tsx/esm packages/llm-anthropic/scripts/smoke.ts
//
// Or after build:
//   ANTHROPIC_API_KEY=<your-key> \
//     node packages/llm-anthropic/dist/scripts/smoke.js
//
// Do NOT wire this into any pnpm script. Do NOT commit captured output
// (it contains model responses which may include the key if the SDK ever
// echoed it back in an error — unlikely but not impossible).

import { HookBus, makeAgentContext, createLogger, type LlmRequest, type LlmResponse } from '@ax/core';
import { createLlmAnthropicPlugin } from '../src/plugin.js';

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY must be set to run this smoke script.');
    process.exit(1);
  }
  const bus = new HookBus();
  await createLlmAnthropicPlugin({ maxTokens: 128 }).init({ bus, config: {} });
  const ctx = makeAgentContext({
    sessionId: 'smoke',
    agentId: 'smoke',
    userId: 'smoke',
    logger: createLogger({ reqId: 'smoke', writer: () => {} }),
  });
  const req: LlmRequest = {
    messages: [{ role: 'user', content: 'Reply with exactly the word: ready.' }],
  };
  const res = await bus.call<LlmRequest, LlmResponse>('llm:call', ctx, req);
  console.log('assistantMessage.content:', JSON.stringify(res.assistantMessage.content));
  console.log('toolCalls.length:', res.toolCalls.length);
  if (typeof res.assistantMessage.content !== 'string' || res.assistantMessage.content.length === 0) {
    console.error('FAIL: empty assistant message');
    process.exit(2);
  }
  console.log('OK');
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(3);
});
