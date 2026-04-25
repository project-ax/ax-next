import { randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { SessionDatabase } from './migrations.js';

const PLUGIN_NAME = '@ax/session-postgres';

// Plugin-specific error codes, matching @ax/session-inmemory exactly so
// callers can switch implementations without changing their catch blocks.
export const DUPLICATE_SESSION = 'duplicate-session';
export const UNKNOWN_SESSION = 'unknown-session';

// ---------------------------------------------------------------------------
// Session store (postgres)
//
// Same surface as @ax/session-inmemory's SessionStore: create, resolveToken,
// get, terminate. Backed by `session_postgres_v1_sessions` instead of an
// in-memory Map.
//
// `terminate()` sets the row's `terminated` flag — we keep the row for
// forensic visibility, mirroring the in-memory plugin which keeps the
// record around with a flag.
//
// Token minting: 32 bytes of crypto.randomBytes, base64url-encoded. 43
// chars exactly (matches /^[A-Za-z0-9_-]{43}$/). NEVER JWT (Invariant I9
// from the Week 4-6 audit).
// ---------------------------------------------------------------------------

export interface SessionRecord {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly token: string;
  readonly terminated: boolean;
}

export interface SessionStore {
  create(sessionId: string, workspaceRoot: string): Promise<SessionRecord>;
  resolveToken(token: string): Promise<{ sessionId: string; workspaceRoot: string } | null>;
  get(sessionId: string): Promise<SessionRecord | null>;
  terminate(sessionId: string): Promise<void>;
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createSessionStore(db: Kysely<SessionDatabase>): SessionStore {
  return {
    async create(sessionId, workspaceRoot) {
      const token = mintToken();
      try {
        const row = await db
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
        return {
          sessionId: row.session_id,
          workspaceRoot: row.workspace_root,
          token: row.token,
          terminated: row.terminated,
        };
      } catch (err) {
        // Postgres error code 23505 is "unique_violation" — surface as a
        // structured PluginError matching session-inmemory's contract.
        if (
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: unknown }).code === '23505'
        ) {
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
      const row = await db
        .selectFrom('session_postgres_v1_sessions')
        .select(['session_id', 'workspace_root', 'terminated'])
        .where('token', '=', token)
        .executeTakeFirst();
      if (row === undefined || row.terminated) return null;
      return {
        sessionId: row.session_id,
        workspaceRoot: row.workspace_root,
      };
    },

    async get(sessionId) {
      const row = await db
        .selectFrom('session_postgres_v1_sessions')
        .select(['session_id', 'token', 'workspace_root', 'terminated'])
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        sessionId: row.session_id,
        workspaceRoot: row.workspace_root,
        token: row.token,
        terminated: row.terminated,
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
