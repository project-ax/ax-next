import {
  isRejection,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import type { ChunkBuffer } from './chunk-buffer.js';
import type { PermissionRequest, PhaseEvent, SseFrame, StreamChunk } from './types.js';

// ---------------------------------------------------------------------------
// SSE handler factory.
//
// Wires GET /api/chat/stream/:reqId. Per request:
//
//   1. auth:require-user → 401 on rejection.
//   2. conversations:get-by-req-id → 404 (NOT 403) on not-found.
//      404-not-403 is intentional (J9): we don't tell foreign callers
//      whether a reqId exists at all.
//   3. agents:resolve(agentId, userId) → 404 same posture as above.
//   4. Open the stream, replay the buffer's current chunks for this
//      reqId, then attach BOTH a `chat:stream-chunk` subscriber (filtered
//      by reqId) AND a `chat:turn-end` subscriber (filtered by
//      conversationId). The chunk subscriber emits one `data:` frame
//      per chunk; the turn-end subscriber emits a final `done: true`
//      and closes.
//
// Subscribers are unwired on:
//   - `done: true` emitted (turn-end)
//   - client disconnect (res.stream's onClose)
//
// Keepalive: a 25 s `:\n\n` heartbeat keeps the connection alive through
// proxies that idle-cull. The sweep is a SINGLE setInterval per
// connection; cleared in onClose.
// ---------------------------------------------------------------------------

const SSE_KEEPALIVE_MS = 25_000;

// Duck-typed request/response. The full @ax/http-server `HttpResponse` adds
// `stream()` (we extended it for this slice); we re-declare just the
// piece we need so this file stays free of @ax/http-server imports
// (Invariant I2).
export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteStream {
  write(chunk: string | Buffer): void;
  close(): void;
  onClose(handler: () => void): void;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  header(name: string, value: string): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
  stream(opts?: { contentType?: string }): RouteStream;
}

export interface SseHandlerDeps {
  bus: HookBus;
  initCtx: AgentContext;
  buffer: ChunkBuffer;
}

/**
 * Build the GET /api/chat/stream/:reqId handler. The SSE handler factory
 * also returns the bus subscriber the channel-web plugin needs to attach
 * to `chat:stream-chunk` so the buffer fills as chunks arrive — this
 * keeps subscriber + handler in one file (the handler reads from the
 * same buffer).
 */
export function createSseHandler(deps: SseHandlerDeps) {
  const PLUGIN_NAME = '@ax/channel-web';

  /** Helper — format a single frame as a complete SSE event line. */
  function formatFrame(frame: SseFrame): string {
    // Newlines inside JSON.stringify output are escaped; \n separators
    // delimit the SSE event. The browser EventSource splits on \n\n.
    return `data: ${JSON.stringify(frame)}\n\n`;
  }

  return async function handle(
    req: RouteRequest,
    res: RouteResponse,
  ): Promise<void> {
    // 1) Authenticate.
    let userId: string;
    try {
      const result = await deps.bus.call<
        { req: RouteRequest },
        { user: { id: string; isAdmin: boolean } }
      >('auth:require-user', deps.initCtx, { req });
      userId = result.user.id;
    } catch (err) {
      // Both PluginError('unauthenticated') and bus.fire-style rejections
      // collapse to 401 — the route is closed by default.
      if (err instanceof PluginError || isRejection(err)) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      throw err;
    }

    // 2) Resolve the reqId → conversation (J9 — server-derived ACL).
    const reqId = req.params.reqId;
    if (typeof reqId !== 'string' || reqId.length === 0) {
      // Same 404 posture as a missing row — the URL didn't shape into
      // a conversation we own.
      res.status(404).json({ error: 'not-found' });
      return;
    }
    let conversationId: string;
    let agentId: string;
    try {
      const conv = await deps.bus.call<
        { reqId: string; userId: string },
        {
          conversationId: string;
          agentId: string;
          userId: string;
          activeReqId: string | null;
        }
      >('conversations:get-by-req-id', deps.initCtx, { reqId, userId });
      conversationId = conv.conversationId;
      agentId = conv.agentId;
    } catch (err) {
      // not-found OR forbidden OR anything else from the lookup → 404.
      // We deliberately collapse to the same code so callers can't tell
      // "your reqId doesn't exist" from "you don't own it" (J9).
      if (err instanceof PluginError) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      throw err;
    }

    // 3) ACL the conversation's agent against the calling user. Same
    // 404-not-403 posture: an agent the user can no longer reach
    // shouldn't even confirm the conversation is theirs.
    try {
      await deps.bus.call<
        { agentId: string; userId: string },
        unknown
      >('agents:resolve', deps.initCtx, { agentId, userId });
    } catch (err) {
      if (err instanceof PluginError) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      throw err;
    }

    // 4) Open the SSE stream. From here on we own the response — write
    // failures and exceptions degrade to a quiet close.
    const stream = res.status(200).stream({
      contentType: 'text/event-stream; charset=utf-8',
    });

    let closed = false;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    // Subscriber keys are unique per connection so multiple SSE
    // listeners on the same reqId (multi-tab) each get their own
    // subscription instead of fighting over a shared one. Mixing in
    // crypto-random isn't strictly needed (the bus uses the key only
    // for unsubscribe), but it keeps two opens on the same reqId
    // cleanly distinguishable in logs.
    const subscriberSuffix = `${reqId}-${Math.random().toString(36).slice(2, 10)}`;
    const chunkSubKey = `${PLUGIN_NAME}/sse-chunk/${subscriberSuffix}`;
    const phaseSubKey = `${PLUGIN_NAME}/sse-phase/${subscriberSuffix}`;
    const turnEndSubKey = `${PLUGIN_NAME}/sse-turn-end/${subscriberSuffix}`;
    const turnErrorSubKey = `${PLUGIN_NAME}/sse-turn-error/${subscriberSuffix}`;
    const permissionSubKey = `${PLUGIN_NAME}/sse-permission/${subscriberSuffix}`;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      // unsubscribe is idempotent if no match — safe to call even when a
      // subscriber was never registered (e.g. error in setup).
      deps.bus.unsubscribe('chat:stream-chunk', chunkSubKey);
      deps.bus.unsubscribe('chat:phase', phaseSubKey);
      deps.bus.unsubscribe('chat:turn-end', turnEndSubKey);
      deps.bus.unsubscribe('chat:turn-error', turnErrorSubKey);
      deps.bus.unsubscribe('chat:permission-request', permissionSubKey);
    };

    stream.onClose(() => {
      cleanup();
    });

    const safeWrite = (frame: SseFrame): void => {
      if (closed) return;
      try {
        stream.write(formatFrame(frame));
      } catch {
        cleanup();
        try {
          stream.close();
        } catch {
          // already closed
        }
      }
    };

    // 4a) Replay the existing buffer BEFORE attaching the live
    // subscriber. If we attached the subscriber first and THEN drained,
    // a chunk that fired in between would arrive twice (once via the
    // subscriber, once via the buffer drain). If we drained first and
    // THEN attached, a chunk fired in between would be lost. We do
    // drain-first because the bus runs subscribers serially: the
    // subscribe call below executes synchronously after this drain,
    // and bus.fire() can't interleave with the same async tick (it
    // awaits each subscriber). The narrow window where a chunk lands
    // in the buffer DURING the drain is harmless because we re-snapshot
    // a copy via `tail()`, so any concurrent appends are visible to
    // the subscriber pass that follows.
    //
    // Phase replays first — it's "before content" by construction (the
    // buffer evicts phase as soon as a content chunk lands), so emitting
    // it ahead of the chunks matches the order the original turn fired.
    const replayPhase = deps.buffer.tailPhase(reqId);
    if (replayPhase !== null) {
      safeWrite({ reqId, phase: replayPhase });
    }
    const replay = deps.buffer.tail(reqId);
    for (const chunk of replay) {
      // The chunk *is* a valid SseFrame variant — types align by design.
      safeWrite(chunk);
    }

    // 4a-bis) Replay a buffered terminal turn-error. The orchestrator can fire
    // `chat:turn-error` BEFORE this EventSource connected and installed the
    // live subscriber below — especially for fast session-open failures (a
    // credential-resolution error rejects `proxy:open-session` synchronously,
    // before the browser's separate GET /api/chat/stream/:reqId arrives). The
    // plugin-level turn-error fill subscriber stored the reason, so we replay
    // the error frame on connect and close — the turn already ended, so we do
    // NOT attach the live subscribers (there's nothing more coming). Without
    // this the client would sit on keepalives forever — the exact silent hang
    // this path is meant to surface.
    const replayTurnError = deps.buffer.tailTurnError(reqId);
    if (replayTurnError !== null) {
      safeWrite({ reqId, error: replayTurnError });
      deps.buffer.evictReqId(reqId);
      cleanup();
      try {
        stream.close();
      } catch {
        // already closed
      }
      return;
    }

    // 4b) Attach the live chunk subscriber. Filter by reqId so multiple
    // in-flight conversations sharing the same host don't bleed.
    deps.bus.subscribe<StreamChunk>(
      'chat:stream-chunk',
      chunkSubKey,
      async (_ctx, payload) => {
        if (payload.reqId !== reqId) return undefined;
        safeWrite(payload);
        // Subscribers are observation-only here; we never reject or
        // mutate. Returning undefined means "pass through".
        return undefined;
      },
    );

    // 4b-bis) Attach the live phase subscriber. Same filter posture as
    // chunks; subscribers are observation-only and never veto.
    deps.bus.subscribe<PhaseEvent>(
      'chat:phase',
      phaseSubKey,
      async (_ctx, payload) => {
        if (payload.reqId !== reqId) return undefined;
        safeWrite({ reqId: payload.reqId, phase: payload.phase });
        return undefined;
      },
    );

    // 4c) Attach the turn-end subscriber. Filter by ctx.conversationId
    // so a turn-end on a different conversation doesn't close us out.
    deps.bus.subscribe<{ reqId?: string; reason?: string }>(
      'chat:turn-end',
      turnEndSubKey,
      async (ctx, _payload) => {
        if (ctx.conversationId !== conversationId) return undefined;
        // Emit the done frame, evict the buffer (this turn is over),
        // then close. The eviction here is the success path; the TTL
        // sweep in chunk-buffer is the fallback for browsers that
        // never get here (closed mid-stream).
        safeWrite({ reqId, done: true });
        deps.buffer.evictReqId(reqId);
        cleanup();
        try {
          stream.close();
        } catch {
          // already closed
        }
        return undefined;
      },
    );

    // 4c-bis) Attach the turn-error subscriber. The orchestrator fires
    // `chat:turn-error` when a turn ends abnormally — the runner died mid-turn,
    // wedged past the chat timeout, an early-spawn step failed, OR the runner
    // itself reported a terminated outcome (F2b) — instead of the normal
    // `chat:turn-end`. Without this the stream would never get a terminal frame
    // and the client's "Thinking…" spinner hangs forever (the keepalive
    // heartbeat keeps the connection open). Match by reqId — the precise
    // per-turn key. Every orchestrator fire site carries the ORIGINAL
    // agent:invoke reqId (the F2b onChatEnd path passes the reqId
    // resolveWaiterFor recovered, since the IPC server restamps ctx.reqId), so
    // a turn-error never closes a co-resident turn's stream on the same
    // conversation. Emit an `error` frame, evict, and close.
    deps.bus.subscribe<{ reqId?: string; reason?: string }>(
      'chat:turn-error',
      turnErrorSubKey,
      async (_ctx, payload) => {
        if (payload.reqId !== reqId) return undefined;
        safeWrite({ reqId, error: payload.reason ?? 'unknown' });
        deps.buffer.evictReqId(reqId);
        cleanup();
        try {
          stream.close();
        } catch {
          // already closed
        }
        return undefined;
      },
    );

    // 4c-ter) Attach the permission-request subscriber. @ax/skill-broker's
    // request_capability fires `chat:permission-request` mid-turn to surface
    // the bundled approval card (design §11.3). Match by ctx.conversationId —
    // the firing ctx is the runner-driven IPC ctx (a FRESH reqId, but the REAL
    // conversationId; see ipc-server/listener.ts), so reqId can't be the key
    // here. One active turn per conversation makes the conversation the right
    // grain. The card is NON-terminal: emit it and KEEP the stream open (unlike
    // turn-error, which closes). We stamp the connection's own reqId onto the
    // frame envelope. The card payload carries only public manifest data — no
    // secret ever rides this frame (the key posts straight to the credential
    // store; §10).
    deps.bus.subscribe<PermissionRequest>(
      'chat:permission-request',
      permissionSubKey,
      async (ctx, payload) => {
        if (ctx.conversationId !== conversationId) return undefined;
        safeWrite({ reqId, permissionRequest: payload });
        return undefined;
      },
    );

    // 4d) Keepalive. The SSE comment ":\n\n" is silently dropped by
    // EventSource but keeps proxies (and the http-server's idle
    // timeout) from culling the connection. setInterval handle is
    // unref'd so a hung connection doesn't block process exit.
    keepaliveTimer = setInterval(() => {
      if (closed) return;
      try {
        stream.write(':\n\n');
      } catch {
        cleanup();
      }
    }, SSE_KEEPALIVE_MS);
    if (typeof (keepaliveTimer as { unref?: () => void }).unref === 'function') {
      (keepaliveTimer as { unref: () => void }).unref();
    }

    // Handler returns now; the stream lives on until cleanup fires.
  };
}

