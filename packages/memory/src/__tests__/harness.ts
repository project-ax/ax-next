import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext, type AgentContext, type Plugin } from '@ax/core';
import { createMemoryFactsSqlitePlugin } from '@ax/memory-facts-sqlite';

import { createMemoryPlugin, type MemoryPluginConfig } from '../plugin.js';
import type {
  MemoryForgetInput,
  MemoryForgetOutput,
  MemoryRecallInput,
  MemoryRecallOutput,
  MemoryRememberInput,
  MemoryRememberOutput,
} from '../types.js';

/**
 * The integration harness: `@ax/memory` over the REAL sqlite engine on a real
 * `HookBus`.
 *
 * Deliberately not a mock. TASK-434's mutation pass found that every channel
 * test called the function directly and NONE covered its wiring, so a mutation
 * to the wiring reddened nothing. The properties this card owes — provenance
 * by hook, owner scoping, the speaker rewrite surviving a round trip — are
 * properties of the two plugins TOGETHER, and a stub that answers whatever we
 * hand it cannot observe any of them.
 *
 * A stub bus is still the right tool for the engine-response edge cases (a
 * `null` return, a missing service), and `engine-contract.test.ts` uses one
 * there for exactly that reason.
 *
 * Note this file imports `@ax/memory-facts-sqlite` as a VALUE. That is legal
 * here and only here: `eslint.config.mjs` turns the cross-plugin import rule
 * off under every package's `src/__tests__` tree, because the test graph is
 * not the production graph. `src/` must reach the engine through the bus, and
 * does.
 */
export interface MemoryHarness {
  bus: HookBus;
  ctx: (opts?: { agentId?: string; userId?: string; conversationId?: string; source?: 'routine' | 'user'; sessionId?: string }) => AgentContext;
  recall: (input: MemoryRecallInput, ctx?: AgentContext) => Promise<MemoryRecallOutput>;
  remember: (input: MemoryRememberInput, ctx?: AgentContext) => Promise<MemoryRememberOutput>;
  forget: (input: MemoryForgetInput, ctx?: AgentContext) => Promise<MemoryForgetOutput>;
  memoryPlugin: Plugin;
  teardown: () => Promise<void>;
}

export const DEFAULT_AGENT = 'agent-1';
export const ALICE = 'user-alice';
export const BOB = 'user-bob';

export async function makeMemoryHarness(
  config: MemoryPluginConfig = {},
): Promise<MemoryHarness> {
  const bus = new HookBus();
  const dir = await mkdtemp(join(tmpdir(), 'ax-memory-'));
  const engine = createMemoryFactsSqlitePlugin({ databasePath: join(dir, 'facts.db') });
  await engine.init({ bus, config: {} });

  const memoryPlugin = createMemoryPlugin(config);
  await memoryPlugin.init({ bus, config: {} });

  const ctx: MemoryHarness['ctx'] = (opts = {}) =>
    makeAgentContext({
      sessionId: opts.sessionId ?? 'session-1',
      agentId: opts.agentId ?? DEFAULT_AGENT,
      userId: opts.userId ?? ALICE,
      workspace: { rootPath: '/tmp' },
      ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
    });

  return {
    bus,
    ctx,
    memoryPlugin,
    recall: (input, c) => bus.call<MemoryRecallInput, MemoryRecallOutput>('memory:recall', c ?? ctx(), input),
    remember: (input, c) =>
      bus.call<MemoryRememberInput, MemoryRememberOutput>('memory:remember', c ?? ctx(), input),
    forget: (input, c) =>
      bus.call<MemoryForgetInput, MemoryForgetOutput>('memory:forget', c ?? ctx(), input),
    teardown: async () => {
      await engine.shutdown?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Read a row straight out of the engine, bypassing `@ax/memory`'s owner
 * scoping, so a test can prove a row EXISTS and is still active even though
 * the product layer refuses to show it to the caller under test.
 *
 * Without this, "owner B cannot see it" and "the row was destroyed" are the
 * same observation, and only one of them is what we mean.
 */
export async function engineRecall(
  bus: HookBus,
  ctx: AgentContext,
  input: { about?: string; limit: number; activeOnly?: boolean },
): Promise<{ statements: Array<{ id: string; until?: string }>; degraded: string[] }> {
  return bus.call('memory:facts:recall', ctx, input);
}
