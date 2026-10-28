import { SafeToolError } from '@ax/core';
import { type RoutineKey, type RoutineWebhookStatus, WebhookRefusalReasonSchema, type WebhookRefusalReason } from '@ax/routines-contract';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import type { RoutinesDatabase, RoutinesDefinitionsRow } from './migrations.js';
import type { StoredRoutine } from './types.js';
import { serializeAdmission } from './admission-order.js';
import { webhookAddressMatches, type WebhookAddressProof } from './webhook-address.js';

const Counts = z.record(WebhookRefusalReasonSchema, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const Health = z.object({ lastAcceptedAt: z.string().nullable(), signatureChecked: z.boolean(), verifiedAt: z.string().nullable(), buckets: z.array(z.object({ minute: z.number().int(), counts: Counts })).max(60) });
type State = z.infer<typeof Health>;
type Raw = Selectable<RoutinesDefinitionsRow>;
type DB = Kysely<RoutinesDatabase>;
export type WebhookObservation = 'accepted' | 'verified' | WebhookRefusalReason;
const minuteAt = (now: Date) => Math.floor(now.getTime() / 60000);
const windowAt = (now: Date) => minuteAt(now) - 59;
function state(raw: unknown, now: Date): State {
  const parsed = Health.safeParse(raw);
  const value = parsed.success ? parsed.data : { lastAcceptedAt: null, signatureChecked: false, verifiedAt: null, buckets: [] };
  return { ...value, buckets: value.buckets.filter(bucket => bucket.minute >= windowAt(now) && bucket.minute <= minuteAt(now)) };
}
/** Caller holds the definition lock. Fixed 60 minute buckets, finite reasons, no request strings. */
export async function writeWebhookObservation(db: DB, row: Raw, observation: WebhookObservation, now: Date): Promise<void> {
  const value = state(row.webhook_health, now);
  if (observation === 'accepted') {
    value.lastAcceptedAt = now.toISOString();
    value.signatureChecked = (row.webhook_spec as { hmac?: unknown } | null)?.hmac !== undefined;
  } else if (observation === 'verified') value.verifiedAt = now.toISOString();
  else {
    let bucket = value.buckets.find(item => item.minute === minuteAt(now));
    if (!bucket) { bucket = { minute: minuteAt(now), counts: {} }; value.buckets.push(bucket); }
    bucket.counts[observation] = Math.min(Number.MAX_SAFE_INTEGER, (bucket.counts[observation] ?? 0) + 1);
  }
  await db.updateTable('routines_v1_definitions').set({ webhook_health: value }).where('agent_id', '=', row.agent_id).where('routine_id', '=', row.routine_id).execute();
}
export function createWebhookHealthStore(db: DB) {
  return {
    /** Idle tasks lose expired counters too. Skip busy rows; the next scheduler pass retries. */
    async pruneWebhookRefusals(now: Date): Promise<void> {
      await sql`WITH expired AS (
        SELECT agent_id,routine_id FROM routines_v1_definitions
        WHERE webhook_health IS NOT NULL AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(webhook_health->'buckets') b WHERE (b->>'minute')::bigint < ${windowAt(now)})
        LIMIT 100 FOR UPDATE SKIP LOCKED
      ) UPDATE routines_v1_definitions r SET webhook_health=jsonb_set(r.webhook_health,'{buckets}',
        coalesce((SELECT jsonb_agg(b) FROM jsonb_array_elements(r.webhook_health->'buckets') b
          WHERE (b->>'minute')::bigint >= ${windowAt(now)}),'[]'::jsonb))
        FROM expired e WHERE r.agent_id=e.agent_id AND r.routine_id=e.routine_id`.execute(db);
    },
    async webhookGeneration(row: StoredRoutine): Promise<string | null> {
      const current = await db.selectFrom('routines_v1_definitions').select('webhook_health_generation').where('agent_id', '=', row.agentId).where('routine_id', '=', row.routineId).where('owner_user_id', '=', row.ownerUserId).where('revision', '=', row.revision).executeTakeFirst();
      return current?.webhook_health_generation ?? null;
    },
    async observeWebhook(input: { row: StoredRoutine; address: WebhookAddressProof; observation: WebhookObservation; now: Date }, authorizeLegacy: () => Promise<boolean>) {
      return serializeAdmission(db, () => db.transaction().execute(async trx => {
        const raw = await trx.selectFrom('routines_v1_definitions').selectAll().where('agent_id', '=', input.row.agentId).where('routine_id', '=', input.row.routineId).forUpdate().executeTakeFirst();
        // A request authenticated before a move, edit or rotation must not change the new setup's evidence.
        if (!raw || raw.owner_user_id !== input.row.ownerUserId || raw.revision !== input.row.revision || raw.webhook_spec === null || !webhookAddressMatches(raw, input.address)
          || input.address.kind === 'legacy' && !await authorizeLegacy()) return false;
        await writeWebhookObservation(trx, raw, input.observation, input.now);
        return true;
      }));
    },
    async webhookStatus(input: RoutineKey & { actorUserId: string; now: Date }): Promise<RoutineWebhookStatus> {
      const raw = await db.selectFrom('routines_v1_definitions').selectAll().where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).where('owner_user_id', '=', input.actorUserId).where('definition_id', 'is', null).where('webhook_spec', 'is not', null).executeTakeFirst();
      if (!raw) throw new SafeToolError('not-found', 'routineId');
      const value = state(raw.webhook_health, input.now);
      const spec = raw.webhook_spec as { hmac?: { app?: 'stripe' | 'slack' | 'zendesk' } };
      const totals: Partial<Record<WebhookRefusalReason, number>> = {};
      for (const bucket of value.buckets) for (const reason of WebhookRefusalReasonSchema.options) {
        if (bucket.counts[reason]) totals[reason] = Math.min(Number.MAX_SAFE_INTEGER, (totals[reason] ?? 0) + bucket.counts[reason]!);
      }
      return { agentId: input.agentId, routineId: input.routineId, setupReady: raw.webhook_address_token !== null || raw.webhook_legacy_enabled,
        app: spec.hmac?.app ?? 'other', lastAcceptedAt: value.lastAcceptedAt, signatureChecked: value.signatureChecked,
        verifiedAt: value.verifiedAt, windowStart: new Date(windowAt(input.now) * 60000).toISOString(),
        refusals: WebhookRefusalReasonSchema.options.flatMap(reason => totals[reason] ? [{ reason, count: totals[reason]! }] : []) };
    },
  };
}
