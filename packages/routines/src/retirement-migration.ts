import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
import { SKILL_REFLECTION_PROMPT, SKILL_REFLECTION_SEED_HASH, SKILL_REFLECTION_STRATA_SEED_HASH } from './reflection-prompt.js';

/** Called only while the legacy path column exists, inside the version transaction. */
export async function retireAuthoredRoutines(db: Kysely<RoutinesDatabase>): Promise<void> {
  // Preserve the old seed guards BEFORE removing the markdown column.
  await sql`UPDATE default_routines_v1 d SET prompt_body=${SKILL_REFLECTION_PROMPT},
    spec_hash=${SKILL_REFLECTION_SEED_HASH}, updated_at=now(),
    enabled=d.enabled OR EXISTS (SELECT 1 FROM routines_v1_fires f WHERE f.path='default:' || d.default_routine_id)
    WHERE d.name='skill-reflection' AND d.spec_hash=${SKILL_REFLECTION_STRATA_SEED_HASH} AND d.source_md='seed'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS routines_v1_credential_cleanup (
    agent_id text NOT NULL, routine_id text NOT NULL, credential_ref text NOT NULL,
    owner_user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(agent_id,credential_ref)
  )`.execute(db);
  // Never trust legacy trigger JSON's secretRef: only this exact owned family is retired.
  await sql`INSERT INTO routines_v1_credential_cleanup (agent_id,routine_id,credential_ref,owner_user_id)
    SELECT agent_id,path,'routine:' || agent_id || ':' || path || ':hmac',owner_user_id
    FROM routines_v1_definitions WHERE definition_id IS NULL AND trigger_kind='webhook' AND trigger_spec ? 'hmac'
    ON CONFLICT DO NOTHING`.execute(db);
  // Default history can outlive its catalog entry; its reserved identity is sufficient.
  await sql`DELETE FROM routines_v1_fires f WHERE f.path NOT LIKE 'default:%' AND NOT EXISTS (
    SELECT 1 FROM routines_v1_definitions r WHERE r.agent_id=f.agent_id AND r.path=f.path AND r.definition_id IS NOT NULL
  )`.execute(db);
  await sql`DELETE FROM routines_v1_definitions WHERE definition_id IS NULL`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions RENAME COLUMN path TO routine_id`.execute(db);
  await sql`ALTER TABLE routines_v1_fires RENAME COLUMN path TO routine_id`.execute(db);
  await sql`ALTER TABLE default_routines_v1 DROP COLUMN source_md`.execute(db);
  await sql`ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS revision text NOT NULL DEFAULT 'initial', ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true`.execute(db);
  const rows = await db.selectFrom('routines_v1_definitions').select(['agent_id', 'routine_id']).execute();
  for (const row of rows) await db.updateTable('routines_v1_definitions').set({ revision: `rev_${randomUUID().replaceAll('-', '')}` }).where('agent_id', '=', row.agent_id).where('routine_id', '=', row.routine_id).execute();
  await sql`ALTER TABLE routines_v1_definitions ALTER COLUMN revision DROP DEFAULT`.execute(db);
}