/**
 * Subscriber the plugin attaches at boot to fill the chunk buffer. Lives
 * here (not in plugin.ts) so the buffer + write-path stay in one file —
 * the SSE handler's `tail()` drain depends on it.
 */
export function createBufferFillSubscriber(buffer: ChunkBuffer) {
  return async function (
    _ctx: AgentContext,
    payload: StreamChunk,
  ): Promise<StreamChunk | undefined> {
    // Defensive: a malformed event from the bus shouldn't tear down the
    // host. The schema validation already happened in the IPC handler
    // (Task 5); this is belt-and-braces.
    if (typeof payload?.reqId !== 'string' || typeof payload?.kind !== 'string') {
      return undefined;
    }
    // TASK-23: `buffer.append` mints + stamps the host-minted per-reqId seq and
    // returns the stamped frame. We RETURN it from the subscriber so the bus
    // propagates the seq-stamped payload to the per-connection live SSE
    // subscriber (and any downstream subscriber) — the documented bus merge
    // contract (`result !== undefined → current = result`), NOT an implicit
    // in-place mutation. The replay path reads the same stamped frame from
    // `tail()`, so the live and replay cursors are identical and the client
    // can dedup an arbitrary partial replay exactly.
    if (payload.kind === 'text' || payload.kind === 'thinking') {
      if (typeof (payload as { text?: unknown }).text !== 'string') {
        return undefined;
      }
      return buffer.append(payload as StreamChunk);
    }
    if (payload.kind === 'tool-use') {
      const p = payload as {
        toolCallId?: unknown;
        toolName?: unknown;
        input?: unknown;
      };
      if (
        typeof p.toolCallId !== 'string' ||
        typeof p.toolName !== 'string' ||
        typeof p.input !== 'object' ||
        p.input === null ||
        Array.isArray(p.input)
      ) {
        return undefined;
      }
      return buffer.append(payload as StreamChunk);
    }
    if (payload.kind === 'tool-result') {
      const p = payload as {
        toolCallId?: unknown;
        output?: unknown;
        isError?: unknown;
      };
      if (
        typeof p.toolCallId !== 'string' ||
        typeof p.output !== 'string' ||
        (p.isError !== undefined && typeof p.isError !== 'boolean')
      ) {
        return undefined;
      }
      return buffer.append(payload as StreamChunk);
    }
    return undefined;
  };
}

