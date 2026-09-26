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
  createPermissionCardFillSubscriber,
  createPhaseFillSubscriber,
  createSseHandler,
  createTurnEndEvictor,
  createTurnErrorFillSubscriber,
  type RouteRequest,
  type RouteResponse,
  type RouteStream,
} from '../../server/sse';
import { recordGrantDecline } from '../../server/grant-declines';
import type { PermissionRequest, PhaseEvent, StreamChunk } from '../../server/types';

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
  /**
   * Test clock for the buffer's pending-card `raisedAt` stamps (TASK-444).
   * Omitted → the system clock, exactly as production wires it.
   */
  now?: () => number;
  /**
   * Register the generic KV services the durable "Not now" marker lives in
   * (TASK-444). `'read-write'` registers both `storage:set` and
   * `storage:list-prefix`; `'write-only'` registers only the writer, so the
   * filter's `hasService('storage:list-prefix')` short-circuit is the thing
   * under test; omitted → neither, i.e. a deployment with no KV store at all.
   */
  storage?: 'read-write' | 'write-only';
  /**
   * Hold `storage:list-prefix` open until the test says otherwise (TASK-444
   * regression seam). The decline read is the only `await` the handler makes
   * anywhere near the replay, and the whole question these tests ask is what
   * happens to the connection while it is in flight — which is unaskable if
   * the stub resolves on the spot. Requires `storage: 'read-write'`.
   */
  gateListPrefix?: boolean;
}

/** A promise plus the handle to settle it from the outside. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

  // The KV substrate the durable decline marker is written through. Only
  // registered when a test asks for it — every other test in this file runs in
  // a process with no store, which is the pre-TASK-444 world.
  const kv = new Map<string, Uint8Array>();
  if (opts.storage !== undefined) {
    bus.registerService<{ key: string; value: Uint8Array }, void>(
      'storage:set',
      'mock-storage',
      async (_ctx, { key, value }) => {
        kv.set(key, value);
      },
    );
  }
  // Resolves the moment the handler asks the store for this user's declines;
  // `listPrefixGate` is what it then waits on when `gateListPrefix` is set.
  const listPrefixEntered = deferred();
  const listPrefixGate = deferred();
  // How many times the handler actually went to the store. A stream opening on
  // a conversation with no pending card must not go at all (TASK-444).
  const listPrefixCalls = { n: 0 };
  // TASK-482: the reclaim capability is REGISTERED on this bus on purpose.
  // "The stream never prunes" is only worth asserting against a deployment
  // that could have — with no `storage:delete` on the bus the assertion would
  // hold for free, and would keep holding after somebody wired pruning into
  // the replay.
  const deleteCalls: string[] = [];
  if (opts.storage === 'read-write') {
    bus.registerService<{ key: string }, { deleted: number }>(
      'storage:delete',
      'mock-storage',
      async (_ctx, { key }) => {
        deleteCalls.push(key);
        return { deleted: kv.delete(key) ? 1 : 0 };
      },
    );
    bus.registerService<
      { prefix: string },
      { entries: Array<{ key: string; value: Uint8Array }> }
    >('storage:list-prefix', 'mock-storage', async (_ctx, { prefix }) => {
      listPrefixCalls.n += 1;
      listPrefixEntered.resolve();
      if (opts.gateListPrefix === true) await listPrefixGate.promise;
      return {
        entries: [...kv.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      };
    });
  }

  const buffer = createChunkBuffer(
    opts.now !== undefined ? { now: opts.now } : {},
  );
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
  // Plugin-side permission-card fill — stores the pending JIT approval card so a
  // connect AFTER the card fired (the cold-boot delivery race) replays it
  // (TASK-82).
  bus.subscribe(
    'chat:permission-request',
    '@ax/channel-web/permission-card-fill',
    createPermissionCardFillSubscriber(buffer),
  );

  const handler = createSseHandler({ bus, initCtx, buffer });
  return {
    bus,
    initCtx,
    buffer,
    handler,
    kv,
    /** Resolves once the handler has entered the decline read. */
    listPrefixCalled: listPrefixEntered.promise,
    /** How many times the handler went to the store. */
    listPrefixCalls,
    /** Every key the handler deleted. Must stay empty (TASK-482). */
    deleteCalls,
    /** Lets that read finish. No-op unless `gateListPrefix` was set. */
    releaseListPrefix: listPrefixGate.resolve,
  };
}

