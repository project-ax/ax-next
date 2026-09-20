// Shared test harness: a REAL HookBus with the plugin initialized on it, plus
// a minimal AgentContext. Every suite drives the hooks through `bus.call`
// rather than calling a handler directly — the bus is where the payload
// actually arrives from another plugin, and it is also what turns a thrown
// non-PluginError into a `code: 'unknown'` one. Testing the handler in
// isolation would not see either.

import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';
import { createEmbeddingsPlugin, type EmbeddingsConfig } from '../plugin.js';

export const ctx: AgentContext = makeAgentContext({
  sessionId: 's',
  agentId: 'a',
  userId: 'u',
  workspace: { rootPath: '/tmp' },
});

/** A bus with `@ax/embeddings` initialized on it. */
export async function busWithPlugin(config?: EmbeddingsConfig): Promise<HookBus> {
  const bus = new HookBus();
  await createEmbeddingsPlugin(config).init({ bus, config: {} });
  return bus;
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function l2(v: readonly number[]): number {
  return Math.hypot(...v);
}
