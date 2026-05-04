/**
 * Transport tests — AX-native chat-flow shape (Task 17).
 *
 * The transport is a two-phase exchange:
 *   1. POST /api/chat/messages with { conversationId | null, agentId,
 *      contentBlocks } — the server mints reqId.
 *   2. GET /api/chat/stream/:reqId — SSE stream of `data: {reqId, text,
 *      kind}` chunks plus a final `data: {reqId, done: true}`.
 *
 * Tests inject a mock fetch (per-call queue) so we can assert URL +
 * method shape, then drive `processResponseStream` directly when we
 * only care about chunk parsing.
 */
import { describe, test, expect, vi } from 'vitest';
import { AxChatTransport } from '../lib/transport';

/**
 * Build a ReadableStream<Uint8Array> from a string body. Mirrors how fetch
 * returns response bodies, letting us exercise processResponseStream directly.
 */
function sseStream(body: string, { chunkSize }: { chunkSize?: number } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  if (!chunkSize || chunkSize >= bytes.length) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/** Drain a UIMessageChunk stream so the transform pipeline runs to completion. */
async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader();
  const chunks: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

/**
 * processResponseStream is protected; cast to a call-signature shape to invoke
 * it in tests without subclassing boilerplate.
 */
type StreamFn = (s: ReadableStream<Uint8Array>) => ReadableStream<unknown>;
const asProcess = (t: AxChatTransport): StreamFn =>
  (t as unknown as { processResponseStream: StreamFn }).processResponseStream.bind(t);

describe('AxChatTransport construction', () => {
  test('constructs with default api /api/chat/messages', () => {
    const transport = new AxChatTransport({ getAgentId: () => 'agent-1' });
    expect(transport).toBeInstanceOf(AxChatTransport);
  });

  test('accepts an explicit api override', () => {
    const transport = new AxChatTransport({
      api: '/custom/messages',
      streamApi: '/custom/stream',
      getAgentId: () => 'agent-1',
    });
    expect(transport).toBeInstanceOf(AxChatTransport);
  });
});

describe('AxChatTransport SSE chunk parsing', () => {
  test('parses text frames into text-start, text-delta(s), text-end, finish', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","text":"Hello","kind":"text"}\n\n` +
      `data: {"reqId":"r1","text":", world","kind":"text"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; delta?: string; finishReason?: string; id?: string }>;
    const types = chunks.map((c) => c.type);
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta);
    expect(deltas).toEqual(['Hello', ', world']);
    const finish = chunks.find((c) => c.type === 'finish') as { finishReason: string };
    expect(finish.finishReason).toBe('stop');
    // All text chunks share one part id.
    const textIds = new Set(
      chunks.filter((c) => c.type === 'text-delta').map((c) => c.id),
    );
    expect(textIds.size).toBe(1);
    expect([...textIds][0]).toMatch(/^text-/);
  });

  test('done frame closes any open part and emits finish', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","text":"hi","kind":"text"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string }>;
    const types = chunks.map((c) => c.type);
    expect(types).toContain('text-end');
    expect(types[types.length - 1]).toBe('finish');
  });

  test('thinking chunks are emitted with a separate id and providerMetadata', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","text":"...thinking","kind":"thinking"}\n\n` +
      `data: {"reqId":"r1","text":"answer","kind":"text"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      delta?: string;
      id?: string;
      providerMetadata?: Record<string, unknown>;
    }>;
    const thinkingDelta = chunks.find(
      (c) => c.type === 'text-delta' && c.id?.startsWith('thinking-'),
    );
    expect(thinkingDelta).toBeTruthy();
    expect(thinkingDelta?.delta).toBe('...thinking');
    expect(thinkingDelta?.providerMetadata?.['ax']).toEqual({ thinking: true });

    const textDelta = chunks.find(
      (c) => c.type === 'text-delta' && c.id?.startsWith('text-'),
    );
    expect(textDelta).toBeTruthy();
    expect(textDelta?.delta).toBe('answer');

    // Thinking part is closed when text begins.
    const thinkingEnd = chunks.find(
      (c) => c.type === 'text-end' && c.id === thinkingDelta?.id,
    );
    expect(thinkingEnd).toBeTruthy();
  });

  test('survives SSE frames split across decoder chunks', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","text":"chunk-split","kind":"text"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body, { chunkSize: 7 }))) as Array<{
      type: string;
      delta?: string;
    }>;
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta);
    expect(deltas.join('')).toBe('chunk-split');
  });

  test('malformed JSON frames are skipped without breaking the stream', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {not json\n\n` +
      `data: {"reqId":"r1","text":"after","kind":"text"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; delta?: string }>;
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta);
    expect(deltas).toEqual(['after']);
  });

  test('flush emits finish if stream closes without an explicit done frame', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body = `data: {"reqId":"r1","text":"stub","kind":"text"}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; finishReason?: string }>;
    const finish = chunks.find((c) => c.type === 'finish') as { finishReason: string } | undefined;
    expect(finish).toBeTruthy();
    expect(finish?.finishReason).toBe('stop');
  });
});