function dataFrames(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .filter((w) => w.startsWith('data: '))
    .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
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

  // TASK-569 — approve while the held reply is still streaming. The approve
  // binds a NEW reqId (the continuation) on the SAME conversation while the
  // held turn is still in flight under its own reqId. The held turn's
  // turn-end then lands on a conversation whose open stream is the
  // continuation's — and must not close it, or the continuation never renders.
  it('turn-end for a DIFFERENT reqId on the SAME conversation does not close us (held turn ending under an open continuation stream)', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      // The continuation stream the client attached to after approving.
      await handler(fakeReq({ reqId: 'r-test' }), res);

      // The held turn ends — same conversation, its own reqId. The runner
      // stamps the inbox entry's reqId onto both turn-ends it emits.
      const sameConversation = ctxWithConversation(initCtx, 'cnv_test');
      await bus.fire('chat:turn-end', sameConversation, {
        reqId: 'r-held',
        reason: 'user-message-wait',
        role: 'tool',
      });
      await bus.fire('chat:turn-end', sameConversation, {
        reqId: 'r-held',
        reason: 'user-message-wait',
        role: 'assistant',
      });
      expect(captured.streamClosed).toBe(false);
      expect(dataFrames(captured.streamWrites).some((f) => f.done === true)).toBe(false);

      // The continuation now streams live on the still-open connection…
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        text: 'continuation',
        kind: 'text',
      });
      // …and closes on ITS OWN turn-end.
      await bus.fire('chat:turn-end', sameConversation, {
        reqId: 'r-test',
        reason: 'user-message-wait',
      });

      const frames = dataFrames(captured.streamWrites);
      expect(frames.map((f) => f.text).filter((t) => t !== undefined)).toEqual(['continuation']);
      expect(frames[frames.length - 1]).toEqual({ reqId: 'r-test', done: true });
      expect(captured.streamClosed).toBe(true);
    } finally {
      buffer.dispose();
    }
  });

  it('turn-end with NO reqId on the same conversation still closes us (a producer that names no turn keeps the old conversation match)', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire('chat:turn-end', ctxWithConversation(initCtx, 'cnv_test'), {
        reason: 'complete',
      });

      expect(dataFrames(captured.streamWrites).at(-1)).toEqual({ reqId: 'r-test', done: true });
      expect(captured.streamClosed).toBe(true);
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

  // TASK-160 — a dev-service-sidecar failure rides an optional `detail` on the
  // turn-error; the live error frame carries it through to the client.
  it('turn-error: forwards the optional detail on the live error frame', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      await bus.fire('chat:turn-error', initCtx, {
        reqId: 'r-test',
        reason: 'dev-service-failed',
        detail: "Dev service 'kafka' couldn't write /opt/kafka (read-only filesystem) — add /opt/kafka to the service's writablePaths.",
      });
      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      const last = frames[frames.length - 1]!;
      expect(JSON.parse(last.slice(6).trim())).toEqual({
        reqId: 'r-test',
        error: 'dev-service-failed',
        detail:
          "Dev service 'kafka' couldn't write /opt/kafka (read-only filesystem) — add /opt/kafka to the service's writablePaths.",
      });
      expect(captured.streamClosed).toBe(true);
    } finally {
      buffer.dispose();
    }
  });

  it('turn-error fired before connect → replays the detail too', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      await bus.fire('chat:turn-error', initCtx, {
        reqId: 'r-test',
        reason: 'dev-service-failed',
        detail: "Dev service 'db' couldn't write /data/db (permission denied) — add /data/db to the service's writablePaths.",
      });
      const req = fakeReq();
      const { res, captured } = fakeRes();
      await handler(req, res);
      const frames = captured.streamWrites.filter((s) => s.startsWith('data:'));
      expect(frames.map((f) => JSON.parse(f.slice(6).trim()))).toEqual([
        {
          reqId: 'r-test',
          error: 'dev-service-failed',
          detail:
            "Dev service 'db' couldn't write /data/db (permission denied) — add /data/db to the service's writablePaths.",
        },
      ]);
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

describe('permission-request frame', () => {
  it('emits a card frame for THIS conversation and keeps the stream open', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        {
          kind: 'skill',
          skillId: 'linear',
          description: 'Read your Linear issues',
          hosts: ['api.linear.app'],
          slots: [{ slot: 'api_key', kind: 'api-key' }],
        },
      );

      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      const card = frames.find((f) => 'permissionRequest' in f);
      expect(card).toMatchObject({
        reqId: 'r-test',
        permissionRequest: {
          skillId: 'linear',
          hosts: ['api.linear.app'],
          slots: [{ slot: 'api_key', kind: 'api-key' }],
        },
      });
      // The card is NON-terminal — unlike turn-error it must not close us.
      expect(captured.streamClosed).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  // JIT P2/P7.2 — the SSE forwarder relays the payload verbatim, so a slot's
  // optional account + haveExisting fields must reach the browser frame intact.
  it('forwards account + haveExisting on a skill card slot verbatim', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        {
          kind: 'skill',
          skillId: 'linear',
          description: 'Read your Linear issues',
          hosts: ['api.linear.app'],
          slots: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: true }],
        },
      );

      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      const card = frames.find((f) => 'permissionRequest' in f);
      const slots = (card?.permissionRequest as { slots: unknown[] }).slots;
      expect(slots[0]).toEqual({
        slot: 'LINEAR_TOKEN',
        kind: 'api-key',
        account: 'linear',
        haveExisting: true,
      });
    } finally {
      buffer.dispose();
    }
  });

  it('does NOT deliver a card raised on a different conversation', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_OTHER'),
        { kind: 'skill', skillId: 'linear', description: 'd', hosts: [], slots: [] },
      );

      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      expect(frames.some((f) => 'permissionRequest' in f)).toBe(false);
      expect(captured.streamClosed).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  // TASK-37 — the host-grant variant. Unlike the skill variant (broker-fired,
  // matched by conversationId), the host variant is orchestrator-fired carrying
  // a routing reqId in the PAYLOAD and matched by payload.reqId (like
  // chat:turn-error). The routing reqId is stripped from what the browser sees.
  it('emits a host card frame matched by reqId and keeps the stream open', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire('chat:permission-request', initCtx, {
        kind: 'host',
        host: 'status.example.com',
        sessionId: 's1',
        reqId: 'r-test',
      });

      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      const card = frames.find((f) => 'permissionRequest' in f);
      expect(card).toMatchObject({
        reqId: 'r-test',
        permissionRequest: { kind: 'host', host: 'status.example.com', sessionId: 's1' },
      });
      // The routing reqId must NOT leak into the card payload (the browser
      // already knows its reqId from the connection).
      expect(
        (card?.permissionRequest as Record<string, unknown>).reqId,
      ).toBeUndefined();
      expect(captured.streamClosed).toBe(false); // non-terminal
    } finally {
      buffer.dispose();
    }
  });

  it('does NOT deliver a host card whose reqId differs from the connection', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire('chat:permission-request', initCtx, {
        kind: 'host',
        host: 'h.example.com',
        sessionId: 's1',
        reqId: 'r-OTHER',
      });

      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      expect(frames.some((f) => 'permissionRequest' in f)).toBe(false);
      expect(captured.streamClosed).toBe(false);
    } finally {
      buffer.dispose();
    }
  });
});

