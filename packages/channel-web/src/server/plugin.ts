import {
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import { createChunkBuffer, type ChunkBuffer } from './chunk-buffer.js';
import { registerAttachmentsRoutes } from './routes-attachments.js';
import { registerChatRoutes } from './routes-chat.js';
import {
  createBufferFillSubscriber,
  createPhaseFillSubscriber,
  createSseHandler,
  createTurnEndEvictor,
  type RouteRequest,
  type RouteResponse,
} from './sse.js';
import { createTitleEventsHandler } from './title-events.js';
import type { PhaseEvent, StreamChunk } from './types.js';

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
// Single-replica only (J8) — the chunk buffer is in-process. The k8s
// chart enforces this by failing `helm template` for replicas > 1
// (ax-next.validateHostReplicas, ARCH-1). Multi-replica fan-out is a
// tracked follow-up that swaps the in-process chunk buffer for a redis
// stream / pg-logical replication path; the SSE handler stays the same.
//
// Manifest:
//   - registers: nothing (the API surface is HTTP routes, not bus hooks).
//   - calls: http:register-route, auth:require-user, agents:resolve,
//     agents:list-for-user, conversations:get-by-req-id,
//     conversations:create / :get / :list / :delete,
//     agent:invoke. All hard — the chat-flow surface can't function without
//     any of them.
//   - subscribes: chat:stream-chunk (fills the buffer + per-connection
//     filter), chat:phase (single-slot phase memory + per-connection
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
        'agents:list-for-user',
        'conversations:get-by-req-id',
        'conversations:create',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
        'agent:invoke',
        // Phase 3 — attachments & artifacts.
        'attachments:store-temp',
        'attachments:commit',
        'attachments:download',
      ],
      subscribes: ['chat:stream-chunk', 'chat:phase', 'chat:turn-end', 'chat:turn-error', 'conversations:title-updated'],
    },

    async init({ bus }) {
      busRef = bus;
      const initCtx: AgentContext = makeAgentContext({
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

      // Phase-fill subscriber — same role as buffer-fill but for the
      // single-slot phase memory. Without this, an SSE consumer that
      // attaches after sandbox-k8s fires `chat:phase` would never see
      // the "Starting sandbox…" label.
      bus.subscribe<PhaseEvent>(
        'chat:phase',
        `${PLUGIN_NAME}/phase-fill`,
        createPhaseFillSubscriber(localBuffer),
      );

      // Turn-end evictor — pre-cleans the buffer for terminated turns
      // so the per-connection turn-end subscriber doesn't have to be
      // present for the buffer to drain.
      bus.subscribe<{ reqId?: string }>(
        'chat:turn-end',
        `${PLUGIN_NAME}/turn-end-evictor`,
        createTurnEndEvictor(localBuffer),
      );

      // Turn-error evictor — same role as the turn-end evictor, for the
      // abnormal-termination path. A turn that errors out with no SSE
      // listener attached still needs its buffered chunks dropped; the
      // payload carries `reqId` so the same evictor factory works.
      bus.subscribe<{ reqId?: string }>(
        'chat:turn-error',
        `${PLUGIN_NAME}/turn-error-evictor`,
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

      // Live title push — per-user SSE. Surfaces a title that lands after
      // the client's poll window without a reload (design I5: ships with
      // its consumer in the same PR; the route auto-registers here, no
      // preset change needed).
      const titleEventsHandler = createTitleEventsHandler({ bus, initCtx });
      const titleEventsRoute = await bus.call<
        unknown,
        { unregister: () => void }
      >('http:register-route', initCtx, {
        method: 'GET',
        path: '/api/chat/title-events',
        handler: titleEventsHandler as unknown as (
          req: RouteRequest,
          res: RouteResponse,
        ) => Promise<void>,
      });
      unregisterRoutes.push(titleEventsRoute.unregister);

      // Tasks 9-13 — chat-flow REST surface (POST messages, GET/DELETE
      // conversations, GET conversations/:id, GET agents). CSRF gated
      // automatically by @ax/http-server's subscriber on state-changing
      // methods. See routes-chat.ts for per-endpoint details.
      const chatRouteUnregisters = await registerChatRoutes(bus, initCtx);
      for (const u of chatRouteUnregisters) unregisterRoutes.push(u);

      // Phase 3 — attachments + downloads. Closes the half-wired window
      // opened in Phase 1 (routes-chat.ts already calls
      // `attachments:commit` for attachment_ref blocks); declaring the
      // three hooks in `manifest.calls` + registering the two routes here
      // makes the surface complete.
      const attachmentRouteUnregisters = await registerAttachmentsRoutes(
        bus,
        initCtx,
      );
      for (const u of attachmentRouteUnregisters) unregisterRoutes.push(u);
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
      busRef?.unsubscribe('chat:phase', `${PLUGIN_NAME}/phase-fill`);
      busRef?.unsubscribe(
        'chat:turn-end',
        `${PLUGIN_NAME}/turn-end-evictor`,
      );
      busRef?.unsubscribe(
        'chat:turn-error',
        `${PLUGIN_NAME}/turn-error-evictor`,
      );
      busRef = undefined;
      // Stop the chunk buffer's sweep timer.
      buffer?.dispose();
      buffer = undefined;
    },
  };
}
