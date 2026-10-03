// ---------------------------------------------------------------------------
// @ax/mcp-client plugin factory (Task 13).
//
// This is the centerpiece of the package. On init we:
//
//   1. Read MCP server configs from storage (Task 8's `loadConfigs`).
//   2. For each enabled config, open an `McpConnection` (Task 10/11) and
//      list its tools.
//   3. Namespace the tools (Task 12's `namespaceTools`) so two servers
//      advertising `read_file` don't collide in the dispatcher's catalog.
//   4. Register each namespaced descriptor with `tool:register`.
//   5. Register a `tool:execute:${namespacedName}` service hook per tool
//      that routes back to `connection.callTool(originalName, input)`.
//
// Why the per-tool service registration is a DYNAMIC exception:
//
// Every other plugin's `manifest.registers` lists hook names statically so
// the bus can validate the call graph before anything runs. But the set of
// `tool:execute:${name}` hooks depends on what MCP servers actually advertise
// at runtime — we don't know the tool list until after `connect()` +
// `listTools()`. So `registers: []` is literal: we add hooks during init
// instead, mirroring the dynamic pattern used by the legacy tool-dispatcher
// and documented in `@ax/ipc-server`'s tool-execute-host handler:
// packages/ipc-server/src/handlers/tool-execute-host.ts:37.
//
// Failure model:
//
//  - A single server failing to connect MUST NOT take the plugin down.
//    We log a warning and skip it; its tools simply don't appear in the
//    catalog. The reconnect backoff in `McpConnection` may still bring
//    it back later (post-MVP: we'd then register its tools lazily — for
//    now Week 6.5e ships with static-at-init-time tool wiring).
//  - `MCP_SERVER_UNAVAILABLE` from `callTool` is translated to a tool-error
//    result (`isError:true` + text content). The model sees a tool failure
//    it can reason about; the chat keeps going.
// ---------------------------------------------------------------------------

