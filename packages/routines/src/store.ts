import { sql, type Kysely } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
import type { TriggerSpec, ActiveHours } from '@ax/validator-routine';
import type { FireSource, FireStatus, RoutineRow } from './types.js';

export interface UpsertInput {
  agentId: string;
  path: string;
  authorUserId: string;
  name: string;
  description: string;
  specHash: string;
  trigger: TriggerSpec;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
  nextRunAt: Date | null;
}

export interface AdvanceInput {
  agentId: string;
  path: string;
  nextRunAt: Date | null;
  lastRunAt: Date;
  lastStatus: FireStatus;
  lastError: string | null;
}

export interface ClaimInput {
  now: Date;
  limit: number;
  claimWindowMinutes: number;
}

export interface RecordFireInput {
  agentId: string;
  path: string;
  triggerSource: FireSource;
  conversationId: string | null;
  status: FireStatus;
  error: string | null;
}

export interface RoutinesStore {
  upsert(input: UpsertInput): Promise<{ changed: boolean }>;
  delete(input: { agentId: string; path: string }): Promise<void>;
  claimDue(input: ClaimInput): Promise<RoutineRow[]>;
  advance(input: AdvanceInput): Promise<void>;
  recordFire(input: RecordFireInput): Promise<number>;
  list(input: { agentId?: string }): Promise<RoutineRow[]>;
  findOne(input: { agentId: string; path: string }): Promise<RoutineRow | null>;
}

function rowToRoutine(row: {
  agent_id: string; path: string; author_user_id: string;
  name: string; description: string; spec_hash: string;
  trigger_kind: string; trigger_spec: unknown;
  active_hours: unknown | null;
  silence_token: string | null; silence_max: number;
  conversation: string; prompt_body: string;
  next_run_at: Date | null; last_run_at: Date | null;
  last_status: string | null; last_error: string | null;
}): RoutineRow {
  return {
    agentId: row.agent_id,
    path: row.path,
    authorUserId: row.author_user_id,
    name: row.name,
    description: row.description,
    specHash: row.spec_hash,
    trigger: row.trigger_spec as TriggerSpec,
    activeHours: row.active_hours as ActiveHours | null,
    silenceToken: row.silence_token,
    silenceMaxChars: row.silence_max,
    conversation: row.conversation as 'per-fire' | 'shared',
    promptBody: row.prompt_body,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as FireStatus | null,
    lastError: row.last_error,
  };
}

export function createRoutinesStore(db: Kysely<RoutinesDatabase>): RoutinesStore {
  return {
    async upsert(input) {
      return db.transaction().execute(async (trx) => {
        const prior = await trx
          .selectFrom('routines_v1_definitions')
          .select(['spec_hash'])
          .where('agent_id', '=', input.agentId)
          .where('path', '=', input.path)
          .executeTakeFirst();

        await trx.insertInto('routines_v1_definitions').values({
          agent_id: input.agentId,
          path: input.path,
          author_user_id: input.authorUserId,
          name: input.name,
          description: input.description,
          spec_hash: input.specHash,
          trigger_kind: input.trigger.kind,
          trigger_spec: input.trigger as unknown,
          active_hours: input.activeHours as unknown,
          silence_token: input.silenceToken,
          silence_max: input.silenceMax,
          conversation: input.conversation,
          prompt_body: input.promptBody,
          next_run_at: input.nextRunAt,
        }).onConflict((oc) => oc
          .columns(['agent_id', 'path'])
          .doUpdateSet((eb) => ({
            author_user_id: eb.ref('excluded.author_user_id'),
            name: eb.ref('excluded.name'),
            description: eb.ref('excluded.description'),
            trigger_kind: eb.ref('excluded.trigger_kind'),
            trigger_spec: eb.ref('excluded.trigger_spec'),
            active_hours: eb.ref('excluded.active_hours'),
            silence_token: eb.ref('excluded.silence_token'),
            silence_max: eb.ref('excluded.silence_max'),
            conversation: eb.ref('excluded.conversation'),
            prompt_body: eb.ref('excluded.prompt_body'),
            next_run_at: sql`CASE
              WHEN routines_v1_definitions.spec_hash IS DISTINCT FROM excluded.spec_hash
              THEN excluded.next_run_at
              ELSE routines_v1_definitions.next_run_at
            END`,
            spec_hash: eb.ref('excluded.spec_hash'),
            updated_at: sql`now()`,
          }))
        ).execute();

        const changed = prior === undefined || prior.spec_hash !== input.specHash;
        return { changed };
      });
    },

    async delete(input) {
      await db.deleteFrom('routines_v1_definitions')
        .where('agent_id', '=', input.agentId)
        .where('path', '=', input.path)
        .execute();
    },

    async claimDue(input) {
      const rows = await sql<{
        agent_id: string; path: string; author_user_id: string;
        name: string; description: string; spec_hash: string;
        trigger_kind: string; trigger_spec: unknown;
        active_hours: unknown | null;
        silence_token: string | null; silence_max: number;
        conversation: string; prompt_body: string;
        next_run_at: Date | null; last_run_at: Date | null;
        last_status: string | null; last_error: string | null;
      }>`
        WITH due AS (
          SELECT agent_id, path
            FROM routines_v1_definitions
           WHERE next_run_at IS NOT NULL
             AND next_run_at <= ${input.now}
             AND trigger_kind IN ('interval', 'cron')
           ORDER BY next_run_at ASC
           LIMIT ${input.limit}
           FOR UPDATE SKIP LOCKED
        )
        UPDATE routines_v1_definitions r
           SET next_run_at = r.next_run_at + (${input.claimWindowMinutes} || ' minutes')::interval
          FROM due
         WHERE r.agent_id = due.agent_id AND r.path = due.path
        RETURNING r.*
      `.execute(db);
      return rows.rows.map(rowToRoutine);
    },

    async advance(input) {
      await db.updateTable('routines_v1_definitions')
        .set({
          next_run_at: input.nextRunAt,
          last_run_at: input.lastRunAt,
          last_status: input.lastStatus,
          last_error: input.lastError,
          updated_at: sql`now()`,
        })
        .where('agent_id', '=', input.agentId)
        .where('path', '=', input.path)
        .execute();
    },

    async recordFire(input) {
      const row = await db.insertInto('routines_v1_fires').values({
        agent_id: input.agentId,
        path: input.path,
        trigger_source: input.triggerSource,
        conversation_id: input.conversationId,
        status: input.status,
        error: input.error,
      }).returning('id').executeTakeFirstOrThrow();
      return Number(row.id);
    },

    async list(input) {
      let q = db.selectFrom('routines_v1_definitions').selectAll();
      if (input.agentId !== undefined) q = q.where('agent_id', '=', input.agentId);
      const rows = await q.orderBy('agent_id').orderBy('path').execute();
      return rows.map(rowToRoutine);
    },

    async findOne(input) {
      const row = await db
        .selectFrom('routines_v1_definitions')
        .selectAll()
        .where('agent_id', '=', input.agentId)
        .where('path', '=', input.path)
        .executeTakeFirst();
      return row === undefined ? null : rowToRoutine(row as Parameters<typeof rowToRoutine>[0]);
    },
  };
}
