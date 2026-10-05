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
//      the cooldown — and the rail's status batch, TASK-787 — still see it;
//      TASK-773), and fire `connectors:tools-discovered` when an `ok` inventory
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
 *
 * TASK-841 — one exception: a server that had NOTHING stored for its sign-in
 * at the window's check, and has one now. Its sign-in finished inside the
 * window, so the answer we hold is stale by definition; one check is made and
 * it opens a new window. Each server buys that at most once while windows
 * chain (the set only shrinks), so one chain of windows holds at most N + 1
 * CHECKS for a connector with N servers, however hard a client pushes — each
 * check lists every server signed in at the time, and each re-check needs a
 * real sign-in to land, which a client cannot manufacture. The price: a call
 * inside the window now reads the vault once per server that had no sign-in
 * at the window's check (local row reads until one lands), where it used to
 * read nothing.
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

/**
 * TASK-773 / TASK-787 — answers this process produced that the store did NOT
 * keep, keyed by (user, agent, connector). Each stands in for the missing row
 * until a write for that key succeeds. ONE holder is shared by describe-tools
 * (which fills it) and `connectors:inventory-status-batch` (which overlays
 * it), so during an inventory-write outage the rail shows the same answer a
 * describe-tools call returns, not the stale stored row. In memory, per
 * process, bounded; oldest goes first when full.
 */
export interface UnstoredInventory {
  get(key: InventoryKey): InventoryRow | undefined;
  keep(key: InventoryKey, row: InventoryRow): void;
  drop(key: InventoryKey): void;
  /** Forget every held answer of a deleted agent (alongside the store purge). */
  dropAgent(agentId: string): void;
}

export function createUnstoredInventory(maxKeys: number = UNSTORED_MAX_KEYS): UnstoredInventory {
  const held = new Map<string, { agentId: string; row: InventoryRow }>();
  const k = (key: InventoryKey) => JSON.stringify([key.userId, key.agentId, key.connectorId]);
  return {
    get: (key) => held.get(k(key))?.row,
    keep(key, row) {
      const id = k(key);
      held.delete(id);
      while (held.size >= maxKeys) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
      held.set(id, { agentId: key.agentId, row });
    },
    drop: (key) => {
      held.delete(k(key));
    },
    dropAgent(agentId) {
      for (const [id, entry] of held) if (entry.agentId === agentId) held.delete(id);
    },
  };
}

/** The held answer when it was checked after the stored one (or nothing is stored). */
function heldIsNewer(held: { checkedAt: Date } | undefined, stored: { checkedAt: Date } | null | undefined): boolean {
  return held !== undefined && (stored == null || held.checkedAt.getTime() > stored.checkedAt.getTime());
}

export interface DescribeToolsDeps {
  bus: BusLike;
  store: InventoryStore;
  /** TASK-787 — shared with the status batch; a private one when omitted. */
  unstored?: UnstoredInventory;
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
  /**
   * (user, connector) → its current window (TASK-756): when a check of its
   * servers last started, and (TASK-841) which servers had nothing stored for
   * their sign-in at that check — `null` while the check is still running, so
   * a concurrent call has nothing to re-check against.
   */
  interface CheckWindow {
    at: number;
    absent: ReadonlySet<string> | null;
  }
  const lastChecked = new Map<string, CheckWindow>();
  function noteChecked(key: string, at: number): CheckWindow {
    lastChecked.delete(key);
    if (lastChecked.size >= CHECK_COOLDOWN_MAX_KEYS) {
      for (const [k, w] of lastChecked) if (at - w.at >= CHECK_COOLDOWN_MS || at < w.at) lastChecked.delete(k);
      while (lastChecked.size >= CHECK_COOLDOWN_MAX_KEYS) {
        const oldest = lastChecked.keys().next().value;
        if (oldest === undefined) break;
        lastChecked.delete(oldest);
      }
    }
    const window: CheckWindow = { at, absent: null };
    lastChecked.set(key, window);
    return window;
  }
  /**
   * The last answer per (user, agent, connector) that the store did NOT keep
   * (TASK-773). It stands in for the missing row, so the TTL and the cooldown
   * see a checked connector whether or not the write landed. Dropped as soon
   * as a write for that key succeeds.
   */
  const unstored = deps.unstored ?? createUnstoredInventory();

