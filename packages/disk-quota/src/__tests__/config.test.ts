import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import {
  BYTES_PER_MB,
  createLimitsStore,
  DEFAULT_LIMITS,
  InvalidLimitsError,
  LIMIT_BOUNDS,
  LIMITS_STORAGE_KEY,
  limitBytesOf,
  statusOf,
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
      new TextEncoder().encode(typeof initial === 'string' ? initial : JSON.stringify(initial)),
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
  return { limits, storage, logger, clock, getCount: () => gets, bus, ctx };
}

describe('the defaults and bounds', () => {
  it('are 1 GB and a warning at 80%, with the documented bounds', () => {
    expect(DEFAULT_LIMITS).toEqual({ limitMb: 1024, warnPercent: 80 });
    expect(LIMIT_BOUNDS).toEqual({
      limitMb: { min: 64, max: 10_485_760 },
      warnPercent: { min: 1, max: 99 },
    });
    expect(LIMITS_STORAGE_KEY).toBe('settings:disk-quota');
  });

  it('1 MB is 1048576 bytes, and the warn line is the floor of the percentage', () => {
    expect(BYTES_PER_MB).toBe(1_048_576);
    expect(limitBytesOf({ limitMb: 1024, warnPercent: 80 })).toEqual({
      limitBytes: 1_073_741_824,
      warnBytes: 858_993_459, // floor(1073741824 * 0.8) = 858993459.2
    });
    expect(limitBytesOf({ limitMb: 64, warnPercent: 1 })).toEqual({
      limitBytes: 67_108_864,
      warnBytes: 671_088, // floor(671088.64)
    });
  });

  it('status is full AT the limit, near-limit AT the warn line, ok below', () => {
    const b = limitBytesOf({ limitMb: 100, warnPercent: 50 });
    expect(statusOf(0, b)).toBe('ok');
    expect(statusOf(b.warnBytes - 1, b)).toBe('ok');
    expect(statusOf(b.warnBytes, b)).toBe('near-limit');
    expect(statusOf(b.limitBytes - 1, b)).toBe('near-limit');
    expect(statusOf(b.limitBytes, b)).toBe('full');
    expect(statusOf(b.limitBytes + 1, b)).toBe('full');
  });
});

describe('createLimitsStore', () => {
  it('returns the defaults when nothing is stored', async () => {
    const { limits, logger } = setup();
    expect(await limits.get()).toEqual(DEFAULT_LIMITS);
    expect(logger.warns).toEqual([]);
  });

  it('merges a partial stored record over the defaults', async () => {
    const { limits, logger } = setup({ limitMb: 2048 });
    expect(await limits.get()).toEqual({ limitMb: 2048, warnPercent: 80 });
    expect(logger.warns).toEqual([]);
  });

  it('falls back field-by-field on out-of-bounds values, with a warn', async () => {
    const { limits, logger } = setup({ limitMb: 63, warnPercent: 90 });
    expect(await limits.get()).toEqual({ limitMb: DEFAULT_LIMITS.limitMb, warnPercent: 90 });
    expect(logger.warns).toEqual(['disk_quota_setting_invalid_field']);
  });

  it('rejects a fractional or non-numeric stored value the same way', async () => {
    const { limits, logger } = setup({ limitMb: 100.5, warnPercent: '80' });
    expect(await limits.get()).toEqual(DEFAULT_LIMITS);
    expect(logger.warns.length).toBe(2);
  });

  it('falls back to the defaults on corrupt JSON, with a warn, and never throws', async () => {
    const { limits, logger } = setup('{not json');
    expect(await limits.get()).toEqual(DEFAULT_LIMITS);
    expect(logger.warns).toEqual(['disk_quota_setting_corrupt']);
  });

  it('falls back when the stored JSON is not an object', async () => {
    for (const bad of [[1, 2], 'null', '7']) {
      const { limits, logger } = setup(bad);
      expect(await limits.get()).toEqual(DEFAULT_LIMITS);
      expect(logger.warns).toEqual(['disk_quota_setting_corrupt']);
    }
  });

  it('caches reads for the TTL and re-reads after it expires', async () => {
    const { limits, storage, clock, getCount } = setup({ limitMb: 200 });
    expect((await limits.get()).limitMb).toBe(200);
    storage.set(LIMITS_STORAGE_KEY, new TextEncoder().encode(JSON.stringify({ limitMb: 300 })));
    clock.advance(500);
    expect((await limits.get()).limitMb).toBe(200);
    expect(getCount()).toBe(1);
    clock.advance(600);
    expect((await limits.get()).limitMb).toBe(300);
    expect(getCount()).toBe(2);
  });

  it('returns a copy, so a caller cannot edit the cache', async () => {
    const { limits } = setup();
    const a = await limits.get();
    a.limitMb = 999_999;
    expect((await limits.get()).limitMb).toBe(DEFAULT_LIMITS.limitMb);
  });

  it('set() merges over a fresh read, persists, and refreshes the cache immediately', async () => {
    const { limits, storage, clock } = setup({ limitMb: 200 });
    await limits.get();
    // Another host changed warnPercent since our cache was filled.
    storage.set(
      LIMITS_STORAGE_KEY,
      new TextEncoder().encode(JSON.stringify({ limitMb: 200, warnPercent: 70 })),
    );
    clock.advance(10);
    const eff = await limits.set({ limitMb: 500 });
    expect(eff).toEqual({ limitMb: 500, warnPercent: 70 });
    expect(await limits.get()).toEqual(eff);
    expect(JSON.parse(new TextDecoder().decode(storage.get(LIMITS_STORAGE_KEY)))).toEqual(eff);
  });

  it('set({}) changes nothing and still succeeds', async () => {
    const { limits } = setup({ limitMb: 200 });
    expect(await limits.set({})).toEqual({ limitMb: 200, warnPercent: 80 });
  });

  it('set() rejects out-of-bounds values with InvalidLimitsError and leaves storage untouched', async () => {
    const { limits, storage } = setup();
    for (const bad of [
      { limitMb: 63 },
      { limitMb: 10_485_761 },
      { limitMb: 100.5 },
      { limitMb: Number.NaN },
      { limitMb: Number.POSITIVE_INFINITY },
      { warnPercent: 0 },
      { warnPercent: 100 },
      { warnPercent: 79.5 },
    ]) {
      await expect(limits.set(bad), JSON.stringify(bad)).rejects.toBeInstanceOf(InvalidLimitsError);
    }
    expect(storage.has(LIMITS_STORAGE_KEY)).toBe(false);
  });

  it('set() accepts both bounds inclusively', async () => {
    const { limits } = setup();
    expect(await limits.set({ limitMb: 64, warnPercent: 1 })).toEqual({ limitMb: 64, warnPercent: 1 });
    expect(await limits.set({ limitMb: 10_485_760, warnPercent: 99 })).toEqual({
      limitMb: 10_485_760,
      warnPercent: 99,
    });
  });

  it('propagates a storage failure on get (the gate turns that into a refusal)', async () => {
    const bus = new HookBus();
    bus.registerService('storage:get', 'test', async () => {
      throw new Error('storage down');
    });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'system' });
    const limits = createLimitsStore({ bus, ctx });
    await expect(limits.get()).rejects.toThrow();
  });
});
