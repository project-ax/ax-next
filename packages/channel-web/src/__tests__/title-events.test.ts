import { describe, it, expect, vi } from 'vitest';
import { subscribeTitleEvents } from '../lib/title-events.js';

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('subscribeTitleEvents', () => {
  it('invokes onTitle for each data frame and ignores comments/junk', async () => {
    const frames: Array<{ conversationId: string; title: string }> = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      streamResponse([
        ':\n\n',
        'data: {"conversationId":"cnv_1","title":"One"}\n\n',
        'data: not-json\n\n',
        'data: {"conversationId":"cnv_2","title":"Two"}\n\n',
      ]),
    ).mockResolvedValue(streamResponse([])); // subsequent reconnects: empty
    const stop = subscribeTitleEvents({
      onTitle: (f) => frames.push(f),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 5,
    });
    await vi.waitFor(() => expect(frames.length).toBe(2));
    stop();
    expect(frames).toEqual([
      { conversationId: 'cnv_1', title: 'One' },
      { conversationId: 'cnv_2', title: 'Two' },
    ]);
  });

  it('calls onOpen on a successful connect', async () => {
    const onOpen = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([]));
    const stop = subscribeTitleEvents({
      onTitle: () => {}, onOpen,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 5,
    });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    stop();
  });

  it('reconnects after the stream ends', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([]));
    const stop = subscribeTitleEvents({
      onTitle: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 1,
    });
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2));
    stop();
  });
});
