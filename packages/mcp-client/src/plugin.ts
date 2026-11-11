// ---------------------------------------------------------------------------
// @ax/mcp-client plugin factory.
//
// What it does now:
//
//   1. Boot sweep (always). Host MCP servers — `mcp-server:<id>` rows behind
//      `/admin/mcp-servers` and `ax-next mcp`, connected at boot and exposed
//      as `mcp.<serverId>.<tool>` tools — were retired 2026-10-04 (TASK-792,
//      docs/plans/2026-10-04-retire-host-mcp-servers.md). Init hard-deletes
//      any stored row and its `mcp:<id>:` credentials (`host-server-sweep.ts`).
//      This plugin no longer connects to anything at boot, registers no
//      tools and mounts no routes.
//   2. Connector tool inventory (opt-in, `connectorToolInventory: true`).
//      Registers `connectors:describe-tools`, `connectors:inventory-status-
//      batch` and `connectors:inventory-tool-titles`, owns their cache table
//      and purges it on `agents:deleted`. The k8s preset turns it on; the CLI
//      preset (no database, no `@ax/connectors`) leaves it off.
//   3. Approved connector calls (same flag, TASK-1046). Registers
//      `connectors:call-tool`: a person approved a connector call held during
//      a task run, so no live agent will make it, and @ax/decisions asks the
//      host to make that one call. It re-derives access from the decision's
//      user and agent and sends one guarded `tools/call`
//      (connector-inventory/call-tool.ts). Not an IPC action and not a
//      `tool:execute:*`: the sandbox cannot reach it.
//
// `credentials:list` / `credentials:delete` are optional calls: the sweep
// purges through them when present (and init orders after the credentials
// plugin), and still deletes the rows when they are not.
// ---------------------------------------------------------------------------

