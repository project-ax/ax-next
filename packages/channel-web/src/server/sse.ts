import {
  isRejection,
  PluginError,
  type ChatContext,
  type HookBus,
} from '@ax/core';
import type { ChunkBuffer } from './chunk-buffer.js';
import type { SseFrame, StreamChunk } from './types.js';

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

// Duck-typed request/response — see auth-oidc/admin-routes.ts for the
// canonical pattern. The full @ax/http-server `HttpResponse` adds
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
  initCtx: ChatContext;
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
    const turnEndSubKey = `${PLUGIN_NAME}/sse-turn-end/${subscriberSuffix}`;

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
      deps.bus.unsubscribe('chat:turn-end', turnEndSubKey);
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
    const replay = deps.buffer.tail(reqId);
    for (const chunk of replay) {
      safeWrite({ reqId: chunk.reqId, text: chunk.text, kind: chunk.kind });
    }

    // 4b) Attach the live chunk subscriber. Filter by reqId so multiple
    // in-flight conversations sharing the same host don't bleed.
    deps.bus.subscribe<StreamChunk>(
      'chat:stream-chunk',
      chunkSubKey,
      async (_ctx, payload) => {
        if (payload.reqId !== reqId) return undefined;
        safeWrite({
          reqId: payload.reqId,
          text: payload.text,
          kind: payload.kind,
        });
        // Subscribers are observation-only here; we never reject or
        // mutate. Returning undefined means "pass through".
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
    _ctx: ChatContext,
    payload: StreamChunk,
  ): Promise<undefined> {
    // Defensive: a malformed event from the bus shouldn't tear down the
    // host. The schema validation already happened in the IPC handler
    // (Task 5); this is belt-and-braces.
    if (
      typeof payload?.reqId !== 'string' ||
      typeof payload?.text !== 'string' ||
      (payload?.kind !== 'text' && payload?.kind !== 'thinking')
    ) {
      return undefined;
    }
    buffer.append({
      reqId: payload.reqId,
      text: payload.text,
      kind: payload.kind,
    });
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
    _ctx: ChatContext,
    payload: { reqId?: string },
  ): Promise<undefined> {
    if (typeof payload?.reqId === 'string' && payload.reqId.length > 0) {
      buffer.evictReqId(payload.reqId);
    }
    return undefined;
  };
}