// TASK-82 — the cold-boot delivery race. The headline regression: a
// `chat:permission-request` (the JIT cap-skill approval card) fires onto the bus
// BEFORE the EventSource opens and installs the live subscriber — exactly what
// happens on a gated turn, where the runner pod is cold-spawned and the SSE GET
// races that boot (it even 404s). Before the fix the card was delivered ONLY to
// an already-attached live subscriber, so the pre-connect card was lost forever
// and the orchestrator's per-conversation dedup suppressed any re-emission,
// leaving the pending skill permanently un-approvable. The boot-level
// permission-card fill subscriber + the SSE-open replay make it durable.
describe('permission-request replay on (re)connect (TASK-82)', () => {
  function skillCard(skillId = 'github-helper'): PermissionRequest {
    return {
      kind: 'skill',
      skillId,
      description: 'Reach the GitHub API on your behalf',
      hosts: ['api.github.com'],
      slots: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
      authored: true,
    };
  }

  it('replays a pending cap-skill card to a stream that opens AFTER it fired', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      // 1) The card fires DURING cold boot — no SSE stream is open yet, so the
      //    live subscriber doesn't exist. The fill subscriber buffers it.
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );

      // 2) The browser's EventSource opens (the turn cold-spawned a pod, the
      //    POST returned the reqId, the GET now races in).
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      // 3) The card MUST surface on connect — without the replay (the bug) the
      //    pending skill is permanently un-approvable.
      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      const card = frames.find((f) => 'permissionRequest' in f);
      expect(card).toMatchObject({
        reqId: 'r-test',
        permissionRequest: {
          kind: 'skill',
          skillId: 'github-helper',
          hosts: ['api.github.com'],
          authored: true,
        },
      });
      // Non-terminal — the replay must not close the stream.
      expect(captured.streamClosed).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  it('replays the same pending card to a SECOND connection (reconnect)', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );

      // First connect (sees it live-or-replay), then drops.
      const first = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), first.res);
      first.captured.fireClientClose();

      // Reconnect — the pending card is still un-approved, so it must replay
      // again (a refresh / tab re-focus must not lose the card).
      const second = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), second.res);
      const frames = second.captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      expect(
        frames.some(
          (f) =>
            (f.permissionRequest as { skillId?: string } | undefined)?.skillId ===
            'github-helper',
        ),
      ).toBe(true);
    } finally {
      buffer.dispose();
    }
  });

  it('does NOT replay a pending card after it is resolved (grant applied)', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );
      // The permission-decision route evicts the resolved card (TASK-82). We
      // model that eviction directly here (the route wiring is exercised in
      // routes-chat.test.ts).
      buffer.evictPermissionCard('cnv_test', 'github-helper');

      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);
      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      expect(frames.some((f) => 'permissionRequest' in f)).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  it('replays a pending host card to a stream that opens after it fired', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      // Host card fires before connect, keyed by routing reqId on the payload.
      await bus.fire('chat:permission-request', initCtx, {
        kind: 'host',
        host: 'status.example.com',
        sessionId: 's1',
        reqId: 'r-test',
      });

      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);
      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      const card = frames.find((f) => 'permissionRequest' in f);
      expect(card).toMatchObject({
        reqId: 'r-test',
        permissionRequest: { kind: 'host', host: 'status.example.com', sessionId: 's1' },
      });
      // Routing reqId must not leak into the replayed payload.
      expect(
        (card?.permissionRequest as Record<string, unknown>).reqId,
      ).toBeUndefined();
      expect(captured.streamClosed).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  it('does NOT replay a card raised on a DIFFERENT conversation', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_OTHER'),
        skillCard(),
      );

      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res); // conversationId cnv_test
      const frames = captured.streamWrites
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
      expect(frames.some((f) => 'permissionRequest' in f)).toBe(false);
    } finally {
      buffer.dispose();
    }
  });
});

