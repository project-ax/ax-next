import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/conversations owns tables under the
 * `conversations_v1_` prefix — never reach into them from another plugin
 * (Invariant I4 — one source of truth per concept). Schema version is
 * forward-only via a future `v2` side-table, never an in-place ALTER.
 *
 * Tables:
 *   conversations_v1_conversations  — conversation entity, owned by user_id.
 *   conversations_v1_turns          — append-only turn log per conversation.
 *
 * No FK to auth_v1_users / agents_v1_agents. Cross-plugin FKs would
 * require shared schema migrations, which violates I4 (no shared rows).
 * The runtime ACL gate (`agents:resolve`) checks ownership against the
 * live row at hook time; orphan conversation rows after a user/agent
 * delete are tolerable (they simply fail every `conversations:get` /
 * `:append-turn` and can be GC'd later).
 *
 * Soft delete:
 *   `deleted_at` is nullable. The owner index excludes tombstones via a
 *   partial WHERE clause so list-by-user is fast even with large numbers
 *   of soft-deleted rows.
 *
 * Turn ordering:
 *   `(conversation_id, turn_index)` is UNIQUE — `appendTurn` retries on
 *   23505 unique-violation if a concurrent insert wins the index.
 */
// Schema-agnostic: the executor only needs to issue raw DDL.
export async function runConversationsMigration<DB>(
  db: Kysely<DB>,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS conversations_v1_conversations (
      conversation_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT,
      active_session_id TEXT,
      active_req_id TEXT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS conversations_v1_conversations_owner
      ON conversations_v1_conversations (user_id, agent_id)
      WHERE deleted_at IS NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS conversations_v1_turns (
      turn_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_blocks JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT conversations_v1_turns_role_check
        CHECK (role IN ('user', 'assistant', 'tool')),
      UNIQUE (conversation_id, turn_index)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS conversations_v1_turns_lookup
      ON conversations_v1_turns (conversation_id, turn_index)
  `.execute(db);

  // Phase B (2026-04-29) — runner-owned-sessions metadata. Pure-additive
  // ALTER on v1 (not a v2 side-table): all four columns are new and
  // nullable, no data migration, no breaking change. ax-next is greenfield
  // (confirmed 2026-04-29) so the original "v2 side-table, never an
  // in-place ALTER" rule — which existed to protect production data — does
  // not apply. We ALTER v1 in place forever.
  //
  //   runner_type:        which runner plugin owns the transcript. Frozen
  //                       at create-time from
  //                       ConversationsConfig.defaultRunnerType (I10).
  //   runner_session_id:  the runner's native session id. Bound once on
  //                       the first turn via
  //                       conversations:store-runner-session.
  //   workspace_ref:      frozen copy of agents.workspaceRef at create.
  //                       TEXT NULL to match the upstream type — JSONB
  //                       NOT NULL would force a backfill on every agent
  //                       without a workspaceRef.
  //   last_activity_at:   bumped by the chat:turn-end subscriber on every
  //                       non-heartbeat turn. Sidebar ordering only —
  //                       opaque to correctness (I8).
  //
  // ADD COLUMN IF NOT EXISTS keeps the migration idempotent (I11).
  await sql`
    ALTER TABLE conversations_v1_conversations
      ADD COLUMN IF NOT EXISTS runner_type TEXT,
      ADD COLUMN IF NOT EXISTS runner_session_id TEXT,
      ADD COLUMN IF NOT EXISTS workspace_ref TEXT,
      ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ
  `.execute(db);
}

/**
 * Row shapes — JSONB columns deserialize to `unknown` until validated.
 * Store helpers parse/validate before returning to plugin code.
 */
export interface ConversationsRow {
  conversation_id: string;
  user_id: string;
  agent_id: string;
  title: string | null;
  active_session_id: string | null;
  active_req_id: string | null;
  // Phase B (2026-04-29) — runner-owned-sessions metadata. All nullable,
  // populated lazily. See migration block above for semantics.
  runner_type: string | null;
  runner_session_id: string | null;
  workspace_ref: string | null;
  last_activity_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TurnsRow {
  turn_id: string;
  conversation_id: string;
  turn_index: number;
  role: string;
  content_blocks: unknown;
  created_at: Date;
}

export interface ConversationDatabase {
  conversations_v1_conversations: ConversationsRow;
  conversations_v1_turns: TurnsRow;
}
