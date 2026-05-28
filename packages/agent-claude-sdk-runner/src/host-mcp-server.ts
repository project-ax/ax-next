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
import {
  ToolExecuteHostResponseSchema,
  type IpcClient,
  type ToolDescriptor,
} from '@ax/ipc-protocol';
import { z } from 'zod';
import type { FlushOutcome } from './commit-notify-resync.js';
import { MCP_HOST_SERVER_NAME } from './tool-names.js';

export interface CreateHostMcpServerOptions {
  client: IpcClient;
  /** Full tool catalog from `tool.list`. We filter to executesIn:'host'. */
  tools: ToolDescriptor[];
  /** Test seam: override the per-call id generator. */
  idGen?: () => string;
  /**
   * Flush the live workspace (commit + push to the host mirror) before
   * forwarding a host tool whose descriptor declares
   * `flushWorkspaceBeforeCall`, returning the flush outcome. Omitted in
   * deployments without a workspace (the flag then simply has no effect).
   * See the precondition gate in the per-tool handler below.
   */
  flushWorkspace?: () => Promise<FlushOutcome>;
  /**
   * Serializer for flagged host tools' flush+forward. When provided, a
   * `flushWorkspaceBeforeCall` tool's flush + host read runs through this so
   * concurrent invocations (the SDK can dispatch several in one turn) execute
   * one-at-a-time, avoiding concurrent host reads racing the just-pushed commit
   * (BUG-W2 concurrent residual). Omitted ⇒ flagged tools run un-serialized.
   */
  serializeFlagged?: <T>(fn: () => Promise<T>) => Promise<T>;
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
  // Reject non-object shapes outright, including arrays — `typeof [] ===
  // 'object'` would otherwise iterate numeric indices from a malformed
  // descriptor and produce a shape keyed by array indices.
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
 * Build the SDK-MCP tool entries for every host-executed tool in the
 * catalog. Exported so tests can exercise the handlers without spinning
 * up the real createSdkMcpServer (it does internal wiring we don't care
 * about for unit tests).
 */
export function buildHostToolEntries(
  client: IpcClient,
  tools: ToolDescriptor[],
  idGen: () => string = () => randomUUID(),
  flushWorkspace?: () => Promise<FlushOutcome>,
  serializeFlagged?: <T>(fn: () => Promise<T>) => Promise<T>,
): Array<SdkMcpToolDefinition> {
  const hostTools = tools.filter((t) => t.executesIn === 'host');
  return hostTools.map((t) =>
    tool(
      t.name,
      t.description ?? '',
      shapeFromInputSchema(t.inputSchema),
      async (args) => {
        // The flush + the forward (host read) for a flagged tool. Returns the
        // rendered output, or an isError content block on a failed precondition.
        const flushThenForward = async () => {
          // Flush the live workspace BEFORE forwarding when this host tool
          // declares it reads workspace files the agent may have written this
          // turn. Under runner-owned sessions the host reads the committed +
          // pushed mirror, which lags the live tree until a turn-boundary
          // commit — without the flush the host read misses a just-written
          // file (e.g. install_authored_skill's `.ax/skills/<id>/SKILL.md`,
          // BUG-W2).
          //
          // The flush is a PRECONDITION, not best-effort: we forward ONLY when
          // it actually synced the mirror. `accepted` = pushed; `noop` =
          // nothing staged because it was already committed+pushed on a prior
          // turn (mirror already current). Anything else means the host would
          // read a stale-or-worse state, so we DON'T forward:
          //   - `kept` (host unreachable / 5xx): committed locally but never
          //     pushed → host read would 404.
          //   - `rolled-back` (workspace veto / resync exhausted): the live
          //     tree was reset to baseline, so the just-authored file is GONE
          //     and the mirror still lacks it — forwarding could even install
          //     an OLDER committed draft with the freshly-requested grants.
          //   - thrown: git/IPC error mid-flush.
          // In those cases we surface a clear, retryable tool error instead of
          // forwarding into a stale read (BUG-W2 follow-up; Codex review).
          if (t.flushWorkspaceBeforeCall === true && flushWorkspace !== undefined) {
            let outcome: FlushOutcome | 'error';
            try {
              outcome = await flushWorkspace();
            } catch (flushErr) {
              process.stderr.write(
                `runner: workspace flush before '${t.name}' failed: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}\n`,
              );
              outcome = 'error';
            }
            if (outcome !== 'accepted' && outcome !== 'noop') {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Could not sync your just-authored workspace files to the host before '${t.name}' (flush outcome: ${outcome}). The files are not visible to the installer yet — please try again.`,
                  },
                ],
                isError: true,
              };
            }
          }
          const raw = await client.call('tool.execute-host', {
            call: { id: idGen(), name: t.name, input: args },
          });
          // Defensive re-parse — the IpcClient already validates, but we
          // want a narrowed local type + to never trust the shape blindly.
          const parsed = ToolExecuteHostResponseSchema.parse(raw);
          return renderOutput(parsed.output);
        };
        try {
          // Flagged tools (which flush + then read the workspace) run through
          // `serializeFlagged` so N parallel calls — the SDK can dispatch
          // several `install_authored_skill` tool_use blocks in one turn —
          // execute the flush+read ONE AT A TIME. Concurrent host reads
          // otherwise race each other against the just-pushed commit (the
          // read-after-push window) and 404 (BUG-W2 concurrent residual);
          // serializing makes each call behave like the working single-call
          // case. Unflagged tools (web_search, …) run free — no serialization.
          if (t.flushWorkspaceBeforeCall === true && serializeFlagged !== undefined) {
            return await serializeFlagged(flushThenForward);
          }
          return await flushThenForward();
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
    tools: buildHostToolEntries(
      opts.client,
      opts.tools,
      opts.idGen,
      opts.flushWorkspace,
      opts.serializeFlagged,
    ),
  });
}
