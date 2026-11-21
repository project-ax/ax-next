// ---------------------------------------------------------------------------
// The shared core of a host-made connector call: the access checks, the
// budget, the catch-all and the one log line (moved out of call-tool.ts).
//
// call-tool.ts's header describes the checks and why they exist; they are
// the same for every hook built on this core. A caller supplies only two
// things: the log event name, and the send. The send gets exactly the
// object the checks produced (`ReadySend`) and runs once, after every check
// passed, with no less than MIN_SEND_BUDGET_MS of the budget left. What it
// answers is returned as is. If it throws, the answer is `unknown`, because
// the call may have landed.
//
// The handler is TOTAL: it never throws, and every failure it answers itself
// is a closed code (`HandlerFailure`). The log line carries codes only:
// `connectorId`, `outcome`, `reason` and the `unexpected` marker.
// ---------------------------------------------------------------------------

import { PluginError, isOwnerlessId, makeAgentContext, type AgentContext } from '@ax/core';
import { CALL_LIMITS } from './call-server-tool.js';
import { connectorHeaders, type ResolvedConnector } from './connector-headers.js';
import { loggableCode } from './loggable-code.js';
import { assertAllowedServerUrl } from './safe-fetch.js';
import { CONNECTOR_TOOL_KEY_RE, ConnectorCallToolInputSchema } from './types.js';

/** With less than this left of the budget, nothing is sent. */
export const MIN_SEND_BUDGET_MS = 15_000;

export interface ConnectorCallBus {
  call<I, O>(hookName: string, ctx: AgentContext, input: I): Promise<O>;
  hasService(hookName: string): boolean;
}

/** Everything the checks established: the one send they allow. */
export interface ReadySend {
  url: string;
  headers: Record<string, string>;
  tool: string;
  input: Record<string, unknown>;
  limits: { budgetMs: number };
}

/** What the handler itself can answer: a check that failed before the send, or the catch-all. */
export type HandlerFailure =
  | { outcome: 'failed'; reason: 'invalid-call' | 'not-connected' | 'needs-auth' | 'unavailable' | 'unreachable' }
  | { outcome: 'unknown'; reason: 'interrupted' };

type HandlerFailedReason = Extract<HandlerFailure, { outcome: 'failed' }>['reason'];

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

const failed = (reason: HandlerFailedReason): HandlerFailure => ({ outcome: 'failed', reason });

/** A lookup that says "not this user's" is an access miss. Anything else is a blip. */
function lookupFailure(err: unknown): HandlerFailure {
  return err instanceof PluginError && (err.code === 'not-found' || err.code === 'forbidden')
    ? failed('not-connected')
    : failed('unavailable');
}

export function createConnectorCallHandler<O extends { outcome: string }>(opts: {
  bus: ConnectorCallBus;
  /**
   * The clock, in whole ms. Default `Math.floor(performance.now())`:
   * monotonic, so a wall clock that steps cannot stretch or shrink the budget,
   * and floored, because `AbortSignal.timeout` refuses a fractional delay.
   */
  now?: () => number;
  logEvent: 'connector_call_tool' | 'connector_call_tool_result';
  send: (s: ReadySend) => Promise<O>;
}): (callerCtx: AgentContext, rawInput: unknown) => Promise<O | HandlerFailure> {
  const now = opts.now ?? (() => Math.floor(performance.now()));

  /** Steps 1-9. `state` is read by the catch-all and the log line. */
  async function attempt(
    callerCtx: AgentContext,
    rawInput: unknown,
    deadline: number,
    state: { sent: boolean; connectorId?: string },
  ): Promise<O | HandlerFailure> {
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
      ({ agent } = await opts.bus.call<{ agentId: string; userId: string }, AgentView>('agents:resolve', ctx, {
        agentId,
        userId,
      }));
    } catch (err) {
      return lookupFailure(err);
    }

    // 5. The namespace is on a connector in the agent's effective set.
    if (!opts.bus.hasService('connectors:list-effective')) return failed('unavailable');
    let effective: ListEffectiveView;
    try {
      effective = await opts.bus.call<
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
      connector = await opts.bus.call<{ userId: string; connectorId: string }, ResolvedConnector>(
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
    const auth = await connectorHeaders(opts.bus, connector, server, ctx, userId);
    if (auth === 'absent' || auth === 'needs-auth') return failed('needs-auth');
    if (auth === 'unavailable') return failed('unavailable');

    // 9. The send has to fit the budget. A clock that answers a non-number
    //    sends nothing, and no clock buys more than the whole budget.
    const remaining = deadline - now();
    if (!Number.isFinite(remaining) || remaining < MIN_SEND_BUDGET_MS) return failed('unavailable');
    const left = Math.min(remaining, CALL_LIMITS.budgetMs);
    state.sent = true;
    return opts.send({ url, headers: auth.headers, tool, input, limits: { budgetMs: left } });
  }

  return async function connectorCall(callerCtx: AgentContext, rawInput: unknown): Promise<O | HandlerFailure> {
    const deadline = now() + CALL_LIMITS.budgetMs;
    const state: { sent: boolean; connectorId?: string } = { sent: false };
    let out: O | HandlerFailure;
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
      callerCtx.logger.info(opts.logEvent, {
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
