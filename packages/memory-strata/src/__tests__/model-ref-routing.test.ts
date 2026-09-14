import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext, type AgentOutcome, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import { createMemoryStrataPlugin } from '../plugin.js';

// A `provider/model-id` REF selects WHICH `llm:call:<provider>` hook is called,
// while `LlmCallInput.model` stays a BARE, provider-native id. The `provider/`
// half is a routing coordinate the hook name already encodes; carrying it in the
// payload too would be a second source of truth, and a provider that forwards
// the payload verbatim to its SDK would 404 on every turn.
//
// WHAT CHANGED 2026-09-14: the ref these paths read is no longer the calling
// AGENT's model. Observer extraction and map densification are pinned to the
// memory-ops role (`DEFAULT_MEMORY_OPS_MODEL`), because memory extraction is a
// fixed internal job — letting it follow whatever model a user picked for chat
// meant memory quality and cost were unstatable, and varied per user. The
// ref-splitting contract above is unchanged; only its SOURCE moved.

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
async function runOneTurn(
  bus: HookBus,
  cfg: { memoryOpsModel?: string } = {},
): Promise<void> {
  let settleObserver: ((agentId: string) => Promise<void>) | undefined;
  const plugin = createMemoryStrataPlugin({
    consolidatorDebounceMs: CONSOLIDATOR_DEBOUNCE_NO_AUTOFIRE_MS,
    ...cfg,
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

describe('memory-ops model ref → llm:call provider routing', () => {
  it('strips the provider prefix: the hook receives the BARE model id', async () => {
    const bus = buildBus('anthropic/claude-sonnet-4-6');
    const calls = registerLlmProvider(bus, 'llm:call:vendor');

    await runOneTurn(bus, { memoryOpsModel: 'vendor/some/model-id' });

    expect(calls).toHaveLength(1);
    // Everything after the FIRST slash is the model id — a two-slash ref like
    // `openrouter/z-ai/glm-5.3-flash:nitro` must keep `z-ai/` in the payload,
    // since that is part of the vendor slug and not a provider coordinate.
    expect(calls[0]!.model).toBe('some/model-id');
  });

  it('IGNORES the calling agent model and uses the memory-ops role', async () => {
    // The regression this file now exists to prevent. The agent is on a
    // different provider entirely; memory extraction must not follow it.
    const bus = buildBus('anthropic/claude-sonnet-4-6');
    const anthropicCalls = registerLlmProvider(bus, 'llm:call:anthropic');
    const openrouterCalls = registerLlmProvider(bus, 'llm:call:openrouter');

    await runOneTurn(bus, { memoryOpsModel: 'openrouter/z-ai/glm-5.3-flash:nitro' });

    expect(openrouterCalls).toHaveLength(1);
    expect(openrouterCalls[0]!.model).toBe('z-ai/glm-5.3-flash:nitro');
    expect(anthropicCalls).toHaveLength(0);
  });

  it('pins reasoningEffort to minimal on every memory-ops call', async () => {
    // Applied by the builder, not the call sites, so a new memory operation
    // cannot forget it. GLM reasons by DEFAULT and these paths have hard
    // timeouts whose overrun degrades SILENTLY (a dropped observation), which
    // is exactly the shape that hides a slow model.
    const bus = buildBus('anthropic/claude-sonnet-4-6');
    const calls = registerLlmProvider(bus, 'llm:call:openrouter');

    await runOneTurn(bus, { memoryOpsModel: 'openrouter/z-ai/glm-5.3-flash:nitro' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.reasoningEffort).toBe('minimal');
  });

  it('degrades cleanly when the role names a provider with no registered llm:call hook', async () => {
    const bus = buildBus('anthropic/claude-sonnet-4-6');
    const anthropicCalls = registerLlmProvider(bus, 'llm:call:anthropic');

    // No throw out of chat:end, and — the worst outcome — no silent fallback to
    // a DIFFERENT provider than the one configured.
    await expect(
      runOneTurn(bus, { memoryOpsModel: 'nobody-registered-this/some-model' }),
    ).resolves.toBeUndefined();
    expect(anthropicCalls).toHaveLength(0);
  });

  it('degrades cleanly when the configured ref is not a ref at all', async () => {
    const bus = buildBus('anthropic/claude-sonnet-4-6');
    const openrouterCalls = registerLlmProvider(bus, 'llm:call:openrouter');

    await expect(runOneTurn(bus, { memoryOpsModel: 'bare-id-no-provider' })).resolves.toBeUndefined();
    expect(openrouterCalls).toHaveLength(0);
  });
});
