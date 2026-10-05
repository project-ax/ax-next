// ---------------------------------------------------------------------------
// `connectors:auth-failure-reported` subscriber (TASK-842).
//
// A chat runner saw a connector's MCP server refuse it: the agent SDK called
// the server `needs-auth` / `failed` at session start, or one of its tools
// came back as an error mid-turn. Before this, nothing on the host heard
// about it, so a sign-in the provider had revoked stayed "Connected" on the
// rail until someone opened the rail or the details view.
//
// The report is a HINT from an untrusted sender. We never mark anything on
// its strength. We re-check the connector ourselves with the same
// `connectors:describe-tools {force: true}` the rail's Retry runs:
//
//   - a 401 to the stored OAuth token goes through TASK-817's path
//     (`credentials:get {rejected: true}` → renew → a refused renewal writes
//     the needs-reconnect marker on the token's OWNER, which only the vault
//     walk knows), and the inventory row becomes `needs-auth`;
//   - a server that answers fine stays `ok` (a lying or confused runner
//     changes nothing);
//   - every check passes describe-tools' per-(user, connector) cooldown, so a
//     flood of reports costs at most one check per connector per window,
//     exactly what a flood of rail Retries would.
//
// Which connector a namespace belongs to is the host's answer, never the
// runner's: we map the reported namespaces through the session agent's
// effective connector set (`connectors:list-effective`, the same union the
// orchestrator folds into the session). A namespace outside that set is
// dropped and counted in a log line, so a runner cannot point us at a
// connector its agent does not have.
//
// Never throws: a subscriber failure must not reach the IPC dispatcher, and
// every failure here is a missed refresh, not a wrong answer.
// ---------------------------------------------------------------------------

import { isOwnerlessId, makeAgentContext, type AgentContext } from '@ax/core';
import type { DescribeToolsOutput } from './types.js';

/** Same shape the runner reports and @ax/connectors mints. */
const TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;
/** Matches the wire cap; a runner never has more connector servers than this. */
const MAX_REPORTED = 32;
const REPORTED_STATUSES = new Set(['needs-auth', 'failed', 'tool-error']);

export interface AuthFailureRecheckBus {
  call<I, O>(hookName: string, ctx: AgentContext, input: I): Promise<O>;
  hasService(hookName: string): boolean;
}

export interface AuthFailureRecheckDeps {
  bus: AuthFailureRecheckBus;
  /** The plugin's own describe-tools (called directly, not over the bus). */
  describeTools: (ctx: AgentContext, input: unknown) => Promise<DescribeToolsOutput>;
}

// Structural views (I2 — no runtime import of @ax/agents / @ax/connectors).
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

/** The reported namespaces, re-validated (the subscriber is reachable from any firer). */
function reportedNamespaces(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const servers = (payload as { servers?: unknown } | null | undefined)?.servers;
  if (!Array.isArray(servers)) return out;
  for (const s of servers.slice(0, MAX_REPORTED)) {
    const ns = (s as { toolNamespace?: unknown } | null)?.toolNamespace;
    const status = (s as { status?: unknown } | null)?.status;
    if (typeof ns !== 'string' || !TOOL_NAMESPACE_RE.test(ns)) continue;
    if (typeof status !== 'string' || !REPORTED_STATUSES.has(status)) continue;
    if (!out.has(ns)) out.set(ns, status);
  }
  return out;
}

export function createAuthFailureRecheck(deps: AuthFailureRecheckDeps) {
  return async function onAuthFailureReported(ctx: AgentContext, payload: unknown): Promise<undefined> {
    try {
      const reported = reportedNamespaces(payload);
      if (reported.size === 0) {
        ctx.logger.info('connector_auth_report_skipped', { reason: 'no valid namespaces' });
        return undefined;
      }
      // A session with no owner has no connectors to re-check.
      if (isOwnerlessId(ctx.userId) || isOwnerlessId(ctx.agentId)) {
        ctx.logger.info('connector_auth_report_skipped', { reason: 'session has no user and agent' });
        return undefined;
      }
      if (!deps.bus.hasService('connectors:list-effective')) {
        ctx.logger.info('connector_auth_report_skipped', { reason: 'connectors:list-effective not loaded' });
        return undefined;
      }
      const { userId, agentId } = ctx;
      const callCtx = makeAgentContext({
        sessionId: ctx.sessionId,
        agentId,
        userId,
        logger: ctx.logger,
      });
      // `agents:resolve` is also the ACL: the session's agent must be the
      // session user's (it always is for a real session; a throw ends here).
      const { agent } = await deps.bus.call<{ agentId: string; userId: string }, AgentView>(
        'agents:resolve',
        callCtx,
        { agentId, userId },
      );
      const { connectors } = await deps.bus.call<
        { userId: string; attachmentIds: string[]; exclusions: string[] },
        ListEffectiveView
      >('connectors:list-effective', callCtx, {
        userId,
        attachmentIds: stringList(agent.connectorAttachments),
        exclusions: stringList(agent.connectorExclusions),
      });

      const matched = new Map<string, string[]>();
      const seen = new Set<string>();
      for (const c of connectors) {
        for (const t of c.toolNamespaces ?? []) {
          const ns = t?.toolNamespace;
          if (typeof ns !== 'string' || !reported.has(ns)) continue;
          seen.add(ns);
          const list = matched.get(c.summary.id) ?? [];
          list.push(reported.get(ns) as string);
          matched.set(c.summary.id, list);
        }
      }
      const unmatched = reported.size - seen.size;
      if (unmatched > 0) {
        // Not this agent's connector (or one a skill brought in, which the
        // effective set does not carry). Counted, never acted on.
        ctx.logger.info('connector_auth_report_unmatched', { unmatched });
      }

      // One at a time: a session has a handful of connectors, and each check
      // may reach a third-party server.
      for (const [connectorId, statuses] of matched) {
        try {
          const out = await deps.describeTools(callCtx, { userId, agentId, connectorId, force: true });
          ctx.logger.info('connector_auth_report_rechecked', {
            connectorId,
            reported: [...new Set(statuses)],
            status: out.status,
          });
        } catch (err) {
          ctx.logger.warn('connector_auth_report_recheck_failed', {
            connectorId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      ctx.logger.warn('connector_auth_report_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  };
}
