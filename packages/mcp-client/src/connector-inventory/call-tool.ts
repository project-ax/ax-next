// ---------------------------------------------------------------------------
// `connectors:call-tool` — the host makes ONE connector call that a person
// approved (TASK-1046).
//
// Intended caller: @ax/decisions, after a decision's owner approved a
// connector call held during a task run, so no live agent will make it.
// Nothing here enforces that. Any host plugin holds the same bus, the
// request carries no proof that anyone approved it, and the tool-policy
// re-check is the caller's job. What IS enforced: this is a NAMED
// service, not a `tool:execute:<name>` (the sandbox reaches every one of
// those through `tool.execute-host`) and not an IPC action, so a runner
// cannot call it.
//
// Access is re-derived on every call from the payload's (userId, agentId),
// which are the decision's owner and agent. The caller's ctx must name the
// same pair (a check against a confused caller: host code can build any
// ctx). Then, in order, before anything is sent:
//   1. `agents:resolve`: the agent is still that user's;
//   2. the key's namespace belongs to a connector in the agent's effective
//      set (`connectors:list-effective` with the agent row's attachments and
//      exclusions: the union a session folds);
//   3. `connectors:resolve` still resolves that connector and still carries
//      the namespace, on an http server with a url;
//   4. that url passes the inventory's URL rules, has no fragment, and its
//      host is in the connector's `allowedHosts` (exact match: the session
//      proxy's rule). So the host never reaches further than the sandbox would;
//   5. the headers come from the connector's own credential plan through
//      `credentials:get`, as (user, agent): the refs a session's proxy spends.
// The namespace-to-connector mapping is always the host's answer, never the
// caller's.
//
// The handler is TOTAL: it never throws, and every failure is a closed code.
// It sends at most one `tools/call` (callServerTool never retries). The budget
// is CALL_LIMITS.budgetMs from handler entry, on a monotonic clock, so slow
// hook reads count against it, and with less than MIN_SEND_BUDGET_MS left
// nothing is sent. A late send could still be running when the bus gives up
// on the caller, which would then record a throw for a call that may land.
//
// Never logged or returned: the input, a header, the url, anything the server
// said. One `connector_call_tool` line per call, codes only. (A credential
// read failure also logs connectorHeaders' own line: connector id and an
// error code.) A failure the handler did not foresee says so: `unexpected:
// true`, plus a PluginError's `code` when it is a short lower-case slug
// (review r2 R4). Without it, the catch-all's `unavailable` read exactly like
// a genuine one. Its message is never logged.
//
// The checks, the budget, the catch-all and the log line live in
// connector-call.ts, shared with the hooks built on the same core. This file
// binds them to `connectors:call-tool`: the `connector_call_tool` log event
// and the outcome-only send, `callServerTool`.
// ---------------------------------------------------------------------------

import type { AgentContext } from '@ax/core';
import { callServerTool, type CallServerToolOptions, type ServerCallOutcome } from './call-server-tool.js';
import { createConnectorCallHandler, type ConnectorCallBus } from './connector-call.js';
import type { ConnectorCallToolOutput } from './types.js';

export { MIN_SEND_BUDGET_MS } from './connector-call.js';

export interface CallToolDeps {
  bus: ConnectorCallBus;
  /** Test seam: the one-shot transport. Default `callServerTool`. */
  callServer?: (opts: CallServerToolOptions) => Promise<ServerCallOutcome>;
  /**
   * Test seam: the clock, in whole ms. Default `Math.floor(performance.now())`:
   * monotonic, so a wall clock that steps cannot stretch or shrink the budget,
   * and floored, because `AbortSignal.timeout` refuses a fractional delay.
   */
  now?: () => number;
}

export function createCallTool(
  deps: CallToolDeps,
): (callerCtx: AgentContext, rawInput: unknown) => Promise<ConnectorCallToolOutput> {
  const callServer = deps.callServer ?? callServerTool;
  return createConnectorCallHandler<ServerCallOutcome>({
    bus: deps.bus,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    logEvent: 'connector_call_tool',
    send: (s) =>
      callServer({ url: s.url, headers: s.headers, tool: s.tool, input: s.input, limits: s.limits }),
  });
}
