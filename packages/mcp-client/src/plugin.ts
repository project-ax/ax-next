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
  makeChatContext,
  type ChatContext,
  type Plugin,
  type ToolCall,
} from '@ax/core';
import { loadConfigs, type McpServerConfig } from './config.js';
import { McpConnection } from './connection.js';
import { namespaceTools } from './tool-names.js';
import {
  createTransport,
  type BusLike,
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
    ctx: ChatContext;
  }) => Promise<McpClientTransport>;
}

/**
 * Build the @ax/mcp-client plugin. Intended to be added to the bootstrap
 * plugin list after @ax/storage-sqlite + @ax/credentials + @ax/tool-dispatcher,
 * since all three produce hooks this plugin calls during init.
 */
export function createMcpClientPlugin(opts: CreateMcpClientPluginOptions = {}): Plugin {
  return {
    manifest: {
      // `registers: []` is deliberate — see file banner. The per-tool
      // `tool:execute:${name}` service hooks are registered dynamically
      // inside init based on what the configured MCP servers advertise.
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['tool:register', 'storage:get', 'storage:set', 'credentials:get'],
      subscribes: [],
    },
    async init({ bus }) {
      // Synthesize a minimal init-time ctx: the hooks we call during init
      // (`storage:get`, `storage:set`, `credentials:get`, `tool:register`)
      // don't read session/agent/user identity, they just need a ChatContext
      // envelope (and a logger). Mirrors @ax/test-harness/test-host-tool.ts.
      const initCtx = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });

      const configs = await loadConfigs(bus, initCtx);

      // Open connections in parallel — 5 MCP servers shouldn't serialize 5
      // round-trip connects during startup. Tool registration happens
      // sequentially afterwards so the dispatcher's catalog (single source
      // of truth, invariant I4) gets writes in a deterministic order.
      const connectResults = await Promise.all(
        configs
          .filter((c) => c.enabled)
          .map(async (config) => {
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
  };
}

// Re-export createTransport for downstream composition tests. The default
// (production) transport factory path runs through it when opts.transportFactory
// is omitted — exposing it here lets acceptance tests (Task 18) assert that
// the real factory is being used without poking at private plugin state.
export { createTransport };
