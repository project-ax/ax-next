// ---------------------------------------------------------------------------
// `connectors:describe-tools` — host-side tool inventory for one connector.
//
//   1. Validate input; if an agent is named, `agents:resolve` it for this user
//      (the agent selects a credential scope, so it must be the caller's).
//   2. `connectors:resolve {userId, connectorId}` — visibility is enforced
//      there; a connector the user can't see throws `not-found` through us.
//   3. Cache: (user, agent, connector) row younger than its TTL → return it,
//      unless `force`.
//   4. For each http server: build auth headers from the connector's
//      credential plan via `credentials:get` (the same refs the session's
//      credential-proxy spends), then one guarded `tools/list`.
//      stdio servers can't be listed host-side → `unknown`.
//   5. Store, and fire `connectors:tools-discovered` when an `ok` inventory
//      differs from the last `ok` one.
//
// Secrets: header values live only in the `headers` object handed to the
// transport for the duration of one listing. They are never logged, stored,
// or returned.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { listServerTools, type ListOutcome, type ListServerToolsOptions } from './list-tools.js';
import type { InventoryKey, InventoryRow, InventoryStore } from './store.js';
import {
  DescribeToolsInputSchema,
  type DescribeToolsOutput,
  type InventoryStatus,
  type InventoryTool,
  type ToolsDiscoveredEvent,
} from './types.js';

const PLUGIN_NAME = '@ax/mcp-client';

/** A fresh `ok` inventory is reused for 15 minutes. */
export const OK_TTL_MS = 15 * 60 * 1000;
/** A failed check is reused for 1 minute — long enough to absorb a page of
 *  renders, short enough that signing in shows up without a forced Retry. */
export const FAILURE_TTL_MS = 60 * 1000;

// Local structural view of `connectors:resolve` output (I2: no runtime import
// of @ax/connectors; only the fields this hook reads).
interface ResolvedSlot {
  slot: string;
  kind: 'api-key' | 'oauth';
  headerName?: string;
  server?: string;
}
interface ResolvedServer {
  name: string;
  transport: 'stdio' | 'http';
  url?: string;
}
interface ResolvedConnector {
  id: string;
  capabilities: { credentials: ResolvedSlot[]; mcpServers: ResolvedServer[] };
  credentialPlan: Array<{ slot: string; ref: string }>;
  toolNamespaces?: Array<{ server: string; toolNamespace: string }>;
}

export interface BusLike {
  call<I, O>(hookName: string, ctx: AgentContext, input: I): Promise<O>;
  fire(hookName: string, ctx: AgentContext, payload: unknown): Promise<unknown>;
}

export interface DescribeToolsDeps {
  bus: BusLike;
  store: InventoryStore;
  now?: () => Date;
  /** Test seam: replace the network listing. */
  listTools?: (opts: ListServerToolsOptions) => Promise<ListOutcome>;
}

/** Same shape the claude-sdk runner lifts and @ax/connectors mints. */
const TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;

