import { describe, it, expect } from 'vitest';
import { makeAgentContext, type Logger } from '@ax/core';
import { createUsageService } from '../service.js';
import type { ProviderVerdict, RecordedUsage, UsageStore } from '../store.js';
import { DEFAULT_LIMITS, type LimitsStore, type UsageLimits } from '../config.js';
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

const NOW = new Date('2026-09-29T00:00:00Z');

function setup(
  opts: {
    admitThrows?: boolean;
    recordThrows?: boolean;
    helperThrows?: boolean;
    providerRecordThrows?: boolean;
    providerStatusThrows?: boolean;
    limitsThrows?: boolean;
    verdict?: ProviderVerdict;
  } = {},
) {
  const recorded: Array<{ userId: string; usage: RecordedUsage }> = [];
  const helperRecorded: Array<{ userId: string; usage: RecordedUsage }> = [];
  const providerRecorded: Array<{ userId: string; costMicros: number; now: Date }> = [];
  const statusCalls: Array<{ userId: string; limits: UsageLimits; now: Date }> = [];
  // Every store call in order, to pin "record, THEN read the verdict".
  const order: string[] = [];
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
    async recordHelper({ userId, usage }: { userId: string; usage: RecordedUsage }) {
      if (opts.helperThrows) throw new Error('db down');
      helperRecorded.push({ userId, usage });
    },
    async recordProvider(input: { userId: string; costMicros: number; now: Date }) {
      order.push('recordProvider');
      if (opts.providerRecordThrows) throw new Error('db down');
      providerRecorded.push(input);
    },
    async providerStatus(input: { userId: string; limits: UsageLimits; now: Date }) {
      order.push('providerStatus');
      if (opts.providerStatusThrows) throw new Error('db down');
      statusCalls.push(input);
      return opts.verdict ?? ({ blocked: false } as const);
    },
  } as unknown as UsageStore;
  const limits: LimitsStore = {
    get: async () => {
      if (opts.limitsThrows) throw new Error('storage down');
      return { ...DEFAULT_LIMITS };
    },
    set: async () => ({ ...DEFAULT_LIMITS }),
  };
  const svc = createUsageService({ store, limits, now: () => NOW });
  const { logger, lines } = capture();
  const ctx = (userId = 'u1') =>
    makeAgentContext({ sessionId: 's', agentId: 'a', userId, logger });
  return { svc, recorded, helperRecorded, providerRecorded, statusCalls, order, admits, lines, ctx };
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
  it('charges a helper call with zero cache tokens, through recordHelper (never record)', async () => {
    const { svc, recorded, helperRecorded, ctx } = setup();
    await svc.recordLlmUsage(ctx(), {
      model: 'anthropic/claude-haiku-4-5',
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    // Helper calls never cross the credential proxy, so they must not land in
    // the runner-reported column: the spend formula adds them outside the GREATEST.
    expect(recorded).toEqual([]);
    expect(helperRecorded).toEqual([
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
    const { svc, recorded, helperRecorded, ctx } = setup();
    await svc.recordLlmUsage(ctx(''), { model: 'm', usage: { inputTokens: 1, outputTokens: 1 } });
    await svc.recordLlmUsage(ctx(), { model: 'm' });
    await svc.recordLlmUsage(ctx(), 42);
    expect(recorded).toEqual([]);
    expect(helperRecorded).toEqual([]);
    const b = setup({ helperThrows: true });
    await expect(
      b.svc.recordLlmUsage(b.ctx(), { model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }),
    ).resolves.toBeUndefined();
    expect(b.lines.some((l) => l.level === 'error' && l.msg === 'usage_record_failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TASK-715: the verdict the credential proxy asks for.
//
// Both methods act for ctx.userId, NEVER throw, and fail CLOSED: a money
// control that reads "database down" as "not blocked" is no control.
// ---------------------------------------------------------------------------

const UNAVAILABLE: ProviderVerdict = { blocked: true, reason: 'usage-check-unavailable' };

// Top-tier ("opus") rates are 15 micros per input token and 75 per output token.
const ESTIMATE_OUTPUT_MICROS = 4096 * 75; // 307_200

describe('providerStatus', () => {
  it('returns the store verdict for the ctx user, with the current limits and time', async () => {
    const blocked: ProviderVerdict = { blocked: true, reason: 'usage-limit-daily' };
    const s = setup({ verdict: blocked });
    expect(await s.svc.providerStatus(s.ctx('alice'))).toEqual(blocked);
    expect(s.statusCalls).toEqual([{ userId: 'alice', limits: { ...DEFAULT_LIMITS }, now: NOW }]);
    const t = setup();
    expect(await t.svc.providerStatus(t.ctx())).toEqual({ blocked: false });
  });

  it('is blocked (usage-check-unavailable) with no user, without touching the store', async () => {
    const s = setup();
    expect(await s.svc.providerStatus(s.ctx(''))).toEqual(UNAVAILABLE);
    expect(s.order).toEqual([]);
  });

  it('FAILS CLOSED when the store throws, and logs it', async () => {
    const s = setup({ providerStatusThrows: true });
    expect(await s.svc.providerStatus(s.ctx())).toEqual(UNAVAILABLE);
    expect(s.lines.some((l) => l.level === 'error' && l.msg === 'usage_provider_status_failed')).toBe(true);
  });

  it('FAILS CLOSED when the limits cannot be read', async () => {
    const s = setup({ limitsThrows: true });
    expect(await s.svc.providerStatus(s.ctx())).toEqual(UNAVAILABLE);
    expect(s.order).toEqual([]);
  });

  it('a logger that throws does not change the answer', async () => {
    const s = setup({ providerStatusThrows: true });
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u1',
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {
          throw new Error('logger down');
        },
        child() {
          return this;
        },
      } as Logger,
    });
    await expect(s.svc.providerStatus(ctx)).resolves.toEqual(UNAVAILABLE);
  });
});

describe('providerRecord', () => {
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 };

  it('charges exactly costMicros(model, usage) for a measured response, then returns the verdict', async () => {
    const blocked: ProviderVerdict = { blocked: true, reason: 'usage-limit-daily' };
    const s = setup({ verdict: blocked });
    const model = 'anthropic/claude-sonnet-4-6';
    expect(await s.svc.providerRecord(s.ctx('alice'), { model, usage, requestBytes: 12_345 })).toEqual(blocked);
    expect(s.providerRecorded).toEqual([
      { userId: 'alice', costMicros: costMicros(model, usage), now: NOW },
    ]);
    // The ledger is written BEFORE the verdict is read, so the verdict includes this call.
    expect(s.order).toEqual(['recordProvider', 'providerStatus']);
    expect(s.statusCalls).toEqual([{ userId: 'alice', limits: { ...DEFAULT_LIMITS }, now: NOW }]);
  });

  it('prices the model by name when measured (haiku is not opus)', async () => {
    const s = setup();
    await s.svc.providerRecord(s.ctx(), {
      model: 'anthropic/claude-haiku-4-5',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      requestBytes: null,
    });
    expect(s.providerRecorded[0]!.costMicros).toBe(1_000_000);
  });

  it('prices an overlong or missing model as unknown (top tier) but keeps the measured tokens', async () => {
    const s = setup();
    const u = { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await s.svc.providerRecord(s.ctx(), { model: 'x'.repeat(500), usage: u, requestBytes: null });
    await s.svc.providerRecord(s.ctx(), { usage: u, requestBytes: null });
    expect(s.providerRecorded.map((r) => r.costMicros)).toEqual([15_000, 15_000]);
  });

  it('charges an ESTIMATE for a billable response it could not read: requestBytes / 3 input tokens + 4096 output, top tier', async () => {
    const s = setup();
    await s.svc.providerRecord(s.ctx(), { model: 'anthropic/claude-haiku-4-5', usage: null, requestBytes: 300 });
    // 300 bytes -> 100 input tokens (1500 micros) + 4096 output tokens (307_200).
    // Priced at the top tier even though the model says haiku: unknown is never cheap.
    expect(s.providerRecorded[0]!.costMicros).toBe(100 * 15 + ESTIMATE_OUTPUT_MICROS);
    expect(s.providerRecorded[0]!.costMicros).toBe(
      costMicros(undefined, { inputTokens: 100, outputTokens: 4096 }),
    );
  });

  it('rounds the input-token estimate up', async () => {
    const s = setup();
    await s.svc.providerRecord(s.ctx(), { usage: null, requestBytes: 301 });
    expect(s.providerRecorded[0]!.costMicros).toBe(101 * 15 + ESTIMATE_OUTPUT_MICROS);
  });

  it('assumes 200_000 input tokens when the request size is unknown too', async () => {
    const s = setup();
    await s.svc.providerRecord(s.ctx(), { usage: null, requestBytes: null });
    expect(s.providerRecorded[0]!.costMicros).toBe(200_000 * 15 + ESTIMATE_OUTPUT_MICROS);
  });

  it('a huge request size cannot overflow the ledger: the estimate is clamped like any token count', async () => {
    const s = setup();
    await s.svc.providerRecord(s.ctx(), { usage: null, requestBytes: 1e18 });
    expect(s.providerRecorded[0]!.costMicros).toBe(
      costMicros(undefined, { inputTokens: 1_000_000_000, outputTokens: 4096 }),
    );
  });

  it('charges an unparseable payload the conservative estimate instead of dropping it', async () => {
    const conservative = 200_000 * 15 + ESTIMATE_OUTPUT_MICROS;
    const s = setup();
    const garbage: unknown[] = [
      undefined,
      null,
      42,
      'not-an-object',
      {},
      { requestBytes: 10 },
      { usage: undefined, requestBytes: 10 },
      { usage: 'lots', requestBytes: 10 },
      { usage: { inputTokens: 1.5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, requestBytes: 10 },
      { usage: { inputTokens: 1, outputTokens: 1 }, requestBytes: 10 },
      { usage: null, requestBytes: 'big' },
      { usage: null, requestBytes: -5 },
      { usage: null, requestBytes: Number.NaN },
    ];
    for (const g of garbage) await s.svc.providerRecord(s.ctx(), g);
    // A payload that fails to parse is treated as { usage: null, requestBytes:
    // null }, so even the ones carrying a plausible requestBytes (10) pay the
    // 200_000-token guess, never a cheaper one.
    expect(s.providerRecorded.map((r) => r.costMicros)).toEqual(garbage.map(() => conservative));
  });

  it('never lets a hostile token count reduce the charge: negatives clamp to zero, huge ones to the ceiling', async () => {
    const s = setup();
    await s.svc.providerRecord(s.ctx(), {
      usage: { inputTokens: -1e12, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      requestBytes: null,
    });
    await s.svc.providerRecord(s.ctx(), {
      usage: { inputTokens: 1e18, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      requestBytes: null,
    });
    expect(s.providerRecorded[0]!.costMicros).toBe(0);
    expect(s.providerRecorded[1]!.costMicros).toBe(costMicros(undefined, { inputTokens: 1_000_000_000, outputTokens: 0 }));
  });

  it('is blocked (usage-check-unavailable) with no user and writes nothing', async () => {
    const s = setup();
    expect(await s.svc.providerRecord(s.ctx(''), { usage: null, requestBytes: null })).toEqual(UNAVAILABLE);
    expect(s.order).toEqual([]);
  });

  it('never throws and FAILS CLOSED when the ledger write throws, and logs it', async () => {
    const s = setup({ providerRecordThrows: true });
    await expect(s.svc.providerRecord(s.ctx(), { usage, requestBytes: null })).resolves.toEqual(UNAVAILABLE);
    expect(s.lines.some((l) => l.level === 'error' && l.msg === 'usage_provider_record_failed')).toBe(true);
    // No verdict is read after a failed write.
    expect(s.order).toEqual(['recordProvider']);
  });

  it('FAILS CLOSED when the write lands but the verdict cannot be read', async () => {
    const s = setup({ providerStatusThrows: true });
    await expect(s.svc.providerRecord(s.ctx(), { usage, requestBytes: null })).resolves.toEqual(UNAVAILABLE);
    expect(s.providerRecorded).toHaveLength(1);
  });

  it('FAILS CLOSED when the limits cannot be read', async () => {
    const s = setup({ limitsThrows: true });
    await expect(s.svc.providerRecord(s.ctx(), { usage, requestBytes: null })).resolves.toEqual(UNAVAILABLE);
  });

  it('a payload that throws when read still resolves to a blocked verdict', async () => {
    const s = setup();
    const hostile = {
      get usage(): never {
        throw new Error('getter boom');
      },
    };
    await expect(s.svc.providerRecord(s.ctx(), hostile)).resolves.toEqual(UNAVAILABLE);
  });

  it('a logger that throws does not change the answer', async () => {
    const s = setup({ providerRecordThrows: true });
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u1',
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {
          throw new Error('logger down');
        },
        child() {
          return this;
        },
      } as Logger,
    });
    await expect(s.svc.providerRecord(ctx, { usage, requestBytes: null })).resolves.toEqual(UNAVAILABLE);
    // ...and a throwing logger on the SUCCESS path (the unmeasured info line) does not either.
    const t = setup();
    const noisy = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u1',
      logger: {
        debug() {},
        info() {
          throw new Error('logger down');
        },
        warn() {
          throw new Error('logger down');
        },
        error() {
          throw new Error('logger down');
        },
        child() {
          return this;
        },
      } as Logger,
    });
    await expect(t.svc.providerRecord(noisy, { usage: null, requestBytes: null })).resolves.toEqual({
      blocked: false,
    });
    expect(t.providerRecorded).toHaveLength(1);
  });
});
