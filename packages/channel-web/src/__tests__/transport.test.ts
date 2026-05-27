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
import { afterEach, beforeEach, describe, it, test, expect, vi } from 'vitest';
import {
  AxChatTransport,
  toContentBlocksForTesting,
  CONNECTION_LOST,
} from '../lib/transport';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
} from '../lib/agent-status-store';
import {
  getPermissionCardSnapshot,
  permissionCardActions,
} from '../lib/permission-card-store';

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

describe('toContentBlocks — attachment handling', () => {
  it('emits attachment_ref blocks for ax://attachment/<id> file parts', () => {
    const msg = {
      role: 'user' as const,
      id: 'm1',
      parts: [
        { type: 'text' as const, text: 'see attached' },
        {
          type: 'file' as const,
          url: 'ax://attachment/att-abc',
          data: 'ax://attachment/att-abc',
          mediaType: 'application/pdf',
          filename: 'report.pdf',
        },
      ],
    };
    const blocks = toContentBlocksForTesting(msg);
    expect(blocks).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'attachment_ref', attachmentId: 'att-abc' },
    ]);
  });

  it('preserves attachment_ref ordering across multiple files', () => {
    // The runtime helper accepts `data` OR `url`. The AI SDK's FileUIPart
    // type makes `url` required, so we cast through unknown to exercise
    // the `data`-only branch.
    const msg = {
      role: 'user' as const,
      id: 'm1',
      parts: [
        { type: 'text' as const, text: 'two files:' },
        { type: 'file' as const, data: 'ax://attachment/a1', mediaType: 'text/plain', filename: 'a.txt' },
        { type: 'file' as const, data: 'ax://attachment/a2', mediaType: 'text/plain', filename: 'b.txt' },
      ],
    } as unknown as Parameters<typeof toContentBlocksForTesting>[0];
    const blocks = toContentBlocksForTesting(msg);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({ type: 'attachment_ref', attachmentId: 'a1' });
    expect(blocks[2]).toEqual({ type: 'attachment_ref', attachmentId: 'a2' });
  });

  it('falls back to a text mention for non-ax file parts', () => {
    const msg = {
      role: 'user' as const,
      id: 'm1',
      parts: [
        {
          type: 'file' as const,
          url: 'https://example.com/x.pdf',
          mediaType: 'application/pdf',
          filename: 'x.pdf',
        },
      ],
    };
    const blocks = toContentBlocksForTesting(msg);
    expect(blocks[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('x.pdf'),
    });
  });
});

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

  it('a skill permissionRequest frame drives the permission-card store (non-terminal)', async () => {
    permissionCardActions.reset();
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      'data: {"reqId":"r1","permissionRequest":{"kind":"skill","skillId":"linear","description":"Read your Linear issues","hosts":["api.linear.app"],"slots":[{"slot":"api_key","kind":"api-key"}]}}\n\n' +
      'data: {"reqId":"r1","text":"ok","kind":"text","seq":1}\n\n' +
      'data: {"reqId":"r1","done":true}\n\n';

    const out = (await drain(asProcess(transport)(sseStream(body)))) as Array<{
      type?: string;
    }>;

    // The card landed in the store...
    expect(getPermissionCardSnapshot().request).toMatchObject({
      kind: 'skill',
      skillId: 'linear',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'api_key', kind: 'api-key' }],
    });
    // ...and the stream still produced the trailing content + finish (non-terminal).
    expect(out.some((c) => c.type === 'finish')).toBe(true);
    permissionCardActions.reset();
  });

  // JIT P2/P7.2 — an account-tagged, already-vaulted slot's optional fields
  // (`account`, `haveExisting`) must survive the typed decode to the store.
  it('a skill permissionRequest frame preserves account + haveExisting on the slot', async () => {
    permissionCardActions.reset();
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      'data: {"reqId":"r1","permissionRequest":{"kind":"skill","skillId":"linear","description":"Read your Linear issues","hosts":["api.linear.app"],"slots":[{"slot":"LINEAR_TOKEN","kind":"api-key","account":"linear","haveExisting":true}]}}\n\n' +
      'data: {"reqId":"r1","done":true}\n\n';

    await drain(asProcess(transport)(sseStream(body)));

    const req = getPermissionCardSnapshot().request;
    expect(req?.kind).toBe('skill');
    if (req?.kind !== 'skill') return;
    expect(req.slots).toEqual([
      { slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: true },
    ]);
    permissionCardActions.reset();
  });

  it('a host permissionRequest frame drives the permission-card store (non-terminal)', async () => {
    permissionCardActions.reset();
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      'data: {"reqId":"r1","permissionRequest":{"kind":"host","host":"status.example.com","sessionId":"s1"}}\n\n' +
      'data: {"reqId":"r1","text":"ok","kind":"text","seq":1}\n\n' +
      'data: {"reqId":"r1","done":true}\n\n';

    const out = (await drain(asProcess(transport)(sseStream(body)))) as Array<{
      type?: string;
    }>;

    expect(getPermissionCardSnapshot().request).toEqual({
      kind: 'host',
      host: 'status.example.com',
      sessionId: 's1',
    });
    expect(out.some((c) => c.type === 'finish')).toBe(true);
    permissionCardActions.reset();
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

  // Faults B/D (FAULTA-5) — the stream closes mid-turn with NO terminal
  // frame (host bounce: the process died and the replica-local chunk buffer
  // is gone; network drop: the TCP connection was severed). Previously
  // flush() synthesized a finish/stop, which looked like a SUCCESSFUL turn
  // and silently dropped the half-streamed answer. It MUST instead close any
  // open part and emit an `error` chunk carrying the CONNECTION_LOST sentinel
  // so the runtime can silently retry (then surface the banner) — NOT a
  // silent finish, and NOT a hang.
  test('done-less close emits a connection-lost error chunk, not a silent finish', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body = `data: {"reqId":"r1","text":"stub","kind":"text"}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      errorText?: string;
    }>;
    const types = chunks.map((c) => c.type);
    // The open text part is closed before the error.
    expect(types).toContain('text-end');
    // It ends as an error, NOT a finish.
    expect(types).toContain('error');
    expect(types).not.toContain('finish');
    expect(types[types.length - 1]).toBe('error');
    const errorChunk = chunks.find((c) => c.type === 'error') as
      | { errorText: string }
      | undefined;
    expect(errorChunk?.errorText).toBe(CONNECTION_LOST);
  });

  // Fault D (hard network drop) — the fetch body ReadableStream ERRORS
  // mid-consumption (TCP severed). The TransformStream flush() does NOT run
  // on an upstream error, so the transport's outer error-catching wrapper
  // must convert the rejection into the SAME CONNECTION_LOST `error` chunk —
  // never a raw rejection (which would skip the silent retry) and never a
  // silent finish. It also closes any open text part first.
  test('mid-stream body error converts to a connection-lost error chunk (not a rejection)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    // Emit one text frame on the first pull (fully processed), then ERROR on
    // the next pull — mirroring a TCP reset after some bytes have streamed.
    let step = 0;
    const erroring = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 0) {
          step = 1;
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"reqId":"r1","text":"partial","kind":"text"}\n\n`,
            ),
          );
          return;
        }
        controller.error(new TypeError('network error: connection reset'));
      },
    });
    const chunks = await drain(asProcess(transport)(erroring)) as Array<{
      type: string;
      delta?: string;
      errorText?: string;
    }>;
    const types = chunks.map((c) => c.type);
    // The partial text streamed, the open part is closed, then connection-lost.
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta === 'partial')).toBe(true);
    expect(types).toContain('text-end'); // open part closed
    expect(types).toContain('error');
    expect(types).not.toContain('finish');
    expect(types[types.length - 1]).toBe('error');
    const errorChunk = chunks.find((c) => c.type === 'error') as
      | { errorText: string }
      | undefined;
    expect(errorChunk?.errorText).toBe(CONNECTION_LOST);
  });

  // A body error AFTER a terminal `done` frame must NOT emit a second
  // (error) chunk — the turn already finished cleanly; the late error is the
  // server closing the connection after the done.
  test('body error after a done frame does not append a spurious error chunk', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    let step = 0;
    const afterDone = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 0) {
          step = 1;
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"reqId":"r1","text":"hi","kind":"text"}\n\n` +
                `data: {"reqId":"r1","done":true}\n\n`,
            ),
          );
          return;
        }
        controller.error(new TypeError('socket closed'));
      },
    });
    const chunks = await drain(asProcess(transport)(afterDone)) as Array<{
      type: string;
    }>;
    const types = chunks.map((c) => c.type);
    expect(types).toContain('finish');
    expect(types).not.toContain('error');
    expect(types[types.length - 1]).toBe('finish');
  });

  // Fault A — the host emits an `error` SSE frame (instead of `done`) when a
  // turn ends abnormally. The transport must terminate the turn as ERRORED
  // (an AI-SDK `error` chunk) so `running` flips false and the runtime's
  // onError can flip the status row to error+retry — NOT silently finish as
  // if the turn completed, and NOT hang.
  test('error frame closes any open part and emits an error chunk (terminates, no silent finish)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","text":"partial","kind":"text"}\n\n` +
      `data: {"reqId":"r1","error":"sandbox-terminated"}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      errorText?: string;
    }>;
    const types = chunks.map((c) => c.type);
    // The open text part is closed before the error.
    expect(types).toContain('text-end');
    // The turn ends as an error, NOT a normal finish.
    expect(types).toContain('error');
    expect(types).not.toContain('finish');
    expect(types[types.length - 1]).toBe('error');
    const errorChunk = chunks.find((c) => c.type === 'error') as
      | { errorText: string }
      | undefined;
    expect(typeof errorChunk?.errorText).toBe('string');
    expect(errorChunk!.errorText.length).toBeGreaterThan(0);
    // The default, user-facing wording for an unmapped reason code.
    expect(errorChunk!.errorText).toBe(
      'The agent stopped unexpectedly. Retry to continue.',
    );
  });

  test('error frame maps a known reason code to a friendly label', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body = `data: {"reqId":"r1","error":"chat-run-timeout"}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      errorText?: string;
    }>;
    const errorChunk = chunks.find((c) => c.type === 'error') as
      | { errorText: string }
      | undefined;
    expect(errorChunk?.errorText).toBe('The agent timed out. Retry to continue.');
  });

  // -----------------------------------------------------------------------
  // TASK-23 — per-chunk seq dedup + gap detection (the enabling infra for a
  // loss-free silent turn-resume; FAULTA-5 follow-up). The host stamps a
  // monotonic per-reqId `seq` on every content frame. The client:
  //   - SKIPS any frame whose seq is at/below its last-seen seq (exact dedup
  //     of a replayed partial buffer — what makes a same-reqId reconnect
  //     loss-free instead of double-rendering the replayed tail);
  //   - on a contiguity GAP (a frame whose seq jumps past last-seen + 1 AFTER
  //     content was already shown — the bounded 256-chunk buffer dropped
  //     frames the client never saw) falls back to the visible CONNECTION_LOST
  //     banner (silent loss is worse than a banner — the FAULTA-5 invariant);
  //   - passes frames WITHOUT seq through unchanged (forward-compat with an
  //     older server build that never stamps seq).
  // -----------------------------------------------------------------------

  test('frames at/below the last-seen seq are deduped (exact replay dedup)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    // Simulate a same-body replay overlap: seq 1,2,3 then a REPLAY of 2,3
    // (duplicate seqs) then live 4. The duplicates must not re-emit.
    const body =
      `data: {"reqId":"r1","text":"a","kind":"text","seq":1}\n\n` +
      `data: {"reqId":"r1","text":"b","kind":"text","seq":2}\n\n` +
      `data: {"reqId":"r1","text":"c","kind":"text","seq":3}\n\n` +
      `data: {"reqId":"r1","text":"b-dup","kind":"text","seq":2}\n\n` +
      `data: {"reqId":"r1","text":"c-dup","kind":"text","seq":3}\n\n` +
      `data: {"reqId":"r1","text":"d","kind":"text","seq":4}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      delta?: string;
    }>;
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta);
    // The two duplicate frames (seq 2,3) are dropped; only 1,2,3,4 stream once.
    expect(deltas).toEqual(['a', 'b', 'c', 'd']);
    const types = chunks.map((c) => c.type);
    expect(types[types.length - 1]).toBe('finish');
    expect(types).not.toContain('error');
  });

  test('a seq gap after content surfaces CONNECTION_LOST (bounded-buffer loss)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    // seq 1,2 stream, then the next frame is seq 7 — a 4-frame hole (the
    // server's 256-cap dropped frames the client never saw). The client must
    // surface the banner rather than silently render a truncated reply.
    const body =
      `data: {"reqId":"r1","text":"a","kind":"text","seq":1}\n\n` +
      `data: {"reqId":"r1","text":"b","kind":"text","seq":2}\n\n` +
      `data: {"reqId":"r1","text":"jumped","kind":"text","seq":7}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      delta?: string;
      errorText?: string;
    }>;
    const types = chunks.map((c) => c.type);
    // The contiguous prefix (a, b) streamed; then the gap terminates as an error.
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual([
      'a',
      'b',
    ]);
    expect(types).toContain('text-end'); // open part closed before the error
    expect(types).toContain('error');
    expect(types).not.toContain('finish');
    expect(types[types.length - 1]).toBe('error');
    const errorChunk = chunks.find((c) => c.type === 'error') as
      | { errorText: string }
      | undefined;
    expect(errorChunk?.errorText).toBe(CONNECTION_LOST);
  });

  test('a clean stream whose FIRST content frame is seq 1 streams normally', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","text":"a","kind":"text","seq":1}\n\n` +
      `data: {"reqId":"r1","text":"b","kind":"text","seq":2}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      delta?: string;
    }>;
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual([
      'a',
      'b',
    ]);
    const types = chunks.map((c) => c.type);
    expect(types[types.length - 1]).toBe('finish');
    expect(types).not.toContain('error');
  });

  test('a FIRST content frame above seq 1 means a truncated head → CONNECTION_LOST (Codex P2)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    // A fresh connection whose buffer head was already dropped before connect:
    // the first seq-bearing content frame is seq 257 (the 256-cap dropped
    // 1..256). Servers mint from 1, so seq 257 first is PROOF the head is gone
    // — surface the banner rather than rendering the tail as a complete answer.
    const body =
      `data: {"reqId":"r1","text":"tail-only","kind":"text","seq":257}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      delta?: string;
      errorText?: string;
    }>;
    const types = chunks.map((c) => c.type);
    // The truncated tail must NOT render as a finished answer.
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(false);
    expect(types).toContain('error');
    expect(types).not.toContain('finish');
    expect(types[types.length - 1]).toBe('error');
    const errorChunk = chunks.find((c) => c.type === 'error') as
      | { errorText: string }
      | undefined;
    expect(errorChunk?.errorText).toBe(CONNECTION_LOST);
  });

  test('frames WITHOUT seq pass through unchanged (older-server forward-compat)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    // No seq anywhere — exactly today's wire from a pre-TASK-23 server. No
    // dedup, no gap detection: every delta streams.
    const body =
      `data: {"reqId":"r1","text":"a","kind":"text"}\n\n` +
      `data: {"reqId":"r1","text":"b","kind":"text"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      delta?: string;
    }>;
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual([
      'a',
      'b',
    ]);
    const types = chunks.map((c) => c.type);
    expect(types[types.length - 1]).toBe('finish');
    expect(types).not.toContain('error');
  });

  test('a locally-detected seq gap CANCELS the SSE body (no leaked open request; Codex P2)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    // A body that streams seq 1, 2, then a HOLE (seq 7), then would keep
    // emitting forever if not cancelled. We assert the gap path cancels the
    // underlying stream rather than leaving it open.
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const enc = new TextEncoder();
        if (pulls === 0) {
          controller.enqueue(
            enc.encode(
              `data: {"reqId":"r1","text":"a","kind":"text","seq":1}\n\n` +
                `data: {"reqId":"r1","text":"b","kind":"text","seq":2}\n\n` +
                `data: {"reqId":"r1","text":"jumped","kind":"text","seq":7}\n\n`,
            ),
          );
          pulls += 1;
          return;
        }
        // If the gap path did NOT cancel, the consumer would keep pulling.
        controller.enqueue(enc.encode(`data: {"reqId":"r1","text":"more","kind":"text","seq":8}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const chunks = await drain(asProcess(transport)(body)) as Array<{
      type: string;
      delta?: string;
      errorText?: string;
    }>;
    // The contiguous prefix streamed, then the gap surfaced CONNECTION_LOST.
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual([
      'a',
      'b',
    ]);
    const errorChunk = chunks.find((c) => c.type === 'error') as
      | { errorText: string }
      | undefined;
    expect(errorChunk?.errorText).toBe(CONNECTION_LOST);
    // The underlying body was cancelled — not left open for the server to keep
    // feeding per-connection subscribers until turn-end/timeout.
    expect(cancelled).toBe(true);
  });

  test('tool frames also participate in seq dedup', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    // A replayed tool-use frame (seq 1) after a text frame at seq 2 must dedup.
    const body =
      `data: {"reqId":"r1","kind":"tool-use","toolCallId":"t1","toolName":"Read","input":{"path":"x"},"seq":1}\n\n` +
      `data: {"reqId":"r1","text":"ok","kind":"text","seq":2}\n\n` +
      `data: {"reqId":"r1","kind":"tool-use","toolCallId":"t1","toolName":"Read","input":{"path":"x"},"seq":1}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      toolCallId?: string;
    }>;
    // Only ONE tool-input-available despite the duplicate seq-1 tool frame.
    expect(chunks.filter((c) => c.type === 'tool-input-available')).toHaveLength(1);
    const types = chunks.map((c) => c.type);
    expect(types[types.length - 1]).toBe('finish');
    expect(types).not.toContain('error');
  });
});

describe('AxChatTransport SSE phase parsing', () => {
  // Phase frames bypass the UIMessageChunk pipeline (they're agent-state
  // metadata, not message content) and drive the agent-status store
  // directly. The store's snapshot is what we assert against.
  beforeEach(() => {
    agentStatusActions.reset();
    // The phase handler is conditional on running already showing the
    // row; emulate the running effect's seed so phase has somewhere to
    // land. Without this, agentStatusActions.set() is also a no-op-ish
    // (it would show working with the new label, but explicit seed
    // matches the production order).
    agentStatusActions.show('Thinking…');
  });
  afterEach(() => {
    agentStatusActions.reset();
  });

  test('phase frame relabels the status row to the human label', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","phase":"sandbox-starting"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    await drain(asProcess(transport)(sseStream(body)));
    expect(getAgentStatusSnapshot().text).toBe('Starting sandbox…');
  });

  test('first content chunk after a phase frame swaps label back to "Thinking…"', async () => {
    // Phase = pre-content only. Once content streams, the row's label
    // returns to the default working label so the run-end cleanup hides
    // it correctly.
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","phase":"sandbox-starting"}\n\n` +
      `data: {"reqId":"r1","text":"hello","kind":"text"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    await drain(asProcess(transport)(sseStream(body)));
    expect(getAgentStatusSnapshot().text).toBe('Thinking…');
  });

  test('phase frames after content are ignored (pre-content only)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","text":"hello","kind":"text"}\n\n` +
      `data: {"reqId":"r1","phase":"sandbox-starting"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    await drain(asProcess(transport)(sseStream(body)));
    // First content chunk swapped to "Thinking…"; the late phase is a no-op.
    expect(getAgentStatusSnapshot().text).toBe('Thinking…');
  });

  test('unknown phase value is ignored (forward-compat with newer servers)', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","phase":"future-phase-we-dont-know"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    await drain(asProcess(transport)(sseStream(body)));
    // No relabel happened — the row stays on whatever it was seeded to.
    expect(getAgentStatusSnapshot().text).toBe('Thinking…');
  });

  test('phase frames do not produce UIMessageChunks', async () => {
    // Critical: phase is OUT-OF-BAND. If the parser leaked it as a
    // text-delta or finish, the assistant message would render with
    // garbage content.
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body =
      `data: {"reqId":"r1","phase":"sandbox-starting"}\n\n` +
      `data: {"reqId":"r1","done":true}\n\n`;
    const chunks = await drain(
      asProcess(transport)(sseStream(body)),
    ) as Array<{ type: string }>;
    // Only `finish` should make it through.
    expect(chunks.map((c) => c.type)).toEqual(['finish']);
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

  // ---------------------------------------------------------------------------
  // Faults B/D — done-less / dropped close surfaces the banner (FAULTA-5).
  //
  // A mid-turn drop (graceful done-less close OR a hard body error) ends the
  // turn as a CONNECTION_LOST `error` chunk → the runtime's error banner with a
  // manual retry — NOT a silent finish (the bug). The transport does NOT
  // auto-reconnect or re-POST: a re-POST could duplicate a live server turn,
  // and a GET-only buffer replay can silently lose output if the agent outran
  // the server's bounded ring buffer while disconnected (no wire sequence
  // number to align a partial replay). One POST + one GET per turn, always.
  // An ABORT (Stop / teardown) closes cleanly with no banner.
  // ---------------------------------------------------------------------------

  /**
   * Fetch mock: one POST (counted, to prove no duplicate turn) + one SSE GET
   * whose body is the given string. Counts GETs to prove no reconnect.
   */
  function makeDropFetchMock(sseBody: string) {
    let postCount = 0;
    let getCount = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : '';
      void init;
      if (u.includes('/api/chat/messages')) {
        postCount += 1;
        return new Response(JSON.stringify({ conversationId: 'c1', reqId: 'req-1' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      getCount += 1;
      return new Response(sseStream(sseBody), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    return {
      fetchFn: fetchFn as unknown as typeof fetch,
      get postCount() {
        return postCount;
      },
      get getCount() {
        return getCount;
      },
    };
  }

  test('a done-less drop ends the turn as CONNECTION_LOST (banner), one POST + one GET, no reconnect', async () => {
    // Streams a content chunk, then closes WITHOUT a done frame.
    const mock = makeDropFetchMock(`data: {"reqId":"req-1","text":"partial","kind":"text"}\n\n`);
    const transport = new AxChatTransport({ fetch: mock.fetchFn, getAgentId: () => 'a' });
    const stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    const chunks = (await drain(stream)) as Array<{ type: string; delta?: string; errorText?: string }>;

    expect(mock.postCount).toBe(1); // no duplicate turn
    expect(mock.getCount).toBe(1); // no reconnect
    // The partial content that DID stream is preserved.
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta);
    expect(deltas).toEqual(['partial']);
    const types = chunks.map((c) => c.type);
    expect(types).toContain('text-end'); // open part closed before the error
    expect(types).not.toContain('finish');
    expect(types[types.length - 1]).toBe('error');
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    expect(err?.errorText).toBe(CONNECTION_LOST);
  });

  test('a hard body error mid-stream (network drop) also surfaces CONNECTION_LOST, no reconnect', async () => {
    let getCount = 0;
    let postCount = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : String(url);
      void init;
      if (u.includes('/api/chat/messages')) {
        postCount += 1;
        return new Response(JSON.stringify({ conversationId: 'c1', reqId: 'req-1' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      getCount += 1;
      let step = 0;
      const erroring = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (step === 0) {
            step = 1;
            controller.enqueue(
              new TextEncoder().encode(`data: {"reqId":"req-1","text":"part","kind":"text"}\n\n`),
            );
            return;
          }
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(erroring, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const transport = new AxChatTransport({
      fetch: fetchFn as unknown as typeof fetch,
      getAgentId: () => 'a',
    });
    const stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    const chunks = (await drain(stream)) as Array<{ type: string; delta?: string; errorText?: string }>;

    expect(postCount).toBe(1);
    expect(getCount).toBe(1); // no reconnect
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta);
    expect(deltas).toEqual(['part']); // streamed content preserved
    const types = chunks.map((c) => c.type);
    expect(types).not.toContain('finish');
    expect(types[types.length - 1]).toBe('error');
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    expect(err?.errorText).toBe(CONNECTION_LOST);
  });

  test('a clean done frame finishes normally (no banner) — one POST + one GET', async () => {
    const mock = makeDropFetchMock(
      `data: {"reqId":"req-1","text":"hello","kind":"text"}\n\n` +
        `data: {"reqId":"req-1","done":true}\n\n`,
    );
    const transport = new AxChatTransport({ fetch: mock.fetchFn, getAgentId: () => 'a' });
    const stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    const chunks = (await drain(stream)) as Array<{ type: string; delta?: string }>;

    expect(mock.postCount).toBe(1);
    expect(mock.getCount).toBe(1);
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toBe('hello');
    expect(chunks[chunks.length - 1]?.type).toBe('finish');
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
  });

  test('a server error frame (Fault A) surfaces its mapped label, not CONNECTION_LOST', async () => {
    const mock = makeDropFetchMock(`data: {"reqId":"req-1","error":"chat-run-timeout"}\n\n`);
    const transport = new AxChatTransport({ fetch: mock.fetchFn, getAgentId: () => 'a' });
    const stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    const chunks = (await drain(stream)) as Array<{ type: string; errorText?: string }>;

    expect(mock.getCount).toBe(1); // no reconnect on a server error either
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined;
    expect(err?.errorText).toBe('The agent timed out. Retry to continue.');
    expect(err?.errorText).not.toBe(CONNECTION_LOST);
  });

  // An ABORT (user Stop / teardown) is NOT connection loss — close cleanly,
  // no banner. The abort lands during the body read.
  test('an aborted request closes cleanly with NO error chunk (not a connection-lost banner)', async () => {
    const ac = new AbortController();
    let getCount = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : String(url);
      void init;
      if (u.includes('/api/chat/messages')) {
        return new Response(JSON.stringify({ conversationId: 'c1', reqId: 'req-1' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      getCount += 1;
      let step = 0;
      const aborting = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (step === 0) {
            step = 1;
            controller.enqueue(
              new TextEncoder().encode(`data: {"reqId":"req-1","text":"x","kind":"text"}\n\n`),
            );
            return;
          }
          ac.abort();
          controller.error(new DOMException('aborted', 'AbortError'));
        },
      });
      return new Response(aborting, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const transport = new AxChatTransport({
      fetch: fetchFn as unknown as typeof fetch,
      getAgentId: () => 'a',
    });
    const stream = await transport.sendMessages({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      abortSignal: ac.signal,
    } as unknown as Parameters<typeof transport.sendMessages>[0]);
    const chunks = (await drain(stream)) as Array<{ type: string }>;
    expect(chunks.map((c) => c.type)).not.toContain('error'); // NO banner on abort
    expect(getCount).toBe(1); // no reconnect
  });
});
