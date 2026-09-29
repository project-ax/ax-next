import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { makeAgentContext, createLogger, type AgentContext, type Logger } from '../context.js';
import { fireLlmUsage, LLM_USAGE_HOOK, type LlmUsageEvent } from '../llm.js';

// TASK-692: `fireLlmUsage` is how a host-side provider plugin (llm-anthropic,
// llm-openrouter) reports what a helper call cost. Metering must never fail the
// call it is metering, so the helper NEVER throws.

const EVENT: LlmUsageEvent = {
  model: 'anthropic/claude-haiku-4-5',
  usage: { inputTokens: 120, outputTokens: 30 },
};

function ctxWithLogger(logger: Logger): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger });
}

function spyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = {
    ...createLogger({ reqId: 'test', writer: () => {} }),
    warn,
  };
  return { logger, warn };
}

describe('fireLlmUsage', () => {
  it('names the hook llm:usage', () => {
    expect(LLM_USAGE_HOOK).toBe('llm:usage');
  });

  it('delivers the payload and the caller ctx to a subscriber', async () => {
    const bus = new HookBus();
    const seen: Array<{ ctx: AgentContext; payload: LlmUsageEvent }> = [];
    bus.subscribe<LlmUsageEvent>(LLM_USAGE_HOOK, 'meter', async (ctx, payload) => {
      seen.push({ ctx, payload });
      return undefined;
    });
    const ctx = ctxWithLogger(spyLogger().logger);

    await fireLlmUsage(bus, ctx, EVENT);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.ctx).toBe(ctx);
    expect(seen[0]!.payload).toEqual(EVENT);
  });

  it('resolves when nobody subscribes', async () => {
    const bus = new HookBus();
    await expect(
      fireLlmUsage(bus, ctxWithLogger(spyLogger().logger), EVENT),
    ).resolves.toBeUndefined();
  });

  it('does not throw when a subscriber throws', async () => {
    const bus = new HookBus();
    bus.subscribe(LLM_USAGE_HOOK, 'boom', async () => {
      throw new Error('subscriber exploded');
    });
    await expect(
      fireLlmUsage(bus, ctxWithLogger(spyLogger().logger), EVENT),
    ).resolves.toBeUndefined();
  });

  it('does not throw when a subscriber rejects', async () => {
    const bus = new HookBus();
    bus.subscribe(LLM_USAGE_HOOK, 'rejecter', () => Promise.reject(new Error('nope')));
    await expect(
      fireLlmUsage(bus, ctxWithLogger(spyLogger().logger), EVENT),
    ).resolves.toBeUndefined();
  });

  it('does not throw and logs llm_usage_report_failed when bus.fire itself rejects', async () => {
    const boom = new Error('bus down');
    const bus = { fire: vi.fn(() => Promise.reject(boom)) } as unknown as HookBus;
    const { logger, warn } = spyLogger();

    await expect(fireLlmUsage(bus, ctxWithLogger(logger), EVENT)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('llm_usage_report_failed');
    expect(warn.mock.calls[0]![1]).toMatchObject({ err: boom });
  });

  it('does not throw and logs when bus.fire throws synchronously', async () => {
    const boom = new Error('sync bus failure');
    const bus = {
      fire: vi.fn(() => {
        throw boom;
      }),
    } as unknown as HookBus;
    const { logger, warn } = spyLogger();

    await expect(fireLlmUsage(bus, ctxWithLogger(logger), EVENT)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('llm_usage_report_failed', expect.objectContaining({ err: boom }));
  });

  it('does not throw even when the failure log itself throws', async () => {
    const bus = { fire: vi.fn(() => Promise.reject(new Error('x'))) } as unknown as HookBus;
    const logger: Logger = {
      ...createLogger({ reqId: 'test', writer: () => {} }),
      warn: () => {
        throw new Error('logger broke');
      },
    };
    await expect(fireLlmUsage(bus, ctxWithLogger(logger), EVENT)).resolves.toBeUndefined();
  });
});
