import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import {
  createLimitsStore,
  DEFAULT_LIMITS,
  InvalidLimitsError,
  LIMITS_STORAGE_KEY,
} from '../config.js';

function fakeLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  const l: Logger & { warns: string[] } = {
    warns,
    debug() {},
    info() {},
    warn(msg) {
      warns.push(msg);
    },
    error() {},
    child() {
      return l;
    },
  };
  return l;
}

function setup(initial?: unknown) {
  const bus = new HookBus();
  const storage = new Map<string, Uint8Array>();
  let gets = 0;
  if (initial !== undefined) {
    storage.set(
      LIMITS_STORAGE_KEY,
      typeof initial === 'string'
        ? new TextEncoder().encode(initial)
        : new TextEncoder().encode(JSON.stringify(initial)),
    );
  }
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    'test',
    async (_ctx, { key }) => {
      gets++;
      return { value: storage.get(key) };
    },
  );
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>(
    'storage:set',
    'test',
    async (_ctx, { key, value }) => {
      storage.set(key, value);
      return {};
    },
  );
  const logger = fakeLogger();
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'system', logger });
  let t = 1_000_000;
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const limits = createLimitsStore({ bus, ctx, now: clock.now, ttlMs: 1000 });
  return { limits, storage, logger, clock, getCount: () => gets };
}

describe('createLimitsStore', () => {
  it('returns the defaults when nothing is stored', async () => {
    const { limits, logger } = setup();
    expect(await limits.get()).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toEqual({ dailySpendUsd: 5, turnsPerHour: 60, assumedTurnCostUsd: 0.25 });
    expect(logger.warns).toEqual([]);
  });

  it('merges a partial stored record over the defaults', async () => {
    const { limits, logger } = setup({ dailySpendUsd: 12 });
    expect(await limits.get()).toEqual({ ...DEFAULT_LIMITS, dailySpendUsd: 12 });
    expect(logger.warns).toEqual([]);
  });

  it('falls back field-by-field on out-of-bounds values, with a warn', async () => {
    const { limits, logger } = setup({ dailySpendUsd: -1, turnsPerHour: 7.5, assumedTurnCostUsd: 3 });
    expect(await limits.get()).toEqual({
      dailySpendUsd: DEFAULT_LIMITS.dailySpendUsd,
      turnsPerHour: DEFAULT_LIMITS.turnsPerHour,
      assumedTurnCostUsd: 3,
    });
    expect(logger.warns.length).toBeGreaterThan(0);
  });

  it('falls back to the defaults on corrupt JSON, with a warn, and never throws', async () => {
    const { limits, logger } = setup('{not json');
    expect(await limits.get()).toEqual(DEFAULT_LIMITS);
    expect(logger.warns.length).toBe(1);
  });

  it('falls back when the stored JSON is not an object', async () => {
    const { limits, logger } = setup([1, 2]);
    expect(await limits.get()).toEqual(DEFAULT_LIMITS);
    expect(logger.warns.length).toBe(1);
  });

  it('caches reads for the TTL and re-reads after it expires', async () => {
    const { limits, storage, clock, getCount } = setup({ dailySpendUsd: 7 });
    expect((await limits.get()).dailySpendUsd).toBe(7);
    storage.set(LIMITS_STORAGE_KEY, new TextEncoder().encode(JSON.stringify({ dailySpendUsd: 9 })));
    clock.advance(500);
    expect((await limits.get()).dailySpendUsd).toBe(7);
    expect(getCount()).toBe(1);
    clock.advance(600);
    expect((await limits.get()).dailySpendUsd).toBe(9);
    expect(getCount()).toBe(2);
  });

  it('set() validates the merged result, persists it and refreshes the cache immediately', async () => {
    const { limits, storage } = setup({ dailySpendUsd: 7 });
    await limits.get();
    const eff = await limits.set({ turnsPerHour: 10 });
    expect(eff).toEqual({ ...DEFAULT_LIMITS, dailySpendUsd: 7, turnsPerHour: 10 });
    expect(await limits.get()).toEqual(eff);
    const stored = JSON.parse(new TextDecoder().decode(storage.get(LIMITS_STORAGE_KEY)));
    expect(stored).toEqual(eff);
  });

  it('set() rejects out-of-bounds values and leaves storage untouched', async () => {
    const { limits, storage } = setup();
    await expect(limits.set({ dailySpendUsd: 0 })).rejects.toBeInstanceOf(InvalidLimitsError);
    await expect(limits.set({ turnsPerHour: 1.5 })).rejects.toBeInstanceOf(InvalidLimitsError);
    await expect(limits.set({ assumedTurnCostUsd: Number.POSITIVE_INFINITY })).rejects.toBeInstanceOf(
      InvalidLimitsError,
    );
    await expect(limits.set({ dailySpendUsd: 10_001 })).rejects.toBeInstanceOf(InvalidLimitsError);
    expect(storage.has(LIMITS_STORAGE_KEY)).toBe(false);
  });
});