/**
 * Sister to `createBufferFillSubscriber`, but for `chat:phase`. Captures
 * the latest phase per reqId so an SSE handler attaching after the phase
 * fired still sees it on replay.
 */
export function createPhaseFillSubscriber(buffer: ChunkBuffer) {
  return async function (
    _ctx: AgentContext,
    payload: PhaseEvent,
  ): Promise<undefined> {
    if (
      typeof payload?.reqId !== 'string' ||
      payload.reqId.length === 0 ||
      payload?.phase !== 'sandbox-starting'
    ) {
      return undefined;
    }
    buffer.appendPhase(payload.reqId, payload.phase);
    return undefined;
  };
}

/**
 * Sister to `createPhaseFillSubscriber`, but for `chat:turn-error`. Records the
 * terminal error reason per reqId so an SSE handler that attaches AFTER the
 * orchestrator already fired `chat:turn-error` still replays the error frame on
 * connect (the pre-SSE-connect race). This is acute for fast session-open
 * failures — a credential-resolution error rejects `proxy:open-session`
 * synchronously, well before the browser opens `/api/chat/stream/:reqId`, so a
 * live-subscriber-only path would drop the event and the stream would hang on
 * keepalives forever. Replaces the buffer's turn-error evictor at the plugin
 * level: storing the reason (rather than evicting) is what makes replay
 * possible; the IDLE_TTL sweep reaps the entry once the connect window passes.
 */
