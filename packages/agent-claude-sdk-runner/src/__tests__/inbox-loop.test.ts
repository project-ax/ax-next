import { describe, it, expect } from 'vitest';
import type { IpcClient } from '@ax/ipc-protocol';
import { createInboxLoop } from '../inbox-loop.js';

// ---------------------------------------------------------------------------
// inbox-loop tests
//
// We mock IpcClient with a bare object whose `callGet` returns pre-queued
// responses in order. That's all the inbox-loop contract needs: it reads
// the discriminated union out of `callGet` and loops on `timeout`, returns
// on `user-message` / `cancel`.
// ---------------------------------------------------------------------------

interface MockCall {
  action: string;
  query: Record<string, string>;
}

function makeMockClient(responses: unknown[]): {
  client: IpcClient;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const queue = [...responses];
  const client: IpcClient = {
    async call() {
      throw new Error('not used in inbox-loop tests');
    },
    async callGet(action, query) {
      calls.push({ action, query });
      if (queue.length === 0) {
        throw new Error('mock: no more responses queued');
      }
      // Shift returns the next response; .shift() narrowing to undefined
      // is pre-empted by the length check above, so the cast is safe.
      return queue.shift() as unknown;
    },
    async event() {
      // no-op for these tests
    },
    async close() {},
  };
  return { client, calls };
}

describe('createInboxLoop', () => {
  it('first next() issues callGet with ?cursor=0 by default', async () => {
    const { client, calls } = makeMockClient([
      { type: 'user-message', payload: { role: 'user', content: 'hi' }, reqId: 'r-1', cursor: 1 },
    ]);
    const loop = createInboxLoop({ client });
    await loop.next();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      action: 'session.next-message',
      query: { cursor: '0' },
    });
  });

  it('on user-message: returns payload + reqId and advances cursor', async () => {
    const msg = { role: 'user' as const, content: 'hello' };
    const { client } = makeMockClient([
      { type: 'user-message', payload: msg, reqId: 'req-7', cursor: 7 },
    ]);
    const loop = createInboxLoop({ client });
    const entry = await loop.next();
    expect(entry).toEqual({ type: 'user-message', payload: msg, reqId: 'req-7' });
    expect(loop.cursor).toBe(7);
  });

  it('on timeout: loops back to callGet without returning', async () => {
    const { client, calls } = makeMockClient([
      { type: 'timeout', cursor: 0 },
      { type: 'user-message', payload: { role: 'user', content: 'x' }, reqId: 'r-x', cursor: 1 },
    ]);
    const loop = createInboxLoop({ client });
    const entry = await loop.next();
    // Two callGet invocations: first timed out, second delivered.
    expect(calls).toHaveLength(2);
    // Cursor on both calls is '0' — timeout does not advance.
    expect(calls[0]?.query['cursor']).toBe('0');
    expect(calls[1]?.query['cursor']).toBe('0');
    expect(entry.type).toBe('user-message');
  });

  it('loops through multiple timeouts before a user-message arrives', async () => {
    const { client, calls } = makeMockClient([
      { type: 'timeout', cursor: 0 },
      { type: 'timeout', cursor: 0 },
      { type: 'timeout', cursor: 0 },
      { type: 'user-message', payload: { role: 'user', content: 'finally' }, reqId: 'r-finally', cursor: 1 },
    ]);
    const loop = createInboxLoop({ client });
    const entry = await loop.next();
    expect(calls).toHaveLength(4);
    expect(entry).toEqual({
      type: 'user-message',
      payload: { role: 'user', content: 'finally' },
      reqId: 'r-finally',
    });
    expect(loop.cursor).toBe(1);
  });

  it('on cancel: returns {type: cancel} with no payload and advances cursor', async () => {
    const { client } = makeMockClient([{ type: 'cancel', cursor: 5 }]);
    const loop = createInboxLoop({ client, initialCursor: 4 });
    const entry = await loop.next();
    expect(entry).toEqual({ type: 'cancel' });
    expect(loop.cursor).toBe(5);
  });
});

// A fake IpcClient whose callGet always reports a host long-poll timeout, so
// next() would loop forever without the idle floor.
function alwaysTimeoutClient() {
  return {
    callGet: async (_action: string, params: { cursor: string }) => ({
      type: 'timeout' as const,
      cursor: Number(params.cursor),
    }),
  } as unknown as Parameters<typeof createInboxLoop>[0]['client'];
}

describe('inbox-loop idle floor', () => {
  it('returns an idle-timeout entry once the cumulative idle floor elapses', async () => {
    let nowMs = 1_000_000;
    const inbox = createInboxLoop({
      client: alwaysTimeoutClient(),
      idleTimeoutMs: 500,
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    });

    const entry = await inbox.next();
    expect(entry.type).toBe('idle-timeout');
  });

  it('idle floor wins while the poll is still in flight: returns idle-timeout, abandoned poll rejection does not leak', async () => {
    // The race case finding C / B flag: sleep() (the idle floor) resolves
    // FIRST, then the in-flight poll rejects later (e.g. SessionInvalidError).
    // next() must return idle-timeout cleanly — it must NOT throw the
    // abandoned poll's rejection, and that rejection must not surface as an
    // unhandled rejection.
    let unhandled = 0;
    const onUnhandled = (): void => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let nowMs = 1_000_000;
      // callGet returns a promise that rejects on a real later macrotask —
      // i.e. the poll is still in flight when the idle floor wins, then fails.
      const client = {
        callGet: () =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('late poll reject')), 10),
          ),
      } as unknown as Parameters<typeof createInboxLoop>[0]['client'];

      const inbox = createInboxLoop({
        client,
        idleTimeoutMs: 1,
        now: () => nowMs,
        // Resolves on the next microtask (advancing the clock), so the idle
        // floor wins the race before the 10ms poll rejection.
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      });

      const entry = await inbox.next();
      expect(entry).toEqual({ type: 'idle-timeout' });

      // Let the abandoned poll reject, then confirm nothing leaked.
      await new Promise((r) => setTimeout(r, 25));
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
