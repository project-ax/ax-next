import {
  isRejection,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
// Reuse the duck-typed route interfaces the SSE handler already declares,
// so this file stays free of @ax/http-server imports (invariant I2).
import type { RouteRequest, RouteResponse } from './sse.js';

// ---------------------------------------------------------------------------
// Per-USER title-events SSE. One long-lived connection per browser tab
// surfaces title changes for ANY of the caller's conversations, so the
// sidebar updates without a reload (TODO: live title refresh after the poll
// window). Mirrors createSseHandler (sse.ts) but:
//   - per-user, not per-reqId: subscribe to conversations:title-updated,
//     filter payload.userId === the authenticated userId.
//   - no replay buffer: titles live in the DB and the initial list()
//     already renders current state; we only push CHANGES while connected.
//     The client resyncs via list() on (re)connect for anything missed.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/channel-web';
const SSE_KEEPALIVE_MS = 25_000;

interface TitleUpdatedEvent {
  conversationId: string;
  userId: string;
  title: string;
}

export interface TitleEventsDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function createTitleEventsHandler(deps: TitleEventsDeps) {
  return async function handle(
    req: RouteRequest,
    res: RouteResponse,
  ): Promise<void> {
    // 1) Authenticate. The route is closed by default — both PluginError
    //    and bus rejections collapse to 401.
    let userId: string;
    try {
      const result = await deps.bus.call<
        { req: RouteRequest },
        { user: { id: string; isAdmin: boolean } }
      >('auth:require-user', deps.initCtx, { req });
      userId = result.user.id;
    } catch (err) {
      if (err instanceof PluginError || isRejection(err)) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      throw err;
    }

    // 2) Open the stream. From here on we own the response.
    const stream = res.status(200).stream({
      contentType: 'text/event-stream; charset=utf-8',
    });

    let closed = false;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    const subKey = `${PLUGIN_NAME}/title-events/${userId}-${Math.random().toString(36).slice(2, 10)}`;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      deps.bus.unsubscribe('conversations:title-updated', subKey);
    };

    stream.onClose(() => cleanup());

    const safeWrite = (s: string): void => {
      if (closed) return;
      try {
        stream.write(s);
      } catch {
        cleanup();
        try {
          stream.close();
        } catch {
          // already closed
        }
      }
    };

    // 3) Subscribe, filtered to THIS user. Observation-only (never rejects
    //    or mutates the event). A malformed payload is skipped defensively.
    deps.bus.subscribe<TitleUpdatedEvent>(
      'conversations:title-updated',
      subKey,
      async (_ctx, payload) => {
        if (
          payload === null ||
          typeof payload !== 'object' ||
          payload.userId !== userId ||
          typeof payload.conversationId !== 'string' ||
          typeof payload.title !== 'string'
        ) {
          return undefined;
        }
        safeWrite(
          `data: ${JSON.stringify({
            conversationId: payload.conversationId,
            title: payload.title,
          })}\n\n`,
        );
        return undefined;
      },
    );

    // 4) Keepalive. ":\n\n" is dropped by EventSource but keeps proxies and
    //    the http-server idle timeout from culling the connection. unref'd
    //    so a hung connection never blocks process exit.
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
  };
}