// TASK-444 — "Not now" has to survive the REPLAY, not just the reload.
//
// Declining a grant does not evict the card: the durable marker is the record,
// not the deletion. So the card stays in the buffer with its original
// `raisedAt`, and the TASK-82 replay above hands it straight back the next time
// a stream opens on that conversation — which is not a reload-only path, it is
// what happens when the person declines and then sends one more message to the
// same agent. The agent never re-proposed anything, so that is a replay, not a
// need, and the whole product decision is that only a need brings the question
// back. These tests pin the replay side of that filter; the mount read-back
// side is pinned in routes-workspace-grants.test.ts.
describe('declined grants are not replayed on stream open (TASK-444)', () => {
  function skillCard(skillId = 'github-helper'): PermissionRequest {
    return {
      kind: 'skill',
      skillId,
      description: 'Reach the GitHub API on your behalf',
      hosts: ['api.github.com'],
      slots: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
      authored: true,
    };
  }

  /** The frames a fresh connection wrote, decoded. */
  async function openStream(
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>,
  ): Promise<Array<Record<string, unknown>>> {
    const { res, captured } = fakeRes();
    await handler(fakeReq({ reqId: 'r-test' }), res);
    return captured.streamWrites
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
  }

  const skillIds = (frames: Array<Record<string, unknown>>): string[] =>
    frames
      .map(
        (f) => (f.permissionRequest as { skillId?: string } | undefined)?.skillId,
      )
      .filter((id): id is string => typeof id === 'string');

  it('does NOT replay a skill card the person already declined', async () => {
    let clock = 1_000;
    const { bus, initCtx, handler, buffer } = bootHandler({
      storage: 'read-write',
      now: () => clock,
    });
    try {
      // The agent proposes; the card is buffered with raisedAt = 1000.
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );

      // The person says "Not now". The route writes the marker and leaves the
      // card where it is — we write it through the real recorder so the key
      // spelling under test is the production one.
      await recordGrantDecline(bus, initCtx, {
        userId: 'userA',
        agentId: 'agt_test',
        kind: 'skill',
        subjectId: 'github-helper',
        declinedAt: 2_000,
      });

      // They send one more message to the same agent: a new stream opens on
      // the same conversation. The answered question must NOT come back.
      clock = 2_500;
      expect(skillIds(await openStream(handler))).toEqual([]);
    } finally {
      buffer.dispose();
    }
  });

  // TASK-482. Reclamation of dead markers rides the MOUNT read-back, and this
  // is the path it must never ride: the stream sees ONE conversation
  // (`tailPermissionCardEntries`), so "no pending card references this marker"
  // is a statement about that conversation and nothing else. Prune from here
  // and every other conversation's live refusal looks unreferenced and goes.
  //
  // The scenario is exactly that shape: two conversations, a live marker on
  // each, a stream opening on only one of them.
  it('never deletes a marker on stream open, not even one this conversation no longer references', async () => {
    let clock = 1_000;
    const { bus, initCtx, handler, buffer, kv, deleteCalls } = bootHandler({
      storage: 'read-write',
      now: () => clock,
    });
    try {
      // A pending card on the conversation the stream will open on...
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );
      await recordGrantDecline(bus, initCtx, {
        userId: 'userA',
        agentId: 'agt_test',
        kind: 'skill',
        subjectId: 'github-helper',
        declinedAt: 2_000,
      });
      // ...and a refusal belonging to a DIFFERENT conversation, whose card
      // this stream cannot see and has no business judging.
      await recordGrantDecline(bus, initCtx, {
        userId: 'userA',
        agentId: 'agt_other',
        kind: 'connector',
        subjectId: 'linear',
        declinedAt: 2_000,
      });
      const before = [...kv.keys()].sort();
      expect(before).toHaveLength(2);

      clock = 2_500;
      // The filter still runs — the answered card is suppressed...
      expect(skillIds(await openStream(handler))).toEqual([]);
      // ...and not one byte was reclaimed.
      expect(deleteCalls).toEqual([]);
      expect([...kv.keys()].sort()).toEqual(before);
    } finally {
      buffer.dispose();
    }
  });

  it('replays the card again once the agent re-proposes it (fresh raisedAt)', async () => {
    let clock = 1_000;
    const { bus, initCtx, handler, buffer } = bootHandler({
      storage: 'read-write',
      now: () => clock,
    });
    try {
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );
      await recordGrantDecline(bus, initCtx, {
        userId: 'userA',
        agentId: 'agt_test',
        kind: 'skill',
        subjectId: 'github-helper',
        declinedAt: 2_000,
      });
      clock = 2_500;
      expect(skillIds(await openStream(handler))).toEqual([]);

      // The agent genuinely needs it again. A re-proposal replaces the card in
      // place with a FRESH raisedAt, which outranks the older refusal — that is
      // the need-trigger, and it is the only thing that brings the card back.
      clock = 3_000;
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );
      expect(skillIds(await openStream(handler))).toEqual(['github-helper']);
    } finally {
      buffer.dispose();
    }
  });

  // DEGRADATION-DIRECTION GUARD, deliberately: it passes against the unfixed
  // code too (nothing filtered there). It exists to catch the OTHER failure —
  // a filter that over-suppresses, e.g. a key spelling where one subject's
  // refusal answers a different subject's card.
  it('replays a card whose subject was never declined', async () => {
    let clock = 1_000;
    const { bus, initCtx, handler, buffer } = bootHandler({
      storage: 'read-write',
      now: () => clock,
    });
    try {
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard('linear-helper'),
      );
      // A refusal recorded against another skill must not answer this one.
      await recordGrantDecline(bus, initCtx, {
        userId: 'userA',
        agentId: 'agt_test',
        kind: 'skill',
        subjectId: 'github-helper',
        declinedAt: 2_000,
      });
      clock = 2_500;
      expect(skillIds(await openStream(handler))).toEqual(['linear-helper']);
    } finally {
      buffer.dispose();
    }
  });

  // DEGRADATION-DIRECTION GUARD, deliberately: this passes against the unfixed
  // code too, because nothing filtered there either. What it pins is that the
  // filter's `hasService('storage:list-prefix')` short-circuit leaves the
  // replay exactly as it was — the degradation the manifest declares, and the
  // thing a later refactor could quietly turn into "no store, no cards".
  it('replays pending cards unchanged when storage:list-prefix is absent', async () => {
    let clock = 1_000;
    const { bus, initCtx, handler, buffer, kv } = bootHandler({
      storage: 'write-only',
      now: () => clock,
    });
    try {
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );
      await recordGrantDecline(bus, initCtx, {
        userId: 'userA',
        agentId: 'agt_test',
        kind: 'skill',
        subjectId: 'github-helper',
        declinedAt: 2_000,
      });
      // The refusal WAS written — there is simply no way to read it back.
      expect(kv.size).toBe(1);
      clock = 2_500;
      expect(skillIds(await openStream(handler))).toEqual(['github-helper']);
    } finally {
      buffer.dispose();
    }
  });

  // Half red, half guard. The skill assertion fails against the unfixed code
  // like the ones above; the host assertion passes either way and is there on
  // purpose — host cards were never filterable and must stay that way. They are
  // turn-scoped, never enumerated, and a later session hitting the same wall is
  // a genuine new need, so this pins that the skill filter did not quietly grow
  // a second victim standing right beside it.
  it('still replays the host card on a stream whose skill card was declined', async () => {
    let clock = 1_000;
    const { bus, initCtx, handler, buffer } = bootHandler({
      storage: 'read-write',
      now: () => clock,
    });
    try {
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard(),
      );
      await bus.fire('chat:permission-request', initCtx, {
        kind: 'host',
        host: 'status.example.com',
        sessionId: 's1',
        reqId: 'r-test',
      });
      await recordGrantDecline(bus, initCtx, {
        userId: 'userA',
        agentId: 'agt_test',
        kind: 'skill',
        subjectId: 'github-helper',
        declinedAt: 2_000,
      });

      clock = 2_500;
      const frames = await openStream(handler);
      expect(skillIds(frames)).toEqual([]);
      expect(
        frames.find((f) => 'permissionRequest' in f)?.permissionRequest,
      ).toMatchObject({ kind: 'host', host: 'status.example.com' });
    } finally {
      buffer.dispose();
    }
  });
});

