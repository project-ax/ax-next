// ---------------------------------------------------------------------------
// Host-side MCP server: exposes `executesIn: 'host'` tools to
// claude-agent-sdk via an in-process SDK-MCP transport.
//
// The SDK accepts an in-process "SDK MCP" server object (built by
// createSdkMcpServer) whose tools are ordinary TypeScript functions.
// When the model calls one, the SDK routes through canUseTool and then
// invokes our handler. For host tools, our handler does NOT implement
// the tool — it forwards the call over IPC (`tool.execute-host`) so the
// host plugin that owns the tool actually does the work. This is what
// preserves the single-source-of-truth invariant: the sandbox only owns
// sandbox-executed tools.
//
// Schema note — we use `z.object({}).passthrough().shape` (i.e. an empty
// raw shape that accepts arbitrary extra keys). Real input validation
// happens host-side in our `tool:pre-call` subscriber chain, so the SDK
// only needs to hand us the raw object the model emitted. This also
// avoids coupling the runner to each tool's JSON Schema (we get those
// dynamically from `tool.list` at runtime — encoding them in static
// types here isn't feasible and isn't useful).
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { IpcClient } from '@ax/agent-runner-core';
import {
  ToolExecuteHostResponseSchema,
  type ToolDescriptor,
} from '@ax/ipc-protocol';
import { z } from 'zod';
import { MCP_HOST_SERVER_NAME } from './tool-names.js';

export interface CreateHostMcpServerOptions {
  client: IpcClient;
  /** Full tool catalog from `tool.list`. We filter to executesIn:'host'. */
  tools: ToolDescriptor[];
  /** Test seam: override the per-call id generator. */
  idGen?: () => string;
}

// Empty-object passthrough: SDK passes the raw args through; the host-side
// `tool:pre-call` subscriber chain is where real validation happens.
const PASSTHROUGH_SHAPE = z.object({}).passthrough().shape;

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
 * Build the SDK-MCP tool entries for every host-executed tool in the
 * catalog. Exported so tests can exercise the handlers without spinning
 * up the real createSdkMcpServer (it does internal wiring we don't care
 * about for unit tests).
 */
export function buildHostToolEntries(
  client: IpcClient,
  tools: ToolDescriptor[],
  idGen: () => string = () => randomUUID(),
): Array<SdkMcpToolDefinition> {
  const hostTools = tools.filter((t) => t.executesIn === 'host');
  return hostTools.map((t) =>
    tool(
      t.name,
      t.description ?? '',
      PASSTHROUGH_SHAPE,
      async (args) => {
        try {
          const raw = await client.call('tool.execute-host', {
            call: { id: idGen(), name: t.name, input: args },
          });
          // Defensive re-parse — the IpcClient already validates, but we
          // want a narrowed local type + to never trust the shape blindly.
          const parsed = ToolExecuteHostResponseSchema.parse(raw);
          return renderOutput(parsed.output);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: message }],
            isError: true,
          };
        }
      },
    ),
  );
}

export function createHostMcpServer(
  opts: CreateHostMcpServerOptions,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_HOST_SERVER_NAME,
    version: '0.0.0',
    tools: buildHostToolEntries(opts.client, opts.tools, opts.idGen),
  });
}
