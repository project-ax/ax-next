import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/decisions owns tables under the `decisions_v1_`
 * prefix — never reach into them from another plugin (invariant 4, one source
 * of truth per concept). Additive-only.
 *
 * NO CROSS-PLUGIN FOREIGN KEYS, deliberately. `agent_id`, `owner_user_id` and
 * `conversation_id` are opaque scoping keys, not references: a FK onto
 * `agents_v1_*` or `conversations_v1_*` would put this table into the shared
 * DROP-TABLE order used by repo-wide test teardown, and that breakage only
 * surfaces on a full-repo run. A decision pointing at a deleted agent is
 * simply never listed.
 */
export async function runDecisionsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS decisions_v1_decisions (
      decision_id       TEXT PRIMARY KEY,
      agent_id          TEXT NOT NULL,
      owner_user_id     TEXT NOT NULL,
      conversation_id   TEXT NOT NULL,
      kind              TEXT NOT NULL,
      attendance        TEXT NOT NULL,
      status            TEXT NOT NULL,
      call_json         TEXT NOT NULL,
      call_fingerprint  TEXT NOT NULL,
      rule_id           TEXT,
      freshness_json    TEXT,
      summary           TEXT NOT NULL,
      detail            TEXT NOT NULL,
      preview_json      TEXT,
      primary_label     TEXT NOT NULL,
      secondary_label   TEXT NOT NULL,
      ghost_label       TEXT NOT NULL,
      approved_text     TEXT NOT NULL,
      dismissed_text    TEXT NOT NULL,
      stale_reason      TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      resolved_at       TIMESTAMPTZ,
      consumed_at       TIMESTAMPTZ
    )
  `.execute(db);

  // The Today queue's read path: everything still actionable, for one user.
  await sql`
    CREATE INDEX IF NOT EXISTS decisions_v1_open
      ON decisions_v1_decisions (owner_user_id, agent_id, status)
      WHERE status IN ('pending', 'stale')
  `.execute(db);

  // AW-5 columns. `ADD COLUMN IF NOT EXISTS` with a default is additive and
  // idempotent — an existing deployment picks these up without a rewrite of
  // the row's meaning, and a decision written before AW-5 reads back as
  // reversible with no replay pending, which is exactly what it was.
  await sql`
    ALTER TABLE decisions_v1_decisions
      ADD COLUMN IF NOT EXISTS irreversible  BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS replay_due_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS replay_claimed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS replayed_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS replay_error  TEXT
  `.execute(db);

  // THE idempotency guarantee, at the storage layer rather than in application
  // code: at most one standing authorisation per (agent, call shape). Two
  // concurrent approvals of the same call cannot both leave an unconsumed
  // authorisation behind — the second one's UPDATE violates this index and
  // fails loudly instead of silently authorising a second execution.
  //
  // AW-5 WIDENS the predicate twice over.
  //
  //   * `approved-pending-agent` is a real standing authorisation — it is the
  //     status for a sandbox-only tool the host cannot replay, where the agent
  //     performs the call on its next run — so it sits inside the same
  //     uniqueness guarantee as `executed`.
  //   * `replayed_at IS NULL` takes a row OUT of the guarantee once the host
  //     has actually performed the call. It is no longer a standing
  //     authorisation, it is history. Without this, a later hold of the same
  //     call could never be approved: the old row would still occupy the index
  //     slot and the second approval would die on a unique violation.
  //
  // The pre-AW-5 index is dropped by name first; dropping an index destroys no
  // data, and leaving the narrower one in place would both misstate where the
  // guarantee lives and keep enforcing the version without `replayed_at`.
  await sql`DROP INDEX IF EXISTS decisions_v1_approved_unconsumed`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS decisions_v1_authorised_unconsumed
      ON decisions_v1_decisions (agent_id, call_fingerprint)
      WHERE status IN ('executed', 'approved-pending-agent')
        AND consumed_at IS NULL
        AND replayed_at IS NULL
  `.execute(db);

  // The deferred-replay sweep's read path: the handful of rows whose undo
  // window has closed and whose irreversible call is now due to actually run.
  await sql`
    CREATE INDEX IF NOT EXISTS decisions_v1_replay_due
      ON decisions_v1_decisions (replay_due_at)
      WHERE replay_due_at IS NOT NULL
  `.execute(db);
}

/** Row shape returned by postgres. */
export interface DecisionRow {
  decision_id: string;
  agent_id: string;
  owner_user_id: string;
  conversation_id: string;
  kind: string;
  attendance: string;
  status: string;
  call_json: string;
  call_fingerprint: string;
  rule_id: string | null;
  freshness_json: string | null;
  summary: string;
  detail: string;
  preview_json: string | null;
  primary_label: string;
  secondary_label: string;
  ghost_label: string;
  approved_text: string;
  dismissed_text: string;
  stale_reason: string | null;
  created_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
  consumed_at: Date | null;
  irreversible: boolean;
  replay_due_at: Date | null;
  replay_claimed_at: Date | null;
  replayed_at: Date | null;
  replay_error: string | null;
}

export interface DecisionsDatabase {
  decisions_v1_decisions: DecisionRow;
}
