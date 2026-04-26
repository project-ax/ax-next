import { randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { SessionDatabase } from './migrations.js';

const PLUGIN_NAME = '@ax/session-postgres';

// Plugin-specific error codes, matching @ax/session-inmemory exactly so
// callers can switch implementations without changing their catch blocks.
export const DUPLICATE_SESSION = 'duplicate-session';
export const UNKNOWN_SESSION = 'unknown-session';
export const OWNER_MISSING = 'owner-missing';

// ---------------------------------------------------------------------------
// AgentConfig — frozen-at-creation snapshot of the resolving agent's
// runner-relevant fields. Duplicated structurally with @ax/session-inmemory's
// AgentConfig (Invariant I2 — no cross-plugin imports between session
// backends; the bus shape is the contract). A drift would surface at the
// resolveAgent → session:create call site in @ax/chat-orchestrator.
// ---------------------------------------------------------------------------

export interface AgentConfig {
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
}

// ---------------------------------------------------------------------------
// Session store (postgres)
//
// Same surface as @ax/session-inmemory's SessionStore: create, resolveToken,
// get, getConfig, terminate. Backed by `session_postgres_v1_sessions` plus
// the v2 side-table `session_postgres_v2_session_agent` for {userId, agentId,
// agentConfig}.
//
// `terminate()` sets the v1 row's `terminated` flag — we keep both v1 and v2
// rows for forensic visibility, mirroring the in-memory plugin which keeps
// the record around with a flag.
//
// Token minting: 32 bytes of crypto.randomBytes, base64url-encoded. 43
// chars exactly (matches /^[A-Za-z0-9_-]{43}$/). NEVER JWT (Invariant I9
// from the Week 4-6 audit).
//
// Atomicity: when an `owner` is supplied, both rows are inserted in a single
// transaction. Without the transaction, a v1-insert-succeeds /
// v2-insert-fails partial would leave a session with no agent — and the
// runner would boot with a session that resolveToken accepts but
// session:get-config rejects. The transaction closes that window.
// ---------------------------------------------------------------------------

export interface SessionOwner {
  userId: string;
  agentId: string;
  agentConfig: AgentConfig;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly token: string;
  readonly userId: string | null;
  readonly agentId: string | null;
  readonly agentConfig: AgentConfig | null;
  readonly terminated: boolean;
}

export interface ResolveTokenResult {
  sessionId: string;
  workspaceRoot: string;
  userId: string | null;
  agentId: string | null;
}

export interface SessionStore {
  create(
    sessionId: string,
    workspaceRoot: string,
    owner?: SessionOwner,
  ): Promise<SessionRecord>;
  resolveToken(token: string): Promise<ResolveTokenResult | null>;
  get(sessionId: string): Promise<SessionRecord | null>;
  /**
   * Read just the {userId, agentId, agentConfig} for a session — what the
   * runner needs at boot. Returns null when the session is unknown,
   * terminated, or has no owner row (pre-9.5 record).
   */
  getConfig(
    sessionId: string,
  ): Promise<{ userId: string; agentId: string; agentConfig: AgentConfig } | null>;
  terminate(sessionId: string): Promise<void>;
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

export function createSessionStore(db: Kysely<SessionDatabase>): SessionStore {
  return {
    async create(sessionId, workspaceRoot, owner) {
      const token = mintToken();
      try {
        // Wrap in a transaction so a v2-insert failure rolls back v1 and
        // we don't leave a session row that resolveToken finds but
        // session:get-config rejects.
        return await db.transaction().execute(async (trx) => {
          const v1Row = await trx
            .insertInto('session_postgres_v1_sessions')
            .values({
              session_id: sessionId,
              token,
              workspace_root: workspaceRoot,
              terminated: false,
              // created_at defaults to NOW() at the DB
            } as never)
            .returning(['session_id', 'token', 'workspace_root', 'terminated'])
            .executeTakeFirstOrThrow();
          if (owner !== undefined) {
            await trx
              .insertInto('session_postgres_v2_session_agent')
              .values({
                session_id: sessionId,
                user_id: owner.userId,
                agent_id: owner.agentId,
                // Cast: kysely's insertInto types JSONB columns as their
                // declared shape; we passed `unknown` in the row type so
                // the value rides as opaque JSON.
                agent_config_json: owner.agentConfig as never,
              } as never)
              .execute();
          }
          return {
            sessionId: v1Row.session_id,
            workspaceRoot: v1Row.workspace_root,
            token: v1Row.token,
            userId: owner?.userId ?? null,
            agentId: owner?.agentId ?? null,
            agentConfig: owner?.agentConfig ?? null,
            terminated: v1Row.terminated,
          };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new PluginError({
            code: DUPLICATE_SESSION,
            plugin: PLUGIN_NAME,
            hookName: 'session:create',
            message: `session '${sessionId}' already exists`,
          });
        }
        throw err;
      }
    },

    async resolveToken(token) {
      // LEFT JOIN: v2 row may not exist for pre-9.5 sessions. We surface
      // userId/agentId as null in that case rather than rejecting at the
      // resolve layer — which subscribers (e.g. tool-dispatcher's per-agent
      // filter) might want to allow legacy sessions through; the call site
      // makes that decision.
      const row = await db
        .selectFrom('session_postgres_v1_sessions as s')
        .leftJoin(
          'session_postgres_v2_session_agent as a',
          'a.session_id',
          's.session_id',
        )
        .select([
          's.session_id',
          's.workspace_root',
          's.terminated',
          'a.user_id',
          'a.agent_id',
        ])
        .where('s.token', '=', token)
        .executeTakeFirst();
      if (row === undefined || row.terminated) return null;
      return {
        sessionId: row.session_id,
        workspaceRoot: row.workspace_root,
        userId: row.user_id ?? null,
        agentId: row.agent_id ?? null,
      };
    },

    async get(sessionId) {
      const row = await db
        .selectFrom('session_postgres_v1_sessions as s')
        .leftJoin(
          'session_postgres_v2_session_agent as a',
          'a.session_id',
          's.session_id',
        )
        .select([
          's.session_id',
          's.token',
          's.workspace_root',
          's.terminated',
          'a.user_id',
          'a.agent_id',
          'a.agent_config_json',
        ])
        .where('s.session_id', '=', sessionId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        sessionId: row.session_id,
        workspaceRoot: row.workspace_root,
        token: row.token,
        userId: row.user_id ?? null,
        agentId: row.agent_id ?? null,
        agentConfig: (row.agent_config_json as AgentConfig | null) ?? null,
        terminated: row.terminated,
      };
    },

    async getConfig(sessionId) {
      // INNER JOIN here — a session without an owner row simply returns
      // null; the bus-side handler maps that to an OWNER_MISSING error.
      const row = await db
        .selectFrom('session_postgres_v1_sessions as s')
        .innerJoin(
          'session_postgres_v2_session_agent as a',
          'a.session_id',
          's.session_id',
        )
        .select([
          's.terminated',
          'a.user_id',
          'a.agent_id',
          'a.agent_config_json',
        ])
        .where('s.session_id', '=', sessionId)
        .executeTakeFirst();
      if (row === undefined || row.terminated) return null;
      return {
        userId: row.user_id,
        agentId: row.agent_id,
        agentConfig: row.agent_config_json as AgentConfig,
      };
    },

    async terminate(sessionId) {
      // Idempotent: UPDATE with no row matched is a no-op, same as the
      // in-memory plugin's behavior.
      await db
        .updateTable('session_postgres_v1_sessions')
        .set({ terminated: true })
        .where('session_id', '=', sessionId)
        .execute();
    },
  };
}
