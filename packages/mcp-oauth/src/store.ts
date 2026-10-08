import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { McpOAuthDatabase } from './migrations.js';
import type { ClientRegistration, PendingAuthorization } from './types.js';

export interface McpOAuthStore {
  /**
   * LEGACY fallback, read-only: the shared client row that tokens/pending rows
   * written before TASK-696 index by `clientKey`. Nothing writes it any more — a
   * token now carries the client it was issued to (see `McpOAuthTokenBlob`), so a
   * new connect can never overwrite the client an older token depends on.
   */
  getClient(clientKey: string): Promise<ClientRegistration | null>;
  /**
   * `createdAtOverride` (epoch ms) is a TEST SEAM for deterministic TTL tests;
   * omit in production (the DB column defaults to NOW()).
   */
  putPending(p: PendingAuthorization, createdAtOverride?: number): Promise<void>;
  /**
   * Read-only peek — returns the row IFF present, WITHOUT deleting it and
   * WITHOUT a TTL filter. Used by the callback to check the CSRF user-binding
   * BEFORE consuming, so a third party who learns a victim's in-flight `state`
   * can't burn it (DoS-cancel the victim's flow) merely by hitting the callback.
   * The atomic single-use + TTL gate remains `consumePending`.
   */
  getPending(state: string): Promise<PendingAuthorization | null>;
  /**
   * Atomically delete + return the row IFF present and `now - createdAt <= ttlMs`.
   * Single-use: a second call for the same state returns null.
   */
  consumePending(
    state: string,
    now: number,
    ttlMs: number,
  ): Promise<PendingAuthorization | null>;
  /**
   * Delete every pending row created before `olderThanMs` (epoch ms). A row past
   * the TTL can never be redeemed, and it may hold a confidential client's secret
   * in plaintext, so an abandoned authorization must not keep it around forever.
   * Callers pass `now - pendingTtlMs`.
   */
  purgeExpiredPending(olderThanMs: number): Promise<void>;
  /**
   * Delete EVERY pending authorization started for `agentId`, whoever started it
   * (TASK-718). Backs the `agents:deleted` subscriber: the row is a handshake
   * that can no longer complete (the callback resolves the agent first), and it
   * may hold a confidential client's secret in plaintext, so it must not outlive
   * the agent. Keyed on `agent_id` ALONE — a team agent's connect can be started
   * by several people.
   *
   * Touches `mcp_oauth_v1_pending` and `mcp_oauth_v1_needs_reconnect_agent`
   * (the agent's reconnect markers go with it; `deleted` counts pending rows,
   * `markers` counts marker rows), and `mcp_oauth_v1_identity_scope_refused`
   * (slice 4 — the agent's identity-scope skip flags; `identityScope`). `mcp_oauth_v1_clients` has no `agent_id`
   * column (it is keyed by `${connectorId}|${authServerUrl}` and shared by every
   * agent), so it is not this method's to delete from.
   *
   * THROWS on an empty `agentId`: a delete keyed on nothing is never what a
   * caller meant, so it is refused rather than run.
   */
  deleteAllForAgent(
    agentId: string,
  ): Promise<{ deleted: number; markers: number; identityScope: number }>;
  /**
   * Slice 2b — a deleted connector's reconnect markers (every agent's) go with
   * it, in one transaction — and (slice 4) so does its identity-scope skip
   * flag, for every authorization server. Backs the `connectors:deleted`
   * subscriber and (slice 5) the boot sweep. THROWS on an empty `connectorId`:
   * a delete keyed on nothing is never what a caller meant.
   */
  deleteMarkersForConnector(
    connectorId: string,
  ): Promise<{ agent: number; identityScope: number }>;
  /**
   * Slice 5 — every distinct connector id that carries an agent reconnect
   * marker. The boot sweep asks `connectors:live-ids` which of them still
   * exist. Ids and nothing else; no secret.
   */
  listMarkedConnectorIds(): Promise<string[]>;
  /**
   * Slice 4 — `authServerUrl` answered `invalid_scope` to a sign-in on
   * `agentId` to `connectorId` that carried the `openid`/`email` add-on.
   * Idempotent. Keyed by agent: the answer arrives through the browser, so it
   * may only ever affect the agent that authorization was begun for.
   */
  markIdentityScopeRefused(agentId: string, connectorId: string, authServerUrl: string): Promise<void>;
  /** Slice 4 — should `begin` leave the identity add-on out for this triple? */
  isIdentityScopeRefused(agentId: string, connectorId: string, authServerUrl: string): Promise<boolean>;
  /**
   * TASK-741 — record that `owner`'s sign-in to `connectorId` was rejected by
   * the authorization server (re-authorization required). Idempotent: marking
   * twice keeps one row and moves `marked_at`. The owner is the agent the
   * sign-in is stored on (slice 5: sign-ins live only on agents).
   */
  markNeedsReconnect(owner: MarkerOwner, connectorId: string): Promise<void>;
  /** TASK-741 — the sign-in works again (refreshed, or signed in anew). */
  clearNeedsReconnect(owner: MarkerOwner, connectorId: string): Promise<void>;
  /**
   * TASK-817 — does `owner` carry a needs-reconnect marker for `connectorId`?
   * One indexed read; the token resolver asks it only for a token the clock
   * still calls valid.
   */
  hasNeedsReconnect(owner: MarkerOwner, connectorId: string): Promise<boolean>;
  /**
   * TASK-741/756 — which of `connectorIds` carry a needs-reconnect marker for
   * `agentId`'s sign-in. A pure read: it never touches a token, so it can
   * never refresh one.
   */
  listNeedsReconnect(agentId: string, connectorIds: readonly string[]): Promise<string[]>;
}

