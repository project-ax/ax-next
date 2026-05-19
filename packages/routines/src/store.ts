import { sql, type Kysely } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
import type { TriggerSpec, ActiveHours } from '@ax/validator-routine';
import type { FireRow, FireSource, FireStatus, RoutineRow } from './types.js';

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
  renderedPrompt?: string | null;
}

export interface UpsertDefaultInput {
  defaultRoutineId?: string;
  name: string;
  description: string;
  specHash: string;
  trigger: TriggerSpec;
  intervalSeconds: number | null;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
  sourceMd: string;
}

export interface DefaultRoutineDetailRow {
  defaultRoutineId: string;
  name: string;
  description: string;
  specHash: string;
  trigger: TriggerSpec;
  intervalSeconds: number | null;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
  enabled: boolean;
  sourceMd: string;
  updatedAt: Date;
}

export interface RoutinesStore {
  upsert(input: UpsertInput): Promise<{ changed: boolean }>;
  delete(input: { agentId: string; path: string }): Promise<void>;
  claimDue(input: ClaimInput): Promise<RoutineRow[]>;
  advance(input: AdvanceInput): Promise<void>;
  recordFire(input: RecordFireInput): Promise<number>;
  recentFires(input: { agentId: string; path: string; limit?: number }): Promise<FireRow[]>;
  list(input: { agentId?: string }): Promise<RoutineRow[]>;
  findOne(input: { agentId: string; path: string }): Promise<RoutineRow | null>;
  upsertDefault(input: UpsertDefaultInput): Promise<{ defaultRoutineId: string; created: boolean }>;
  getDefault(defaultRoutineId: string): Promise<DefaultRoutineDetailRow | null>;
  listDefaults(): Promise<DefaultRoutineDetailRow[]>;
  deleteDefault(defaultRoutineId: string): Promise<void>;
}

/**
 * Truncate `value` to at most `maxBytes` UTF-8 bytes (including a
 * trailing ellipsis). Uses TextEncoder.encode() length so multibyte
 * content (CJK, emoji) doesn't sneak past the cap. Binary-searches the
 * code-unit cut point; correct for surrogate pairs because slice() on
 * a string never splits a pair when called at a non-low-surrogate
 * position — and the binary search converges on a value where the
 * encoded length is <= maxBytes, so any split that would have produced
 * an unpaired surrogate is naturally rejected.
 *
 * Edge case: if maxBytes < 3 (smaller than the UTF-8 ellipsis itself),
 * return empty string. In practice MAX is 64 KiB so this never triggers,
 * but the guard keeps the function robust.
 */
