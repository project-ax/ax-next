import { sql, type Generated, type Kysely } from 'kysely';

/**
 * Per-plugin migration. @ax/agents owns tables under the `agents_v1_`
 * prefix — never reach into them from another plugin (Invariant I4 — one
 * source of truth per concept). Every statement runs on every boot, so each
 * one is forward-only and safe to re-run: new tables (`IF NOT EXISTS`),
 * additive columns (`ADD COLUMN IF NOT EXISTS`), idempotent rewrites, and
 * drops of columns nothing reads any more (`DROP COLUMN IF EXISTS`).
 *
 * Tables:
 *   agents_v1_agents    — agent entity, owned by user_id OR team_id.
 *   agents_v1_identity  — the agent's identity, soul, its people's
 *                         Instructions and its onboarding state (TASK-989),
 *                         and when the agent itself last changed its identity
 *                         or its soul (TASK-990).
 *   agents_v1_owners    — a personal agent's owners, creator first (TASK-1246).
 *   agents_v1_audience_members
 *                       — the people a `list` audience names (TASK-1246).
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

  // Per-agent sandbox settings: turn limit and idle timeout in minutes, and
  // the runner's size as JSONB ({cpuMillis?, memoryMiB?} request/limit pairs).
  // Additive and nullable: NULL (what every existing row reads as) means "use
  // the chart default". Shape is checked on write; the chart's caps clamp at
  // use, never on read.
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS turn_limit_minutes INTEGER
  `.execute(db);
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS idle_minutes INTEGER
  `.execute(db);
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS runner_size JSONB
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

  // TASK-995: DROP the `workspace_ref` column the same way. It was an opaque
  // pointer at the agent's version-controlled workspace, a tier TASK-995
  // deletes, and nothing ever read it (the orchestrator left it unconsumed).
  // It is out of CREATE TABLE above, so a brand-new DB never has it; an
  // already-deployed DB drops it here once, and every later boot is a no-op.
  await sql`
    ALTER TABLE agents_v1_agents
      DROP COLUMN IF EXISTS workspace_ref
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

  // TASK-990: the last time the agent itself changed this section, outside
  // first-run setup; not a history. Each column holds one instant, which the
  // agent's next change to that section overwrites, and no text. It is written
  // in the same UPDATE as the text, and only for a saved
  // `agents:identity:set` with `author: 'agent'` (which only the agent's own
  // update_identity tool sends), so a person's save never sets it.
  // `agents:identity:self-changes-for-user` lists the recent ones on the
  // owner's Today. NULL means the agent never changed that section, and is
  // what every row written before this column reads as.
  await sql`
    ALTER TABLE agents_v1_identity
      ADD COLUMN IF NOT EXISTS identity_changed_by_agent_at TIMESTAMPTZ
  `.execute(db);
  await sql`
    ALTER TABLE agents_v1_identity
      ADD COLUMN IF NOT EXISTS soul_changed_by_agent_at TIMESTAMPTZ
  `.execute(db);

  // TASK-1246 (sharing phase 1A): who can use a personal agent besides its
  // owners. `just-me` is today's personal agent, the default, and what every
  // existing row reads as. `everyone` is every AX account. `list` is the people
  // in agents_v1_audience_members below. A team agent's row keeps the default
  // and nothing reads it: a team agent's members use it.
  //
  // A domain enum CHECKed in SQL, like owner_type and visibility, so a logic bug
  // can't store an audience nothing knows how to check. store.ts refuses an
  // unknown value on read too: an audience fails closed. The named CHECK rides
  // on ADD COLUMN IF NOT EXISTS, so a later boot that finds the column skips
  // the whole clause, constraint included (the run-twice test pins this).
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'just-me'
      CONSTRAINT agents_v1_audience_check CHECK (audience IN ('just-me', 'everyone', 'list'))
  `.execute(db);

  // TASK-1246: a personal agent's owners, the people who may change it and who
  // can use it. The creator (`owner_id`) is the first one, so `owner_id` keeps
  // naming the creator, and phase 1 never removes the creator. Team agents have
  // no rows here in phase 1.
  //
  // Indexed on user_id for "the agents this person owns". No FOREIGN KEY to
  // agents_v1_agents, for the same teardown reason as agents_v1_identity:
  // `deleteById` purges these rows in the agent's own transaction, and
  // `bootstrap:reset-cleanup` truncates them.
  await sql`
    CREATE TABLE IF NOT EXISTS agents_v1_owners (
      agent_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_id, user_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS agents_v1_owners_user ON agents_v1_owners (user_id)
  `.execute(db);

  // TASK-1246: the people a `list` audience names. Rows exist only while the
  // agent's audience is `list`: every audience write deletes them all, in the
  // same transaction, before it inserts a new list. A row that outlived its
  // list must never grant anything.
  //
  // `member_type` allows 'group' as well as 'user', although nothing writes or
  // reads a group yet. That leaves room for phase 2's groups without a
  // constraint migration, and a rollback from phase 2 then leaves no row this
  // CHECK refuses. Indexed on (member_type, member_id) for "the agents that
  // list this person". No FOREIGN KEY, for the reason above.
  await sql`
    CREATE TABLE IF NOT EXISTS agents_v1_audience_members (
      agent_id    TEXT NOT NULL,
      member_type TEXT NOT NULL,
      member_id   TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_id, member_type, member_id),
      CONSTRAINT agents_v1_audience_member_type_check CHECK (member_type IN ('user', 'group'))
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS agents_v1_audience_members_member
      ON agents_v1_audience_members (member_type, member_id)
  `.execute(db);

  // TASK-1246: every personal agent made before owners existed gets its
  // creator as its first owner. Runs on every boot and is idempotent: it only
  // touches an agent with NO owner row at all, not one whose creator row is
  // missing, so a later phase that lets the creator step down can't have this
  // add them back. ON CONFLICT covers the gap between the NOT EXISTS and the
  // insert. Team agents get no owner rows in phase 1.
  await sql`
    INSERT INTO agents_v1_owners (agent_id, user_id)
    SELECT a.agent_id, a.owner_id FROM agents_v1_agents a
     WHERE a.owner_type = 'user'
       AND NOT EXISTS (SELECT 1 FROM agents_v1_owners o WHERE o.agent_id = a.agent_id)
    ON CONFLICT DO NOTHING
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
  webhook_token: string | null;
  skill_attachments: unknown; // JSONB; validated by store
  connector_attachments: unknown; // JSONB; validated by store (TASK-107)
  connector_exclusions: unknown; // JSONB; validated by store (TASK-739)
  turn_limit_minutes: number | null;
  idle_minutes: number | null;
  runner_size: unknown; // JSONB | null; validated by store
  /**
   * TASK-1246: who can use a personal agent besides its owners. CHECKed to
   * 'just-me' | 'everyone' | 'list'; store.ts narrows it on read.
   */
  audience: string;
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
  /** TASK-990: when the agent itself last changed its identity (see the migration). */
  identity_changed_by_agent_at: Generated<Date | null>;
  /** TASK-990: when the agent itself last changed its soul (see the migration). */
  soul_changed_by_agent_at: Generated<Date | null>;
}

/** `agents_v1_owners` row (TASK-1246): one per (agent, owner). */
export interface AgentsOwnerRow {
  agent_id: string;
  user_id: string;
  created_at: Generated<Date>;
}

/**
 * `agents_v1_audience_members` row (TASK-1246): one per (agent, member).
 * `member_type` is CHECKed to 'user' | 'group'; phase 1 writes and reads only
 * 'user'.
 */
export interface AgentsAudienceMemberRow {
  agent_id: string;
  member_type: string;
  member_id: string;
  created_at: Generated<Date>;
}

export interface AgentsDatabase {
  agents_v1_agents: AgentsRow;
  agents_v1_identity: AgentsIdentityRow;
  agents_v1_owners: AgentsOwnerRow;
  agents_v1_audience_members: AgentsAudienceMemberRow;
}