/**
 * TASK-756 — who owns the token a needs-reconnect marker is about. Slice 5:
 * only ever an agent — every sign-in is stored on one, and the per-person
 * marker table is gone. Kept as a tagged object so a call site still says
 * whose marker it means.
 */
export type MarkerOwner = { kind: 'agent'; agentId: string };

/** Map a DB row to the domain {@link PendingAuthorization}. Shared by
 *  `getPending` and `consumePending` so the two never drift. */
function rowToPending(r: {
  state: string;
  user_id: string;
  agent_id: string;
  connector_id: string;
  slot: string;
  code_verifier: string;
  auth_server_url: string;
  issuer_required: boolean;
  client_key: string;
  resource: string;
  scope: string | null;
  mode: string;
  identity_scope?: boolean | null;
  client_id: string | null;
  client_secret: string | null;
  created_at: Date | string | number;
}): PendingAuthorization {
  const createdAt =
    r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at);
  return {
    state: r.state,
    userId: r.user_id,
    agentId: r.agent_id,
    connectorId: r.connector_id,
    slot: r.slot,
    codeVerifier: r.code_verifier,
    authServerUrl: r.auth_server_url,
    issuerRequired: r.issuer_required,
    clientKey: r.client_key,
    // NULL columns ⇒ ABSENT keys (never `clientId: undefined`): a pre-TASK-696 row
    // has no client of its own, and the callback keys its fallback off that.
    ...(r.client_id !== null ? { clientId: r.client_id } : {}),
    ...(r.client_secret !== null ? { clientSecret: r.client_secret } : {}),
    resource: r.resource,
    scope: r.scope ?? undefined,
    // Only the exact 'add' attaches; anything else (an unknown value) is the
    // flow that attaches nothing.
    mode: r.mode === 'add' ? 'add' : 'sign-in-again',
    identityScope: r.identity_scope === true,
    createdAt,
  };
}

