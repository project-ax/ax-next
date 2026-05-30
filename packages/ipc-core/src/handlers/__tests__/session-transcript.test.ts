import { describe, it, expect, vi } from 'vitest';
import {
  sessionAppendTranscriptHandler,
  sessionGetTranscriptHandler,
  sessionReplaceTranscriptHandler,
} from '../session-transcript.js';
import type { HandlerBinary, HandlerErr, HandlerOk } from '../types.js';

const HASH = 'a'.repeat(64);

function fakeBus(impl: (hook: string, payload: unknown) => Promise<unknown>) {
  return {
    call: vi.fn(async (hook: string, _ctx: unknown, payload: unknown) =>
      impl(hook, payload),
    ),
    hasService: vi.fn(() => true),
    registerService: vi.fn(),
    subscribe: vi.fn(),
    fire: vi.fn(),
  };
}

function fakeCtx() {
  return {
    sessionId: 's1',
    agentId: 'a1',
    userId: 'u1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

// A bus where session:get-config returns the given conversationId, and the
// transcript hook returns `hookResult`.
function busWith(conversationId: string | null, hookResult: unknown) {
  return fakeBus(async (hook, _payload) => {
    if (hook === 'session:get-config') return { conversationId };
    return hookResult;
  });
}

describe('session.append-transcript handler', () => {
  it('resolves conversationId host-side and forwards the delta', async () => {
    let forwarded: Record<string, unknown> | undefined;
    const bus = fakeBus(async (hook, payload) => {
      if (hook === 'session:get-config') return { conversationId: 'cnv_1' };
      expect(hook).toBe('conversations:append-transcript');
      forwarded = payload as Record<string, unknown>;
      return { outcome: 'appended', maxSeq: 2 };
    });
    const result = (await sessionAppendTranscriptHandler(
      { fromSeq: 0, prefixHash: HASH, lines: ['a', 'b'] },
      fakeCtx(),
      bus as never,
    )) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ outcome: 'appended', maxSeq: 2 });
    // Host-stamped conversationId — NOT from the body (body has none).
    expect(forwarded).toEqual({
      conversationId: 'cnv_1',
      fromSeq: 0,
      prefixHash: HASH,
      lines: ['a', 'b'],
    });
  });

  it('passes resync-required through unchanged', async () => {
    const bus = busWith('cnv_1', { outcome: 'resync-required', maxSeq: 5 });
    const result = (await sessionAppendTranscriptHandler(
      { fromSeq: 1, prefixHash: HASH, lines: ['x'] },
      fakeCtx(),
      bus as never,
    )) as HandlerOk;
    expect(result.body).toEqual({ outcome: 'resync-required', maxSeq: 5 });
  });

  it('rejects a body that smuggles a conversationId (strict schema → 400)', async () => {
    const bus = busWith('cnv_1', { outcome: 'appended', maxSeq: 1 });
    const result = (await sessionAppendTranscriptHandler(
      { conversationId: 'cnv_evil', fromSeq: 0, prefixHash: HASH, lines: [] },
      fakeCtx(),
      bus as never,
    )) as HandlerErr;
    expect(result.status).toBe(400);
  });

  it('rejects a bad prefixHash shape (not 64-hex → 400)', async () => {
    const bus = busWith('cnv_1', { outcome: 'appended', maxSeq: 1 });
    const result = (await sessionAppendTranscriptHandler(
      { fromSeq: 0, prefixHash: 'short', lines: [] },
      fakeCtx(),
      bus as never,
    )) as HandlerErr;
    expect(result.status).toBe(400);
  });

  it('returns 409 when the session is not conversation-scoped', async () => {
    const bus = busWith(null, { outcome: 'appended', maxSeq: 1 });
    const result = (await sessionAppendTranscriptHandler(
      { fromSeq: 0, prefixHash: HASH, lines: [] },
      fakeCtx(),
      bus as never,
    )) as HandlerErr;
    expect(result.status).toBe(409);
  });
});

describe('session.replace-transcript handler (binary REQUEST body)', () => {
  it('splits the raw bytes on newlines and forwards verbatim lines', async () => {
    let forwarded: { conversationId: string; lines: string[] } | undefined;
    const bus = fakeBus(async (hook, payload) => {
      if (hook === 'session:get-config') return { conversationId: 'cnv_1' };
      expect(hook).toBe('conversations:replace-transcript');
      forwarded = payload as { conversationId: string; lines: string[] };
      return { maxSeq: 3 };
    });
    // Three lines, each '\n'-terminated (as the SDK writes them).
    const body = Buffer.from('line1\nline2\nline3\n', 'utf8');
    const result = (await sessionReplaceTranscriptHandler(
      body,
      fakeCtx(),
      bus as never,
    )) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ maxSeq: 3 });
    // The trailing terminator must NOT produce an empty 4th line.
    expect(forwarded!.lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('handles an empty body (zero lines)', async () => {
    let forwarded: { lines: string[] } | undefined;
    const bus = fakeBus(async (hook, payload) => {
      if (hook === 'session:get-config') return { conversationId: 'cnv_1' };
      forwarded = payload as { lines: string[] };
      return { maxSeq: 0 };
    });
    await sessionReplaceTranscriptHandler(
      Buffer.alloc(0),
      fakeCtx(),
      bus as never,
    );
    expect(forwarded!.lines).toEqual([]);
  });

  it('returns 409 when the session is not conversation-scoped', async () => {
    const bus = busWith(null, { maxSeq: 0 });
    const result = (await sessionReplaceTranscriptHandler(
      Buffer.from('x\n'),
      fakeCtx(),
      bus as never,
    )) as HandlerErr;
    expect(result.status).toBe(409);
  });
});

describe('session.get-transcript handler (binary RESPONSE body)', () => {
  it('streams the reconstructed jsonl bytes back', async () => {
    const bus = busWith('cnv_1', { bytes: 'a\nb\nc', maxSeq: 3 });
    const result = (await sessionGetTranscriptHandler(
      {},
      fakeCtx(),
      bus as never,
    )) as HandlerBinary;
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/octet-stream');
    expect(result.binary.toString('utf8')).toBe('a\nb\nc');
  });

  it('streams a zero-byte body for an empty transcript', async () => {
    const bus = busWith('cnv_1', { bytes: '', maxSeq: 0 });
    const result = (await sessionGetTranscriptHandler(
      {},
      fakeCtx(),
      bus as never,
    )) as HandlerBinary;
    expect(result.binary.length).toBe(0);
  });

  it('returns 409 when the session is not conversation-scoped', async () => {
    const bus = busWith(null, { bytes: '', maxSeq: 0 });
    const result = (await sessionGetTranscriptHandler(
      {},
      fakeCtx(),
      bus as never,
    )) as HandlerErr;
    expect(result.status).toBe(409);
  });
});
