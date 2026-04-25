import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness } from '@ax/test-harness';
import { PluginError } from '@ax/core';
import {
  createEventbusPostgresPlugin,
  type EventbusEmitInput,
  type EventbusPostgresPlugin,
  type EventbusSubscribeInput,
  type EventbusSubscription,
} from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: EventbusPostgresPlugin[] = [];

async function makeBus() {
  const plugin = createEventbusPostgresPlugin({ connectionString });
  const h = await createTestHarness({ plugins: [plugin] });
  opened.push(plugin);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  // Drain the dedicated LISTEN client for each instance so the next test
  // starts clean and the container doesn't get torn down with active
  // connections (which would surface as unhandled `terminating connection`
  // errors from pg-protocol). There's no kernel shutdown lifecycle yet
  // (TODO: kernel-shutdown), so the factory exposes shutdown() directly.
  while (opened.length > 0) {
    const p = opened.pop()!;
    await p.shutdown().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

// Tiny helper: wait until `predicate()` is true (or fail at timeout).
// LISTEN delivery is async, so polling with a short ceiling is the
// canonical shape for these tests.
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate never became true within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('@ax/eventbus-postgres', () => {
  it('delivers payloads to subscribers within a single instance', async () => {
    const h = await makeBus();
    const ctx = h.ctx();
    const seen: unknown[] = [];
    await h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctx,
      {
        channel: 'demo',
        handler: async (p) => {
          seen.push(p);
        },
      },
    );
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'demo',
      payload: { hello: 'world' },
    });
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual([{ hello: 'world' }]);
  });

  it('delivers cross-instance via LISTEN/NOTIFY', async () => {
    const a = await makeBus();
    const b = await makeBus();
    const ctxA = a.ctx();
    const ctxB = b.ctx();
    const seen: unknown[] = [];
    await a.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctxA,
      {
        channel: 'cross',
        handler: async (p) => {
          seen.push(p);
        },
      },
    );
    // Emit on B; A's listener must pick it up.
    await b.bus.call<EventbusEmitInput, void>('eventbus:emit', ctxB, {
      channel: 'cross',
      payload: { from: 'B' },
    });
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual([{ from: 'B' }]);
  });

  it('isolates a throwing subscriber (other subscribers still fire)', async () => {
    const h = await makeBus();
    const ctx = h.ctx();
    const ok = vi.fn(async () => {});
    await h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctx,
      {
        channel: 'iso',
        handler: async () => {
          throw new Error('bad sub');
        },
      },
    );
    await h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctx,
      { channel: 'iso', handler: ok },
    );
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'iso',
      payload: 1,
    });
    await waitFor(() => ok.mock.calls.length > 0);
    expect(ok).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops delivery', async () => {
    const h = await makeBus();
    const ctx = h.ctx();
    const seen: number[] = [];
    const sub = await h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctx,
      {
        channel: 'unsub',
        handler: async (p) => {
          seen.push(p as number);
        },
      },
    );
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'unsub',
      payload: 1,
    });
    await waitFor(() => seen.length > 0);
    sub.unsubscribe();
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'unsub',
      payload: 2,
    });
    // Give NOTIFY time to fail to deliver — if it WERE delivered it would
    // be inside ~50ms; 200ms is a comfortable lower bound for "didn't fire".
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([1]);
  });

  it('rejects channel names that are not [a-zA-Z0-9_]+', async () => {
    const h = await makeBus();
    const ctx = h.ctx();
    await expect(
      h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
        channel: 'has-dash',
        payload: 1,
      }),
    ).rejects.toMatchObject({
      name: 'PluginError',
      code: 'invalid-channel',
    });
    await expect(
      h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
        'eventbus:subscribe',
        ctx,
        {
          channel: 'drop table students;--',
          handler: async () => {},
        },
      ),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('rejects payloads larger than the postgres NOTIFY 8000-byte cap', async () => {
    const h = await makeBus();
    const ctx = h.ctx();
    // 9000 chars of "a" json-encodes to ~9002 bytes — over the 8000 cap.
    const big = 'a'.repeat(9000);
    await expect(
      h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
        channel: 'big',
        payload: big,
      }),
    ).rejects.toMatchObject({
      name: 'PluginError',
      code: 'payload-too-large',
    });
  });
});