export function createMcpOAuthStore(db: Kysely<McpOAuthDatabase>): McpOAuthStore {
  return {
    async getClient(clientKey) {
      const r = await db
        .selectFrom('mcp_oauth_v1_clients')
        .selectAll()
        .where('client_key', '=', clientKey)
        .executeTakeFirst();
      if (!r) return null;
      return {
        clientKey: r.client_key,
        clientId: r.client_id,
        clientSecret: r.client_secret ?? undefined,
        dynamic: r.dynamic,
      };
    },

    async putPending(p, createdAtOverride) {
      await db
        .insertInto('mcp_oauth_v1_pending')
        .values({
          state: p.state,
          user_id: p.userId,
          agent_id: p.agentId,
          connector_id: p.connectorId,
          slot: p.slot,
          code_verifier: p.codeVerifier,
          auth_server_url: p.authServerUrl,
          issuer_required: p.issuerRequired ?? false,
          client_key: p.clientKey,
          resource: p.resource,
          scope: p.scope ?? null,
          mode: p.mode,
          identity_scope: p.identityScope === true,
          client_id: p.clientId ?? null,
          client_secret: p.clientSecret ?? null,
          created_at:
            createdAtOverride !== undefined ? new Date(createdAtOverride) : new Date(),
        })
        .execute();
    },

    async getPending(state) {
      const r = await db
        .selectFrom('mcp_oauth_v1_pending')
        .selectAll()
        .where('state', '=', state)
        .executeTakeFirst();
      if (!r) return null;
      return rowToPending(r);
    },

    async consumePending(state, now, ttlMs) {
      const r = await db
        .deleteFrom('mcp_oauth_v1_pending')
        .where('state', '=', state)
        .returningAll()
        .executeTakeFirst();
      if (!r) return null;
      const pending = rowToPending(r);
      if (now - pending.createdAt > ttlMs) return null;
      return pending;
    },

    async purgeExpiredPending(olderThanMs) {
      await db
        .deleteFrom('mcp_oauth_v1_pending')
        .where('created_at', '<', new Date(olderThanMs))
        .execute();
    },

    async deleteAllForAgent(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new PluginError({
          code: 'missing-field',
          plugin: '@ax/mcp-oauth',
          message: 'agentId is required',
        });
      }
      return db.transaction().execute(async (trx) => {
        const pending = await trx
          .deleteFrom('mcp_oauth_v1_pending')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        const markers = await trx
          .deleteFrom('mcp_oauth_v1_needs_reconnect_agent')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        const identityScope = await trx
          .deleteFrom('mcp_oauth_v1_identity_scope_refused')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        return {
          deleted: Number(pending.numDeletedRows ?? 0n),
          markers: Number(markers.numDeletedRows ?? 0n),
          identityScope: Number(identityScope.numDeletedRows ?? 0n),
        };
      });
    },

    async deleteMarkersForConnector(connectorId) {
      if (typeof connectorId !== 'string' || connectorId.length === 0) {
        throw new PluginError({
          code: 'missing-field',
          plugin: '@ax/mcp-oauth',
          message: 'connectorId is required',
        });
      }
      return db.transaction().execute(async (trx) => {
        const agent = await trx
          .deleteFrom('mcp_oauth_v1_needs_reconnect_agent')
          .where('connector_id', '=', connectorId)
          .executeTakeFirst();
        const identityScope = await trx
          .deleteFrom('mcp_oauth_v1_identity_scope_refused')
          .where('connector_id', '=', connectorId)
          .executeTakeFirst();
        return {
          agent: Number(agent.numDeletedRows ?? 0n),
          identityScope: Number(identityScope.numDeletedRows ?? 0n),
        };
      });
    },

    async listMarkedConnectorIds() {
      const rows = await db
        .selectFrom('mcp_oauth_v1_needs_reconnect_agent')
        .select('connector_id')
        .distinct()
        .orderBy('connector_id')
        .execute();
      return rows.map((r) => r.connector_id);
    },

    async markIdentityScopeRefused(agentId, connectorId, authServerUrl) {
      await db
        .insertInto('mcp_oauth_v1_identity_scope_refused')
        .values({
          agent_id: agentId,
          connector_id: connectorId,
          auth_server: authServerUrl,
          created_at: new Date(),
        })
        .onConflict((oc) => oc.columns(['agent_id', 'connector_id', 'auth_server']).doNothing())
        .execute();
    },

    async isIdentityScopeRefused(agentId, connectorId, authServerUrl) {
      const row = await db
        .selectFrom('mcp_oauth_v1_identity_scope_refused')
        .select('connector_id')
        .where('agent_id', '=', agentId)
        .where('connector_id', '=', connectorId)
        .where('auth_server', '=', authServerUrl)
        .executeTakeFirst();
      return row !== undefined;
    },

    async markNeedsReconnect(owner, connectorId) {
      const markedAt = new Date();
      await db
        .insertInto('mcp_oauth_v1_needs_reconnect_agent')
        .values({ agent_id: owner.agentId, connector_id: connectorId, marked_at: markedAt })
        .onConflict((oc) =>
          oc.columns(['agent_id', 'connector_id']).doUpdateSet({ marked_at: markedAt }),
        )
        .execute();
    },

    async clearNeedsReconnect(owner, connectorId) {
      await db
        .deleteFrom('mcp_oauth_v1_needs_reconnect_agent')
        .where('agent_id', '=', owner.agentId)
        .where('connector_id', '=', connectorId)
        .execute();
    },

    async hasNeedsReconnect(owner, connectorId) {
      const row = await db
        .selectFrom('mcp_oauth_v1_needs_reconnect_agent')
        .select('connector_id')
        .where('agent_id', '=', owner.agentId)
        .where('connector_id', '=', connectorId)
        .executeTakeFirst();
      return row !== undefined;
    },

    async listNeedsReconnect(agentId, connectorIds) {
      if (connectorIds.length === 0 || agentId.length === 0) return [];
      const rows = await db
        .selectFrom('mcp_oauth_v1_needs_reconnect_agent')
        .select('connector_id')
        .where('agent_id', '=', agentId)
        .where('connector_id', 'in', [...connectorIds])
        .execute();
      return rows.map((r) => r.connector_id);
    },
  };
}
