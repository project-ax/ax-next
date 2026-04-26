// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  PluginError,
  makeChatContext,
  type ChatContext,
} from '@ax/core';
import { createChunkBuffer } from '../../server/chunk-buffer';
import {
  createBufferFillSubscriber,
  createSseHandler,
  createTurnEndEvictor,
  type RouteRequest,
  type RouteResponse,
  type RouteStream,
} from '../../server/sse';
import type { StreamChunk } from '../../server/types';

// ---------------------------------------------------------------------------
// SSE handler tests. We exercise the handler by directly calling it with
// a fake `req` and a fake `res` adapter that captures status, JSON
// responses, and stream writes. The full http-server integration is
// covered downstream (Task 8 / acceptance test); the unit boundary here
// is the handler factory.
// ---------------------------------------------------------------------------

interface CapturedResponse {
  statusCode?: number;
  jsonBody?: unknown;
  textBody?: string;
  ended: boolean;
  streamWrites: string[];
  streamClosed: boolean;
  /** Synchronously fire a "client closed" event from outside the handler. */
  fireClientClose(): void;
}

function fakeRes(): { res: RouteResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    ended: false,
    streamWrites: [],
    streamClosed: false,
    fireClientClose: () => {},
  };
  let stream: RouteStream | null = null;
  const onCloseHandlers: Array<() => void> = [];
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    header(_n, _v) {
      return res;
    },
    json(v) {
      captured.jsonBody = v;
      captured.ended = true;
    },
    text(s) {
      captured.textBody = s;
      captured.ended = true;
    },
    end() {
      captured.ended = true;
    },
    stream() {
      stream = {
        write(chunk) {
          if (captured.streamClosed) return;
          captured.streamWrites.push(
            typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
          );
        },
        close() {
          captured.streamClosed = true;
          for (const h of onCloseHandlers.splice(0)) h();
        },
        onClose(handler) {
          if (captured.streamClosed) {
            queueMicrotask(handler);
            return;
          }
          onCloseHandlers.push(handler);
        },
      };
      captured.ended = true;
      return stream;
    },
  };
  captured.fireClientClose = () => {
    if (captured.streamClosed) return;
    captured.streamClosed = true;
    for (const h of onCloseHandlers.splice(0)) h();
  };
  return { res, captured };
}

interface FakeReqOpts {
  reqId?: string;
  cookieUserId?: string | null;
}

function fakeReq(opts: FakeReqOpts = {}): RouteRequest {
  const reqId = opts.reqId ?? 'r-test';
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params: { reqId },
    signedCookie() {
      // The auth subscriber inspects this — we model auth via a service
      // hook rather than a real cookie chain (the cookie mechanism lives
      // in @ax/auth-oidc and is exercised separately).
      return opts.cookieUserId ?? null;
    },
  };
}

interface BootOpts {
  /** userId returned by auth:require-user; null → unauthenticated. */
  authUser?: { id: string; isAdmin: boolean } | null;
  /** conversationId/agentId looked up by reqId; null → not-found. */
  conversation?: {
    conversationId: string;
    agentId: string;
    userId: string;
    activeReqId: string;
  } | null;
  /** Whether agents:resolve allows the (agentId, userId) tuple. */
  agentResolveAllow?: boolean;
}

function bootHandler(opts: BootOpts = {}) {
  const bus = new HookBus();
  const initCtx = makeChatContext({
    sessionId: 'init',
    agentId: '@ax/channel-web',
    userId: 'system',
  });

  const authUser = opts.authUser === undefined ? { id: 'userA', isAdmin: false } : opts.authUser;
  const conversation =
    opts.conversation === undefined
      ? {
          conversationId: 'cnv_test',
          agentId: 'agt_test',
          userId: 'userA',
          activeReqId: 'r-test',
        }
      : opts.conversation;
  const agentResolveAllow = opts.agentResolveAllow ?? true;

  bus.registerService('auth:require-user', 'mock-auth', async () => {
    if (authUser === null) {
      throw new PluginError({
        code: 'unauthenticated',
        plugin: 'mock-auth',
        message: 'no session',
      });
    }
    return { user: authUser };
  });

  bus.registerService('conversations:get-by-req-id', 'mock-conv', async () => {
    if (conversation === null) {
      throw new PluginError({
        code: 'not-found',
        plugin: 'mock-conv',
        message: 'reqId not found',
      });
    }
    return conversation;
  });

  bus.registerService('agents:resolve', 'mock-agents', async () => {
    if (!agentResolveAllow) {
      throw new PluginError({
        code: 'forbidden',
        plugin: 'mock-agents',
        message: 'forbidden',
      });
    }
    return { agent: { id: 'agt_test', visibility: 'personal' } };
  });

  const buffer = createChunkBuffer();
  // Plugin-side buffer-fill subscriber — stand-in for the channel-web
  // plugin's boot-time wiring.
  bus.subscribe(
    'chat:stream-chunk',
    '@ax/channel-web/buffer-fill',
    createBufferFillSubscriber(buffer),
  );
  // Plugin-side turn-end evictor.
  bus.subscribe(
    'chat:turn-end',
    '@ax/channel-web/turn-end-evictor',
    createTurnEndEvictor(buffer),
  );

  const handler = createSseHandler({ bus, initCtx, buffer });
  return { bus, initCtx, buffer, handler };
}

