import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeAgentContext } from '@ax/core';
import { startJanitor } from '../janitor.js';
import type { AttachmentsStore } from '../store.js';

function makeMockStore(purgeImpl?: () => Promise<number>): AttachmentsStore & {
  purgeCalls: number;
} {
  let purgeCalls = 0;
  const store = {
    insertTemp: async () => {},
    insertTempIfWithinQuota: async () => ({ ok: true as const }),
    getTemp: async () => null,
    sumPendingBytesForUser: async () => 0,
    deleteTemp: async () => {},
    purgeExpired: async () => {
      purgeCalls += 1;
      return purgeImpl ? await purgeImpl() : 0;
    },
  } as AttachmentsStore & { purgeCalls: number };
  Object.defineProperty(store, 'purgeCalls', {
    get: () => purgeCalls,
  });
  return store;
}

function makeCtx() {
  return makeAgentContext({
    sessionId: 'janitor-test-session',
    agentId: 'system',
    userId: 'system',
  });
}

describe('startJanitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs an initial sweep at startup', async () => {
    const store = makeMockStore();
    const handle = startJanitor({ store, intervalSeconds: 5, ctx: makeCtx() });
    // Initial sweep is kicked off synchronously inside startJanitor.
    // Flush microtasks so it actually runs.
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(store.purgeCalls).toBeGreaterThanOrEqual(1);
    await handle.stop();
  });

  it('sweeps again after the configured interval', async () => {
    const store = makeMockStore();
    const handle = startJanitor({ store, intervalSeconds: 5, ctx: makeCtx() });
    await Promise.resolve();
    const initialCalls = store.purgeCalls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.purgeCalls).toBeGreaterThan(initialCalls);
    await handle.stop();
  });

  it('does not sweep after stop() is called', async () => {
    const store = makeMockStore();
    const handle = startJanitor({ store, intervalSeconds: 5, ctx: makeCtx() });
    await Promise.resolve();
    await handle.stop();
    const callsAfterStop = store.purgeCalls;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.purgeCalls).toBe(callsAfterStop);
  });

  it('survives a thrown error inside purgeExpired', async () => {
    const store = makeMockStore(async () => {
      throw new Error('db blew up');
    });
    const handle = startJanitor({ store, intervalSeconds: 5, ctx: makeCtx() });
    // Initial sweep throws internally; janitor must catch and continue.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    // No unhandled rejection. Janitor still alive. stop() resolves cleanly.
    await handle.stop();
  });

  it('stop() is idempotent', async () => {
    const store = makeMockStore();
    const handle = startJanitor({ store, intervalSeconds: 5, ctx: makeCtx() });
    await handle.stop();
    await handle.stop(); // second call must not throw
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws on non-positive intervalSeconds (%j)',
    (value) => {
      const store = makeMockStore();
      expect(() =>
        startJanitor({ store, intervalSeconds: value, ctx: makeCtx() }),
      ).toThrow(/intervalSeconds must be > 0/);
    },
  );
});
