import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/auth-oidc owns tables under the `auth_v1_` prefix —
 * never reach into them from another plugin (Invariant I4 — one source of
 * truth per concept). The `v1` is the schema version; future shape changes
 * are forward-only via a `v2` side-table, not in-place ALTERs.
 *
 * Two tables, two concepts:
 *   auth_v1_users       — identity row (one per IdP-issued subject).
 *   auth_v1_sessions    — HTTP login session (signed-cookie value).
 *
 * `auth_v1_sessions` is intentionally distinct from
 * `session_postgres_v1_sessions`. The auth session points at a user; the
 * session-postgres session points at a workspace + (Week 9.5) an agent.
 * They coexist by design — see plan §Task 3.
 *
 * No FKs across the auth_v1_ ↔ session_postgres_v1_ boundary (I4 again).
 */
// Schema-agnostic migration; raw DDL only needs the executor, not the
// type-level table map. Generic keeps callers free to pass `Kysely<MySchema>`
// without a cast.
export async function runAuthMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS auth_v1_users (
      user_id TEXT PRIMARY KEY,
      auth_subject_id TEXT NOT NULL,
      auth_provider TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (auth_provider, auth_subject_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS auth_v1_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS auth_v1_sessions_user_id_idx
      ON auth_v1_sessions (user_id)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS auth_v1_sessions_expires_at_idx
      ON auth_v1_sessions (expires_at)
  `.execute(db);
}

export interface UserRow {
  user_id: string;
  auth_subject_id: string;
  auth_provider: string;
  email: string | null;
  display_name: string | null;
  is_admin: boolean;
  created_at: Date;
}

export interface AuthSessionRow {
  session_id: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
}

export interface AuthDatabase {
  auth_v1_users: UserRow;
  auth_v1_sessions: AuthSessionRow;
}
