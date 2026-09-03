import { describe, it, expect } from 'vitest';
import type { IpcClient } from '@ax/ipc-protocol';
import { createInboxLoop } from '../inbox-loop.js';

// ---------------------------------------------------------------------------
// inbox-loop tests
//
// We mock IpcClient with a bare object whose `callGet` returns pre-queued
// responses in order. That's all the inbox-loop contract needs: it reads
// the discriminated union out of `callGet` and loops on `timeout`, returns
// on `user-message` / `cancel` / `decision-resolved`.
//
// Worth knowing before you read the queued fixtures: this mock returns them
// RAW. The real `createIpcClient` parses every 2xx body through
// `SessionNextMessageResponseSchema` first, so a fixture the schema would
// reject is a shape no production caller can produce. Where that matters,
// the test says so.
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
    async callBinary() {
      throw new Error('not used in inbox-loop tests');
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

  // -------------------------------------------------------------------------
  // AW-6 — the fourth delivery variant (`decision-resolved`), and the
  // defence-in-depth branch sitting behind it.
  //
  // The wire union is CLOSED: `SessionNextMessageResponseSchema` is a
  // `z.discriminatedUnion` with four arms and no catch-all, and the real
  // ipc-client validates every 2xx body against it (see `rejects an unknown
  // type` in @ax/ipc-protocol's `schemas.test.ts`). So the two unknown-type
  // tests below are NOT production paths — `makeMockClient` returns queued
  // objects raw, bypassing the schema, which is the only reason they can reach
  // that branch at all. They pin defence-in-depth behaviour for a client that
  // does not validate, and nothing more. Their names say so on purpose.
  // -------------------------------------------------------------------------

  it('surfaces a decision-resolved delivery and advances the cursor', async () => {
    const { client, calls } = makeMockClient([
      {
        type: 'decision-resolved',
        decisionId: 'dec_1',
        outcome: 'approved',
        note: 'They said yes.',
        cursor: 4,
      },
    ]);
    const loop = createInboxLoop({ client });
    expect(await loop.next()).toEqual({
      type: 'decision-resolved',
      decisionId: 'dec_1',
      outcome: 'approved',
      note: 'They said yes.',
    });
    expect(loop.cursor).toBe(4);
    expect(calls).toHaveLength(1);
  });

  it('passes a continuation reqId through a decision-resolved delivery (TASK-278)', async () => {
    const { client } = makeMockClient([
      {
        type: 'decision-resolved',
        decisionId: 'dec_1',
        outcome: 'approved',
        note: 'They said yes.',
        reqId: 'req-continuation-1',
        cursor: 4,
      },
    ]);
    const loop = createInboxLoop({ client });
    expect(await loop.next()).toEqual({
      type: 'decision-resolved',
      decisionId: 'dec_1',
      outcome: 'approved',
      note: 'They said yes.',
      reqId: 'req-continuation-1',
    });
    expect(loop.cursor).toBe(4);
  });

  it('defence-in-depth (non-validating client only): re-polls past an unknown delivery type instead of crashing the turn', async () => {
    // Reachable only because this mock skips schema validation. Against the
    // real ipc-client the response below is rejected upstream and the error
    // propagates — see the comment at the end of `next()`.
    const seen: string[] = [];
    const { client } = makeMockClient([
      { type: 'something-from-the-future', cursor: 3 },
      { type: 'cancel', cursor: 4 },
    ]);
    const loop = createInboxLoop({ client, onUnknownDelivery: (t) => seen.push(t) });
    expect(await loop.next()).toEqual({ type: 'cancel' });
    expect(loop.cursor).toBe(4);
    // Reported, not swallowed: the operator gets the variant name.
    expect(seen).toEqual(['something-from-the-future']);
  });

  it('defence-in-depth (non-validating client only): never rewinds the cursor on an unknown delivery with a bogus cursor', async () => {
    // Same caveat as above — the mock is what makes these two entries
    // reachable. Given that they ARE reachable for a non-validating client:
    // skipping an entry we cannot act on is fine, but REPLAYING one we already
    // delivered is not — a rewound cursor would re-deliver a user message and
    // the agent would answer it twice.
    const { client } = makeMockClient([
      { type: 'user-message', payload: { role: 'user', content: 'hi' }, reqId: 'r-1', cursor: 5 },
      { type: 'something-from-the-future', cursor: 1 },
      { type: 'weird-with-no-cursor' },
      { type: 'cancel', cursor: 6 },
    ]);
    const loop = createInboxLoop({ client, onUnknownDelivery: () => {} });
    await loop.next();
    expect(loop.cursor).toBe(5);
    expect(await loop.next()).toEqual({ type: 'cancel' });
    expect(loop.cursor).toBe(6);
  });
});