// TASK-444 regression — the stream-open span has to stay SYNCHRONOUS.
//
// A first pass put the decline read (`withoutDeclinedGrants`, one
// `storage:list-prefix` round trip) at the replay site, between the buffer
// drain and the `subscribe` calls. With an in-memory sqlite store that await
// resolves in the same tick and nothing shows; against postgres it is real
// I/O, and the handler is then suspended in the middle of the one span step 4a
// documents as unbreakable. Two things fall out of that, and neither has a
// louder symptom than "the reply lost a bit":
//
//   - A frame fired during the await is appended to the buffer AFTER the drain
//     and delivered to a subscriber that is not attached YET, so it reaches
//     nobody. For a chunk that is TASK-23's gap detector firing; for a pending
//     card there is no seq and no gap net at all, so it is silently gone — the
//     exact TASK-82 class this replay exists to prevent.
//   - A client that disconnects during the await runs `cleanup()` against six
//     subscribers that do not exist yet (all no-ops), and the handler then
//     attaches them, plus a keepalive, with nothing left to tear them down.
//
// So these two tests are not about declines. They are about the await, and
// they are written at that level: the decline read is held open, the world
// moves, and the connection is asked whether it noticed.
describe('the SSE setup span stays synchronous (TASK-444 regression)', () => {
  function skillCard(skillId: string): PermissionRequest {
    return {
      kind: 'skill',
      skillId,
      description: 'Reach the GitHub API on your behalf',
      hosts: ['api.github.com'],
      slots: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
      authored: true,
    };
  }

  const framesOf = (captured: CapturedResponse): Array<Record<string, unknown>> =>
    captured.streamWrites
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);

  it('delivers a chunk and a card fired while the decline read is in flight', async () => {
    let clock = 1_000;
    const { bus, initCtx, handler, buffer, listPrefixCalled, releaseListPrefix } =
      bootHandler({
        storage: 'read-write',
        gateListPrefix: true,
        now: () => clock,
      });
    try {
      // One pending card, so there is a replay for the decline read to filter.
      // Load-bearing, not scene-setting: the handler only reads the markers
      // when this conversation actually has a card to judge, so with an empty
      // list it never reaches the store and `listPrefixCalled` below would
      // never resolve.
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard('already-pending'),
      );

      const { res, captured } = fakeRes();
      const inFlight = handler(fakeReq({ reqId: 'r-test' }), res);
      await listPrefixCalled;

      // The turn does not pause while we read a KV store. A chunk lands and the
      // agent proposes a second grant, both with the connection half-set-up.
      clock = 1_500;
      await bus.fire<StreamChunk>('chat:stream-chunk', initCtx, {
        reqId: 'r-test',
        kind: 'text',
        text: 'mid-read',
      });
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard('raised-mid-read'),
      );

      releaseListPrefix();
      await inFlight;

      const written = framesOf(captured);
      const cardIds = written
        .map(
          (f) => (f.permissionRequest as { skillId?: string } | undefined)?.skillId,
        )
        .filter((id): id is string => typeof id === 'string');
      // Asserted as ONE object so a regression shows both losses at once: they
      // have the same cause and fixing only the loud one is the trap.
      expect({
        // The chunk: neither re-drained nor delivered live is a TASK-23 gap.
        chunkDelivered: written.some(
          (f) => f.kind === 'text' && f.text === 'mid-read',
        ),
        // The card: no seq, no gap net — losing it is silent and permanent,
        // because the orchestrator's dedup suppresses a re-emission.
        midReadCardDelivered: cardIds.includes('raised-mid-read'),
        // Degradation direction: this one holds either way, and is here so a
        // "fix" that stops replaying the buffer entirely cannot pass.
        alreadyPendingReplayed: cardIds.includes('already-pending'),
      }).toEqual({
        chunkDelivered: true,
        midReadCardDelivered: true,
        alreadyPendingReplayed: true,
      });
    } finally {
      buffer.dispose();
    }
  });

  /*
    A STREAM WITH NOTHING TO FILTER MUST NOT GO TO THE STORE.

    Most streams open on a conversation holding no pending card at all, and
    scanning this person's markers to filter an empty list buys a round trip
    per turn for nothing. `withoutDeclinedGrants` short-circuits on an empty
    list for exactly this reason; splitting the read from the filter (so the
    read could happen before the stream opens) left that behind for one
    commit, and this is the assertion that keeps it.
  */
  it('never asks the store for declines when nothing is pending to filter', async () => {
    const { handler, buffer, listPrefixCalls } = bootHandler({
      storage: 'read-write',
    });
    try {
      const { res } = fakeRes();
      const inFlight = handler(fakeReq({ reqId: 'r-test' }), res);
      await inFlight;
      expect(listPrefixCalls.n).toBe(0);
    } finally {
      buffer.dispose();
    }
  });

  it('does ask once there IS a pending card to judge', async () => {
    const { bus, initCtx, handler, buffer, listPrefixCalls } = bootHandler({
      storage: 'read-write',
    });
    try {
      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard('github-helper'),
      );
      const { res } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);
      expect(listPrefixCalls.n).toBe(1);
    } finally {
      buffer.dispose();
    }
  });

  it('leaves no subscriber and no keepalive behind when the client disconnects during the decline read', async () => {
    // Fake timers BEFORE bootHandler so the buffer's own sweep interval is in
    // the baseline: what we are counting is the ONE extra timer a leaked
    // keepalive adds, not the absolute number.
    vi.useFakeTimers();
    const sseSubscriptions: Array<{ hook: string; key: string }> = [];
    const { bus, initCtx, handler, buffer, listPrefixCalled, releaseListPrefix } =
      bootHandler({
        storage: 'read-write',
        gateListPrefix: true,
        now: () => 1_000,
      });
    try {
      // Record what the handler attaches. The keys carry a per-connection
      // random suffix, so watching `subscribe` is the only way to learn them —
      // and `unsubscribe`'s removed-count is then the bus's own bookkeeping
      // answering "is this still attached?".
      const realSubscribe = bus.subscribe.bind(bus);
      vi.spyOn(bus, 'subscribe').mockImplementation(((
        hook: string,
        key: string,
        handlerFn: Parameters<typeof realSubscribe>[2],
      ): void => {
        if (key.startsWith('@ax/channel-web/sse-')) {
          sseSubscriptions.push({ hook, key });
        }
        realSubscribe(hook, key, handlerFn);
      }) as typeof bus.subscribe);

      await bus.fire(
        'chat:permission-request',
        ctxWithConversation(initCtx, 'cnv_test'),
        skillCard('github-helper'),
      );

      const timersBefore = vi.getTimerCount();
      const { res, captured } = fakeRes();
      const inFlight = handler(fakeReq({ reqId: 'r-test' }), res);
      await listPrefixCalled;

      // The tab closes while we are still reading the store.
      captured.fireClientClose();

      releaseListPrefix();
      await inFlight;
      // Let a close handler queued during setup run before we count.
      await Promise.resolve();

      const stillAttached = sseSubscriptions.filter(
        ({ hook, key }) => bus.unsubscribe(hook, key) > 0,
      );
      expect(stillAttached).toEqual([]);
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally {
      buffer.dispose();
      vi.useRealTimers();
    }
  });
});

