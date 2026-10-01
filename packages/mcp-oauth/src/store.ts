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
   * Touches `mcp_oauth_v1_pending` only. `mcp_oauth_v1_clients` has no `agent_id`
   * column (it is keyed by `${connectorId}|${authServerUrl}` and shared by every
   * agent), so it is not this method's to delete from.
   *
   * THROWS on an empty `agentId`: a delete keyed on nothing is never what a
   * caller meant, so it is refused rather than run.
   */
  deleteAllForAgent(agentId: string): Promise<{ deleted: number }>;
}

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
  cred_scope: string;
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
    credScope: r.cred_scope === 'user' ? 'user' : 'agent',
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
          cred_scope: p.credScope,
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
      const res = await db
        .deleteFrom('mcp_oauth_v1_pending')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return { deleted: Number(res.numDeletedRows ?? 0n) };
    },
  };
}
