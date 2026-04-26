import {
  makeChatContext,
  type ChatContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import { createChunkBuffer, type ChunkBuffer } from './chunk-buffer.js';
import {
  createBufferFillSubscriber,
  createSseHandler,
  createTurnEndEvictor,
  type RouteRequest,
  type RouteResponse,
} from './sse.js';
import type { StreamChunk } from './types.js';

const PLUGIN_NAME = '@ax/channel-web';

// ---------------------------------------------------------------------------
// @ax/channel-web host-side plugin shell.
//
// Today: registers GET /api/chat/stream/:reqId for browser SSE consumers
// (Task 7 of Week 10–12). Tasks 9–13 extend this same plugin with the
// rest of the /api/chat/* surface (POST messages, GET conversations, etc.)
// — those slices land here so channel-web's wire surface stays in one
// place.
//
// Single-replica only (J8). Multi-replica fan-out is a Week 13+ slice
// that swaps the in-process chunk buffer for a redis stream / pg
// logical replication path; the SSE handler stays the same.
//
// Manifest:
//   - registers: nothing yet (the API surface is HTTP routes, not bus
//     hooks). Tasks 9-13 may add small service hooks if a runner needs
//     them; until then, this plugin is a pure consumer.
//   - calls: http:register-route, auth:require-user, agents:resolve,
//     conversations:get-by-req-id. All hard — the SSE route can't
//     function without any of them.
//   - subscribes: chat:stream-chunk (fills the buffer + per-connection
//     filter), chat:turn-end (host-side eviction so the buffer doesn't
//     grow unbounded for streams nobody listens to).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ChannelWebServerConfig {}

export function createChannelWebServerPlugin(
  _config: ChannelWebServerConfig = {},
): Plugin {
  let buffer: ChunkBuffer | undefined;
  const unregisterRoutes: Array<() => void> = [];
  let busRef: HookBus | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [
        'http:register-route',
        'auth:require-user',
        'agents:resolve',
        'conversations:get-by-req-id',
      ],
      subscribes: ['chat:stream-chunk', 'chat:turn-end'],
    },

    async init({ bus }) {
      busRef = bus;
      const initCtx: ChatContext = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      const localBuffer = createChunkBuffer();
      buffer = localBuffer;

      // Buffer-fill subscriber — host-side, captures every chunk
      // regardless of whether anyone's listening yet. Without this,
      // the SSE handler's `tail()` replay would always be empty.
      bus.subscribe<StreamChunk>(
        'chat:stream-chunk',
        `${PLUGIN_NAME}/buffer-fill`,
        createBufferFillSubscriber(localBuffer),
      );

      // Turn-end evictor — pre-cleans the buffer for terminated turns
      // so the per-connection turn-end subscriber doesn't have to be
      // present for the buffer to drain.
      bus.subscribe<{ reqId?: string }>(
        'chat:turn-end',
        `${PLUGIN_NAME}/turn-end-evictor`,
        createTurnEndEvictor(localBuffer),
      );

      const handler = createSseHandler({
        bus,
        initCtx,
        buffer: localBuffer,
      });

      const routeResult = await bus.call<
        unknown,
        { unregister: () => void }
      >('http:register-route', initCtx, {
        method: 'GET',
        path: '/api/chat/stream/:reqId',
        // The http-server's HttpRequest/HttpResponse are the canonical
        // shapes; our duck-typed RouteRequest/RouteResponse are a
        // structural subset (Invariant I2 — no @ax/http-server import in
        // sse.ts). Cast through `unknown` because exactOptionalProperty-
        // Types treats the structural intersection differently than the
        // `HttpRouteHandler` parameter declaration.
        handler: handler as unknown as (
          req: RouteRequest,
          res: RouteResponse,
        ) => Promise<void>,
      });
      unregisterRoutes.push(routeResult.unregister);
    },

    async shutdown() {
      // Drop the route first so a re-init doesn't hit duplicate-route.
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
      // Drop our subscribers so a re-init in tests doesn't leave the
      // old buffer-fill closure ALONGSIDE the new one.
      busRef?.unsubscribe('chat:stream-chunk', `${PLUGIN_NAME}/buffer-fill`);
      busRef?.unsubscribe(
        'chat:turn-end',
        `${PLUGIN_NAME}/turn-end-evictor`,
      );
      busRef = undefined;
      // Stop the chunk buffer's sweep timer.
      buffer?.dispose();
      buffer = undefined;
    },
  };
}