// AW-11 — the `decisionRaised` frame. `@ax/decisions` fires `decisions:raised`
// the moment a tool call is held for a person to approve, and this connection is
// how the waiting card reaches the thread the person is already looking at.
//
// Two things about this frame are worth stating out loud, because both are the
// kind of detail a later change quietly undoes:
//
//   - It is matched on the payload's OWN `conversationId`, not on the firing
//     ctx. `@ax/decisions` runs inside `tool.pre-call`, and that ctx belongs to
//     whatever path invoked the tool; the payload field is the authoritative one
//     and a synthetic ctx cannot confuse it.
//   - It carries `decisionId` and `summary` and nothing else. The held call's
//     `input` is model-authored, and a card that rendered it would put untrusted
//     text straight onto a trust surface.
describe('decisionRaised frame', () => {
  // Built from char codes rather than typed literally: a raw U+202E in a source
  // file reverses the rest of the line for whoever reads the diff, which is the
  // very problem this test is about.
  const BIDI_OVERRIDE = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
  const ZERO_WIDTH = String.fromCharCode(0x200b); // ZERO WIDTH SPACE
  const ELLIPSIS = String.fromCharCode(0x2026);

  /** The payload `@ax/decisions` fires, with room to bend one field per test. */
  function raised(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      decisionId: 'dec_1',
      agentId: 'agt_test',
      conversationId: 'cnv_test',
      summary: 'Send the weekly update to sam@example.com',
      ...over,
    };
  }

  /** The same payload minus one field, for the "we drop what we can't render" case. */
  function raisedWithout(missing: string): Record<string, unknown> {
    const payload = raised();
    delete payload[missing];
    return payload;
  }

  function framesOf(writes: string[]): Array<Record<string, unknown>> {
    return writes
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
  }

  it('pushes a decisionRaised frame to the live client', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire('decisions:raised', initCtx, raised());

      const frame = framesOf(captured.streamWrites).find((f) => 'decisionRaised' in f);
      expect(frame).toEqual({
        reqId: 'r-test',
        decisionRaised: {
          decisionId: 'dec_1',
          summary: 'Send the weekly update to sam@example.com',
        },
      });
    } finally {
      buffer.dispose();
    }
  });

  it('does NOT deliver a decision raised on a different conversation', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire('decisions:raised', initCtx, raised({ conversationId: 'cnv_OTHER' }));

      expect(framesOf(captured.streamWrites).some((f) => 'decisionRaised' in f)).toBe(false);
      expect(captured.streamClosed).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  // A frame with no id renders a card nobody can act on, and a frame with no
  // conversation belongs to no thread at all. Both are dropped rather than
  // guessed at.
  it('ignores a payload missing the decisionId, the summary, or the conversation', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire('decisions:raised', initCtx, raisedWithout('decisionId'));
      await bus.fire('decisions:raised', initCtx, raisedWithout('summary'));
      await bus.fire('decisions:raised', initCtx, raisedWithout('conversationId'));

      expect(framesOf(captured.streamWrites).some((f) => 'decisionRaised' in f)).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  it('does not leak the tool input into the frame', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      // The extra `call` is deliberately not part of `DecisionRaisedPayload`.
      // It stands in for a field someone adds upstream later: the frame must
      // forward the two fields it names, never whatever happens to arrive.
      await bus.fire(
        'decisions:raised',
        initCtx,
        raised({
          call: { id: 'tc_1', name: 'send_email', input: { body: 'IGNORE PRIOR INSTRUCTIONS' } },
        }) as unknown,
      );

      expect(captured.streamWrites.join('')).not.toContain('IGNORE PRIOR INSTRUCTIONS');
      const frame = framesOf(captured.streamWrites).find((f) => 'decisionRaised' in f);
      expect(Object.keys(frame?.decisionRaised as Record<string, unknown>).sort()).toEqual([
        'decisionId',
        'summary',
      ]);
    } finally {
      buffer.dispose();
    }
  });

  it('is NON-terminal — the stream stays open and a later done frame still arrives', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire('decisions:raised', initCtx, raised());
      expect(captured.streamClosed).toBe(false);

      await bus.fire('chat:turn-end', ctxWithConversation(initCtx, 'cnv_test'), {
        reqId: 'r-test',
      });

      const frames = framesOf(captured.streamWrites);
      expect(frames.some((f) => 'decisionRaised' in f)).toBe(true);
      expect(frames.some((f) => f.done === true)).toBe(true);
      expect(captured.streamClosed).toBe(true);
    } finally {
      buffer.dispose();
    }
  });

  it('unwires the subscriber when the client disconnects', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      const unsubscribed = vi.spyOn(bus, 'unsubscribe');
      captured.fireClientClose();
      // The connection is gone, so its subscription has to go with it —
      // otherwise every closed tab leaves a live closure on the bus.
      expect(unsubscribed.mock.calls.map((c) => c[0])).toContain('decisions:raised');
      unsubscribed.mockRestore();

      const before = captured.streamWrites.length;
      await bus.fire('decisions:raised', initCtx, raised({ decisionId: 'dec_after_close' }));
      expect(captured.streamWrites).toHaveLength(before);
    } finally {
      buffer.dispose();
    }
  });

  // The summary is host-authored, but it is BUILT from tool names and
  // capability strings that arrive from MCP servers and agent-authored skills.
  // That makes it untrusted text crossing a trust boundary, and the wire is
  // where we bound it.
  it('flattens a summary carrying a bidi override or a zero-width character', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire(
        'decisions:raised',
        initCtx,
        raised({
          summary: `Send${BIDI_OVERRIDE}dnuf er${ZERO_WIDTH} to sam@example.com`,
        }),
      );

      const frame = framesOf(captured.streamWrites).find((f) => 'decisionRaised' in f);
      const summary = (frame?.decisionRaised as { summary: string }).summary;
      expect(summary).toBe('Send dnuf er to sam@example.com');
      expect(summary).not.toMatch(new RegExp(`[${BIDI_OVERRIDE}${ZERO_WIDTH}]`));
    } finally {
      buffer.dispose();
    }
  });

  it('falls back to a generic line when nothing legible survives the fence', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire(
        'decisions:raised',
        initCtx,
        raised({ summary: `${BIDI_OVERRIDE}${ZERO_WIDTH}  ` }),
      );

      const frame = framesOf(captured.streamWrites).find((f) => 'decisionRaised' in f);
      expect(frame).toEqual({
        reqId: 'r-test',
        decisionRaised: { decisionId: 'dec_1', summary: 'A decision is waiting for you' },
      });
    } finally {
      buffer.dispose();
    }
  });

  it('bounds a very long summary at 120 code points', async () => {
    const { bus, initCtx, handler, buffer } = bootHandler();
    try {
      const { res, captured } = fakeRes();
      await handler(fakeReq({ reqId: 'r-test' }), res);

      await bus.fire('decisions:raised', initCtx, raised({ summary: 'x'.repeat(400) }));

      const frame = framesOf(captured.streamWrites).find((f) => 'decisionRaised' in f);
      const summary = (frame?.decisionRaised as { summary: string }).summary;
      expect([...summary]).toHaveLength(120);
      expect(summary.endsWith(ELLIPSIS)).toBe(true);
    } finally {
      buffer.dispose();
    }
  });
});

