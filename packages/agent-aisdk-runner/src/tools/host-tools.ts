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
import {
  flushPreconditionMessage,
  type HoldLatch,
  type HostToolFlush,
  type ToolPolicy,
} from '@ax/agent-runner-core';
import { wrapWithPolicy } from './policy-wrap.js';

export interface BuildHostToolsOptions {
  policy: ToolPolicy;
  client: IpcClient;
  /** Full tool catalog from `tool.list`. We filter to executesIn:'host'. */
  tools: ToolDescriptor[];
  /**
   * Flush the live workspace (commit + push to the host mirror) before
   * forwarding a host tool whose descriptor declares
   * `flushWorkspaceBeforeCall`, returning the flush outcome plus, on a
   * refusal, the host's stated reason. Omitted in deployments without a
   * workspace (the flag then simply has no effect). See the precondition gate
   * below.
   */
  flushWorkspace?: () => Promise<HostToolFlush>;
  /** Test seam: override the per-call id generator. */
  idGen?: () => string;
  /** The one latch shared by every tool this turn — see WrapWithPolicyOptions. */
  holdLatch: HoldLatch;
  /** Fired with the call id on a hold — see WrapWithPolicyOptions. */
  onHold: (toolCallId: string) => void;
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
  const { policy, client, tools, flushWorkspace, idGen = () => randomUUID(), holdLatch } = opts;
  const hostTools = tools.filter((t) => t.executesIn === 'host');

  const entries: Record<string, Tool> = {};
  for (const descriptor of hostTools) {
    entries[descriptor.name] = tool({
      description: descriptor.description ?? '',
      inputSchema: jsonSchema(descriptor.inputSchema as JSONSchema7),
      execute: wrapWithPolicy(
        { policy, name: descriptor.name, isBuiltin: false, holdLatch, onHold: opts.onHold },
        async (input) => {
          // Flush the live workspace BEFORE forwarding when this host tool
          // declares it reads workspace files the agent may have written
          // this turn. Under runner-owned sessions the host reads the
          // committed + pushed mirror, which lags the live tree until a
          // turn-boundary commit — without the flush the host read misses a
          // just-written file (BUG-W2).
          //
          // The flush is a PRECONDITION, not best-effort: we forward ONLY
          // when it actually synced the mirror. `accepted` = pushed; `noop`
          // = nothing staged because it was already committed+pushed on a
          // prior turn (mirror already current). Anything else means the
          // host would read a stale-or-worse state, so we DON'T forward:
          //   - `kept` (host unreachable / 5xx): committed locally but
          //     never pushed → host read would 404.
          //   - `rolled-back` (workspace veto / resync exhausted): the live
          //     tree was reset to baseline, so the just-authored file is
          //     GONE and the mirror still lacks it — forwarding could even
          //     install an OLDER committed draft with the freshly-requested
          //     grants.
          //   - thrown: git/IPC error mid-flush.
          // In those cases we surface a clear message instead of forwarding
          // into a stale read (BUG-W2 follow-up; Codex review) — carrying the
          // host's own reason for the refusal when it gave one, so a veto is
          // something the model can act on rather than a bare `rolled-back`.
          //
          // This THROWS rather than returning a plain string, and the
          // difference is about parity, not style. The SDK runner's shim
          // returns this refusal as `{ isError: true }` content, so the host
          // persists `is_error` and the UI renders a failed tool. Returning a
          // plain result here would render the same refusal as a SUCCESSFUL
          // tool call whose text happens to complain — a visible divergence
          // between two runners that are supposed to be
          // host-indistinguishable. Throwing does NOT abort the turn: ai@7
          // converts a thrown executor into a `tool-error` part plus an
          // `error-text` tool result and continues the loop (verified against
          // ai@7.0.70), so the model still reads the message and retries.
          //
          // A policy VETO is the one case that stays a plain result — that is
          // a design mandate (§3), and it is a different event: permission
          // refused before the tool ran, not a precondition failing on a
          // permitted call.
          if (descriptor.flushWorkspaceBeforeCall === true && flushWorkspace !== undefined) {
            let flush: { outcome: HostToolFlush['outcome'] | 'error'; rejectionReason?: string };
            try {
              flush = await flushWorkspace();
            } catch (flushErr) {
              process.stderr.write(
                `runner: workspace flush before '${descriptor.name}' failed: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}\n`,
              );
              flush = { outcome: 'error' };
            }
            if (flush.outcome !== 'accepted' && flush.outcome !== 'noop') {
              throw new Error(flushPreconditionMessage(descriptor.name, flush));
            }
          }

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
