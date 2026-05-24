// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  type AgentContext,
} from '@ax/core';
import { createChunkBuffer } from '../../server/chunk-buffer';
import {
  createBufferFillSubscriber,
  createPhaseFillSubscriber,
  createSseHandler,
  createTurnEndEvictor,
  type RouteRequest,
  type RouteResponse,
  type RouteStream,
} from '../../server/sse';
import type { PhaseEvent, StreamChunk } from '../../server/types';

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
      // in @ax/auth-better and is exercised separately).
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
  const initCtx = makeAgentContext({
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
  // Plugin-side phase-fill subscriber — same role as buffer-fill but for
  // single-slot phase memory.
  bus.subscribe(
    'chat:phase',
    '@ax/channel-web/phase-fill',
    createPhaseFillSubscriber(buffer),
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

function ctxWithConversation(ctx: AgentContext, conversationId: string): AgentContext {
  // makeAgentContext spreads conversationId only when defined; reuse to
  // produce a context the turn-end subscriber will match.
  return makeAgentContext({
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

  // -----------------------------------------------------------------------
  // chat:turn-error — the terminated-turn terminator (Fault A). The
  // orchestrator fires this with the ORIGINAL agent:invoke ctx.reqId when a
  // turn ends abnormally (sandbox death / wedged-runner timeout) instead of
  // firing chat:turn-end. The SSE handler matches by reqId (NOT
  // conversationId — the orchestrator carries the original reqId, so the
  // precise per-turn join key is available) and emits an `error` frame +
  // closes, so the client flips out of the "Thinking…" spinner.
  // -----------------------------------------------------------------------

  it('turn-error: when chat:turn-error fires with the matching reqId, SSE emits an error frame and closes', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'partial',
        kind: 'text',
      });

      await bus.fire('chat:turn-error', initCtx, {
        reqId: 'r-test',
        reason: 'sandbox-terminated',
      });

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      const last = frames[frames.length - 1]!;
      expect(JSON.parse(last.slice(6).trim())).toEqual({
        reqId: 'r-test',
        error: 'sandbox-terminated',
      });
      expect(captured.streamClosed).toBe(true);
    } finally {
      buffer.dispose();
    }
  });

  it('turn-error with a non-matching reqId does not close us', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      await bus.fire('chat:turn-error', initCtx, {
        reqId: 'r-other',
        reason: 'sandbox-terminated',
      });

      expect(captured.streamClosed).toBe(false);
      expect(
        captured.streamWrites.filter((s) => s.startsWith('data:')),
      ).toEqual([]);
    } finally {
      buffer.dispose();
    }
  });

  // F2b — a runner-reported terminated chat:end is fired by the IPC server
  // with a RESTAMPED reqId (fresh per request) but a stamped ctx.conversationId.
  // So onChatEnd's turn-error can't match by reqId; the SSE matches it by
  // conversationId, mirroring the done-frame chat:turn-end subscriber.
  it('turn-error matched by conversationId (restamped reqId) emits an error frame and closes', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      const convCtx = ctxWithConversation(initCtx, 'cnv_test');
      await bus.fire('chat:turn-error', convCtx, {
        // reqId restamped by the IPC server → will NOT match 'r-test'.
        reqId: 'r-restamped-by-ipc',
        reason: 'Error: resume boom',
      });

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      const last = frames[frames.length - 1]!;
      expect(JSON.parse(last.slice(6).trim())).toEqual({
        reqId: 'r-test',
        error: 'Error: resume boom',
      });
      expect(captured.streamClosed).toBe(true);
    } finally {
      buffer.dispose();
    }
  });

  it('turn-error on a DIFFERENT conversationId (and non-matching reqId) does not close us', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      const otherCtx = ctxWithConversation(initCtx, 'cnv_other');
      await bus.fire('chat:turn-error', otherCtx, {
        reqId: 'r-other',
        reason: 'sandbox-terminated',
      });

      expect(captured.streamClosed).toBe(false);
      expect(
        captured.streamWrites.filter((s) => s.startsWith('data:')),
      ).toEqual([]);
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

  // -----------------------------------------------------------------------
  // chat:phase — out-of-band agent-state frames. Same posture as chunks:
  // per-connection subscriber filters by reqId, the buffer-fill flavor
  // captures phase for replay-on-attach.
  // -----------------------------------------------------------------------

  it('phase fires on bus → SSE phase frame written to the connection', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      await bus.fire<PhaseEvent>('chat:phase', initCtx, {
        reqId: 'r-test',
        phase: 'sandbox-starting',
      });

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames).toEqual([
        'data: {"reqId":"r-test","phase":"sandbox-starting"}\n\n',
      ]);
    } finally {
      buffer.dispose();
    }
  });

  it('phase frames with non-matching reqId are NOT emitted', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      await bus.fire<PhaseEvent>('chat:phase', initCtx, {
        reqId: 'r-other',
        phase: 'sandbox-starting',
      });

      expect(
        captured.streamWrites.filter((s) => s.startsWith('data:')),
      ).toEqual([]);
    } finally {
      buffer.dispose();
    }
  });

  it('phase fired BEFORE attach is replayed on connect (pre-content window)', async () => {
    // Mirrors the chunk replay test: an SSE consumer that connects after
    // sandbox-k8s already announced the phase should still see it. This
    // is the whole reason for the single-slot phase memory in
    // chunk-buffer.
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      // Phase fires while no SSE listener is attached.
      await bus.fire<PhaseEvent>('chat:phase', initCtx, {
        reqId: 'r-test',
        phase: 'sandbox-starting',
      });

      // Now the client connects.
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames).toEqual([
        'data: {"reqId":"r-test","phase":"sandbox-starting"}\n\n',
      ]);
    } finally {
      buffer.dispose();
    }
  });

  it('phase replay precedes any chunk replay (matches original fire order)', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      await bus.fire<PhaseEvent>('chat:phase', initCtx, {
        reqId: 'r-test',
        phase: 'sandbox-starting',
      });
      // (In the real flow the buffer evicts phase as soon as content
      // lands, so this scenario — phase-then-chunk-then-attach — is
      // mostly theoretical. We still verify the *ordering* matches the
      // would-be live ordering.)
      // To exercise the ordering test we need to re-introduce the phase
      // post-content. Since appendPhase is ignored after content, we
      // attach BEFORE any content lands and verify phase comes first.
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'hi',
        kind: 'text',
      });

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames[0]).toBe(
        'data: {"reqId":"r-test","phase":"sandbox-starting"}\n\n',
      );
      expect(frames[1]).toBe(
        'data: {"reqId":"r-test","text":"hi","kind":"text"}\n\n',
      );
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