export function createTurnErrorFillSubscriber(buffer: ChunkBuffer) {
  return async function (
    _ctx: AgentContext,
    payload: { reqId?: string; reason?: string },
  ): Promise<undefined> {
    if (typeof payload?.reqId !== 'string' || payload.reqId.length === 0) {
      return undefined;
    }
    buffer.appendTurnError(payload.reqId, payload.reason ?? 'unknown');
    return undefined;
  };
}

/**
 * Turn-end subscriber the plugin attaches at boot. Pre-evicts the buffer
 * for reqIds that ended successfully so the per-connection turn-end
 * subscriber is the only path that needs to fire the done frame. Lives
 * here for the same one-file reason as the chunk filler.
 *
 * NOTE: this subscriber MUST NOT close any per-connection streams — it
 * runs on the host bus and doesn't know about the SSE handlers. Per-
 * connection turn-end handling is inside `createSseHandler` and matches
 * `ctx.conversationId`. We keep this subscriber separate because a
 * conversation may end without any SSE listener attached, and the
 * buffer should still be cleaned up.
 */
export function createTurnEndEvictor(buffer: ChunkBuffer) {
  return async function (
    _ctx: AgentContext,
    payload: { reqId?: string },
  ): Promise<undefined> {
    if (typeof payload?.reqId === 'string' && payload.reqId.length > 0) {
      buffer.evictReqId(payload.reqId);
    }
    return undefined;
  };
}