describe('buffer-fill tool-use activityPhrase (TASK-271)', () => {
  it('passes a string phrase into the buffered chunk', async () => {
    const buffer = createChunkBuffer();
    try {
      const fill = createBufferFillSubscriber(buffer);
      const ctx = makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
      });
      await fill(ctx, {
        reqId: 'r1',
        kind: 'tool-use',
        toolCallId: 'c1',
        toolName: 'Bash',
        input: {},
        activityPhrase: 'Running a command',
      });
      const tail = buffer.tail('r1');
      expect(tail).toHaveLength(1);
      expect(tail[0]).toMatchObject({
        kind: 'tool-use',
        toolName: 'Bash',
        activityPhrase: 'Running a command',
      });
    } finally {
      buffer.dispose();
    }
  });

  it('drops a non-string phrase but keeps the chunk', async () => {
    const buffer = createChunkBuffer();
    try {
      const fill = createBufferFillSubscriber(buffer);
      const ctx = makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
      });
      await fill(ctx, {
        reqId: 'r1',
        kind: 'tool-use',
        toolCallId: 'c1',
        toolName: 'Bash',
        input: {},
        activityPhrase: 42,
      } as unknown as StreamChunk);
      const tail = buffer.tail('r1');
      expect(tail).toHaveLength(1);
      expect(tail[0]).toMatchObject({ kind: 'tool-use', toolName: 'Bash' });
      expect('activityPhrase' in (tail[0] as object)).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  it('a throwing getter on an unrelated prop cannot lose the chunk', async () => {
    // The non-string-phrase drop path must not spread the payload: spreading
    // invokes every own getter, and a throwing one would take down the whole
    // buffering. The chunk is rebuilt field-by-field instead.
    const buffer = createChunkBuffer();
    try {
      const fill = createBufferFillSubscriber(buffer);
      const ctx = makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
      });
      const hostile = {
        reqId: 'r1',
        kind: 'tool-use',
        toolCallId: 'c1',
        toolName: 'Bash',
        input: {},
        activityPhrase: 42,
      } as unknown as StreamChunk;
      Object.defineProperty(hostile, 'boom', {
        enumerable: true,
        get() {
          throw new Error('getter threw');
        },
      });
      await fill(ctx, hostile);
      const tail = buffer.tail('r1');
      expect(tail).toHaveLength(1);
      expect(tail[0]).toMatchObject({ kind: 'tool-use', toolName: 'Bash' });
    } finally {
      buffer.dispose();
    }
  });
});

