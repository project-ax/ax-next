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

  // ----- v2 schema (Week 9.5) -----
  //
  // Side-table that pairs a v1 session_id with the {user_id, agent_id,
  // agent_config_json} that minted it. We do NOT add columns to v1 —
  // forward-only schema evolution lets a rolling deploy run old code
  // (which doesn't know about user/agent) alongside new code, and keeps
  // I10 (session ↔ agent immutability) crisp: this table is INSERT-once
  // per session, never UPDATEd. Existing v1 sessions that pre-date 9.5
  // simply have no v2 row — `resolveToken` returns nulls for those, and
  // the orchestrator decides what to do.
  //
  // `agent_config_json` is the FROZEN snapshot of the resolving agent's
  // config at session-creation time. The runner reads it via
  // `session:get-config`. Frozen-at-creation is the correct semantics
  // (matches I10 — switching agents = new session, not mutate). Live
  // edits to the agent row (admin PATCH) DO NOT affect in-flight sessions.
  // The shape is opaque at the SQL layer — see SessionAgentConfigRow.
  await sql`
    CREATE TABLE IF NOT EXISTS session_postgres_v2_session_agent (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_config_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // Indexes for the read patterns we need before Week 12 — `user_id` for
  // "list this user's sessions" admin views, `agent_id` for "what's running
  // against agent X right now" debugging. Both are bounded-cardinality and
  // queried more often than session_id-by-itself.
  await sql`
    CREATE INDEX IF NOT EXISTS session_postgres_v2_session_agent_user_id_idx
      ON session_postgres_v2_session_agent (user_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS session_postgres_v2_session_agent_agent_id_idx
      ON session_postgres_v2_session_agent (agent_id)
  `.execute(db);

  // ----- Week 10–12 Task 15: conversation_id on the v2 row ----------------
  //
  // Forward-only additive ALTER. The orchestrator (Task 16) populates this
  // when minting a session for an existing conversation; the runner reads
  // it back via `session:get-config` and uses it as the trigger to call
  // `conversation.fetch-history` at boot. Existing v2 rows pre-Task-15
  // simply have a NULL — the runner treats null as "no history to
  // replay".
  //
  // Why a column on v2 instead of bumping to v3? The session ↔ agent
  // immutability contract (I10) says this row is INSERT-once-per-session;
  // conversationId joins the same write. There's no UPDATE path that
  // changes it, so adding a nullable column doesn't violate I10 — it
  // widens the insert without changing the immutability promise.
  await sql`
    ALTER TABLE session_postgres_v2_session_agent
      ADD COLUMN IF NOT EXISTS conversation_id TEXT
  `.execute(db);
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
  payload: unknown; // JSONB — null for cancel, AgentMessage for user-message
  created_at: Date;
}

/**
 * v2 side-table pairing a session with its {user_id, agent_id} owners and
 * the FROZEN agent config snapshot. Insert-once per session_id (the PK
 * enforces it); there is intentionally no `updated_at` — Invariant I10
 * (session ↔ agent immutability) is the contract and we want a missing
 * UPDATE-time column to make the contract obvious to anyone reading.
 *
 * `agent_config_json` is stored as JSONB but is opaque at the SQL layer.
 * Shape lives in TypeScript (`SessionAgentConfig` in store.ts) — kept off
 * the migration to keep the migration file shape-agnostic.
 */
export interface SessionAgentRow {
  session_id: string;
  user_id: string;
  agent_id: string;
  agent_config_json: unknown;
  /**
   * Optional conversation binding (Week 10–12 Task 15). Null for
   * non-conversation sessions (canary, admin, pre-Task-15 records).
   */
  conversation_id: string | null;
  created_at: Date;
}

export interface SessionDatabase {
  session_postgres_v1_sessions: SessionRow;
  session_postgres_v1_inbox: InboxRow;
  session_postgres_v2_session_agent: SessionAgentRow;
}
