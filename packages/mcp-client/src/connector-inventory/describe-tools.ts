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
//      credential-proxy spends), then one guarded `tools/list`. No usable
//      sign-in → `needs-auth`; a credential that could not be READ (a vault
//      blip) → the call throws `credential-unavailable` and stores nothing
//      (TASK-756), so a blip is never reported as a sign-in problem.
//   5. Store (a failed write is logged and the answer held in memory, so
//      the cooldown still sees it — TASK-773), and fire `connectors:tools-discovered` when an `ok` inventory
//      differs from the last `ok` one.
//
// Secrets: header values live only in the per-server `headers` objects of
// one describe call — read for every server first (so a credential blip
// stops the call before anything is sent; TASK-756), then handed to the
// transport for each listing. They are never logged, stored, or returned,
// and are dropped when the call returns.

// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { listServerTools, type ListOutcome, type ListServerToolsOptions } from './list-tools.js';
import type { InventoryKey, InventoryRow, InventoryStore } from './store.js';
import {
  DescribeToolsInputSchema,
  InventoryStatusBatchInputSchema,
  InventoryToolTitlesInputSchema,
  type InventoryStatusBatchOutput,
  type InventoryToolTitlesOutput,
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
/**
 * TASK-756 — at most one check of a connector's servers per window per
 * (user, connector), whichever route asked and whichever agent it was for.
 * Inside the window a call is answered from the row it already has, fresh or
 * stale, `force` or not. Only a (user, agent, connector) that has NEVER been
 * checked is checked inside a window: there is nothing to answer it with, and
 * that happens once per agent, ever (rows persist; an answer the store
 * refused to keep is held in memory instead, TASK-773). This is the one
 * chokepoint every check passes through (Retry, Reconnect, `?refresh=1`, an
 * expired cache), so no caller can probe a third-party server faster. Per
 * process: N replicas allow N per window, a small fixed multiple that never
 * grows with how hard a client pushes.
 */
export const CHECK_COOLDOWN_MS = 30 * 1000;
const CHECK_COOLDOWN_MAX_KEYS = 1_000;
/**
 * TASK-773 — bound on answers held in memory because the store refused them.
 * The cooldown above reads the stored row ("rows persist"); when the write
 * fails there is no row, so without this a never-stored (user, agent,
 * connector) would be checked on every call. Oldest goes first when full.
 */
const UNSTORED_MAX_KEYS = 1_000;

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
  transport: 'http';
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

/**
 * TASK-756 — a credential failure that means "there is no usable sign-in":
 * nothing stored for the ref, or an OAuth sign-in the authorization server
 * rejected. The reconnect error crosses the bus twice (resolver →
 * credentials:get → here) and is wrapped on the way, so it is recognised by
 * name on the error or its cause, never by importing @ax/mcp-oauth (I2) —
 * the same rule channel-web's `credentialMissing` applies. Anything else (a
 * vault/storage blip, a refresh the provider could not answer right now) says
 * nothing about the sign-in, so it must not be reported as one.
 */
function noUsableCredential(err: unknown): boolean {
  if (err instanceof PluginError && err.code === 'credential-not-found') return true;
  const named = (e: unknown): boolean => e instanceof Error && e.name === 'NeedsReconnectError';
  return named(err) || named((err as { cause?: unknown } | null)?.cause);
}

export function createDescribeTools(deps: DescribeToolsDeps) {
  const now = deps.now ?? (() => new Date());
  const list = deps.listTools ?? listServerTools;
  const inFlight = new Map<string, Promise<DescribeToolsOutput>>();
  /** (user, connector) → when a check of its servers last started (TASK-756). */
  const lastChecked = new Map<string, number>();
  function noteChecked(key: string, at: number): void {
    lastChecked.delete(key);
    if (lastChecked.size >= CHECK_COOLDOWN_MAX_KEYS) {
      for (const [k, t] of lastChecked) if (at - t >= CHECK_COOLDOWN_MS || at < t) lastChecked.delete(k);
      while (lastChecked.size >= CHECK_COOLDOWN_MAX_KEYS) {
        const oldest = lastChecked.keys().next().value;
        if (oldest === undefined) break;
        lastChecked.delete(oldest);
      }
    }
    lastChecked.set(key, at);
  }
  /**
   * (user, agent, connector) → the last answer this process produced that the
   * store did NOT keep (TASK-773). It stands in for the missing row, so the
   * TTL and the cooldown see a checked connector whether or not the write
   * landed. Dropped as soon as a write for that key succeeds.
   */
  const unstored = new Map<string, InventoryRow>();
  function keepUnstored(key: string, row: InventoryRow): void {
    unstored.delete(key);
    while (unstored.size >= UNSTORED_MAX_KEYS) {
      const oldest = unstored.keys().next().value;
      if (oldest === undefined) break;
      unstored.delete(oldest);
    }
    unstored.set(key, row);
  }

  async function headersFor(
    connector: ResolvedConnector,
    server: ResolvedServer,
    ctx: AgentContext,
    userId: string,
  ): Promise<Record<string, string> | 'needs-auth' | 'unavailable'> {
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
        const missing = noUsableCredential(err);
        ctx.logger.info('connector_inventory_credential_unavailable', {
          connectorId: connector.id,
          code: err instanceof PluginError ? err.code : 'error',
          transient: !missing,
        });
        return missing ? 'needs-auth' : 'unavailable';
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
    flightKey: string,
    previous: InventoryRow | null,
    connector: ResolvedConnector,
  ): Promise<{ out: DescribeToolsOutput; asked: boolean }> {
    const nsByServer = new Map((connector.toolNamespaces ?? []).map((t) => [t.server, t.toolNamespace]));

    let status: InventoryStatus = 'unknown';
    const tools: InventoryTool[] = [];
    const reasons: string[] = [];
    let dropped = 0;
    let anyHttp = false;
    // Pass 1 — read EVERY server's credential before any network call. A
    // credential that could not be read (TASK-756) then throws while nothing
    // has been sent anywhere, which is what lets callers treat
    // `credential-unavailable` as "no server was asked" (the Retry cooldown
    // forgets such an attempt; a multi-server connector must not be able to
    // probe server A and then blip on server B to dodge it).
    type Planned =
      | { server: ResolvedServer; ns: string; outcome: ListOutcome }
      | { server: ResolvedServer; ns: string; url: string; headers: Record<string, string> };
    const planned: Planned[] = [];
    for (const server of connector.capabilities.mcpServers) {
      anyHttp = true;
      const ns = nsByServer.get(server.name) ?? '';
      if (!TOOL_NAMESPACE_RE.test(ns)) {
        // No canonical key to attach — fail closed, same as the orchestrator
        // drops an un-namespaced server.
        planned.push({ server, ns, outcome: { kind: 'unreachable', reason: 'no-namespace' } });
        continue;
      }
      if (server.url === undefined || server.url.length === 0) {
        planned.push({ server, ns, outcome: { kind: 'unreachable', reason: 'no-url' } });
        continue;
      }
      const headers = await headersFor(connector, server, ctx, input.userId);
      if (headers === 'unavailable') {
        // TASK-756 — the credential could not be READ right now. That is not
        // "needs sign-in": answering needs-auth would misreport a blip, and
        // storing anything would overwrite the last real answer. So the check
        // did not happen — say so, store nothing, and let the caller retry.
        throw new PluginError({
          code: 'credential-unavailable',
          plugin: PLUGIN_NAME,
          hookName: 'connectors:describe-tools',
          message: 'credential temporarily unavailable; try again',
        });
      }
      planned.push(
        headers === 'needs-auth'
          ? { server, ns, outcome: { kind: 'needs-auth' } }
          : { server, ns, url: server.url, headers },
      );
    }
    // TASK-812 — whether pass 2 sends anything anywhere. A check where every
    // server stopped at pass 1 (nobody signed in, no url, no namespace) asked
    // no third-party server, so the caller releases the cooldown window.
    const asked = planned.some((p) => !('outcome' in p));
    // Pass 2 — the listings.
    for (const p of planned) {
      const ns = p.ns;
      const outcome: ListOutcome = 'outcome' in p ? p.outcome : await list({ url: p.url, headers: p.headers });
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
    const row: InventoryRow = { status, tools, fingerprint: fp, checkedAt };
    try {
      await deps.store.put(key, row);
      unstored.delete(flightKey);
    } catch (err) {
      // TASK-773 — the servers WERE asked, so this is a real answer: return it,
      // and hold it in memory so the next call inside the window is answered
      // from it instead of asking again. Logged loudly; never swallowed. Only
      // the error's code/name is logged — a driver message can quote values.
      ctx.logger.error('connector_inventory_store_failed', {
        connectorId: input.connectorId,
        code: err instanceof PluginError ? err.code : err instanceof Error ? err.name : 'error',
      });
      keepUnstored(flightKey, row);
    }
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
    return { out: { status, tools, checkedAt: checkedAt.toISOString() }, asked };
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
    const flightKey = JSON.stringify([key.userId, key.agentId, key.connectorId]);
    // TASK-773 — the newest real answer: the stored row, or the one the store
    // refused to keep (whichever was checked later).
    const stored = await deps.store.get(key);
    const kept = unstored.get(flightKey);
    const previous =
      kept !== undefined && (stored === null || kept.checkedAt.getTime() > stored.checkedAt.getTime())
        ? kept
        : stored;
    const coolKey = JSON.stringify([key.userId, key.connectorId]);
    const at = now().getTime();
    const cached = (row: InventoryRow): DescribeToolsOutput => ({
      status: row.status,
      tools: row.tools,
      checkedAt: row.checkedAt.toISOString(),
    });
    if (previous !== null) {
      const ttl = previous.status === 'ok' ? OK_TTL_MS : FAILURE_TTL_MS;
      const age = at - previous.checkedAt.getTime();
      if (input.force !== true && age >= 0 && age < ttl) return cached(previous);
      const last = lastChecked.get(coolKey);
      if (last !== undefined && at >= last && at - last < CHECK_COOLDOWN_MS) {
        // Forced, or stale: either way not inside the window. What we have is
        // the last real answer.
        callerCtx.logger.info('connector_inventory_check_cooled_down', { connectorId: input.connectorId });
        return cached(previous);
      }
    }
    const pending = inFlight.get(flightKey);
    if (pending !== undefined) return pending;
    noteChecked(coolKey, at);
    const run = check(input, ctx, key, flightKey, previous, connector)
      .then(({ out, asked }) => {
        // TASK-812 — same rule as the credential blip below: a check that
        // asked no server must not use up the window. Otherwise a sign-in
        // finished inside it is answered "needs-auth" from the row this
        // credential-only check just wrote, Retry and `?refresh=1` included.
        // Probes stay bounded: the window still holds after any check that
        // listed even one server.
        if (!asked && lastChecked.get(coolKey) === at) lastChecked.delete(coolKey);
        return out;
      })
      .catch((err: unknown) => {
        // A credential blip throws before any server was asked (pass 1), so
        // it must not use up the window — "try again" has to mean it.
        if (
          err instanceof PluginError &&
          err.code === 'credential-unavailable' &&
          lastChecked.get(coolKey) === at
        ) {
          lastChecked.delete(coolKey);
        }
        throw err;
      })
      .finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, run);
    return run;
  };
}

/**
 * `connectors:inventory-status-batch` (TASK-741) — the cached status of each
 * connector, never a fresh check. See `InventoryStatusBatchInput`.
 */
export function createInventoryStatusBatch(store: Pick<InventoryStore, 'statuses'>) {
  return async function inventoryStatusBatch(
    _ctx: AgentContext,
    rawInput: unknown,
  ): Promise<InventoryStatusBatchOutput> {
    const parsed = InventoryStatusBatchInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'connectors:inventory-status-batch',
        message: 'invalid inventory-status-batch input',
      });
    }
    const { userId, agentId, connectorIds } = parsed.data;
    const rows = await store.statuses(userId, agentId ?? '', connectorIds);
    return {
      statuses: rows.map((r) => ({
        connectorId: r.connectorId,
        status: r.status,
        checkedAt: r.checkedAt.toISOString(),
      })),
    };
  };
}

