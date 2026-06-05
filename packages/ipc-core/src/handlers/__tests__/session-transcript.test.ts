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

// The delta lines are now the raw octet-stream REQUEST body (matching the
// runner's `lines.join('\n') + '\n'` encoding); `fromSeq`/`prefixHash` ride the
// query. These helpers build the two so the tests mirror the wire shape.
function appendBody(lines: string[]): Buffer {
  return Buffer.from(lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
}
function appendUrl(params: Record<string, string>): URL {
  const u = new URL('http://ipc.local/session.append-transcript');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
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
      appendBody(['a', 'b']),
      fakeCtx(),
      bus as never,
      appendUrl({ fromSeq: '0', prefixHash: HASH }),
    )) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ outcome: 'appended', maxSeq: 2 });
    // Host-resolved conversationId — NOT from the wire. fromSeq coerced from
    // the query string back to a number.
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
      appendBody(['x']),
      fakeCtx(),
      bus as never,
      appendUrl({ fromSeq: '1', prefixHash: HASH }),
    )) as HandlerOk;
    expect(result.body).toEqual({ outcome: 'resync-required', maxSeq: 5 });
  });

  it('ignores a conversationId smuggled onto the query (host resolves it)', async () => {
    let forwarded: Record<string, unknown> | undefined;
    const bus = fakeBus(async (hook, payload) => {
      if (hook === 'session:get-config') return { conversationId: 'cnv_real' };
      forwarded = payload as Record<string, unknown>;
      return { outcome: 'appended', maxSeq: 1 };
    });
    const result = (await sessionAppendTranscriptHandler(
      appendBody([]),
      fakeCtx(),
      bus as never,
      appendUrl({ fromSeq: '0', prefixHash: HASH, conversationId: 'cnv_evil' }),
    )) as HandlerOk;
    expect(result.status).toBe(200);
    expect(forwarded!.conversationId).toBe('cnv_real');
  });

  it('rejects a bad prefixHash shape (not 64-hex → 400)', async () => {
    const bus = busWith('cnv_1', { outcome: 'appended', maxSeq: 1 });
    const result = (await sessionAppendTranscriptHandler(
      appendBody([]),
      fakeCtx(),
      bus as never,
      appendUrl({ fromSeq: '0', prefixHash: 'short' }),
    )) as HandlerErr;
    expect(result.status).toBe(400);
  });

  it('rejects a non-numeric fromSeq (→ 400)', async () => {
    const bus = busWith('cnv_1', { outcome: 'appended', maxSeq: 1 });
    const result = (await sessionAppendTranscriptHandler(
      appendBody([]),
      fakeCtx(),
      bus as never,
      appendUrl({ fromSeq: 'NaN', prefixHash: HASH }),
    )) as HandlerErr;
    expect(result.status).toBe(400);
  });

  it('rejects a missing fromSeq/prefixHash query param (→ 400)', async () => {
    const bus = busWith('cnv_1', { outcome: 'appended', maxSeq: 1 });
    const result = (await sessionAppendTranscriptHandler(
      appendBody([]),
      fakeCtx(),
      bus as never,
      appendUrl({ prefixHash: HASH }), // no fromSeq
    )) as HandlerErr;
    expect(result.status).toBe(400);
  });

  it('returns 409 when the session is not conversation-scoped', async () => {
    const bus = busWith(null, { outcome: 'appended', maxSeq: 1 });
    const result = (await sessionAppendTranscriptHandler(
      appendBody([]),
      fakeCtx(),
      bus as never,
      appendUrl({ fromSeq: '0', prefixHash: HASH }),
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