function truncateUtf8(value: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(value).length <= maxBytes) return value;
  if (maxBytes < 3) return '';
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(`${value.slice(0, mid)}…`).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return `${value.slice(0, lo)}…`;
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
  definition_id: string | null;
  definition_updated_at: Date | null;
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
    definitionId: row.definition_id,
    definitionUpdatedAt: row.definition_updated_at,
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
        definition_id: string | null;
        definition_updated_at: Date | null;
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
      // L5: rendered prompt is post-substitution model-template output —
      // cap at 64 KiB defense-in-depth at the write boundary. The cap is
      // BYTES, not chars: code-unit-based truncation lets UTF-8 multibyte
      // content (CJK, emoji) sneak past the limit since one JS char can
      // be 3-4 bytes after encoding.
      const MAX = 64 * 1024;
      const raw = input.renderedPrompt ?? null;
      const renderedPrompt = raw !== null ? truncateUtf8(raw, MAX) : null;
      const row = await db.insertInto('routines_v1_fires').values({
        agent_id: input.agentId,
        path: input.path,
        trigger_source: input.triggerSource,
        conversation_id: input.conversationId,
        status: input.status,
        error: input.error,
        rendered_prompt: renderedPrompt,
      }).returning('id').executeTakeFirstOrThrow();
      return Number(row.id);
    },

    async recentFires(input) {
      const limit = Math.min(100, Math.max(1, input.limit ?? 20));
      const rows = await db
        .selectFrom('routines_v1_fires')
        .selectAll()
        .where('agent_id', '=', input.agentId)
        .where('path', '=', input.path)
        .orderBy('fired_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        id: Number(r.id),
        agentId: r.agent_id,
        path: r.path,
        firedAt: r.fired_at,
        triggerSource: r.trigger_source as FireSource,
        conversationId: r.conversation_id,
        status: r.status as FireStatus,
        error: r.error,
        renderedPrompt: r.rendered_prompt,
      }));
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

    async upsertDefault(input) {
      const existing = await db
        .selectFrom('default_routines_v1')
        .select(['default_routine_id'])
        .where('name', '=', input.name)
        .executeTakeFirst();
      if (existing === undefined) {
        const id = input.defaultRoutineId ?? `default-${input.name}-${Date.now()}`;
        await db.insertInto('default_routines_v1').values({
          default_routine_id: id,
          name: input.name,
          description: input.description,
          spec_hash: input.specHash,
          trigger_kind: input.trigger.kind as 'interval',
          trigger_spec: input.trigger as unknown,
          interval_seconds: input.intervalSeconds,
          active_hours: input.activeHours as unknown,
          silence_token: input.silenceToken,
          silence_max: input.silenceMax,
          conversation: input.conversation,
          prompt_body: input.promptBody,
          enabled: true,
          source_md: input.sourceMd,
        }).execute();
        return { defaultRoutineId: id, created: true };
      }
      await db.updateTable('default_routines_v1')
        .set({
          description: input.description,
          spec_hash: input.specHash,
          trigger_kind: input.trigger.kind as 'interval',
          trigger_spec: input.trigger as unknown,
          interval_seconds: input.intervalSeconds,
          active_hours: input.activeHours as unknown,
          silence_token: input.silenceToken,
          silence_max: input.silenceMax,
          conversation: input.conversation,
          prompt_body: input.promptBody,
          source_md: input.sourceMd,
          updated_at: sql`now()` as unknown as Date,
        })
        .where('default_routine_id', '=', existing.default_routine_id)
        .execute();
      return { defaultRoutineId: existing.default_routine_id, created: false };
    },

    async getDefault(defaultRoutineId) {
      const row = await db
        .selectFrom('default_routines_v1')
        .selectAll()
        .where('default_routine_id', '=', defaultRoutineId)
        .executeTakeFirst();
      return row === undefined ? null : defaultRowToDetail(row);
    },

    async listDefaults() {
      const rows = await db
        .selectFrom('default_routines_v1')
        .selectAll()
        .orderBy('name')
        .execute();
      return rows.map(defaultRowToDetail);
    },

    async deleteDefault(defaultRoutineId) {
      // FK ON DELETE CASCADE on routines_v1_definitions.definition_id
      // drops dependent per-agent rows.
      await db.deleteFrom('default_routines_v1')
        .where('default_routine_id', '=', defaultRoutineId)
        .execute();
    },
  };
}

function defaultRowToDetail(row: {
  default_routine_id: string;
  name: string;
  description: string;
  spec_hash: string;
  trigger_spec: unknown;
  interval_seconds: number | null;
  active_hours: unknown | null;
  silence_token: string | null;
  silence_max: number;
  conversation: string;
  prompt_body: string;
  enabled: boolean;
  source_md: string;
  updated_at: Date;
}): DefaultRoutineDetailRow {
  return {
    defaultRoutineId: row.default_routine_id,
    name: row.name,
    description: row.description,
    specHash: row.spec_hash,
    trigger: row.trigger_spec as TriggerSpec,
    intervalSeconds: row.interval_seconds,
    activeHours: row.active_hours as ActiveHours | null,
    silenceToken: row.silence_token,
    silenceMax: row.silence_max,
    conversation: row.conversation as 'per-fire' | 'shared',
    promptBody: row.prompt_body,
    enabled: row.enabled,
    sourceMd: row.source_md,
    updatedAt: row.updated_at,
  };
}