  async function headersFor(
    connector: ResolvedConnector,
    server: ResolvedServer,
    ctx: AgentContext,
    userId: string,
  ): Promise<{ headers: Record<string, string>; bearerRef?: string } | 'absent' | 'needs-auth' | 'unavailable'> {
    const headers: Record<string, string> = {};
    // The ref whose token is in `Authorization` (the last OAuth slot wins).
    let bearerRef: string | undefined;
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
        if (!missing) return 'unavailable';
        // TASK-841 — nothing stored at all (never signed in, or signed out),
        // as opposed to a sign-in the authorization server rejected.
        return err instanceof PluginError && err.code === 'credential-not-found' ? 'absent' : 'needs-auth';
      }
      if (typeof value !== 'string' || value.length === 0) return 'needs-auth';
      headers[header] = slot.kind === 'oauth' ? `Bearer ${value}` : value;
      if (slot.kind === 'oauth') bearerRef = ref;
      // A key slot that writes its own `Authorization` replaced the bearer.
      else if (header.toLowerCase() === 'authorization') bearerRef = undefined;
    }
    return { headers, ...(bearerRef !== undefined ? { bearerRef } : {}) };
  }

  /**
   * TASK-817 — the server answered 401 to the OAuth token we sent. The token
   * looked fine by the clock (or the vault would have renewed it already), so
   * the provider revoked or forgot it. Tell the vault (`rejected: true`): the
   * OAuth resolver renews it, or — when the authorization server refuses the
   * renewal too — throws its reconnect error and writes the "sign-in
   * expired" marker the rail reads. Returns the headers to list with once
   * more, or null when there is nothing better to send (the caller keeps the
   * 401's needs-auth). Never throws: the server was already asked, so a
   * credential blip here is not the "nothing was sent" `credential-unavailable`.
   */
  async function renewRefused(
    connectorId: string,
    bearerRef: string,
    headers: Readonly<Record<string, string>>,
    ctx: AgentContext,
    userId: string,
  ): Promise<Record<string, string> | null> {
    let renewed: string;
    try {
      renewed = await deps.bus.call<{ ref: string; userId: string; rejected: true }, string>(
        'credentials:get',
        ctx,
        { ref: bearerRef, userId, rejected: true },
      );
    } catch (err) {
      ctx.logger.info('connector_inventory_token_renew_failed', {
        connectorId,
        code: err instanceof PluginError ? err.code : 'error',
        reconnect: noUsableCredential(err),
      });
      return null;
    }
    if (typeof renewed !== 'string' || renewed.length === 0) return null;
    return { ...headers, Authorization: `Bearer ${renewed}` };
  }

  async function check(
    input: { userId: string; connectorId: string },
    ctx: AgentContext,
    key: InventoryKey,
    previous: InventoryRow | null,
    connector: ResolvedConnector,
  ): Promise<{ out: DescribeToolsOutput; asked: boolean; absent: Set<string> }> {
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
      | {
          server: ResolvedServer;
          ns: string;
          url: string;
          headers: Record<string, string>;
          bearerRef?: string;
        };
    const planned: Planned[] = [];
    // TASK-841 — servers that stopped here because nothing is stored for
    // their sign-in: the only ones a call inside the window reads again.
    const absent = new Set<string>();
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
      if (headers === 'absent') absent.add(server.name);
      planned.push(
        headers === 'needs-auth' || headers === 'absent'
          ? { server, ns, outcome: { kind: 'needs-auth' } }
          : { server, ns, url: server.url, headers: headers.headers, ...(headers.bearerRef !== undefined ? { bearerRef: headers.bearerRef } : {}) },
      );
    }
    // TASK-812 — whether pass 2 sends anything anywhere. A check where every
    // server stopped at pass 1 (nobody signed in, no url, no namespace) asked
    // no third-party server, so the caller releases the cooldown window.
    const asked = planned.some((p) => !('outcome' in p));
    // Pass 2 — the listings.
    for (const p of planned) {
      const ns = p.ns;
      let outcome: ListOutcome = 'outcome' in p ? p.outcome : await list({ url: p.url, headers: p.headers });
      if (
        !('outcome' in p) &&
        outcome.kind === 'needs-auth' &&
        outcome.rejected === true &&
        p.bearerRef !== undefined
      ) {
        // TASK-817 — one renewal, one more listing; never a loop.
        const renewed = await renewRefused(connector.id, p.bearerRef, p.headers, ctx, input.userId);
        ctx.logger.info('connector_inventory_token_refused', {
          connectorId: connector.id,
          renewed: renewed !== null,
        });
        if (renewed !== null) outcome = await list({ url: p.url, headers: renewed });
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
    const row: InventoryRow = { status, tools, fingerprint: fp, checkedAt };
    try {
      await deps.store.put(key, row);
      unstored.drop(key);
    } catch (err) {
      // TASK-773 — the servers WERE asked, so this is a real answer: return it,
      // and hold it in memory so the next call inside the window is answered
      // from it instead of asking again. Logged loudly; never swallowed. Only
      // the error's code/name is logged — a driver message can quote values.
      ctx.logger.error('connector_inventory_store_failed', {
        connectorId: input.connectorId,
        code: err instanceof PluginError ? err.code : err instanceof Error ? err.name : 'error',
      });
      unstored.keep(key, row);
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
    return { out: { status, tools, checkedAt: checkedAt.toISOString() }, asked, absent };
  }

  /**
   * TASK-841 — which of `absent` (servers that had nothing stored for their
   * sign-in at the window's check) have a usable sign-in now. Runs on every
   * call inside the window while that set is non-empty. Reads ONLY those
   * servers: with no row stored, `credentials:get` never reaches a resolver
   * (a local scope walk that ends in `credential-not-found`), and once a
   * sign-in lands it is a fresh token — whereas reading a REJECTED sign-in may ask
   * the authorization server to renew it, which is the kind of call the
   * window exists to bound. A blip reads as "not yet"; never throws.
   */
  async function signedInSince(
    absent: ReadonlySet<string>,
    connector: ResolvedConnector,
    ctx: AgentContext,
    userId: string,
  ): Promise<Set<string>> {
    const found = new Set<string>();
    for (const server of connector.capabilities.mcpServers) {
      if (!absent.has(server.name)) continue;
      const headers = await headersFor(connector, server, ctx, userId).catch(() => 'unavailable' as const);
      if (typeof headers === 'object') found.add(server.name);
    }
    return found;
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
    const kept = unstored.get(key);
    const previous = heldIsNewer(kept, stored) ? kept! : stored;
    const coolKey = JSON.stringify([key.userId, key.connectorId]);
    const at = now().getTime();
    const cached = (row: InventoryRow): DescribeToolsOutput => ({
      status: row.status,
      tools: row.tools,
      checkedAt: row.checkedAt.toISOString(),
    });
    // TASK-841 — set only when this call is the one re-check a sign-in buys
    // inside the window: `before` is the window's set of servers that had no
    // sign-in, `carried` the ones that still have none. The new window this
    // check opens starts from `carried`, so the set only shrinks while
    // windows chain.
    let reCheck: { before: ReadonlySet<string>; carried: ReadonlySet<string> } | null = null;
    if (previous !== null) {
      const ttl = previous.status === 'ok' ? OK_TTL_MS : FAILURE_TTL_MS;
      const age = at - previous.checkedAt.getTime();
      if (input.force !== true && age >= 0 && age < ttl) return cached(previous);
      const last = lastChecked.get(coolKey);
      if (last !== undefined && at >= last.at && at - last.at < CHECK_COOLDOWN_MS) {
        // Forced, or stale: either way not inside the window. What we have is
        // the last real answer — unless a server that had no sign-in at the
        // window's check has one now (TASK-841).
        const before = last.absent;
        const signedIn =
          before !== null && before.size > 0
            ? await signedInSince(before, connector, ctx, input.userId)
            : new Set<string>();
        // Re-read after the await: a concurrent call may have used this
        // window's re-check already. Nothing awaits between here and
        // `noteChecked`, so only one call can.
        if (before === null || signedIn.size === 0 || lastChecked.get(coolKey) !== last) {
          callerCtx.logger.info('connector_inventory_check_cooled_down', { connectorId: input.connectorId });
          return cached(previous);
        }
        reCheck = { before, carried: new Set([...before].filter((s) => !signedIn.has(s))) };
        callerCtx.logger.info('connector_inventory_check_after_sign_in', {
          connectorId: input.connectorId,
          servers: signedIn.size,
        });
      }
    }
    // A check of this same key already running is the answer. With `reCheck`
    // set that is rare but reachable: the window is per (user, connector) and
    // this key is per agent, so a check of ours that outlives its window (a
    // slow listing) can still be running when another agent's later check
    // has opened and closed the current one. The running check reads every
    // credential in its own pass 1; the dropped `reCheck` leaves the window
    // as it was, so the next call can still buy it.
    const pending = inFlight.get(flightKey);
    if (pending !== undefined) return pending;
    const window = noteChecked(coolKey, at);
    const run = check(input, ctx, key, previous, connector)
      .then(({ out, asked, absent }) => {
        if (lastChecked.get(coolKey) !== window) return out;
        if (reCheck !== null) {
          // TASK-841 — a re-check keeps its window whatever it asked: the
          // check before it did ask a server.
          const carried = reCheck.carried;
          window.absent = new Set([...carried].filter((s) => absent.has(s)));
        } else if (!asked) {
          // TASK-812 — same rule as the credential blip below: a check that
          // asked no server must not use up the window. Otherwise a sign-in
          // finished inside it is answered "needs-auth" from the row this
          // credential-only check just wrote, Retry and `?refresh=1` included.
          // Probes stay bounded: the window still holds after any check that
          // listed even one server.
          lastChecked.delete(coolKey);
        } else {
          window.absent = absent;
        }
        return out;
      })
      .catch((err: unknown) => {
        if (lastChecked.get(coolKey) === window) {
          if (reCheck !== null) {
            // TASK-841 — the re-check keeps its window either way (the check
            // before it asked a server). A credential blip throws before any
            // server is listed, so the servers it was for still count as "no
            // sign-in yet" and the next call may try again. Any other failure
            // may have come after a listing: nothing more is bought.
            const blip = err instanceof PluginError && err.code === 'credential-unavailable';
            window.absent = blip ? reCheck.before : reCheck.carried;
          } else if (err instanceof PluginError && err.code === 'credential-unavailable') {
            // A credential blip throws before any server was asked (pass 1), so
            // it must not use up the window — "try again" has to mean it.
            lastChecked.delete(coolKey);
          }
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
 * connector, never a fresh check. See `InventoryStatusBatchInput`. An answer
 * describe-tools holds because the store refused it (TASK-787) overrides an
 * older stored row, so the rail never lags what describe-tools returns.
 */
export function createInventoryStatusBatch(
  store: Pick<InventoryStore, 'statuses'>,
  unstored: Pick<UnstoredInventory, 'get'>,
) {
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
    const byId = new Map(rows.map((r) => [r.connectorId, r]));
    const statuses: InventoryStatusBatchOutput['statuses'] = [];
    for (const connectorId of new Set(connectorIds)) {
      const stored = byId.get(connectorId);
      const held = unstored.get({ userId, agentId: agentId ?? '', connectorId });
      const row = heldIsNewer(held, stored) ? held! : stored;
      if (row !== undefined) statuses.push({ connectorId, status: row.status, checkedAt: row.checkedAt.toISOString() });
    }
    return { statuses };
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
