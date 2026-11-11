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
// ---------------------------------------------------------------------------

import { PluginError, isOwnerlessId, makeAgentContext, type AgentContext } from '@ax/core';
import {
  CALL_LIMITS,
  callServerTool,
  type CallServerToolOptions,
  type ServerCallOutcome,
} from './call-server-tool.js';
import type { McpClientInfo } from './client-info.js';
import { connectorHeaders, type ResolvedConnector } from './connector-headers.js';
import { loggableCode } from './loggable-code.js';
import { assertAllowedServerUrl } from './safe-fetch.js';
import {
  CONNECTOR_TOOL_KEY_RE,
  ConnectorCallToolInputSchema,
  type ConnectorCallFailedReason,
  type ConnectorCallToolOutput,
} from './types.js';

/** With less than this left of the budget, nothing is sent. */
export const MIN_SEND_BUDGET_MS = 15_000;

export interface CallToolDeps {
  bus: {
    call<I, O>(hookName: string, ctx: AgentContext, input: I): Promise<O>;
    hasService(hookName: string): boolean;
  };
  /** Test seam: the one-shot transport. Default `callServerTool`. */
  callServer?: (opts: CallServerToolOptions) => Promise<ServerCallOutcome>;
  /** Sent as `clientInfo` in `initialize`. Default `DEFAULT_CLIENT_INFO`. */
  clientInfo?: McpClientInfo;
  /**
   * Test seam: the clock, in whole ms. Default `Math.floor(performance.now())`:
   * monotonic, so a wall clock that steps cannot stretch or shrink the budget,
   * and floored, because `AbortSignal.timeout` refuses a fractional delay.
   */
  now?: () => number;
}

