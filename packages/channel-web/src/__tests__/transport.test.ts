import { describe, test, expect, vi } from 'vitest';
import { AxChatTransport, type Diagnostic, type StatusEvent } from '../lib/transport';

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
  test('constructs with default api /api/chat/completions', () => {
    const transport = new AxChatTransport();
    // The base HttpChatTransport stores `api` as a private/protected member; we
    // don't assert on it directly. Instead, smoke-test that constructing with
    // defaults does not throw and yields a usable instance.
    expect(transport).toBeInstanceOf(AxChatTransport);
  });

  test('accepts an explicit api override', () => {
    const transport = new AxChatTransport({ api: '/api/chat/completions' });
    expect(transport).toBeInstanceOf(AxChatTransport);
  });
});

describe('AxChatTransport text stream parsing', () => {
  test('parses a basic OpenAI text stream into text-start, text-delta(s), text-end, finish', async () => {
    const transport = new AxChatTransport();
    const body =
      `data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{"content":", world"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; delta?: string; finishReason?: string }>;
    const types = chunks.map((c) => c.type);
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta);
    expect(deltas).toEqual(['Hello', ', world']);
    const finish = chunks.find((c) => c.type === 'finish') as { finishReason: string };
    expect(finish.finishReason).toBe('stop');
  });

  test('handles a [DONE] terminator that arrives before an explicit finish_reason', async () => {
    const transport = new AxChatTransport();
    const body =
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
      `data: [DONE]\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string }>;
    const types = chunks.map((c) => c.type);
    // [DONE] should still close the open text part and emit finish.
    expect(types).toContain('text-end');
    expect(types[types.length - 1]).toBe('finish');
  });
});

describe('AxChatTransport status event forwarding', () => {
  test('forwards `event: status` payloads to onStatus callback', async () => {
    const onStatus = vi.fn((_: StatusEvent) => {});
    const transport = new AxChatTransport({ onStatus });
    const status: StatusEvent = { operation: 'session', phase: 'starting', message: 'Spinning up' };
    const body =
      `event: status\ndata: ${JSON.stringify(status)}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    await drain(asProcess(transport)(sseStream(body)));

    // First call must be the explicit status event we sent. (A synthesized
    // clear-status fires only on real content; this stream has none.)
    expect(onStatus).toHaveBeenCalled();
    expect(onStatus.mock.calls[0]?.[0]).toEqual(status);
  });
});

describe('AxChatTransport diagnostic event forwarding', () => {
  test('forwards `event: diagnostic` payloads to onDiagnostic callback', async () => {
    const onDiagnostic = vi.fn();
    const transport = new AxChatTransport({ onDiagnostic });
    const diagnostic: Diagnostic = {
      severity: 'warn',
      kind: 'catalog_populate_openapi_source_failed',
      message: 'Skill "petstore" failed to load OpenAPI spec',
      context: { skill: 'petstore', source: 'https://example.com/spec.json' },
      timestamp: '2026-04-21T18:30:00.000Z',
    };
    const body =
      `event: diagnostic\ndata: ${JSON.stringify(diagnostic)}\n\n` +
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    await drain(asProcess(transport)(sseStream(body)));

    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
  });

  test('malformed diagnostic JSON is skipped without crashing the stream', async () => {
    const onDiagnostic = vi.fn();
    const onStatus = vi.fn((_: StatusEvent) => {});
    const transport = new AxChatTransport({ onDiagnostic, onStatus });
    const body =
      `event: diagnostic\ndata: {not valid json\n\n` +
      `event: status\ndata: {"operation":"test","phase":"go","message":"ok"}\n\n` +
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; delta?: string }>;

    expect(onDiagnostic).not.toHaveBeenCalled();
    // Stream kept flowing — subsequent status event was parsed.
    expect(onStatus.mock.calls.some(([ev]) => ev?.operation === 'test' && ev?.message === 'ok')).toBe(true);
    const textDeltas = chunks.filter((c) => c.type === 'text-delta');
    expect(textDeltas.some((c) => c.delta === 'hi')).toBe(true);
  });

  test('survives SSE frames split across decoder chunks', async () => {
    const onDiagnostic = vi.fn();
    const transport = new AxChatTransport({ onDiagnostic });
    const diagnostic: Diagnostic = { severity: 'warn', kind: 'catalog_populate_server_failed', message: 'chunk-split', timestamp: '2026-04-21T18:30:03.000Z' };
    const body =
      `event: diagnostic\ndata: ${JSON.stringify(diagnostic)}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    // chunkSize=7 forces frames to span multiple transform() calls
    await drain(asProcess(transport)(sseStream(body, { chunkSize: 7 })));

    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
  });
});

describe('AxChatTransport tool_calls handling', () => {
  test('emits tool-input-available with parsed JSON args from a tool_calls delta', async () => {
    const transport = new AxChatTransport();
    const toolCall = {
      id: 'call_abc',
      index: 0,
      function: { name: 'lookup_user', arguments: '{"id":"u-1","verbose":true}' },
    };
    const body =
      `data: {"choices":[{"delta":{"tool_calls":[${JSON.stringify(toolCall)}]},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown }>;
    const toolInputs = chunks.filter((c) => c.type === 'tool-input-available');
    expect(toolInputs).toHaveLength(1);
    expect(toolInputs[0]).toMatchObject({
      type: 'tool-input-available',
      toolCallId: 'call_abc',
      toolName: 'lookup_user',
      input: { id: 'u-1', verbose: true },
    });
    // After tool runs and content arrives, the pending tool gets marked done.
    const toolOutputs = chunks.filter((c) => c.type === 'tool-output-available');
    expect(toolOutputs).toHaveLength(1);
    expect(toolOutputs[0]).toMatchObject({ type: 'tool-output-available', toolCallId: 'call_abc' });
  });

  test('uses synthetic id when tool_call has no id', async () => {
    const transport = new AxChatTransport();
    const toolCall = {
      index: 2,
      function: { name: 'noop', arguments: '{}' },
    };
    const body =
      `data: {"choices":[{"delta":{"tool_calls":[${JSON.stringify(toolCall)}]},"finish_reason":null}]}\n\n` +
      `data: [DONE]\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; toolCallId?: string }>;
    const toolInput = chunks.find((c) => c.type === 'tool-input-available');
    expect(toolInput?.toolCallId).toBe('call_2');
  });
});

