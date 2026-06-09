import type { Kysely } from 'kysely';
import type { McpOAuthDatabase } from './migrations.js';
import type { ClientRegistration, PendingAuthorization } from './types.js';

export interface McpOAuthStore {
  putClient(c: ClientRegistration): Promise<void>;
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
  client_key: string;
  resource: string;
  scope: string | null;
  cred_scope: string;
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
    clientKey: r.client_key,
    resource: r.resource,
    scope: r.scope ?? undefined,
    credScope: r.cred_scope === 'user' ? 'user' : 'agent',
    createdAt,
  };
}

export function createMcpOAuthStore(db: Kysely<McpOAuthDatabase>): McpOAuthStore {
  return {
    async putClient(c) {
      await db
        .insertInto('mcp_oauth_v1_clients')
        .values({
          client_key: c.clientKey,
          client_id: c.clientId,
          client_secret: c.clientSecret ?? null,
          dynamic: c.dynamic,
          created_at: new Date(),
        })
        .onConflict((oc) =>
          oc.column('client_key').doUpdateSet({
            client_id: c.clientId,
            client_secret: c.clientSecret ?? null,
            dynamic: c.dynamic,
          }),
        )
        .execute();
    },

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
          client_key: p.clientKey,
          resource: p.resource,
          scope: p.scope ?? null,
          cred_scope: p.credScope,
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
  };
}
