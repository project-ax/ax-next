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
// Schema note — the SDK's `tool()` helper wraps its raw-shape argument in
// `z.object(shape)` which strips unknown keys when it validates the model's
// input. Passing an empty shape would therefore strip EVERY field and our
// host handler would see `{}`. We build a one-key-per-declared-property
// shape of `z.unknown()` from each tool's JSON Schema so the keys survive;
// real input validation still happens host-side in `tool:pre-call` and in
// each host tool's own handler (we never re-implement JSON Schema → Zod).
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

/**
 * Build a minimal Zod raw shape from a tool's JSON Schema so the SDK
 * preserves the model-supplied input keys.
 *
 * `tool()` treats its third argument as a `ZodRawShape`, i.e. a plain
 * `{[key]: ZodType}` map. Internally the SDK does `z.object(shape)` and
 * uses the result both to generate the advertised JSON Schema and to
 * validate/coerce incoming tool-call input. `z.object({})` strips unknown
 * keys — so if we pass an empty shape, every argument the model sends
 * arrives at our handler as `{}`. The host-side `tool:execute:<name>`
 * handler then fails its own schema validation and the turn dies.
 *
 * To avoid that, we translate the JSON Schema's declared `properties` into
 * a one-key-per-property shape, each value `z.unknown()` (so we don't
 * re-implement JSON Schema → Zod; real validation still happens host-side
 * in `tool:pre-call` and in each host tool's own handler). Tools without
 * declared properties fall back to an empty shape — they genuinely
 * expect no input.
 */
function shapeFromInputSchema(
  inputSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const rawProps = (inputSchema as { properties?: unknown }).properties;
  if (rawProps === null || typeof rawProps !== 'object') return {};
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
      shapeFromInputSchema(t.inputSchema),
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