import {
  PluginError,
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type ToolCall,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { registerAdminMcpRoutes } from './admin-routes.js';
import {
  createDescribeTools,
  createInventoryStatusBatch,
} from './connector-inventory/describe-tools.js';
import type { ListOutcome, ListServerToolsOptions } from './connector-inventory/list-tools.js';
import {
  createInventoryStore,
  runMcpClientMigration,
  type McpClientDatabase,
} from './connector-inventory/store.js';
import { isReservedServerId, loadConfigs, type McpServerConfig } from './config.js';
import { McpConnection } from './connection.js';
import { namespaceTools } from './tool-names.js';
import {
  createTransport,
  type BusLike,
  type CreateTransportOptions,
  type McpClientTransport,
} from './transports.js';

const PLUGIN_NAME = '@ax/mcp-client';

interface HandlerEntry {
  connection: McpConnection;
  originalName: string;
}

export interface CreateMcpClientPluginOptions {
  /**
   * Test seam: override transport construction. Production callers should
   * leave this undefined so `createTransport` (stdio / streamable-http /
   * sse) is used. Tests inject pre-linked `InMemoryTransport` pairs so they
   * can exercise the full plugin without spawning subprocesses or opening
   * sockets.
   */
  transportFactory?: (opts: {
    config: McpServerConfig;
    bus: BusLike;
    ctx: AgentContext;
  }) => Promise<McpClientTransport>;
  /**
   * If true, mount the /admin/mcp-servers routes. Default: false. The
   * agents plugin always mounts admin routes; this plugin gates on the
   * flag because @ax/mcp-client is also loaded in CLI / sandbox-side
   * contexts (no @ax/http-server, no @ax/auth) and we don't want those
   * boots to fail. The multi-tenant preset sets it.
   */
  mountAdminRoutes?: boolean;
  /**
   * Test seam for the /test endpoint. Lets a test inject a fake
   * transport (in-memory pair) so the test endpoint exercises connect
   * + listTools without an actual outbound network call.
   */
  testTransportFactory?: (
    opts: CreateTransportOptions,
  ) => Promise<McpClientTransport>;
  /**
   * Test seam to shorten the /test timeout. Defaults to 30 s in production.
   */
  testTimeoutMs?: number;
  /**
   * If true, register `connectors:describe-tools` (connector tool inventory)
   * and own its cache table. Default: false — like `mountAdminRoutes`, this
   * plugin also boots in the CLI preset, which has no database, no
   * `@ax/connectors` and no agents; the multi-tenant (k8s) preset sets it.
   */
  connectorToolInventory?: boolean;
  /**
   * Test seam: replace the guarded network listing used by
   * `connectors:describe-tools`. Production leaves this undefined.
   */
  connectorInventoryListTools?: (opts: ListServerToolsOptions) => Promise<ListOutcome>;
}

/**
 * Build the @ax/mcp-client plugin. Intended to be added to the bootstrap
 * plugin list after @ax/storage-sqlite + @ax/credentials + @ax/tool-dispatcher,
 * since all three produce hooks this plugin calls during init.
 */
export function createMcpClientPlugin(opts: CreateMcpClientPluginOptions = {}): Plugin {
  const mountAdminRoutes = opts.mountAdminRoutes === true;
  const unregisterRoutes: Array<() => void> = [];
  // calls list is built once at construction so the manifest is stable
  // and matches what init actually uses.
  const calls: string[] = [
    'tool:register',
    'storage:get',
    'storage:set',
    'credentials:get',
  ];
  if (mountAdminRoutes) {
    calls.push('http:register-route', 'auth:require-user');
  }
  const connectorToolInventory = opts.connectorToolInventory === true;
  const registers: string[] = [];
  const subscribes: string[] = [];
  if (connectorToolInventory) {
    subscribes.push('agents:deleted');
    registers.push('connectors:describe-tools', 'connectors:inventory-status-batch');
    calls.push('database:get-instance', 'connectors:resolve', 'agents:resolve');
  }
  return {
    manifest: {
      // The per-tool `tool:execute:${name}` service hooks are registered
      // dynamically inside init (see file banner) and so are NOT listed here.
      // `connectors:describe-tools` is static and listed when enabled.
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers,
      calls,
      subscribes,
    },
    async init({ bus }) {
      // Synthesize a minimal init-time ctx: the hooks we call during init
      // (`storage:get`, `storage:set`, `credentials:get`, `tool:register`)
      // don't read session/agent/user identity, they just need a AgentContext
      // envelope (and a logger). Mirrors @ax/test-harness/test-host-tool.ts.
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });

      if (connectorToolInventory) {
        const { db } = await bus.call<unknown, { db: unknown }>(
          'database:get-instance',
          initCtx,
          {},
        );
        const typed = db as Kysely<McpClientDatabase>;
        await runMcpClientMigration(typed);
        const store = createInventoryStore(typed);
        // Purge the agent's cached inventories. Payload declared locally (no
        // cross-plugin import); only `agentId` matters. A subscriber must never
        // throw — a failed purge is logged and swallowed.
        bus.subscribe<unknown>('agents:deleted', PLUGIN_NAME, async (ctx, payload) => {
          const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
          if (typeof agentId !== 'string' || agentId.length === 0) {
            ctx.logger.warn('connector_inventory_purge_skipped', {
              reason: 'agents:deleted payload has no non-empty string agentId',
            });
            return undefined;
          }
          try {
            const { deleted } = await store.deleteForAgent(agentId);
            ctx.logger.info('connector_inventory_purged_for_deleted_agent', { agentId, deleted });
          } catch (err) {
            ctx.logger.error('connector_inventory_purge_failed', { agentId, err });
          }
          return undefined;
        });
        const describeTools = createDescribeTools({
          bus,
          store,
          ...(opts.connectorInventoryListTools !== undefined
            ? { listTools: opts.connectorInventoryListTools }
            : {}),
        });
        bus.registerService('connectors:describe-tools', PLUGIN_NAME, describeTools);
        bus.registerService(
          'connectors:inventory-status-batch',
          PLUGIN_NAME,
          createInventoryStatusBatch(store),
        );
      }

      // A row whose id is in the reserved connector-namespace form (TASK-752)
      // predates the reservation. Never connect it — its tools would land in a
      // connector's permission keyspace. It stays listed in the admin API so
      // an admin can see it and delete it.
      const configs = (await loadConfigs(bus, initCtx)).filter((c) => {
        if (!isReservedServerId(c.id)) return true;
        initCtx.logger.warn('mcp_server_reserved_id_skipped', {
          serverId: c.id,
          hint: "ids of the form 'c' + 10 hex are reserved for connector tools; recreate it under another id",
        });
        return false;
      });

      // Open connections in parallel — 5 MCP servers shouldn't serialize 5
      // round-trip connects during startup. Tool registration happens
      // sequentially afterwards so the dispatcher's catalog (single source
      // of truth, invariant I4) gets writes in a deterministic order.
      const connectResults = await Promise.all(
        configs
          .filter((c) => c.enabled)
          .map(async (config) => {
            // HTTPS-by-default: if an HTTP/SSE config points at plain http://,
            // warn so operators know secrets traverse the wire in cleartext.
            // The config still works (Task 8 accepts http:// for dev loops).
            if (
              (config.transport === 'streamable-http' || config.transport === 'sse') &&
              config.url.startsWith('http://')
            ) {
              initCtx.logger.warn('mcp_plain_http_transport', {
                serverId: config.id,
                hint: 'secrets will traverse the wire in cleartext; prefer https://',
              });
            }
            const connection = new McpConnection({
              config,
              bus,
              ctx: initCtx,
              ...(opts.transportFactory !== undefined
                ? { transportFactory: opts.transportFactory }
                : {}),
            });
            try {
              await connection.connect();
            } catch (err) {
              // Don't fail plugin init — other servers should still come
              // up. The reconnect backoff in McpConnection will continue
              // retrying this one in the background (though its tools
              // won't make it into the catalog until a post-MVP lazy-
              // registration path lands).
              initCtx.logger.warn('mcp_init_connect_failed', {
                serverId: config.id,
                err: err instanceof Error ? err.message : String(err),
              });
              return null;
            }
            const listed = await connection.listTools();
            if (!listed.ok) {
              initCtx.logger.warn('mcp_init_list_failed', {
                serverId: config.id,
                code: listed.code,
                reason: listed.reason,
              });
              return null;
            }
            return { config, connection, tools: listed.tools };
          }),
      );

      const handlerByName = new Map<string, HandlerEntry>();

      for (const result of connectResults) {
        if (result === null) continue;
        const { config, connection, tools } = result;
        const { descriptors, nameMap } = namespaceTools(config.id, tools);
        for (const descriptor of descriptors) {
          await bus.call('tool:register', initCtx, descriptor);
          const originalName = nameMap.get(descriptor.name);
          if (originalName === undefined) {
            // Unreachable if namespaceTools honors its own invariants, but
            // cheap to guard and expensive to debug otherwise.
            throw new PluginError({
              code: 'name-map-mismatch',
              plugin: PLUGIN_NAME,
              message: `internal: descriptor '${descriptor.name}' missing from nameMap`,
            });
          }
          handlerByName.set(descriptor.name, { connection, originalName });
        }
      }

      // Mount /admin/mcp-servers[/:id][/test] last — the bus calls inside
      // their handlers reach storage / credentials / auth, which are
      // already registered (auth comes from the auth plugin via the
      // manifest's `calls` edge). When mountAdminRoutes is false we
      // skip this entirely so single-process / sandbox contexts that
      // don't load @ax/http-server still boot.
      if (mountAdminRoutes) {
        const opts2: {
          testTransportFactory?: (
            o: CreateTransportOptions,
          ) => Promise<McpClientTransport>;
          testTimeoutMs?: number;
        } = {};
        if (opts.testTransportFactory !== undefined) {
          opts2.testTransportFactory = opts.testTransportFactory;
        }
        if (opts.testTimeoutMs !== undefined) {
          opts2.testTimeoutMs = opts.testTimeoutMs;
        }
        const unregisters = await registerAdminMcpRoutes(bus, initCtx, opts2);
        unregisterRoutes.push(...unregisters);
      }

      // Dynamic tool:execute:${name} registration. See file banner for why
      // this lives in init instead of manifest.registers.
      for (const [namespacedName, entry] of handlerByName) {
        const hookName = `tool:execute:${namespacedName}`;
        bus.registerService<ToolCall, { output: unknown }>(
          hookName,
          PLUGIN_NAME,
          async (_ctx, call) => {
            const result = await entry.connection.callTool(
              entry.originalName,
              (call as { input: unknown }).input,
            );
            if (result.ok) {
              return { output: result.result };
            }
            // Server is unavailable. Wrap as a tool-error result so the
            // model sees a tool failure rather than a chat-terminating
            // exception. Shape (`isError:true` + content) matches what
            // providers already render for server-reported tool errors.
            return {
              output: {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: `MCP server '${entry.connection.serverId}' unavailable: ${result.reason}`,
                  },
                ],
              },
            };
          },
        );
      }
    },
    async shutdown() {
      // Drop admin routes so a re-init in tests doesn't trip duplicate-
      // route. The http-server's unregister is idempotent; we still
      // wrap in try/catch so a transport-level error doesn't abort the
      // rest of the shutdown loop.
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
    },
  };
}

// Re-export createTransport for downstream composition tests. The default
// (production) transport factory path runs through it when opts.transportFactory
// is omitted — exposing it here lets acceptance tests (Task 18) assert that
// the real factory is being used without poking at private plugin state.
export { createTransport };
