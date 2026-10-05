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
import type { ListOutcome, ListServerToolsOptions } from './connector-inventory/list-tools.js';
import {
  createInventoryStore,
  runMcpClientMigration,
  type McpClientDatabase,
} from './connector-inventory/store.js';
import { sweepHostMcpServers } from './host-server-sweep.js';

const PLUGIN_NAME = '@ax/mcp-client';

const SWEEP_PURGE_DEGRADATION =
  'boot sweep deletes retired host MCP server rows without purging their mcp:<id>: credentials';

export interface CreateMcpClientPluginOptions {
  /**
   * If true, register `connectors:describe-tools` (connector tool inventory)
   * and own its cache table. Default: false — this plugin also boots in the
   * CLI preset, which has no database, no `@ax/connectors` and no agents;
   * the multi-tenant (k8s) preset sets it.
   */
  connectorToolInventory?: boolean;
  /**
   * Test seam: replace the guarded network listing used by
   * `connectors:describe-tools`. Production leaves this undefined.
   */
  connectorInventoryListTools?: (opts: ListServerToolsOptions) => Promise<ListOutcome>;
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
        "A runner's report that a connector server refused it is dropped (logged): the connector's rail status updates only on its next rail or details check.",
    });
    registers.push(
      'connectors:describe-tools',
      'connectors:inventory-status-batch',
      'connectors:inventory-tool-titles',
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
      }

      // Host MCP servers were retired 2026-10-04 (TASK-792): hard-delete any
      // stored row and its credentials. Nothing connects to them any more.
      await sweepHostMcpServers(bus, initCtx);
    },
  };
}