// Structural views (I2: no runtime import of @ax/agents / @ax/connectors).
interface AgentView {
  agent: { connectorAttachments?: unknown; connectorExclusions?: unknown };
}
interface ListEffectiveView {
  connectors: Array<{
    summary: { id: string };
    toolNamespaces?: Array<{ toolNamespace?: unknown }>;
  }>;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const failed = (reason: ConnectorCallFailedReason): ConnectorCallToolOutput => ({ outcome: 'failed', reason });

/** A lookup that says "not this user's" is an access miss. Anything else is a blip. */
function lookupFailure(err: unknown): ConnectorCallToolOutput {
  return err instanceof PluginError && (err.code === 'not-found' || err.code === 'forbidden')
    ? failed('not-connected')
    : failed('unavailable');
}

export function createCallTool(deps: CallToolDeps) {
  const callServer = deps.callServer ?? callServerTool;
  const now = deps.now ?? (() => Math.floor(performance.now()));

  /** Steps 1-9. `state` is read by the catch-all and the log line. */
  async function attempt(
    callerCtx: AgentContext,
    rawInput: unknown,
    deadline: number,
    state: { sent: boolean; connectorId?: string },
  ): Promise<ConnectorCallToolOutput> {
    // 1. Shape. The send uses the caller's own `input` object, never zod's
    //    copy: byte-faithful, and no `__proto__` key re-assigned on the way.
    const parsed = ConnectorCallToolInputSchema.safeParse(rawInput);
    if (!parsed.success) return failed('invalid-call');
    const { userId, agentId, toolKey } = parsed.data;
    const input = (rawInput as { input: Record<string, unknown> }).input;
    const key = CONNECTOR_TOOL_KEY_RE.exec(toolKey);
    const ns = key?.[1];
    const tool = key?.[2];
    if (ns === undefined || tool === undefined) return failed('invalid-call');

    // 2. The caller speaks for exactly this user and agent, and both are real.
    if (callerCtx.userId !== userId || callerCtx.agentId !== agentId) return failed('invalid-call');
    if (isOwnerlessId(userId) || isOwnerlessId(agentId)) return failed('not-connected');

    // 3. Reads run as (user, agent), so `credentials:get` walks the scopes a
    //    session of this agent would.
    const ctx = makeAgentContext({ sessionId: 'connector-call', agentId, userId, logger: callerCtx.logger });

    // 4. The agent is still this user's.
    let agent: AgentView['agent'];
    try {
      ({ agent } = await deps.bus.call<{ agentId: string; userId: string }, AgentView>('agents:resolve', ctx, {
        agentId,
        userId,
      }));
    } catch (err) {
      return lookupFailure(err);
    }

    // 5. The namespace is on a connector in the agent's effective set.
    if (!deps.bus.hasService('connectors:list-effective')) return failed('unavailable');
    let effective: ListEffectiveView;
    try {
      effective = await deps.bus.call<
        { userId: string; attachmentIds: string[]; exclusions: string[] },
        ListEffectiveView
      >('connectors:list-effective', ctx, {
        userId,
        attachmentIds: stringList(agent.connectorAttachments),
        exclusions: stringList(agent.connectorExclusions),
      });
    } catch {
      return failed('unavailable');
    }
    const entry = effective.connectors.find((c) => (c.toolNamespaces ?? []).some((t) => t?.toolNamespace === ns));
    if (entry === undefined) return failed('not-connected');
    const connectorId = entry.summary.id;
    state.connectorId = connectorId;

    // 6. The connector still resolves, still carries the namespace, and the
    //    namespace names an http server with a url.
    let connector: ResolvedConnector;
    try {
      connector = await deps.bus.call<{ userId: string; connectorId: string }, ResolvedConnector>(
        'connectors:resolve',
        ctx,
        { userId, connectorId },
      );
    } catch (err) {
      return lookupFailure(err);
    }
    const serverName = connector.toolNamespaces?.find((t) => t.toolNamespace === ns)?.server;
    const server =
      serverName === undefined ? undefined : connector.capabilities.mcpServers.find((s) => s.name === serverName);
    if (server === undefined || server.transport !== 'http' || server.url === undefined || server.url.length === 0) {
      return failed('not-connected');
    }
    const url = server.url;

    // 7. Reach parity with the sandbox: the inventory's URL rules, no
    //    fragment (the session fold binds no credential to one), and the host
    //    in `allowedHosts`, matched the way the session proxy matches it
    //    (exact, IPv6 brackets stripped).
    let target: URL;
    try {
      target = assertAllowedServerUrl(url);
    } catch {
      return failed('unreachable');
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (target.hash !== '' || !(connector.capabilities.allowedHosts ?? []).includes(host)) {
      return failed('unreachable');
    }

    // 8. The connector's own credential plan, as (user, agent).
    const auth = await connectorHeaders(deps.bus, connector, server, ctx, userId);
    if (auth === 'absent' || auth === 'needs-auth') return failed('needs-auth');
    if (auth === 'unavailable') return failed('unavailable');

    // 9. The send has to fit the budget. A clock that answers a non-number
    //    sends nothing, and no clock buys more than the whole budget.
    const remaining = deadline - now();
    if (!Number.isFinite(remaining) || remaining < MIN_SEND_BUDGET_MS) return failed('unavailable');
    const left = Math.min(remaining, CALL_LIMITS.budgetMs);
    state.sent = true;
    return callServer({
      url,
      headers: auth.headers,
      tool,
      input,
      limits: { budgetMs: left },
      ...(deps.clientInfo !== undefined ? { clientInfo: deps.clientInfo } : {}),
    });
  }

  return async function callTool(callerCtx: AgentContext, rawInput: unknown): Promise<ConnectorCallToolOutput> {
    const deadline = now() + CALL_LIMITS.budgetMs;
    const state: { sent: boolean; connectorId?: string } = { sent: false };
    let out: ConnectorCallToolOutput;
    // Set only by the catch-all, so its answer cannot pass for a genuine one.
    let unexpected: { code?: string } | null = null;
    try {
      out = await attempt(callerCtx, rawInput, deadline, state);
    } catch (err) {
      // 10. Something we did not foresee. Before the send nothing went out;
      //     after it, the call may have landed.
      out = state.sent ? { outcome: 'unknown', reason: 'interrupted' } : failed('unavailable');
      const code = loggableCode(err);
      unexpected = code !== undefined ? { code } : {};
    }
    try {
      callerCtx.logger.info('connector_call_tool', {
        ...(state.connectorId !== undefined ? { connectorId: state.connectorId } : {}),
        outcome: out.outcome,
        ...('reason' in out ? { reason: out.reason } : {}),
        ...(unexpected !== null ? { unexpected: true, ...unexpected } : {}),
      });
    } catch {
      // A log line must never change the answer.
    }
    return out;
  };
}
