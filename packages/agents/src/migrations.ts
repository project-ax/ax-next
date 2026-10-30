import { sql, type Generated, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/agents owns tables under the `agents_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept). Every statement runs on every boot, so each
 * one is forward-only and safe to re-run: new tables (`IF NOT EXISTS`),
 * additive columns (`ADD COLUMN IF NOT EXISTS`), idempotent rewrites.
 *
 * Tables:
 *   agents_v1_agents    — agent entity, owned by user_id OR team_id.
 *   agents_v1_identity  — the agent's identity, soul, its people's
 *                         Instructions and its onboarding state (TASK-989).
 *
 * No FK to auth_better_v1_users / teams_v1_teams. Cross-plugin FKs would
 * require shared schema migrations, which violates I4 (no shared rows).
 * The runtime ACL gate checks ownership against the live row at
 * resolve-time; orphan rows after a user/team delete are tolerable
 * (they simply fail every `agents:resolve` and can be GC'd later).
 *
 * CHECK constraints:
 *   - owner_type IN ('user','team') and visibility IN ('personal','team')
 *     are domain enums; SQL-level enforcement keeps a logic bug from
 *     persisting a malformed row.
 *   - owner_type/visibility pairing — `personal` MUST be owned by `user`
 *     and `team` by `team`. Without this, someone could insert a row
 *     where ACL would have to fall back to "deny by default" forever.
 */
// Schema-agnostic: the executor only needs to issue raw DDL.
export async function runAgentsMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS agents_v1_agents (
      agent_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      visibility TEXT NOT NULL,
      display_name TEXT NOT NULL,
      allowed_tools JSONB NOT NULL,
      mcp_config_ids JSONB NOT NULL,
      model TEXT NOT NULL,
      workspace_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT agents_v1_owner_type_check
        CHECK (owner_type IN ('user', 'team')),
      CONSTRAINT agents_v1_visibility_check
        CHECK (visibility IN ('personal', 'team')),
      CONSTRAINT agents_v1_owner_visibility_pair_check
        CHECK (
          (owner_type = 'user' AND visibility = 'personal')
          OR (owner_type = 'team' AND visibility = 'team')
        )
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS agents_v1_agents_owner
      ON agents_v1_agents (owner_type, owner_id)
  `.execute(db);

  // Phase C: lazy-generated webhook bearer token. Nullable so the
  // column is harmless for agents that never grow a webhook routine.
  // Partial unique index avoids burning index space on NULL rows and
  // makes `agents:resolve-by-webhook-token` an indexed equality lookup.
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS webhook_token TEXT
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_v1_agents_webhook_token
      ON agents_v1_agents (webhook_token)
     WHERE webhook_token IS NOT NULL
  `.execute(db);

  // Phase 1.4: skill attachments — which installed skills this agent uses
  // and how their credential slots are bound to specific credential refs.
  // NOT NULL DEFAULT '[]' so existing rows are safe; the column is owned
  // exclusively by PATCH /admin/agents/:id/skill-attachments (never the
  // generic update path).
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS skill_attachments JSONB NOT NULL DEFAULT '[]'
  `.execute(db);

  // TASK-107: per-agent connector attachments — the connector ids this agent
  // is attached to. A FIRST-CLASS store replacing the TASK-98 stopgap that
  // overloaded `mcp_config_ids` (which reverts to MCP-only meaning). A plain
  // array of connector-id slugs (no credential bindings — the connector owns
  // its own slots; the credential ref derives from keyMode→scope, TASK-96).
  // NOT NULL DEFAULT '[]' so every existing row reads safely — this additive
  // column IS the idempotent migration (no lossy mcp_config_ids reclassification:
  // a real MCP config id and a TASK-98 connector id are indistinguishable, and
  // ax-next has no prod data). Written only by agents:attach-connector /
  // agents:detach-connector (never the generic update path).
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS connector_attachments JSONB NOT NULL DEFAULT '[]'
  `.execute(db);

  // TASK-739: per-agent connector EXCLUSIONS — connector ids the owner removed
  // from this agent although they reach it by another source (a legacy owned
  // connector; connector defaults were retired by TASK-808). A plain array of connector-id slugs. Additive +
  // idempotent; NOT NULL DEFAULT '[]' means every existing row excludes
  // nothing (today's behaviour). Written only by agents:attach-connector /
  // agents:detach-connector (one row-locked transaction each).
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS connector_exclusions JSONB NOT NULL DEFAULT '[]'
  `.execute(db);

  // TASK-142 (conversational-agent-identity Phase 4): DROP the legacy
  // `system_prompt` column. The column carries nothing live (identity moved
  // out of it in TASK-142, and into `agents_v1_identity` below in TASK-989).
  // `DROP COLUMN IF EXISTS` makes this idempotent + forward-only: a brand-new
  // DB never had the column (we removed it from CREATE TABLE above); an
  // already-deployed DB drops it here once.
  await sql`
    ALTER TABLE agents_v1_agents
      DROP COLUMN IF EXISTS system_prompt
  `.execute(db);

  // PR 2 of the provider-agnostic runner sequence
  // (docs/plans/2026-08-18-provider-agnostic-runner-design.md §1/§6):
  // per-agent runner selection. The value is an ID (`claude-sdk`), never a
  // path — the id → binary-path mapping lives in host config, so nothing
  // filesystem-shaped leaks into the row or the hook payload (Invariant I1).
  // NOT NULL DEFAULT backfills every existing row in one statement: before
  // this column there was exactly one runner, and it was the SDK one.
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS runner TEXT NOT NULL DEFAULT 'claude-sdk'
  `.execute(db);

  // Same PR: model ids become `provider/model-id` refs (design §6). Legacy
  // rows hold a bare Anthropic id, and there is deliberately NO runtime
  // "no slash means anthropic" fallback — the ambiguity the prefix removes
  // would come straight back. So the rewrite happens here, once, and the
  // `NOT LIKE '%/%'` guard makes it idempotent: an already-prefixed row (or
  // a nested `openrouter/x-ai/...` ref) is skipped, so re-running the
  // migration can never produce `anthropic/anthropic/...`.
  //
  // SCOPE: agent ROWS only. A session snapshot frozen before this deploy
  // (`session_v1`'s persisted agent_config_json) keeps its bare model and is
  // NOT rewritten — the runner's parseModelRef then rejects it and that turn
  // terminates. Deliberate: there is no runtime bare-id fallback by design,
  // and sessions are ephemeral, so the next conversation self-heals off the
  // migrated row. Worth knowing before a rolling upgrade with live sessions.
  await sql`
    UPDATE agents_v1_agents
       SET model = 'anthropic/' || model
     WHERE model NOT LIKE '%/%'
  `.execute(db);

  // TASK-989: the agent's identity and soul (how it describes itself), its
  // people's Instructions, and its onboarding state, one row per agent. Read
  // and written only through `agents:identity:get|set|complete-bootstrap`;
  // the queries live in identity/store.ts.
  //
  // Its own table, not columns on agents_v1_agents: `agents:resolve` and the
  // lists `selectAll` that table on every call, and these texts may reach
  // hundreds of KiB together.
  //
  // Rows are LAZY: an agent with no row reads as empty texts, `bootstrap =
  // 'none'` and `revision = 0` (that is also the reset for agents that existed
  // before this table: nothing is backfilled from their old files). A row
  // appears on the first saved write, or at create time for an agent that
  // starts a first-run setup (`bootstrap = 'pending'`).
  //
  // `revision` counts saved changes (an optimistic-concurrency token for
  // `agents:identity:set`, NOT a history: no old text is kept). INTEGER, not
  // BIGINT: node-postgres hands int8 back as a string.
  //
  // No FOREIGN KEY to agents_v1_agents, on purpose: a FK breaks every
  // downstream `DROP TABLE agents_v1_agents` teardown. `deleteById` purges the
  // row in the same transaction as the agent row instead, and
  // `bootstrap:reset-cleanup` truncates both tables.
  await sql`
    CREATE TABLE IF NOT EXISTS agents_v1_identity (
      agent_id     TEXT PRIMARY KEY,
      identity     TEXT NOT NULL DEFAULT '',
      soul         TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      bootstrap    TEXT NOT NULL DEFAULT 'none',
      revision     INTEGER NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT agents_v1_identity_bootstrap_check
        CHECK (bootstrap IN ('none', 'pending', 'done')),
      CONSTRAINT agents_v1_identity_revision_check
        CHECK (revision >= 0)
    )
  `.execute(db);
}

