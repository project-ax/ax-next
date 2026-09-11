/**
 * The orchestrator's production route: through a registered `llm:call:<provider>`
 * hook rather than a fetch client holding its own API key.
 *
 * That swap is the point. The provider plugin already resolves a credential
 * per call (user key → global key → env), so the orchestrator stops needing a
 * dedicated key, a dedicated env var and a dedicated chart value — an operator
 * who stores an OpenRouter key in the credentials UI gets the orchestrator
 * with no deploy at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeAgentContext } from '@ax/core';
import type { AgentContext, HookBus } from '@ax/core';

import { makeBusOrchestratorClient } from '../orchestrator-client.js';

const ctx: AgentContext = makeAgentContext({
  sessionId: 's1',
  agentId: 'a1',
  userId: 'u1',
});

function busWith(
  services: Record<string, unknown>,
  call = vi.fn(),
): HookBus {
  return {
    hasService: (name: string) => name in services,
    call,
  } as unknown as HookBus;
}

describe('makeBusOrchestratorClient', () => {
  it('translates a completion into one llm:call and back', async () => {
    const call = vi.fn().mockResolvedValue({
      text: 'plan',
      stopReason: 'end_turn',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    const client = makeBusOrchestratorClient(
      busWith({ 'llm:call:openrouter': true }, call),
      ctx,
      { hook: 'llm:call:openrouter', model: 'x-ai/grok-4-fast' },
    );

    const out = await client!.complete({ system: 'SYS', user: 'USR' });

    expect(out).toEqual({ text: 'plan', usage: { in: 11, out: 7 } });
    expect(call).toHaveBeenCalledTimes(1);
    const [hook, gotCtx, input] = call.mock.calls[0]!;
    expect(hook).toBe('llm:call:openrouter');
    expect(gotCtx).toBe(ctx);
    // A BARE provider-native id: the hook name already encodes the provider,
    // so a prefixed `openrouter/...` ref would be routed twice.
    expect(input).toEqual({
      model: 'x-ai/grok-4-fast',
      maxTokens: 512,
      system: 'SYS',
      messages: [{ role: 'user', content: 'USR' }],
    });
  });

  it('is undefined when the provider hook is not registered', () => {
    // A deployment with no OpenRouter plugin must degrade to BM25, not throw
    // missing-service on every memory_search.
    expect(
      makeBusOrchestratorClient(busWith({}), ctx, {
        hook: 'llm:call:openrouter',
        model: 'x-ai/grok-4-fast',
      }),
    ).toBeUndefined();
  });

  it('is undefined when no hook or no model is configured', () => {
    const bus = busWith({ 'llm:call:openrouter': true });
    expect(makeBusOrchestratorClient(bus, ctx, undefined)).toBeUndefined();
    expect(makeBusOrchestratorClient(bus, ctx, { model: 'm' })).toBeUndefined();
    expect(
      makeBusOrchestratorClient(bus, ctx, { hook: 'llm:call:openrouter' }),
    ).toBeUndefined();
  });

  it('lets a call failure propagate, for the caller to turn into BM25', async () => {
    // The provider throws `no-openrouter-credential` when nothing holds a key.
    // That is the ordinary case on a deployment that never configured one, and
    // memory_search's own try/catch is what turns it into the BM25 fallback —
    // so this client must not swallow it into a bogus empty completion.
    const call = vi.fn().mockRejectedValue(new Error('no-openrouter-credential'));
    const client = makeBusOrchestratorClient(
      busWith({ 'llm:call:openrouter': true }, call),
      ctx,
      { hook: 'llm:call:openrouter', model: 'x-ai/grok-4-fast' },
    );

    await expect(client!.complete({ system: 's', user: 'u' })).rejects.toThrow(
      'no-openrouter-credential',
    );
  });
});
