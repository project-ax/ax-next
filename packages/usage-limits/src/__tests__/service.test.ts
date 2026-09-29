import { describe, it, expect } from 'vitest';
import { makeAgentContext, type Logger } from '@ax/core';
import { createUsageService } from '../service.js';
import type { RecordedUsage, UsageStore } from '../store.js';
import { DEFAULT_LIMITS, type LimitsStore } from '../config.js';
import { costMicros } from '../pricing.js';

interface Line {
  level: string;
  msg: string;
  bindings?: Record<string, unknown>;
}

function capture(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const mk = (level: string) => (msg: string, bindings?: Record<string, unknown>) =>
    lines.push({ level, msg, ...(bindings !== undefined ? { bindings } : {}) });
  const logger: Logger = {
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    child: () => logger,
  };
  return { logger, lines };
}

function setup(opts: { admitThrows?: boolean; recordThrows?: boolean } = {}) {
  const recorded: Array<{ userId: string; usage: RecordedUsage }> = [];
  const admits: string[] = [];
  const store = {
    async admit({ userId }: { userId: string }) {
      if (opts.admitThrows) throw new Error('db down');
      admits.push(userId);
      return { ok: true } as const;
    },
    async record({ userId, usage }: { userId: string; usage: RecordedUsage }) {
      if (opts.recordThrows) throw new Error('db down');
      recorded.push({ userId, usage });
    },
  } as unknown as UsageStore;
  const limits: LimitsStore = {
    get: async () => ({ ...DEFAULT_LIMITS }),
    set: async () => ({ ...DEFAULT_LIMITS }),
  };
  const svc = createUsageService({ store, limits, now: () => new Date('2026-09-29T00:00:00Z') });
  const { logger, lines } = capture();
  const ctx = (userId = 'u1') =>
    makeAgentContext({ sessionId: 's', agentId: 'a', userId, logger });
  return { svc, recorded, admits, lines, ctx };
}

describe('admitTurn', () => {
  it('passes the store result through', async () => {
    const { svc, admits, ctx } = setup();
    expect(await svc.admitTurn(ctx())).toEqual({ ok: true });
    expect(admits).toEqual(['u1']);
  });

  it('refuses an empty userId without touching the store', async () => {
    const { svc, admits, ctx } = setup();
    expect(await svc.admitTurn(ctx(''))).toEqual({ ok: false, reason: 'usage-check-unavailable' });
    expect(admits).toEqual([]);
  });

  it('FAILS CLOSED when the store throws, and logs it', async () => {
    const { svc, lines, ctx } = setup({ admitThrows: true });
    expect(await svc.admitTurn(ctx())).toEqual({ ok: false, reason: 'usage-check-unavailable' });
    expect(lines.some((l) => l.level === 'error' && l.msg === 'usage_admit_failed')).toBe(true);
  });
});