describe('AxChatTransport sendMessages two-phase exchange', () => {
  /**
   * Build a fetch mock that returns:
   *  - the POST /api/chat/messages 202 response with reqId
   *  - the GET /api/chat/stream/<reqId> SSE response
   * in that order. Asserts the order matches the transport's flow.
   */
  function makeFetchMock(opts: {
    postResponse?: { conversationId: string; reqId: string };
    sseBody?: string;
    postStatus?: number;
    sseStatus?: number;
  } = {}) {
    const postResponse = opts.postResponse ?? { conversationId: 'conv-1', reqId: 'req-1' };
    const sseBody =
      opts.sseBody ??
      `data: {"reqId":"req-1","text":"ok","kind":"text"}\n\n` +
        `data: {"reqId":"req-1","done":true}\n\n`;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : '';
      calls.push({ url: u, ...(init !== undefined ? { init } : {}) });
      if (u.includes('/api/chat/messages')) {
        return new Response(JSON.stringify(postResponse), {
          status: opts.postStatus ?? 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/api/chat/stream/')) {
        return new Response(sseStream(sseBody), {
          status: opts.sseStatus ?? 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    return { fetchFn: fetchFn as unknown as typeof fetch, calls };
  }

  test('POSTs to /api/chat/messages then opens SSE on returned reqId', async () => {
    const { fetchFn, calls } = makeFetchMock();
    const transport = new AxChatTransport({
      fetch: fetchFn,
      getAgentId: () => 'agent-1',
    });
    const stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    await drain(stream);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('/api/chat/messages');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[1]?.url).toContain('/api/chat/stream/req-1');
    const postBody = JSON.parse(String(calls[0]?.init?.body));
    expect(postBody).toMatchObject({
      conversationId: null,
      agentId: 'agent-1',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });
    // Regression: the http-server CSRF subscriber accepts the literal
    // `ax-admin` value (csrf.ts BYPASS_VALUE). Sending any other value
    // causes a 403 on every state-changing request when the cookie-only
    // session can't satisfy the same-Origin rule.
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-requested-with']).toBe('ax-admin');
  });

  test('preserves conversationId across messages within a thread', async () => {
    const { fetchFn, calls } = makeFetchMock();
    const transport = new AxChatTransport({
      fetch: fetchFn,
      getAgentId: () => 'agent-1',
    });
    // First send → server mints conversationId.
    let stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'one' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    await drain(stream);
    // Second send → transport should re-use the captured conversationId.
    stream = await transport.sendMessages({
      messages: [{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'two' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    await drain(stream);

    expect(calls).toHaveLength(4);
    const secondPostBody = JSON.parse(String(calls[2]?.init?.body));
    expect(secondPostBody.conversationId).toBe('conv-1');
  });

  test('uses caller-provided getConversationId resolver', async () => {
    const { fetchFn, calls } = makeFetchMock();
    const transport = new AxChatTransport({
      fetch: fetchFn,
      getAgentId: () => 'agent-1',
      getConversationId: () => 'pre-existing-conv',
    });
    const stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    await drain(stream);

    const postBody = JSON.parse(String(calls[0]?.init?.body));
    expect(postBody.conversationId).toBe('pre-existing-conv');
  });

  test('writes server conversationId back via setConversationId callback', async () => {
    const { fetchFn } = makeFetchMock({
      postResponse: { conversationId: 'srv-conv', reqId: 'r1' },
    });
    const setConv = vi.fn();
    const transport = new AxChatTransport({
      fetch: fetchFn,
      getAgentId: () => 'agent-1',
      setConversationId: setConv,
    });
    const stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    await drain(stream);
    expect(setConv).toHaveBeenCalledWith('srv-conv');
  });

  test('throws when agentId resolver returns empty', async () => {
    const { fetchFn } = makeFetchMock();
    const transport = new AxChatTransport({
      fetch: fetchFn,
      getAgentId: () => null,
    });
    await expect(
      transport.sendMessages({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      } as unknown as Parameters<typeof transport.sendMessages>[0]),
    ).rejects.toThrow(/agentId is required/);
  });

  test('throws on POST failure', async () => {
    const { fetchFn } = makeFetchMock({ postStatus: 500 });
    const transport = new AxChatTransport({
      fetch: fetchFn,
      getAgentId: () => 'agent-1',
    });
    await expect(
      transport.sendMessages({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      } as unknown as Parameters<typeof transport.sendMessages>[0]),
    ).rejects.toThrow(/chat-flow POST failed/);
  });

  test('returns empty finish stream when no user message is present', async () => {
    const { fetchFn, calls } = makeFetchMock();
    const transport = new AxChatTransport({
      fetch: fetchFn,
      getAgentId: () => 'agent-1',
    });
    const stream = await transport.sendMessages({
      messages: [],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    const chunks = await drain(stream) as Array<{ type: string }>;
    expect(chunks.map((c) => c.type)).toEqual(['finish']);
    // No fetches issued.
    expect(calls).toHaveLength(0);
  });

  // Regression: the constructor previously stored the global `fetch`
  // reference unbound (`opts.fetch ?? fetch`). Calling
  // `this.fetchImpl(url, init)` then ran fetch with `this === transport`,
  // which the browser's WebIDL binding rejects as
  // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`.
  // That made the chat UI fail silently — the message rendered locally
  // but no POST ever fired. This test pins the binding by stubbing
  // globalThis.fetch with a function that REQUIRES its receiver to be
  // globalThis itself; if the transport stores it unbound, the call
  // throws and the test fails.
  test('default fetch is bound to globalThis (regression)', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const trueFetch = function (
      this: unknown,
      url: string,
      init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError(
          "Failed to execute 'fetch' on 'Window': Illegal invocation",
        );
      }
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/api/chat/messages')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ conversationId: 'c1', reqId: 'r1' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      // Stream phase — empty body, immediate close.
      return Promise.resolve(
        new Response(sseStream(`data: {"reqId":"r1","done":true}\n\n`), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    };
    const orig = globalThis.fetch;
    // Cast through unknown — vitest doesn't widen RequestInfo to plain string.
    globalThis.fetch = trueFetch as unknown as typeof fetch;
    try {
      const transport = new AxChatTransport({ getAgentId: () => 'agent-1' });
      const stream = await transport.sendMessages({
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        ],
      } as unknown as Parameters<typeof transport.sendMessages>[0]);
      await drain(stream);
    } finally {
      globalThis.fetch = orig;
    }
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(calls[0]?.url).toContain('/api/chat/messages');
  });
});