function ctxWithConversation(ctx: ChatContext, conversationId: string): ChatContext {
  // makeChatContext spreads conversationId only when defined; reuse to
  // produce a context the turn-end subscriber will match.
  return makeChatContext({
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    userId: ctx.userId,
    conversationId,
  });
}

describe('@ax/channel-web SSE handler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 401 when auth:require-user rejects', async () => {
    const { handler, buffer } = bootHandler({ authUser: null });
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      expect(captured.statusCode).toBe(401);
      expect(captured.jsonBody).toEqual({ error: 'unauthenticated' });
      expect(captured.streamWrites).toEqual([]);
    } finally {
      buffer.dispose();
    }
  });

  it("returns 404 (NOT 403) when reqId doesn't belong to the user", async () => {
    // J9: foreign-reqId guess returns the same shape as nonexistent.
    const { handler, buffer } = bootHandler({ conversation: null });
    try {
      const req = fakeReq({ reqId: 'r-someone-elses' });
      const { res, captured } = fakeRes();
      await handler(req, res);
      expect(captured.statusCode).toBe(404);
      expect(captured.jsonBody).toEqual({ error: 'not-found' });
    } finally {
      buffer.dispose();
    }
  });

  it("returns 404 (NOT 403) when agents:resolve forbids", async () => {
    const { handler, buffer } = bootHandler({ agentResolveAllow: false });
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      expect(captured.statusCode).toBe(404);
      expect(captured.jsonBody).toEqual({ error: 'not-found' });
    } finally {
      buffer.dispose();
    }
  });

  it('happy: chunk fires on bus → SSE frame written to the connection', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      // Headers should have flushed by now (status 200 + stream started).
      expect(captured.statusCode).toBe(200);

      // Fire one chunk on the bus — handler's subscriber should write it.
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'hello',
        kind: 'text',
      });

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames).toHaveLength(1);
      expect(frames[0]).toBe(
        'data: {"reqId":"r-test","text":"hello","kind":"text"}\n\n',
      );
    } finally {
      buffer.dispose();
    }
  });

  it('filter: chunks with non-matching reqId are NOT emitted', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-other',
        text: 'leaked?',
        kind: 'text',
      });

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames).toHaveLength(0);
    } finally {
      buffer.dispose();
    }
  });

  it('replay: client connects AFTER 3 chunks already fired → receives those 3 chunks then tails live', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      // Three chunks BEFORE the SSE client connects.
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'a',
        kind: 'text',
      });
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'b',
        kind: 'text',
      });
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'c',
        kind: 'text',
      });

      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      // Replay should have written exactly those three.
      let frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames.map((f) => JSON.parse(f.slice(6).trim()).text)).toEqual([
        'a',
        'b',
        'c',
      ]);

      // Now fire a fourth — it should arrive live via the subscriber.
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'd',
        kind: 'text',
      });
      frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames.map((f) => JSON.parse(f.slice(6).trim()).text)).toEqual([
        'a',
        'b',
        'c',
        'd',
      ]);
    } finally {
      buffer.dispose();
    }
  });

  it('turn-end: when chat:turn-end fires with the matching conversationId, SSE emits done:true and closes', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      // Quick chunk so we can observe done arriving after.
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'x',
        kind: 'text',
      });

      const turnEndCtx = ctxWithConversation(initCtx, 'cnv_test');
      await bus.fire('chat:turn-end', turnEndCtx, {
        reqId: 'r-test',
        reason: 'complete',
      });

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      // Last frame should be the done marker.
      const last = frames[frames.length - 1]!;
      expect(JSON.parse(last.slice(6).trim())).toEqual({
        reqId: 'r-test',
        done: true,
      });
      expect(captured.streamClosed).toBe(true);
    } finally {
      buffer.dispose();
    }
  });

  it('turn-end on a DIFFERENT conversationId does not close us', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      const otherCtx = ctxWithConversation(initCtx, 'cnv_other');
      await bus.fire('chat:turn-end', otherCtx, {
        reqId: 'r-other',
        reason: 'complete',
      });

      expect(captured.streamClosed).toBe(false);
      // No done frame.
      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames).toEqual([]);
    } finally {
      buffer.dispose();
    }
  });

  it('client disconnect unsubscribes both bus subscriptions', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      // Fire the client-close.
      captured.fireClientClose();
      // After client close, future chunks must NOT be written.
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'after-close',
        kind: 'text',
      });
      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames).toHaveLength(0);

      // Same for turn-end.
      const turnEndCtx = ctxWithConversation(initCtx, 'cnv_test');
      await bus.fire('chat:turn-end', turnEndCtx, {
        reqId: 'r-test',
        reason: 'complete',
      });
      // Stream is closed; no late writes.
      expect(
        captured.streamWrites.filter((s) => s.startsWith('data:')),
      ).toHaveLength(0);
    } finally {
      buffer.dispose();
    }
  });

  it('keepalive heartbeat fires every 25s with a comment frame', async () => {
    vi.useFakeTimers();
    const { handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      // No keepalive yet.
      expect(captured.streamWrites.filter((s) => s === ':\n\n')).toHaveLength(0);

      vi.advanceTimersByTime(25_000);
      expect(captured.streamWrites.filter((s) => s === ':\n\n')).toHaveLength(1);

      vi.advanceTimersByTime(25_000);
      expect(captured.streamWrites.filter((s) => s === ':\n\n')).toHaveLength(2);
    } finally {
      buffer.dispose();
    }
  });
});
