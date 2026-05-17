// ---------------------------------------------------------------------------
// Sandbox-MCP bridge: exposes `executesIn: 'sandbox'` tools to
// claude-agent-sdk via the same in-process SDK-MCP transport that
// host-mcp-server.ts uses for host tools. The difference is the handler
// dispatches through the runner's local-dispatcher (an in-process map of
// tool-name → executor) instead of doing a `tool.execute-host` IPC.
//
// Why a separate file from host-mcp-server.ts: the dispatch path is
// fundamentally different — IPC vs. in-process. Keeping them separate
// makes the "where does this tool actually run" question one grep away.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { ToolDescriptor } from '@ax/core';
import { z } from 'zod';
import type { LocalDispatcher } from './local-dispatcher.js';
import { MCP_SANDBOX_SERVER_NAME } from './tool-names.js';

/**
 * Build a minimal Zod raw shape from a tool's JSON Schema so the SDK
 * preserves the model-supplied input keys.
 *
 * Mirrors the same helper in host-mcp-server.ts — not exported there so
 * duplicated here. Real validation still happens in each executor; we only
 * need the keys to survive `z.object(shape)`'s unknown-key stripping.
 */
function shapeFromInputSchema(
  inputSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const rawProps = (inputSchema as { properties?: unknown }).properties;
  if (
    rawProps === null ||
    typeof rawProps !== 'object' ||
    Array.isArray(rawProps)
  ) {
    return {};
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const key of Object.keys(rawProps as Record<string, unknown>)) {
    shape[key] = z.unknown();
  }
  return shape;
}

/**
 * Render a tool output as an SDK-MCP content block list. String outputs
 * pass through verbatim; anything else is JSON-stringified.
 */
function renderOutput(output: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return { content: [{ type: 'text', text }] };
}

/**
 * Build the SDK-MCP tool entries for every sandbox-executed tool in the
 * catalog. Exported so tests can exercise the handlers without spinning
 * up the real createSdkMcpServer.
 */
export function buildSandboxToolEntries(
  dispatcher: LocalDispatcher,
  tools: ToolDescriptor[],
  idGen: () => string = () => randomUUID(),
): Array<SdkMcpToolDefinition> {
  const sandboxTools = tools.filter((t) => t.executesIn === 'sandbox');
  return sandboxTools.map((t) =>
    tool(
      t.name,
      t.description ?? '',
      shapeFromInputSchema(t.inputSchema),
      async (args) => {
        try {
          const out = await dispatcher.execute({
            id: idGen(),
            name: t.name,
            input: args,
          });
          return renderOutput(out);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: message }],
            isError: true,
          };
        }
      },
    ),
  );
}

export interface CreateSandboxMcpServerOptions {
  dispatcher: LocalDispatcher;
  /** Full tool catalog from `tool.list`. We filter to executesIn:'sandbox'. */
  tools: ToolDescriptor[];
  /** Test seam: override the per-call id generator. */
  idGen?: () => string;
}

export function createSandboxMcpServer(
  opts: CreateSandboxMcpServerOptions,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SANDBOX_SERVER_NAME,
    version: '0.0.0',
    tools: buildSandboxToolEntries(opts.dispatcher, opts.tools, opts.idGen),
  });
}
