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
  /**
   * Operator-only global kill-switch for the default routine. Out-of-band from
   * the routine markdown (NOT a frontmatter field) — it gates whether the
   * default materializes/fires for ANY agent. When provided, it is applied on
   * both INSERT and the ON CONFLICT UPDATE path, so an operator can flip a
   * seeded default's global `enabled` true↔false. When omitted, INSERT defaults
   * to `true` and the UPDATE path leaves the existing flag untouched — a routine
   * spec re-upsert (which carries no `enabled`) must never silently flip the
   * kill-switch.
   */
  enabled?: boolean;
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
  /**
   * Materialize one row per (agent, enabled default) pair, stamping
   * `author_user_id = ownerUserId` per agent. The owner id is the
   * identity that `fire.ts` passes to `agents:resolve`'s ACL gate —
   * the gate has no concept of a system actor, so a synthetic
   * '@ax/routines/defaults' string here would fail every fire as
   * forbidden. Team agents are excluded upstream (see
   * `agents:list-personal-owners`); routing a default fire under a
   * team is a separate policy decision.
   */
  materializeMissing(input: {
    agents: ReadonlyArray<{ agentId: string; ownerUserId: string }>;
    now: Date;
  }): Promise<void>;
  refreshStale(input: { now: Date }): Promise<void>;
  /**
   * Set whether `defaultRoutineId` is enabled for `agentId`. The override
   * table stores only explicit DISABLES — `enabled=true` DELETEs any disable
   * row (restoring the default-ON state), `enabled=false` upserts a disable
   * row. De/re-materialization is the caller's job (the hook), because it
   * needs an owner identity for re-materialize; this method only records the
   * intent.
   */
  setAgentDefaultEnabled(input: {
    agentId: string;
    defaultRoutineId: string;
    ownerUserId: string;
    enabled: boolean;
  }): Promise<void>;
  /** True unless an explicit disable override exists (absence = enabled). */
  isAgentDefaultEnabled(input: { agentId: string; defaultRoutineId: string }): Promise<boolean>;
  /** The default-routine ids explicitly disabled for `agentId`. */
  disabledDefaultIdsForAgent(agentId: string): Promise<string[]>;
  /**
   * Drop the materialized per-agent row for `(agentId, defaultRoutineId)`.
   * The materialized row carries no enabled/active flag (schema check: rows
   * are present-or-absent), so this is a DELETE. Fire history in
   * routines_v1_fires has no FK to definitions, so it is preserved.
   */
  removeMaterializedDefault(input: { agentId: string; defaultRoutineId: string }): Promise<void>;
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
      // Two-branch claim:
      //
      // Branch 1 — workspace rows: definition_id IS NULL, claim by
      //   next_run_at <= now, supports interval and cron.
      //
      // Branch 2 — default-sourced rows: definition_id IS NOT NULL,
      //   claim by COALESCE(last_run_at, created_at) + interval <= now.
      //   v1 supports interval only (default_routines_v1 CHECK enforces).
      //   Excluded if:
      //     - the source default has been edited but per-agent copy is
      //       not yet refreshed (definition_updated_at < d.updated_at)
      //     - a same-name workspace row exists for the same agent
      //       (override). Workspace wins.
      //
      // The UPDATE keeps next_run_at NULL on default-sourced rows (CASE
      // branch); only workspace rows advance their next_run_at by the
      // claim window.
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
        WITH workspace_due AS (
          SELECT agent_id, path
            FROM routines_v1_definitions
           WHERE definition_id IS NULL
             AND next_run_at IS NOT NULL
             AND next_run_at <= ${input.now}
             AND trigger_kind IN ('interval', 'cron')
           ORDER BY next_run_at ASC
           LIMIT ${input.limit}
           FOR UPDATE SKIP LOCKED
        ),
        default_due AS (
          SELECT r.agent_id, r.path
            FROM routines_v1_definitions r
            JOIN default_routines_v1 d ON d.default_routine_id = r.definition_id
           WHERE r.definition_id IS NOT NULL
             AND d.enabled
             AND d.trigger_kind = 'interval'
             AND r.definition_updated_at IS NOT NULL
             AND r.definition_updated_at >= d.updated_at
             AND COALESCE(r.last_run_at, r.created_at)
                 + (d.interval_seconds || ' seconds')::interval <= ${input.now}
             AND NOT EXISTS (
               SELECT 1 FROM routines_v1_definitions w
                WHERE w.agent_id = r.agent_id
                  AND w.definition_id IS NULL
                  AND w.name = r.name
             )
           ORDER BY r.last_run_at NULLS FIRST
           LIMIT ${input.limit}
           FOR UPDATE OF r SKIP LOCKED
        ),
        due AS (
          SELECT agent_id, path FROM workspace_due
          UNION ALL
          SELECT agent_id, path FROM default_due
          -- total cap across both branches; per-branch LIMITs bound lock acquisition
          LIMIT ${input.limit}
        )
        UPDATE routines_v1_definitions r
           SET next_run_at = CASE
             WHEN r.definition_id IS NULL
               THEN r.next_run_at + (${input.claimWindowMinutes} || ' minutes')::interval
             ELSE r.next_run_at
           END
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
      // Single atomic INSERT … ON CONFLICT DO UPDATE to avoid TOCTOU race
      // between SELECT and INSERT/UPDATE in concurrent callers.
      // (xmax = 0) is true for freshly INSERTed rows and false for UPDATEd rows —
      // that's how we report `created` without a separate SELECT.
      const id = input.defaultRoutineId ?? `default-${input.name}-${Date.now()}`;
      // The global `enabled` flag is an operator-only kill-switch, not part of
      // the routine spec. On INSERT we default to `true` unless the caller is
      // explicitly setting it. On the ON CONFLICT UPDATE path we ONLY touch
      // `enabled` when the caller passed it — a plain routine-spec re-upsert
      // (no `enabled`) must leave a seeded default's kill-switch alone (else
      // every spec edit would silently re-enable a deliberately-off default).
      const insertEnabled = input.enabled ?? true;
      const enabledUpdateFragment =
        input.enabled === undefined ? sql`` : sql`enabled = EXCLUDED.enabled,`;
      const row = await sql<{ default_routine_id: string; created: boolean }>`
        INSERT INTO default_routines_v1
          (default_routine_id, name, description, spec_hash, trigger_kind, trigger_spec,
           interval_seconds, active_hours, silence_token, silence_max, conversation,
           prompt_body, enabled, source_md)
        VALUES
          (${id}, ${input.name}, ${input.description}, ${input.specHash},
           ${input.trigger.kind}, ${JSON.stringify(input.trigger)}::jsonb,
           ${input.intervalSeconds}, ${input.activeHours === null ? null : JSON.stringify(input.activeHours)}::jsonb,
           ${input.silenceToken}, ${input.silenceMax}, ${input.conversation},
           ${input.promptBody}, ${insertEnabled}, ${input.sourceMd})
        ON CONFLICT (name) DO UPDATE SET
          description = EXCLUDED.description,
          spec_hash = EXCLUDED.spec_hash,
          trigger_kind = EXCLUDED.trigger_kind,
          trigger_spec = EXCLUDED.trigger_spec,
          interval_seconds = EXCLUDED.interval_seconds,
          active_hours = EXCLUDED.active_hours,
          silence_token = EXCLUDED.silence_token,
          silence_max = EXCLUDED.silence_max,
          conversation = EXCLUDED.conversation,
          prompt_body = EXCLUDED.prompt_body,
          ${enabledUpdateFragment}
          source_md = EXCLUDED.source_md,
          updated_at = now()
        RETURNING default_routine_id, (xmax = 0) AS created
      `.execute(db);
      const r = row.rows[0];
      if (!r) throw new Error('upsertDefault: INSERT … RETURNING returned no row');
      return { defaultRoutineId: r.default_routine_id, created: r.created };
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

    async materializeMissing(input) {
      if (input.agents.length === 0) return;
      // INSERT … SELECT cross-joins agents with all enabled defaults,
      // filtering out (agent, default) pairs that already have a
      // materialized row. ON CONFLICT (agent_id, path) DO NOTHING makes
      // this safe under concurrent materializers — the path encodes the
      // default id, so two materializers racing on the same agent will
      // not duplicate.
      //
      // author_user_id is the owner user id (a.owner_user_id), not a
      // synthetic system actor: fire.ts:51 passes this through to
      // agents:resolve, whose ACL gate requires a real user id. See
      // bug write-up in 2026-05-19 MANUAL-ACCEPTANCE walk.
      //
      // next_run_at is NULL for default-sourced rows: the claim SQL
      // computes due-ness from last_run_at + interval, and the CHECK
      // constraint routines_v1_default_next_run_at_chk forbids a non-null
      // next_run_at for default_id IS NOT NULL.
      const agentIds = input.agents.map((a) => a.agentId);
      const ownerIds = input.agents.map((a) => a.ownerUserId);
      await sql`
        INSERT INTO routines_v1_definitions
          (agent_id, path, author_user_id, name, description, spec_hash,
           trigger_kind, trigger_spec, active_hours, silence_token, silence_max,
           conversation, prompt_body, next_run_at, definition_id, definition_updated_at,
           created_at, updated_at)
        SELECT
          a.agent_id, 'default:' || d.default_routine_id, a.owner_user_id,
          d.name, d.description, d.spec_hash,
          d.trigger_kind, d.trigger_spec, d.active_hours, d.silence_token, d.silence_max,
          d.conversation, d.prompt_body, NULL,
          d.default_routine_id, d.updated_at,
          ${input.now}, ${input.now}
        FROM unnest(${agentIds}::text[], ${ownerIds}::text[])
          AS a(agent_id, owner_user_id)
        CROSS JOIN default_routines_v1 d
        WHERE d.enabled
          AND NOT EXISTS (
            SELECT 1 FROM routines_v1_definitions r
             WHERE r.agent_id = a.agent_id
               AND r.definition_id = d.default_routine_id
          )
          -- TASK-177: skip (agent, default) pairs the agent owner has
          -- explicitly disabled. Absence of an override row = enabled, so
          -- this NOT EXISTS keeps the default-ON behavior for every pair
          -- without an override.
          AND NOT EXISTS (
            SELECT 1 FROM agent_default_routine_overrides_v1 o
             WHERE o.agent_id = a.agent_id
               AND o.default_routine_id = d.default_routine_id
               AND o.enabled = false
          )
        ON CONFLICT (agent_id, path) DO NOTHING
      `.execute(db);
    },

    async refreshStale(input) {
      // Refresh denormalized fields on all default-sourced per-agent rows
      // whose copy is older than the source default. Runs unconditionally
      // before each tick — the WHERE clause makes it a no-op when nothing
      // is stale.
      await sql`
        UPDATE routines_v1_definitions r
           SET name = d.name,
               description = d.description,
               spec_hash = d.spec_hash,
               trigger_kind = d.trigger_kind,
               trigger_spec = d.trigger_spec,
               active_hours = d.active_hours,
               silence_token = d.silence_token,
               silence_max = d.silence_max,
               conversation = d.conversation,
               prompt_body = d.prompt_body,
               definition_updated_at = d.updated_at,
               updated_at = ${input.now}
          FROM default_routines_v1 d
         WHERE r.definition_id = d.default_routine_id
           AND (r.definition_updated_at IS NULL
                OR r.definition_updated_at < d.updated_at)
      `.execute(db);
    },

    async setAgentDefaultEnabled(input) {
      if (input.enabled) {
        // Enabled is the default (absence = on) — drop any disable row.
        await db.deleteFrom('agent_default_routine_overrides_v1')
          .where('agent_id', '=', input.agentId)
          .where('default_routine_id', '=', input.defaultRoutineId)
          .execute();
        return;
      }
      // Disable: upsert an explicit override row. Atomic INSERT … ON CONFLICT
      // avoids a TOCTOU race between a SELECT and the write.
      await sql`
        INSERT INTO agent_default_routine_overrides_v1
          (agent_id, default_routine_id, owner_user_id, enabled, updated_at)
        VALUES
          (${input.agentId}, ${input.defaultRoutineId}, ${input.ownerUserId}, false, now())
        ON CONFLICT (agent_id, default_routine_id) DO UPDATE SET
          owner_user_id = EXCLUDED.owner_user_id,
          enabled = EXCLUDED.enabled,
          updated_at = now()
      `.execute(db);
    },

    async isAgentDefaultEnabled(input) {
      const row = await db
        .selectFrom('agent_default_routine_overrides_v1')
        .select(['enabled'])
        .where('agent_id', '=', input.agentId)
        .where('default_routine_id', '=', input.defaultRoutineId)
        .executeTakeFirst();
      // Absence = enabled. A present row reports its own flag (only `false`
      // is ever written today, but honor the stored value either way).
      return row === undefined ? true : row.enabled;
    },

    async disabledDefaultIdsForAgent(agentId) {
      const rows = await db
        .selectFrom('agent_default_routine_overrides_v1')
        .select(['default_routine_id'])
        .where('agent_id', '=', agentId)
        .where('enabled', '=', false)
        .execute();
      return rows.map((r) => r.default_routine_id);
    },

    async removeMaterializedDefault(input) {
      await db.deleteFrom('routines_v1_definitions')
        .where('agent_id', '=', input.agentId)
        .where('definition_id', '=', input.defaultRoutineId)
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
