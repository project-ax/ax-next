import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext, type AgentOutcome, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import { createMemoryStrataPlugin } from '../plugin.js';

// PR 2 (host-side runner + model selection): `agents_v1_agents.model` now stores a
// `provider/model-id` REF (`anthropic/claude-sonnet-4-6`), while `LlmCallInput.model`
// — the input to the `llm:call:*` hook — stays a BARE, provider-native id. The
// `provider/` half is a routing coordinate: it selects WHICH `llm:call:<provider>`
// hook we call, and the hook name already encodes it, so carrying it in the payload
// too would be a second source of truth (and, for `llm:call:anthropic`, would be
// forwarded verbatim to the Anthropic SDK and 404 on every turn).
//
// These tests pin that split on the two agent-model-derived paths (the Observer
// here; the map densifier shares the same `resolveAgent` helper).

// Large enough that the consolidation debounce timer can never auto-fire inside a
// test — so every captured `llm:call` below comes from the Observer, not from a
// consolidation pass's densifier. (Same posture as plugin.test.ts.)
const CONSOLIDATOR_DEBOUNCE_NO_AUTOFIRE_MS = 600_000;

const EXTRACTION_JSON = JSON.stringify([
  { fact: 'User prefers React.', subject: 'react', factType: 'preference', confidence: 0.9 },
]);

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memory-strata-model-ref-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** Register an `llm:call:<provider>` stub that records every input it is handed. */
function registerLlmProvider(bus: HookBus, hook: string): LlmCallInput[] {
  const seen: LlmCallInput[] = [];
  bus.registerService<LlmCallInput, LlmCallOutput>(hook, `test-${hook}`, async (_ctx, input) => {
    seen.push(input);
    return {
      text: EXTRACTION_JSON,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  });
  return seen;
}

function buildBus(agentModelRef: string): HookBus {
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'test-agents', async () => ({
    agent: { model: agentModelRef },
  }));
  bus.registerService('tool:register', 'test-tool-dispatcher', async () => ({ ok: true as const }));
  return bus;
}

const OUTCOME: AgentOutcome = {
  kind: 'complete',
  messages: [
    { role: 'user', content: 'I prefer React.' },
    { role: 'assistant', content: 'Noted.' },
  ],
};

/** Fire one chat:end and await the detached Observer chain (agents:resolve → llm:call). */
async function runOneTurn(bus: HookBus): Promise<void> {
  let settleObserver: ((agentId: string) => Promise<void>) | undefined;
  const plugin = createMemoryStrataPlugin({
    consolidatorDebounceMs: CONSOLIDATOR_DEBOUNCE_NO_AUTOFIRE_MS,
    testHooks: {
      onObserverSettleReady(s) { settleObserver = s; },
    },
  });
  await plugin.init?.({ bus, config: {} });
  const ctx = makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
    workspace: { rootPath: workspaceRoot },
  });
  await bus.fire('chat:end', ctx, { outcome: OUTCOME });
  await settleObserver!(ctx.agentId);
}

describe('agent model ref → llm:call provider routing', () => {
  it('strips the provider prefix: llm:call:anthropic receives the BARE model id', async () => {
    const bus = buildBus('anthropic/claude-sonnet-4-6');
    const anthropicCalls = registerLlmProvider(bus, 'llm:call:anthropic');

    await runOneTurn(bus);

    expect(anthropicCalls).toHaveLength(1);
    // The input the provider hook ACTUALLY saw — `llm-anthropic` forwards this
    // straight to the SDK, so a `provider/` prefix here is a 404 per turn.
    expect(anthropicCalls[0]!.model).toBe('claude-sonnet-4-6');
  });

  it('routes to llm:call:<provider> named by the ref when that service is registered', async () => {
    const bus = buildBus('openrouter/some-model');
    const anthropicCalls = registerLlmProvider(bus, 'llm:call:anthropic');
    const openrouterCalls = registerLlmProvider(bus, 'llm:call:openrouter');

    await runOneTurn(bus);

    expect(openrouterCalls).toHaveLength(1);
    expect(openrouterCalls[0]!.model).toBe('some-model');
    expect(anthropicCalls).toHaveLength(0);
  });

  it('degrades cleanly when the ref names a provider with no registered llm:call hook', async () => {
    const bus = buildBus('openrouter/some-model');
    const anthropicCalls = registerLlmProvider(bus, 'llm:call:anthropic');

    // No throw out of chat:end, and — the worst outcome — no silent fallback to
    // a DIFFERENT provider than the one the agent selected.
    await expect(runOneTurn(bus)).resolves.toBeUndefined();
    expect(anthropicCalls).toHaveLength(0);
  });
});
