import {
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import { createChunkBuffer, type ChunkBuffer } from './chunk-buffer.js';
import { makeAllowHostHandler } from './routes-allow-host.js';
import { registerAttachmentsRoutes } from './routes-attachments.js';
import { registerChatRoutes } from './routes-chat.js';
import { makeConnectionsHandlers } from './routes-connections.js';
import {
  createBufferFillSubscriber,
  createPermissionCardFillSubscriber,
  createPhaseFillSubscriber,
  createSseHandler,
  createTurnEndEvictor,
  createTurnErrorFillSubscriber,
  type RouteRequest,
  type RouteResponse,
} from './sse.js';
import { createTitleEventsHandler } from './title-events.js';
import type { PermissionRequest, PhaseEvent, StreamChunk } from './types.js';

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
//     grow unbounded for streams nobody listens to), chat:turn-error
//     (durable terminal-error replay), chat:permission-request (the JIT
//     bundled approval card — surfaced per-connection only, matched by
//     ctx.conversationId; declared here for visibility, the subscription
//     itself lives in createSseHandler's cleanup() lifecycle).
// ---------------------------------------------------------------------------

export interface ChannelWebServerConfig {
  /**
   * The configured chat run timeout (ms) — the max a single turn can stay live
   * before the orchestrator terminates it (AX_CHAT_TIMEOUT_MS; default 10 min).
   * Used ONLY to size the chunk buffer's orphaned-cursor-shell reap ceiling so
   * it always exceeds the max live turn duration (TASK-23 / Codex P2): a shell
   * reaped while its turn is still streaming would reset the seq cursor to 1 and
   * silently drop output for a connected client. Optional — the buffer falls
   * back to its own conservative default when unset. This is NOT a fresh source
   * of truth for the timeout (the orchestrator owns that); it's a sizing hint.
   */
  chatTimeoutMs?: number;
}

// How far above the configured chat timeout the cursor-shell reap ceiling sits,
// so a turn that runs right up to the timeout still has its shell preserved
// until the orchestrator's terminal chat:turn-error fires (which evicts it).
const SHELL_AGE_SLACK_MS = 5 * 60_000;

export function createChannelWebServerPlugin(
  config: ChannelWebServerConfig = {},
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
        // JIT (TASK-36) — the permission-decision endpoint applies a
        // user-approved capability grant via the orchestrator. Orchestrator +
        // channel-web always co-deploy in presets/k8s, so this is a hard dep.
        'agent:apply-capability-grant',
        // Phase 3 — attachments & artifacts.
        'attachments:store-temp',
        'attachments:commit',
        'attachments:download',
        // TASK-37 — the reactive egress wall's grant route calls the
        // host-internal proxy:add-host service hook. channel-web only loads in
        // the k8s preset, which always loads @ax/credential-proxy, so this is a
        // hard dep (the route is the ONLY caller — the untrusted runner can't
        // reach this hook over IPC).
        'proxy:add-host',
        // TASK-42 — the Settings "Connections" surface composes a per-(user,
        // agent) merged skills read here (the BFF — it can't live in @ax/skills
        // without forming a @ax/skills → agents:resolve boot cycle). channel-web
        // always co-deploys with @ax/skills in presets/k8s, so these are hard
        // deps. detach-for-user is host-internal: this CSRF-gated route is its
        // only caller (the untrusted runner can't reach it over IPC).
        'skills:list',
        'skills:list-user-attachments',
        'skills:detach-for-user',
      ],
      optionalCalls: [
        {
          // TASK-44 — when the user clicks "Always for this agent" on the
          // reactive-wall card, the allow-host route persists a durable
          // per-(user, agent) grant via host-grants:grant (after the live
          // proxy:add-host widen). TASK-131 — the Settings "Allowed sites"
          // section's proactive "Add a site" also grants through this hook
          // (POST /api/chat/allowed-sites/:agentId); without host-grants that
          // add returns 503 (the grant cannot persist — no silent success).
          hook: 'host-grants:grant',
          degradation:
            'the reactive-wall "Always for this agent" button persists nothing across sessions (the live proxy:add-host grant still applies for the current session); the Settings "Add a site" control returns 503',
        },
        {
          // TASK-54 — the Settings "Allowed sites" panel reads the durable
          // per-(user, agent) grants. host-grants is k8s-preset-only; a preset
          // without it degrades the panel to empty.
          hook: 'host-grants:list',
          degradation:
            'the Settings "Allowed sites" panel shows no persisted hosts (the live reactive wall still applies per session)',
        },
        {
          // TASK-54 — the Settings "Allowed sites" panel's Revoke control removes
          // a durable grant so it is not re-loaded into the next session's
          // allowlist. Degrades to an idempotent no-op without host-grants.
          hook: 'host-grants:revoke',
          degradation:
            'the Settings "Allowed sites" Revoke control is a no-op (no persisted grants to remove)',
        },
      ],
      subscribes: ['chat:stream-chunk', 'chat:phase', 'chat:turn-end', 'chat:turn-error', 'chat:permission-request', 'conversations:title-updated'],
    },

    async init({ bus }) {
      busRef = bus;
      const initCtx: AgentContext = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      // Size the cursor-shell reap ceiling above the max live turn duration
      // (the configured chat timeout + slack) so a long-but-still-live quiet
      // turn never has its seq cursor reset mid-stream (TASK-23 / Codex P2).
      // When chatTimeoutMs is unset, createChunkBuffer uses its own default.
      const localBuffer = createChunkBuffer(
        config.chatTimeoutMs !== undefined && config.chatTimeoutMs > 0
          ? { shellMaxAgeMs: config.chatTimeoutMs + SHELL_AGE_SLACK_MS }
          : {},
      );
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

      // Turn-error fill — stores the terminal error reason per reqId so an
      // SSE handler that connects AFTER the orchestrator fired
      // `chat:turn-error` can replay the error frame on connect instead of
      // hanging. This is the pre-SSE-connect race, acute for fast session-open
      // failures (e.g. a credential-resolution error that rejects
      // `proxy:open-session` before the browser opens the stream). It replaces
      // the prior turn-error evictor: storing (not evicting) is what makes
      // replay possible, and the buffer's IDLE_TTL sweep reaps the entry once
      // the connect window passes.
      bus.subscribe<{ reqId?: string; reason?: string }>(
        'chat:turn-error',
        `${PLUGIN_NAME}/turn-error-fill`,
        createTurnErrorFillSubscriber(localBuffer),
      );

      // Permission-card fill — stores the pending JIT approval card per
      // conversation (skill) / reqId (host) so an SSE handler that connects
      // AFTER the card fired replays it on connect (TASK-82). Without this, a
      // card raised during the cold-boot window (every gated turn cold-spawns a
      // runner pod, and the SSE GET races that boot) is delivered ONLY to an
      // already-attached live subscriber — and dropped otherwise. The
      // orchestrator's per-conversation dedup then suppresses re-emission, so the
      // pending cap-skill becomes permanently un-approvable. The card is cleared
      // on grant (permission-decision) / conversation delete; host cards ride the
      // turn boundary. The card carries only public manifest data — no secret.
      bus.subscribe<PermissionRequest & { reqId?: string }>(
        'chat:permission-request',
        `${PLUGIN_NAME}/permission-card-fill`,
        createPermissionCardFillSubscriber(localBuffer),
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
      //
      // TASK-82 — pass card-eviction hooks so a resolved grant (or a deleted
      // conversation) drops the pending approval card from the replay buffer,
      // preventing a re-prompt on a later SSE (re)connect.
      const chatRouteUnregisters = await registerChatRoutes(bus, initCtx, {
        onCardResolved: (conversationId, skillId) =>
          localBuffer.evictPermissionCard(conversationId, skillId),
        onConversationDeleted: (conversationId) =>
          localBuffer.evictConversationCards(conversationId),
      });
      for (const u of chatRouteUnregisters) unregisterRoutes.push(u);

      // TASK-37 — the reactive egress wall's grant route. The <PermissionCard>
      // host variant POSTs { sessionId, host } here on grant; this calls the
      // host-internal proxy:add-host hook with the AUTHENTICATED user ctx (the
      // proxy re-validates session ownership). CSRF-gated automatically by
      // @ax/http-server's subscriber on state-changing methods. Ships with its
      // consumer (the card) in the same PR (I3 — no half-wired surface).
      const allowHost = makeAllowHostHandler({ bus, initCtx });
      const allowHostRoute = await bus.call<
        unknown,
        { unregister: () => void }
      >('http:register-route', initCtx, {
        method: 'POST',
        path: '/api/chat/allow-host',
        handler: allowHost as unknown as (
          req: RouteRequest,
          res: RouteResponse,
        ) => Promise<void>,
      });
      unregisterRoutes.push(allowHostRoute.unregister);

      // TASK-42 — the Settings "Connections" surface. GET returns the per-(user,
      // agent) merged skills list (default + agent-global + per-user); DELETE
      // detaches one user-added skill. Both derive identity from the auth cookie
      // (server-forced) and gate the agent via agents:resolve (ACL → 404, no
      // existence leak). Ships with its consumer (the ConnectionsTab) in the
      // same PR (I3 — no half-wired surface).
      // TASK-54 — the Settings "Allowed sites" panel (host-grants list/revoke,
      // the durable twin of the reactive wall — design P3/P6) and the "Keys"
      // tab's service-keyed "used by" derivation (account-usage from skills:list)
      // ride on the same Connections-surface BFF handlers + ctx. Both ship with
      // their consumers (ConnectionsTab + KeysTab) in the same PR (I3 — no
      // half-wired surface), closing TASK-44/43's deferred-UI windows.
      const connections = makeConnectionsHandlers({ bus, initCtx });
      for (const route of [
        { method: 'GET' as const, path: '/api/chat/connections/:agentId', handler: connections.get },
        // TASK-126 — Skills app-store: the every-user global-catalog read (the
        // "Not installed" shelf) + the self-install attach route. Both ship with
        // their consumer (SkillsAppStore) in the same PR (I3 — no half-wired
        // surface).
        {
          method: 'GET' as const,
          path: '/api/chat/catalog-skills',
          handler: connections.listCatalog,
        },
        {
          method: 'POST' as const,
          path: '/api/chat/connections/:agentId/skills',
          handler: connections.attach,
        },
        {
          method: 'DELETE' as const,
          path: '/api/chat/connections/:agentId/skills/:skillId',
          handler: connections.detach,
        },
        {
          method: 'GET' as const,
          path: '/api/chat/allowed-sites/:agentId',
          handler: connections.listAllowedSites,
        },
        // TASK-131 — proactive "Add a site" (host-grants:grant). Ships with its
        // consumer (the ConnectorsTab Allowed-sites section) in the same PR
        // (I3 — no half-wired surface).
        {
          method: 'POST' as const,
          path: '/api/chat/allowed-sites/:agentId',
          handler: connections.addAllowedSite,
        },
        {
          method: 'DELETE' as const,
          path: '/api/chat/allowed-sites/:agentId/:host',
          handler: connections.revokeAllowedSite,
        },
        {
          method: 'GET' as const,
          path: '/api/chat/account-usage',
          handler: connections.accountUsage,
        },
      ]) {
        const r = await bus.call<unknown, { unregister: () => void }>(
          'http:register-route',
          initCtx,
          {
            method: route.method,
            path: route.path,
            handler: route.handler as unknown as (
              req: RouteRequest,
              res: RouteResponse,
            ) => Promise<void>,
          },
        );
        unregisterRoutes.push(r.unregister);
      }

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
        `${PLUGIN_NAME}/turn-error-fill`,
      );
      busRef = undefined;
      // Stop the chunk buffer's sweep timer.
      buffer?.dispose();
      buffer = undefined;
    },
  };
}