describe('buffer-fill tool-result held (TASK-270)', () => {
  it('passes a held flag into the buffered chunk', async () => {
    const buffer = createChunkBuffer();
    try {
      const fill = createBufferFillSubscriber(buffer);
      const ctx = makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
      });
      await fill(ctx, {
        reqId: 'r1',
        kind: 'tool-result',
        toolCallId: 'c1',
        output: 'Waiting for you to choose.',
        held: true,
      });
      const tail = buffer.tail('r1');
      expect(tail).toHaveLength(1);
      expect(tail[0]).toMatchObject({
        kind: 'tool-result',
        toolCallId: 'c1',
        held: true,
      });
    } finally {
      buffer.dispose();
    }
  });

  it('a chunk without the flag buffers as before', async () => {
    const buffer = createChunkBuffer();
    try {
      const fill = createBufferFillSubscriber(buffer);
      const ctx = makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
      });
      await fill(ctx, {
        reqId: 'r1',
        kind: 'tool-result',
        toolCallId: 'c1',
        output: 'ok',
      });
      const tail = buffer.tail('r1');
      expect(tail).toHaveLength(1);
      expect('held' in (tail[0] as object)).toBe(false);
    } finally {
      buffer.dispose();
    }
  });

  it('drops the chunk on a mistyped held, same as a mistyped isError', async () => {
    const buffer = createChunkBuffer();
    try {
      const fill = createBufferFillSubscriber(buffer);
      const ctx = makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
      });
      await fill(ctx, {
        reqId: 'r1',
        kind: 'tool-result',
        toolCallId: 'c1',
        output: 'ok',
        held: 'yes',
      } as unknown as StreamChunk);
      expect(buffer.tail('r1')).toHaveLength(0);
    } finally {
      buffer.dispose();
    }
  });
});
