import { sql, type Kysely } from 'kysely';

/**
 * Per-plugin migration. `@ax/tool-policy` owns tables under the
 * `tool_policy_v1_` prefix — never reach into them from another plugin
 * (invariant 4, one source of truth per concept). Additive-only, idempotent,
 * re-run on every boot.
 *
 * NO CROSS-PLUGIN FOREIGN KEYS, deliberately, same as `@ax/decisions`.
 * `owner_user_id` is an opaque scoping key, not a reference: a FK onto
 * `auth_better_v1_*` or `agents_v1_*` would drag this table into the shared
 * DROP-TABLE order used by repo-wide test teardown, and that breakage only
 * shows up on a full-repo run. An entry owned by a deleted user is simply
 * never read.
 */
export async function runToolPolicyMigration<DB>(db: Kysely<DB>): Promise<void> {
  // The egress allowlist (TASK-330): hosts `web_extract` may be pointed at
  // without stopping to ask.
  //
  // `owner_user_id` IS NOT NULLABLE, and `''` is the global sentinel. The type
  // (`EgressAllowlistEntry.ownerId`) models global as `null`, which is the
  // honest shape in TypeScript — but a Postgres PRIMARY KEY column cannot hold
  // NULL, and a partial unique index over `scope = 'global'` would be a second
  // uniqueness rule to keep in step with the first. One sentinel, converted at
  // exactly one place (`store.ts`'s `ownerKey`), is the smaller surface.
  // `''` is safe as a sentinel because a user id is never empty — the same
  // shape check that guards `scope: 'user'` writes rejects it.
  await sql`
    CREATE TABLE IF NOT EXISTS tool_policy_v1_egress_allowlist (
      scope         TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      host          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (scope, owner_user_id, host)
    )
  `.execute(db);
}

export interface EgressAllowlistRow {
  scope: string;
  owner_user_id: string;
  host: string;
  created_at: Date;
}

export interface ToolPolicyDatabase {
  tool_policy_v1_egress_allowlist: EgressAllowlistRow;
}
