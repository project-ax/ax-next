import { describe, it, expect, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import {
  createEventbusInprocessPlugin,
  type EventbusEmitInput,
  type EventbusSubscribeInput,
  type EventbusSubscription,
} from '../plugin.js';

async function makeHarness() {
  return createTestHarness({ plugins: [createEventbusInprocessPlugin()] });
}

describe('@ax/eventbus-inprocess', () => {
  it('delivers payloads to subscribers in order', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    const seen: string[] = [];
    await h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctx,
      {
        channel: 'demo',
        handler: async (p) => {
          seen.push(String(p));
        },
      },
    );
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'demo',
      payload: 'a',
    });
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'demo',
      payload: 'b',
    });
    expect(seen).toEqual(['a', 'b']);
  });

  it('isolates a throwing subscriber (other subscribers still fire)', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    const ok = vi.fn(async () => {});
    await h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctx,
      {
        channel: 'x',
        handler: async () => {
          throw new Error('bad sub');
        },
      },
    );
    await h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctx,
      { channel: 'x', handler: ok },
    );
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'x',
      payload: 1,
    });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops delivery', async () => {
    const h = await makeHarness();
    const ctx = h.ctx();
    const seen: number[] = [];
    const sub = await h.bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      ctx,
      {
        channel: 'y',
        handler: async (p) => {
          seen.push(p as number);
        },
      },
    );
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'y',
      payload: 1,
    });
    sub.unsubscribe();
    await h.bus.call<EventbusEmitInput, void>('eventbus:emit', ctx, {
      channel: 'y',
      payload: 2,
    });
    expect(seen).toEqual([1]);
  });
});