/**
 * Bound on one cached title in the answer, in code points. Renderers clamp far
 * tighter (a step row allows 48); this only keeps one hostile server from
 * inflating every label read.
 */
const TOOL_TITLE_WIRE_MAX = 200;

/**
 * `connectors:inventory-tool-titles` (TASK-753) — the cached server title of
 * each tool, never a fresh check. See `InventoryToolTitlesInput`.
 */
export function createInventoryToolTitles(store: Pick<InventoryStore, 'okInventories'>) {
  return async function inventoryToolTitles(
    _ctx: AgentContext,
    rawInput: unknown,
  ): Promise<InventoryToolTitlesOutput> {
    const parsed = InventoryToolTitlesInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: 'connectors:inventory-tool-titles',
        message: 'invalid inventory-tool-titles input',
      });
    }
    const { userId, connectorIds } = parsed.data;
    const rows = await store.okInventories(userId, connectorIds);
    // Rows arrive newest check first, so the newest REAL title for a toolKey
    // wins (a row whose server sent no title is skipped, so an older real
    // title beats none) — the same tool under two agents' rows is one entry.
    const seen = new Set<string>();
    const titles: InventoryToolTitlesOutput['titles'] = [];
    for (const row of rows) {
      for (const tool of row.tools) {
        if (tool === null || typeof tool !== 'object') continue;
        const { toolKey, title, name } = tool as Partial<InventoryTool>;
        if (typeof toolKey !== 'string' || typeof title !== 'string') continue;
        if (title === name || title.trim().length === 0) continue;
        const key = `${row.connectorId}\u0000${toolKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const points = [...title];
        titles.push({
          connectorId: row.connectorId,
          toolKey,
          title: points.length > TOOL_TITLE_WIRE_MAX ? points.slice(0, TOOL_TITLE_WIRE_MAX).join('') : title,
        });
      }
    }
    return { titles };
  };
}