function fingerprint(tools: InventoryTool[]): string {
  const sorted = [...tools].sort((a, b) => (a.toolKey < b.toolKey ? -1 : a.toolKey > b.toolKey ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

const SEVERITY: Record<InventoryStatus, number> = { ok: 0, unknown: 0, unreachable: 1, 'needs-auth': 2 };

export function createDescribeTools(deps: DescribeToolsDeps) {
  const now = deps.now ?? (() => new Date());
  const list = deps.listTools ?? listServerTools;
  const inFlight = new Map<string, Promise<DescribeToolsOutput>>();

  async function headersFor(
    connector: ResolvedConnector,
    server: ResolvedServer,
    ctx: AgentContext,
    userId: string,
  ): Promise<Record<string, string> | 'needs-auth'> {
    const headers: Record<string, string> = {};
    for (const slot of connector.capabilities.credentials) {
      if (slot.server !== server.name) continue;
      const header = slot.kind === 'oauth' ? 'Authorization' : slot.headerName;
      if (header === undefined || header.length === 0) continue;
      const ref = connector.credentialPlan.find((p) => p.slot === slot.slot)?.ref;
      if (ref === undefined) return 'needs-auth';
      let value: string;
      try {
        value = await deps.bus.call<{ ref: string; userId: string }, string>('credentials:get', ctx, {
          ref,
          userId,
        });
      } catch (err) {
        ctx.logger.info('connector_inventory_credential_unavailable', {
          connectorId: connector.id,
          code: err instanceof PluginError ? err.code : 'error',
        });
        return 'needs-auth';
      }
      if (typeof value !== 'string' || value.length === 0) return 'needs-auth';
      headers[header] = slot.kind === 'oauth' ? `Bearer ${value}` : value;
    }
    return headers;
  }

  async function check(
    input: { userId: string; connectorId: string },
    ctx: AgentContext,
    key: InventoryKey,
    previous: InventoryRow | null,
    connector: ResolvedConnector,
  ): Promise<DescribeToolsOutput> {
    const nsByServer = new Map((connector.toolNamespaces ?? []).map((t) => [t.server, t.toolNamespace]));

    let status: InventoryStatus = 'unknown';
    const tools: InventoryTool[] = [];
    const reasons: string[] = [];
    let dropped = 0;
    let anyHttp = false;
    for (const server of connector.capabilities.mcpServers) {
      if (server.transport !== 'http') continue; // stdio: not listable host-side
      anyHttp = true;
      const ns = nsByServer.get(server.name);
      let outcome: ListOutcome;
      if (ns === undefined || !TOOL_NAMESPACE_RE.test(ns)) {
        // No canonical key to attach — fail closed, same as the orchestrator
        // drops an un-namespaced server.
        outcome = { kind: 'unreachable', reason: 'no-namespace' };
      } else if (server.url === undefined || server.url.length === 0) {
        outcome = { kind: 'unreachable', reason: 'no-url' };
      } else {
        const headers = await headersFor(connector, server, ctx, input.userId);
        outcome =
          headers === 'needs-auth'
            ? { kind: 'needs-auth' }
            : await list({ url: server.url, headers });
      }
      const serverStatus: InventoryStatus = outcome.kind;
      if (outcome.kind === 'ok') {
        dropped += outcome.dropped;
        for (const t of outcome.tools) tools.push({ ...t, toolKey: `mcp.${ns}.${t.name}` });
      } else if (outcome.kind === 'unreachable') {
        reasons.push(outcome.reason);
      }
      if (status === 'unknown' || SEVERITY[serverStatus] > SEVERITY[status]) status = serverStatus;
    }
    if (!anyHttp) status = 'unknown';

    const checkedAt = now();
    const fp = status === 'ok' ? fingerprint(tools) : (previous?.fingerprint ?? '');
    await deps.store.put(key, { status, tools, fingerprint: fp, checkedAt });
    ctx.logger.info('connector_inventory_checked', {
      connectorId: input.connectorId,
      status,
      toolCount: tools.length,
      dropped,
      ...(reasons.length > 0 ? { reasons } : {}),
    });
    if (status === 'ok' && fp !== previous?.fingerprint) {
      const event: ToolsDiscoveredEvent = { connectorId: input.connectorId, tools };
      await deps.bus.fire('connectors:tools-discovered', ctx, event);
    }
    return { status, tools, checkedAt: checkedAt.toISOString() };
  }

  return async function describeTools(
    callerCtx: AgentContext,
    rawInput: unknown,
  ): Promise<DescribeToolsOutput> {
    const parsed = DescribeToolsInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'connectors:describe-tools',
        message: `invalid describe-tools input: ${parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`,
      });
    }
    const input = parsed.data;
    // Downstream calls run as (user, agent) so credentials:get walks the same
    // user → agent → global scopes a session of that agent would.
    const ctx = makeAgentContext({
      sessionId: 'connector-inventory',
      agentId: input.agentId ?? '',
      userId: input.userId,
      logger: callerCtx.logger,
    });
    if (input.agentId !== undefined) {
      await deps.bus.call('agents:resolve', ctx, { agentId: input.agentId, userId: input.userId });
    }
    const key: InventoryKey = {
      userId: input.userId,
      agentId: input.agentId ?? '',
      connectorId: input.connectorId,
    };
    // Resolve BEFORE reading the cache: visibility is enforced there, and a
    // cached row must never outlive the caller's access to the connector.
    const connector = await deps.bus.call<{ userId: string; connectorId: string }, ResolvedConnector>(
      'connectors:resolve',
      ctx,
      { userId: input.userId, connectorId: input.connectorId },
    );
    const previous = await deps.store.get(key);
    if (previous !== null && input.force !== true) {
      const ttl = previous.status === 'ok' ? OK_TTL_MS : FAILURE_TTL_MS;
      const age = now().getTime() - previous.checkedAt.getTime();
      if (age >= 0 && age < ttl) {
        return {
          status: previous.status,
          tools: previous.tools,
          checkedAt: previous.checkedAt.toISOString(),
        };
      }
    }
    const flightKey = JSON.stringify([key.userId, key.agentId, key.connectorId]);
    const pending = inFlight.get(flightKey);
    if (pending !== undefined) return pending;
    const run = check(input, ctx, key, previous, connector).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, run);
    return run;
  };
}
