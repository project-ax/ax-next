import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. Each postgres-backed AX plugin owns its own
 * tables under a unique prefix — `session_postgres_v1_` for this one.
 *
 * The `v1` in the prefix is the schema version. When the shape needs to
 * change incompatibly, we add a `v2` table and a forward-only migration —
 * we do NOT mutate v1 in place, because old code may still be reading it
 * during a rolling deploy.
 *
 * Schema decision (Week 7-9 / Week 9.5 handoff):
 * The v1 schema is intentionally session-resolution-only — token plus
 * the workspace-root metadata needed to dispatch messages. The
 * `user_id` / `agent_id` columns that Week 9.5's auth slice will need
 * are NOT pre-emptively added (not even nullable). 9.5 owns its own
 * forward-only migration; designing v1 additively means 9.5 lands
 * cleanly without renaming/relaxing v1 columns.
 *
 * No foreign keys between sessions and inbox. The inbox table COULD
 * reference sessions.session_id, but we deliberately don't — the
 * per-plugin-tables rule says no FKs, and keeping the inbox FK-less
 * means it can be split into its own plugin later without a schema
 * migration. (See architecture doc Section 6.)
 */
// The migration is schema-agnostic — it issues raw DDL via sql``.execute,
// which only needs the executor, not the type-level table map.
export async function runSessionMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS session_postgres_v1_sessions (
      session_id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      workspace_root TEXT NOT NULL,
      terminated BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // NB: no FK to session_postgres_v1_sessions on session_id. Defensive —
  // keeps the inbox split-able into its own plugin later. (architecture
  // doc Section 6 + Invariant 4.)
  await sql`
    CREATE TABLE IF NOT EXISTS session_postgres_v1_inbox (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      cursor BIGINT NOT NULL,
      type TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, cursor)
    )
  `.execute(db);

  // Index for the hot-path "next entry at cursor" lookup. Composite on
  // (session_id, cursor) is already unique, so the unique constraint
  // serves the same lookup — no extra index needed.
}

export interface SessionRow {
  session_id: string;
  token: string;
  workspace_root: string;
  terminated: boolean;
  created_at: Date;
}

export interface InboxRow {
  id: string; // BIGSERIAL — pg returns BIGINT as string by default
  session_id: string;
  cursor: string; // BIGINT — string for safety; we coerce in code
  type: 'user-message' | 'cancel';
  payload: unknown; // JSONB — null for cancel, ChatMessage for user-message
  created_at: Date;
}

export interface SessionDatabase {
  session_postgres_v1_sessions: SessionRow;
  session_postgres_v1_inbox: InboxRow;
}
