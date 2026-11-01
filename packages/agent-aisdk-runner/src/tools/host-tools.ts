// ---------------------------------------------------------------------------
// Host tools: `ai@7` `Tool` entries for every catalog descriptor whose
// `executesIn` is `'host'`. This is the aisdk-runner counterpart to
// `packages/agent-claude-sdk-runner/src/host-mcp-server.ts`, minus the MCP
// wrapping — `ai@7` needs no in-process MCP server to expose a tool, a plain
// entry in a `tools` object is enough (I₄: no MCP shims).
//
// Dispatch is the same as the SDK shim: forward the call over IPC
// (`tool.execute-host`) so the host plugin that owns the tool does the actual
// work. This is what preserves the single-source-of-truth invariant — the
// sandbox never re-implements a host tool, it only relays the call.
//
// The `shapeFromInputSchema` workaround in the SDK shim has NO counterpart
// here (I₄ / constraint 4 of the port). That helper existed only because the
// SDK's `tool()` does `z.object(shape)` internally, and `z.object({})`
// strips every key the shape didn't declare — so an empty Zod shape silently
// erased the model's entire input. `ai@7`'s `jsonSchema()` does not
// validate-and-strip like that; it hands the descriptor's JSON Schema
// straight to the provider for advertising and lets whatever the model sends
// through untouched. We pass `descriptor.inputSchema` straight in. See
// `host-tools.test.ts` for the regression test that keeps this true.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { jsonSchema, tool, type JSONSchema7, type Tool } from 'ai';
import {
  ToolExecuteHostResponseSchema,
  type IpcClient,
  type ToolDescriptor,
} from '@ax/ipc-protocol';
import type { HoldLatch, ToolPolicy } from '@ax/agent-runner-core';
import { wrapWithPolicy } from './policy-wrap.js';

export interface BuildHostToolsOptions {
  policy: ToolPolicy;
  client: IpcClient;
  /** Full tool catalog from `tool.list`. We filter to executesIn:'host'. */
  tools: ToolDescriptor[];
  /** Test seam: override the per-call id generator. */
  idGen?: () => string;
  /** The one latch shared by every tool this turn — see WrapWithPolicyOptions. */
  holdLatch: HoldLatch;
  /** Fired with the call id on a hold — see WrapWithPolicyOptions. */
  onHold: (toolCallId: string) => void;
  /** Fired with the call id when a tool ran and failed — see WrapWithPolicyOptions. */
  onToolFailure: (toolCallId: string) => void;
}

/**
 * Render a tool output as the string `ai@7`'s `execute` must return. String
 * outputs pass through verbatim; anything else is JSON-stringified.
 */
function renderOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * Build the `ai@7` tool entries for every host-executed tool in the catalog,
 * keyed by tool name (the shape `ToolLoopAgent`'s `tools` option expects).
 * Every `execute` is policy-wrapped (`wrapWithPolicy`) — that is the ONLY
 * pre-call gate on this runner (I₁), and it's what stops a catalog tool
 * happening to be named `Bash` from reaching the builtin Bash egress-block
 * drain (`isBuiltin: false` here, unconditionally — catalog tools are never
 * builtins).
 */
export function buildHostTools(opts: BuildHostToolsOptions): Record<string, Tool> {
  const { policy, client, tools, idGen = () => randomUUID(), holdLatch } = opts;
  const hostTools = tools.filter((t) => t.executesIn === 'host');

  const entries: Record<string, Tool> = {};
  for (const descriptor of hostTools) {
    entries[descriptor.name] = tool({
      description: descriptor.description ?? '',
      inputSchema: jsonSchema(descriptor.inputSchema as JSONSchema7),
      execute: wrapWithPolicy(
        { policy, name: descriptor.name, isBuiltin: false, holdLatch, onHold: opts.onHold, onToolFailure: opts.onToolFailure },
        async (input) => {
          const raw = await client.call('tool.execute-host', {
            call: { id: idGen(), name: descriptor.name, input },
          });
          // Defensive re-parse — the IpcClient already validates, but we
          // want a narrowed local type + to never trust the shape blindly.
          const parsed = ToolExecuteHostResponseSchema.parse(raw);
          return renderOutput(parsed.output);
        },
      ),
    });
  }
  return entries;
}