describe('recordTurnEnd', () => {
  const usage = {
    model: 'anthropic/claude-sonnet-4-6',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 300,
  };

  it('charges the priced cost of a reported assistant turn', async () => {
    const { svc, recorded, ctx } = setup();
    await svc.recordTurnEnd(ctx(), { role: 'assistant', reason: 'complete', usage });
    expect(recorded).toEqual([
      {
        userId: 'u1',
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 5000,
          cacheWriteTokens: 300,
          costMicros: costMicros(usage.model, usage),
        },
      },
    ]);
  });

  it('charges zero for an all-zeros usage report (reported, not unknown)', async () => {
    const { svc, recorded, ctx } = setup();
    await svc.recordTurnEnd(ctx(), { role: 'assistant', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(recorded[0]!.usage.costMicros).toBe(0);
  });

  it('charges the assumed cost, with zero tokens, when usage is absent or null', async () => {
    const { svc, recorded, lines, ctx } = setup();
    await svc.recordTurnEnd(ctx(), { role: 'assistant', reason: 'complete' });
    await svc.recordTurnEnd(ctx(), { role: 'assistant', usage: null });
    expect(recorded.map((r) => r.usage)).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 250_000 },
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 250_000 },
    ]);
    expect(lines.filter((l) => l.msg === 'usage_unreported')).toHaveLength(2);
    expect(lines.find((l) => l.msg === 'usage_unreported')!.level).toBe('info');
  });

  it('treats a usage object with NO token figure in it as unreported, not as a free turn', async () => {
    // `{}` (or a bare model name) is not a measurement. Runner-core never sends
    // one, so seeing one means a runner that forgot the fields or a caller
    // trying to pay nothing: either way the flat assumed cost applies. Explicit
    // zeros (above) ARE a measurement and stay free.
    const { svc, recorded, ctx } = setup();
    await svc.recordTurnEnd(ctx(), { role: 'assistant', usage: {} });
    await svc.recordTurnEnd(ctx(), { role: 'assistant', usage: { model: 'anthropic/claude-sonnet-4-6' } });
    expect(recorded.map((r) => r.usage.costMicros)).toEqual([250_000, 250_000]);
  });

  it('charges nothing for tool / user / heartbeat turn-ends', async () => {
    const { svc, recorded, ctx } = setup();
    await svc.recordTurnEnd(ctx(), { role: 'tool', usage });
    await svc.recordTurnEnd(ctx(), { role: 'user' });
    await svc.recordTurnEnd(ctx(), { reason: 'complete' });
    await svc.recordTurnEnd(ctx(), null);
    await svc.recordTurnEnd(ctx(), 'garbage');
    expect(recorded).toEqual([]);
  });

  it('never lets hostile numbers reduce or corrupt the charge', async () => {
    const { svc, recorded, ctx } = setup();
    const hostile: unknown[] = [
      { inputTokens: -1_000_000, outputTokens: 0 },
      { inputTokens: Number.NaN, outputTokens: 1 },
      { inputTokens: '5', outputTokens: 1 },
      { inputTokens: 1.5, outputTokens: 1 },
      { inputTokens: 1e18, outputTokens: 0 },
      { inputTokens: Number.POSITIVE_INFINITY },
    ];
    for (const u of hostile) {
      await svc.recordTurnEnd(ctx(), { role: 'assistant', usage: u });
    }
    for (const r of recorded) {
      for (const v of Object.values(r.usage)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(costMicros(undefined, { inputTokens: 1e9, outputTokens: 1e9, cacheReadTokens: 1e9, cacheWriteTokens: 1e9 }));
      }
    }
    // A negative count is clamped to zero, never subtracted.
    expect(recorded[0]!.usage.inputTokens).toBe(0);
    // Unparseable reports are charged the flat assumed cost, not zero.
    expect(recorded[1]!.usage.costMicros).toBe(250_000);
    expect(recorded[2]!.usage.costMicros).toBe(250_000);
    expect(recorded[3]!.usage.costMicros).toBe(250_000);
    // Absurdly large counts are clamped to the per-field ceiling.
    expect(recorded[4]!.usage.inputTokens).toBe(1_000_000_000);
    expect(recorded[5]!.usage.costMicros).toBe(250_000);
  });

  it('prices an overlong model name as unknown (top tier) rather than dropping the tokens', async () => {
    const { svc, recorded, ctx } = setup();
    await svc.recordTurnEnd(ctx(), {
      role: 'assistant',
      usage: { model: 'x'.repeat(500), inputTokens: 1000, outputTokens: 0 },
    });
    expect(recorded[0]!.usage.costMicros).toBe(costMicros(undefined, { inputTokens: 1000, outputTokens: 0 }));
  });

  it('skips a turn with no user, and never throws when the store does', async () => {
    const a = setup();
    await a.svc.recordTurnEnd(a.ctx(''), { role: 'assistant', usage });
    expect(a.recorded).toEqual([]);
    const b = setup({ recordThrows: true });
    await expect(b.svc.recordTurnEnd(b.ctx(), { role: 'assistant', usage })).resolves.toBeUndefined();
    expect(b.lines.some((l) => l.level === 'error' && l.msg === 'usage_record_failed')).toBe(true);
  });
});

describe('recordLlmUsage', () => {
  it('charges a helper call with zero cache tokens', async () => {
    const { svc, recorded, ctx } = setup();
    await svc.recordLlmUsage(ctx(), {
      model: 'anthropic/claude-haiku-4-5',
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    expect(recorded).toEqual([
      {
        userId: 'u1',
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicros: costMicros('anthropic/claude-haiku-4-5', { inputTokens: 100, outputTokens: 10 }),
        },
      },
    ]);
  });

  it('skips silently without a user, ignores garbage, and never throws', async () => {
    const { svc, recorded, ctx } = setup();
    await svc.recordLlmUsage(ctx(''), { model: 'm', usage: { inputTokens: 1, outputTokens: 1 } });
    await svc.recordLlmUsage(ctx(), { model: 'm' });
    await svc.recordLlmUsage(ctx(), 42);
    expect(recorded).toEqual([]);
    const b = setup({ recordThrows: true });
    await expect(
      b.svc.recordLlmUsage(b.ctx(), { model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }),
    ).resolves.toBeUndefined();
    expect(b.lines.some((l) => l.level === 'error' && l.msg === 'usage_record_failed')).toBe(true);
  });
});