import { makeAgentContext, type OptionalCall, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import {
  createDescribeTools,
  createInventoryStatusBatch,
  createUnstoredInventory,
  createInventoryToolTitles,
} from './connector-inventory/describe-tools.js';
import { createAuthFailureRecheck } from './connector-inventory/auth-failure-recheck.js';
import { createCallTool } from './connector-inventory/call-tool.js';
import { readMcpClientInfo, type McpClientInfo } from './connector-inventory/client-info.js';
import type { CallServerToolOptions, ServerCallOutcome } from './connector-inventory/call-server-tool.js';
import type { ListOutcome, ListServerToolsOptions } from './connector-inventory/list-tools.js';
import {
  createInventoryStore,
  runMcpClientMigration,
  type McpClientDatabase,
} from './connector-inventory/store.js';
import { ConnectorCallToolOutputSchema } from './connector-inventory/types.js';
import { sweepHostMcpServers } from './host-server-sweep.js';

const PLUGIN_NAME = '@ax/mcp-client';

const SWEEP_PURGE_DEGRADATION =
  'boot sweep deletes retired host MCP server rows without purging their mcp:<id>: credentials';

export interface CreateMcpClientPluginOptions {
  /**
   * If true, register `connectors:describe-tools` (connector tool inventory)
   * and own its cache table, and register `connectors:call-tool` (approved
   * connector calls, TASK-1046). Default: false — this plugin also boots in
   * the CLI preset, which has no database, no `@ax/connectors` and no agents;
   * the multi-tenant (k8s) preset sets it.
   */
  connectorToolInventory?: boolean;
  /**
   * Test seam: replace the guarded network listing used by
   * `connectors:describe-tools`. Production leaves this undefined.
   */
  connectorInventoryListTools?: (opts: ListServerToolsOptions) => Promise<ListOutcome>;
  /**
   * Test seam: replace the one-shot guarded `tools/call` used by
   * `connectors:call-tool`. Production leaves this undefined.
   */
  connectorCallServerTool?: (opts: CallServerToolOptions) => Promise<ServerCallOutcome>;
  /**
   * The `clientInfo` sent to connector servers by `connectors:describe-tools`
   * and `connectors:call-tool`. Default: `readMcpClientInfo()` (the
   * AX_MCP_CLIENT_NAME env var, else `@ax/mcp-client`).
   */
  clientInfo?: McpClientInfo;
}

/**
 * Build the @ax/mcp-client plugin. Load it after a storage plugin (and, when
 * present, @ax/credentials) — init sweeps retired host MCP server rows.
 */
export function createMcpClientPlugin(opts: CreateMcpClientPluginOptions = {}): Plugin {
  // calls list is built once at construction so the manifest is stable
  // and matches what init actually uses.
  const calls: string[] = ['storage:list-prefix', 'storage:delete'];
  const optionalCalls: OptionalCall[] = [
    { hook: 'credentials:list', degradation: SWEEP_PURGE_DEGRADATION },
    { hook: 'credentials:delete', degradation: SWEEP_PURGE_DEGRADATION },
  ];
  const connectorToolInventory = opts.connectorToolInventory === true;
  const registers: string[] = [];
  const subscribes: string[] = [];
  if (connectorToolInventory) {
    subscribes.push('agents:deleted', 'connectors:auth-failure-reported');
    optionalCalls.push({
      hook: 'connectors:list-effective',
      degradation:
        "A runner's report that a connector server refused it is dropped (logged): the connector's rail status updates only on its next rail or details check. And connectors:call-tool cannot match a call to the agent's connector, so it sends nothing and answers unavailable.",
    });
    registers.push(
      'connectors:describe-tools',
      'connectors:inventory-status-batch',
      'connectors:inventory-tool-titles',
      'connectors:call-tool',
    );
    calls.push('database:get-instance', 'connectors:resolve', 'agents:resolve', 'credentials:get');
  }
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers,
      calls,
      optionalCalls,
      subscribes,
    },
    async init({ bus }) {
      // Synthesize a minimal init-time ctx: the hooks we call during init
      // don't read session/agent/user identity, they just need an
      // AgentContext envelope (and a logger).
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
        // Read before any work, so a malformed AX_MCP_CLIENT_NAME fails boot.
        const clientInfo = opts.clientInfo ?? readMcpClientInfo();
        const typed = db as Kysely<McpClientDatabase>;
        await runMcpClientMigration(typed);
        const store = createInventoryStore(typed);
        // TASK-787 — answers the store refused to keep: filled by
        // describe-tools, overlaid by the status batch. One holder, so the
        // rail and describe-tools agree during an inventory-write outage.
        const unstored = createUnstoredInventory();
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
          unstored.dropAgent(agentId);
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
          unstored,
          clientInfo,
          ...(opts.connectorInventoryListTools !== undefined
            ? { listTools: opts.connectorInventoryListTools }
            : {}),
        });
        bus.registerService('connectors:describe-tools', PLUGIN_NAME, describeTools);
        // TASK-842 — a runner saw a connector server refuse it mid-chat: re-check
        // it host-side (the report is only a hint; see auth-failure-recheck.ts).
        bus.subscribe<unknown>(
          'connectors:auth-failure-reported',
          PLUGIN_NAME,
          createAuthFailureRecheck({ bus, describeTools }),
        );
        bus.registerService(
          'connectors:inventory-status-batch',
          PLUGIN_NAME,
          createInventoryStatusBatch(store, unstored),
        );
        // TASK-753 — cached server tool titles for `connectors:tool-labels`.
        bus.registerService(
          'connectors:inventory-tool-titles',
          PLUGIN_NAME,
          createInventoryToolTitles(store),
        );
        // TASK-1046 — the host makes one call a person approved, when no live
        // agent is there to make it. The intended caller is @ax/decisions,
        // which holds the approval and re-checks tool policy; this hook does
        // neither (SECURITY.md). The bus's default timeout on purpose: the
        // handler bounds itself well inside it (45 s from entry; see
        // call-tool.ts). `returns` holds the answer to the closed codes, so no
        // field can carry a server's text.
        bus.registerService(
          'connectors:call-tool',
          PLUGIN_NAME,
          createCallTool({
            bus,
            clientInfo,
            ...(opts.connectorCallServerTool !== undefined ? { callServer: opts.connectorCallServerTool } : {}),
          }),
          { returns: ConnectorCallToolOutputSchema },
        );
      }

      // Host MCP servers were retired 2026-10-04 (TASK-792): hard-delete any
      // stored row and its credentials. Nothing connects to them any more.
      await sweepHostMcpServers(bus, initCtx);
    },
  };
}
