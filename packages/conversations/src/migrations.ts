import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/conversations owns tables under the
 * `conversations_v1_` prefix — never reach into them from another plugin
 * (Invariant I4 — one source of truth per concept). Schema version is
 * forward-only via a future `v2` side-table, never an in-place ALTER.
 *
 * Tables:
 *   conversations_v1_conversations  — conversation entity, owned by user_id.
 *
 * No FK to auth_better_v1_users / agents_v1_agents. Cross-plugin FKs would
 * require shared schema migrations, which violates I4 (no shared rows).
 * The runtime ACL gate (`agents:resolve`) checks ownership against the
 * live row at hook time; orphan conversation rows after a user/agent
 * delete are tolerable (they simply fail every `conversations:get` and
 * can be GC'd later).
 *
 * Soft delete:
 *   `deleted_at` is nullable. The owner index excludes tombstones via a
 *   partial WHERE clause so list-by-user is fast even with large numbers
 *   of soft-deleted rows.
 *
 * Phase E (2026-05-09):
 *   `conversations_v1_turns` was the host-side append-only turn log.
 *   Phase D switched the reader to the runner-native workspace jsonl;
 *   Phase E removes the writer and DROPs the table. The DROP step at
 *   the end of this migration is forward-only and uses `IF EXISTS` so
 *   it's idempotent on both fresh databases (no-op) and existing ones
 *   (drops the legacy table).
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

  // Phase A routines foundation (2026-05-14). Adds the `hidden` column so
  // silenced routine fires can hide their conversation from the sidebar
  // without deleting it. Default FALSE keeps every existing row visible.
  // Idempotent ADD COLUMN IF NOT EXISTS — re-runs are safe (I11).
  await sql`
    ALTER TABLE conversations_v1_conversations
      ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE
  `.execute(db);

  // Phase A routines foundation (2026-05-14). Stable per-(user, agent, key)
  // conversation lookup for routines with `conversation: shared`. The
  // routines plugin passes external_key = routine_path; non-routine
  // callers leave it null. Partial unique index excludes NULL keys
  // (so the column is genuinely optional) AND tombstones (so a
  // soft-deleted row doesn't pin its key forever — re-create after
  // delete is allowed).
  await sql`
    ALTER TABLE conversations_v1_conversations
      ADD COLUMN IF NOT EXISTS external_key TEXT
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_v1_external_key_unique
      ON conversations_v1_conversations (user_id, agent_id, external_key)
      WHERE external_key IS NOT NULL AND deleted_at IS NULL
  `.execute(db);

  // Phase E (2026-05-09): drop the now-dead transcript table. Phase D
  // migrated readers to the workspace's runner-native jsonl; Phase E
  // drops the writer + the table. Idempotent (`IF EXISTS`) so a fresh
  // database (where the table was never created) is a no-op, and an
  // existing database has the legacy table removed.
  await sql`DROP TABLE IF EXISTS conversations_v1_turns`.execute(db);

  // TASK-66 (out-of-git Part B / B1, 2026-05-30): the display event log —
  // the redisplay source of truth. Append-only, keyed (conversation_id, seq)
  // with a per-conversation monotonic seq (single writer per conversation:
  // the host — contention-free, NOT a CAS). Persists the exact ordered
  // display frames the host already emits over SSE so reload == live by
  // construction: `turn` rows carry the model/tool content (the folded
  // terminal ContentBlock[] the runner sends at the result boundary);
  // `permission-card` / `turn-error` rows carry the HOST-only UI events the
  // SDK jsonl never sees.
  //
  //   seq:        per-conversation monotonic int (1-based). The PK is the
  //               composite (conversation_id, seq) so ordering + dedup are
  //               free. Minted by the store inside the same statement that
  //               inserts (SELECT COALESCE(MAX)+1) — single writer, no CAS.
  //   event_kind: display-semantic enum — 'turn' | 'permission-card' |
  //               'turn-error'. CHECK-constrained so a malformed kind can't
  //               land. Storage-agnostic (I1): no backend vocabulary.
  //   role:       turn role for 'turn' rows ('user'|'assistant'|'tool');
  //               NULL for host-only events.
  //   fold_key:   stable per-card / per-turn key. The read keeps the LAST row
  //               per (conversation_id, event_kind, fold_key) so a later
  //               card-resolution frame folds an earlier card to its terminal
  //               state on replay with no special bookkeeping.
  //   payload:    the opaque display frame body (JSONB). Untrusted host/model
  //               output — stored opaque, never interpreted by the store, and
  //               re-validated against ContentBlockSchema on read for turns
  //               (the J2 hardening posture). Renderers sanitize.
  //
  // No FK to conversations_v1_conversations — keeping the same no-cross-row
  // posture (orphan event rows after a conversation delete are tolerable and
  // GC'able). CREATE TABLE / INDEX IF NOT EXISTS keeps the migration
  // idempotent (I11).
  await sql`
    CREATE TABLE IF NOT EXISTS conversations_v1_events (
      conversation_id TEXT NOT NULL,
      seq BIGINT NOT NULL,
      event_kind TEXT NOT NULL
        CHECK (event_kind IN ('turn', 'permission-card', 'turn-error')),
      role TEXT,
      fold_key TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (conversation_id, seq)
    )
  `.execute(db);

  // Read path orders by seq within a conversation; the PK already covers
  // (conversation_id, seq) so a plain conversation_id scan is index-served.
  // The explicit index keeps the read fast even if the PK column order ever
  // changes. Idempotent.
  await sql`
    CREATE INDEX IF NOT EXISTS conversations_v1_events_by_conv
      ON conversations_v1_events (conversation_id, seq)
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
  hidden: boolean;
  // Phase A (routines foundation, 2026-05-14). Stable per-(user, agent, key)
  // lookup handle. See migration block above for semantics. NULL for
  // non-routine conversations.
  external_key: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * TASK-66 — display event log row (out-of-git Part B / B1). One row per
 * persisted display frame, append-only, ordered by `seq` within a conversation.
 * `payload` is JSONB and deserializes to `unknown` — store helpers
 * parse/validate before returning to plugin code (the same don't-trust-the-DB
 * posture as the conversation row's blocks).
 */
export interface ConversationEventsRow {
  conversation_id: string;
  /** Per-conversation monotonic int. BIGINT → kysely surfaces it as string or
   *  number depending on the driver; the store coerces to number on read. */
  seq: string | number;
  event_kind: string;
  role: string | null;
  fold_key: string;
  payload: unknown;
  created_at: Date;
}

export interface ConversationDatabase {
  conversations_v1_conversations: ConversationsRow;
  conversations_v1_events: ConversationEventsRow;
}