/**
 * Row shape — the JSONB columns deserialize to `unknown` until validated.
 * Store helpers parse/validate before returning to plugin code.
 */
export interface AgentsRow {
  agent_id: string;
  owner_id: string;
  owner_type: string;
  visibility: string;
  display_name: string;
  allowed_tools: unknown;
  mcp_config_ids: unknown;
  model: string;
  /** Runner id (`claude-sdk`), never a path. See the migration comment. */
  runner: string;
  workspace_ref: string | null;
  webhook_token: string | null;
  skill_attachments: unknown; // JSONB; validated by store
  connector_attachments: unknown; // JSONB; validated by store (TASK-107)
  connector_exclusions: unknown; // JSONB; validated by store (TASK-739)
  created_at: Date;
  updated_at: Date;
}

/**
 * `agents_v1_identity` row (TASK-989). Every column but the key has a default,
 * so an insert may name only `agent_id`. `bootstrap` is CHECKed to
 * 'none' | 'pending' | 'done'; identity/store.ts narrows it on read.
 */
export interface AgentsIdentityRow {
  agent_id: string;
  identity: Generated<string>;
  soul: Generated<string>;
  instructions: Generated<string>;
  bootstrap: Generated<string>;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}

export interface AgentsDatabase {
  agents_v1_agents: AgentsRow;
  agents_v1_identity: AgentsIdentityRow;
}