describe('AxChatTransport content_block events', () => {
  test('image content_block emits an inline /api/files/<id> markdown link', async () => {
    const transport = new AxChatTransport();
    const block = { type: 'image', fileId: 'img-1' };
    const body =
      `event: content_block\ndata: ${JSON.stringify(block)}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; delta?: string }>;
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta ?? '');
    const joined = deltas.join('');
    expect(joined).toContain('![Generated image](/api/files/img-1)');
    expect(joined).not.toContain('/v1/files/');
  });

  test('file content_block emits an inline /api/files/<id> markdown link with filename', async () => {
    const transport = new AxChatTransport();
    const block = { type: 'file', fileId: 'doc-1', filename: 'report.pdf' };
    const body =
      `event: content_block\ndata: ${JSON.stringify(block)}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; delta?: string }>;
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta ?? '');
    const joined = deltas.join('');
    expect(joined).toContain('[report.pdf](/api/files/doc-1)');
    expect(joined).not.toContain('/v1/files/');
  });
});

describe('AxChatTransport user-field default', () => {
  test('defaults user to "guest" when none provided', async () => {
    const transport = new AxChatTransport();
    // Reach into the (private) prepareSendMessagesRequest the constructor wired up.
    // It lives on the underlying HttpChatTransport — accessing via `any` keeps the
    // test focused on observable wire behavior rather than base-class internals.
    const prepare = (transport as unknown as { prepareSendMessagesRequest: (opts: { id?: string; messages: unknown[] }) => Promise<{ body: { user: string } }> }).prepareSendMessagesRequest;
    expect(typeof prepare).toBe('function');
    const out = await prepare({ messages: [] });
    expect(out.body.user).toBe('guest');
  });

  test('uses provided user verbatim when no thread id', async () => {
    const transport = new AxChatTransport({ user: 'vinay' });
    const prepare = (transport as unknown as { prepareSendMessagesRequest: (opts: { id?: string; messages: unknown[] }) => Promise<{ body: { user: string } }> }).prepareSendMessagesRequest;
    const out = await prepare({ messages: [] });
    expect(out.body.user).toBe('vinay');
  });

  test('combines user + thread id and strips assistant-ui __LOCALID_ prefix', async () => {
    const transport = new AxChatTransport({ user: 'vinay' });
    const prepare = (transport as unknown as { prepareSendMessagesRequest: (opts: { id?: string; messages: unknown[] }) => Promise<{ body: { user: string } }> }).prepareSendMessagesRequest;
    const out = await prepare({ id: '__LOCALID_t1', messages: [] });
    expect(out.body.user).toBe('vinay/t1');
  });
});
