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
  createTurnErrorFillSubscriber,
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
  // Plugin-side turn-error fill — stores the terminal error so a connect after
  // the error fired can replay it (TASK-22 pre-SSE-connect race).
  bus.subscribe(
    'chat:turn-error',
    '@ax/channel-web/turn-error-fill',
    createTurnErrorFillSubscriber(buffer),
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
      // TASK-23: the buffer-fill subscriber stamps the host-minted seq onto
      // the live payload, so the wire frame now carries seq:1.
      expect(frames[0]).toBe(
        'data: {"reqId":"r-test","text":"hello","kind":"text","seq":1}\n\n',
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

  // TASK-22 — the pre-SSE-connect race. channel-web returns 202 to
  // POST /api/chat/messages and the browser opens GET /api/chat/stream/:reqId
  // SEPARATELY. A fast session-open failure (e.g. a credential-resolution
  // error rejecting proxy:open-session) fires chat:turn-error BEFORE that
  // EventSource connects and installs the live subscriber. The plugin-level
  // turn-error-fill subscriber stored the reason, so the handler must replay
  // the error frame on connect and close — NOT hang on keepalives. This is the
  // exact silent-hang the host-side fireTurnError was meant to surface; the
  // live-subscriber-only path would have dropped the event.
  it('turn-error fired BEFORE connect → replays the error frame on connect and closes', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      // Terminal error fires while NO SSE client is connected — the fast
      // credential/session-open failure case (no chunks, no phase, just the
      // error).
      await bus.fire('chat:turn-error', initCtx, {
        reqId: 'r-test',
        reason: 'proxy-open-failed',
      });

      // Now the browser's EventSource connects.
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      // The replayed error frame is the only data frame, and the stream closes.
      expect(frames.map((f) => JSON.parse(f.slice(6).trim()))).toEqual([
        { reqId: 'r-test', error: 'proxy-open-failed' },
      ]);
      expect(captured.streamClosed).toBe(true);
    } finally {
      buffer.dispose();
    }
  });

  it('turn-error fired before connect for a DIFFERENT reqId does not replay', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      await bus.fire('chat:turn-error', initCtx, {
        reqId: 'r-other',
        reason: 'proxy-open-failed',
      });
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      // Our reqId ('r-test') had no buffered error → no replay, stream stays open.
      expect(
        captured.streamWrites.filter((s) => s.startsWith('data:')),
      ).toEqual([]);
      expect(captured.streamClosed).toBe(false);
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

  // F2b regression — turn-error matches by reqId ONLY, never by conversationId.
  // A runner-reported terminated chat:end restamps ctx.reqId, but the
  // orchestrator recovers the ORIGINAL agent:invoke reqId (resolveWaiterFor)
  // and fires with that, so this stream still terminates on its own reqId. The
  // important property: a turn-error for a DIFFERENT reqId on the SAME
  // conversation must NOT close this stream (two concurrent invokes can share a
  // conversation — a conversationId match would wrongly terminate the sibling).
  it('turn-error for a DIFFERENT reqId on the SAME conversation does not close us', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq(); // reqId 'r-test', conversationId 'cnv_test'
      const { res, captured } = fakeRes();
      await handler(req, res);

      // A sibling turn on the same conversation errored — fire with its reqId
      // and the same conversationId on ctx.
      const convCtx = ctxWithConversation(initCtx, 'cnv_test');
      await bus.fire('chat:turn-error', convCtx, {
        reqId: 'r-sibling',
        reason: 'sandbox-terminated',
      });

      // Our stream (r-test) stays open — only the sibling's stream should close.
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
      // TASK-23: the content chunk carries the host-minted seq:1 (the phase
      // frame above is out-of-band and never stamped).
      expect(frames[1]).toBe(
        'data: {"reqId":"r-test","text":"hi","kind":"text","seq":1}\n\n',
      );
    } finally {
      buffer.dispose();
    }
  });

  // -----------------------------------------------------------------------
  // TASK-23 — per-chunk monotonic seq on the SSE wire. The buffer-fill
  // subscriber stamps the seq the ChunkBuffer minted onto the live
  // chat:stream-chunk payload (by returning it from the subscriber), so the
  // per-connection live subscriber and the replay tail carry the SAME seq.
  // The client dedups replayed frames at/below its last-seen seq.
  // -----------------------------------------------------------------------

  it('live chunk frames carry a host-minted monotonic seq', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

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

      const frames = captured.streamWrites
        .filter((s) => s.startsWith('data:'))
        .map((f) => JSON.parse(f.slice(6).trim()));
      expect(frames).toEqual([
        { reqId: 'r-test', text: 'a', kind: 'text', seq: 1 },
        { reqId: 'r-test', text: 'b', kind: 'text', seq: 2 },
      ]);
    } finally {
      buffer.dispose();
    }
  });

  it('replayed frames carry their stored seq, then a live frame continues the count', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      // Three chunks BEFORE the SSE client connects.
      for (const text of ['a', 'b', 'c']) {
        await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
          reqId: 'r-test',
          text,
          kind: 'text',
        });
      }

      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);

      // Live fourth chunk.
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'd',
        kind: 'text',
      });

      const frames = captured.streamWrites
        .filter((s) => s.startsWith('data:'))
        .map((f) => JSON.parse(f.slice(6).trim()));
      expect(frames.map((f) => [f.text, f.seq])).toEqual([
        ['a', 1],
        ['b', 2],
        ['c', 3],
        ['d', 4],
      ]);
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
