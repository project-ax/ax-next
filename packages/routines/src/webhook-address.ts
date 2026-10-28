import { createHash, randomBytes } from 'node:crypto';
import { SafeToolError } from '@ax/core';
import { serializeAdmission } from './admission-order.js';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { RoutineKey } from '@ax/routines-contract';
import type { RoutinesDatabase, RoutinesDefinitionsRow } from './migrations.js';
import type { StoredRoutine } from './types.js';

export type WebhookAddressProof = { kind: 'task' | 'legacy'; token: string; generation?: string };
type Raw = Selectable<RoutinesDefinitionsRow>;
type DB = Kysely<RoutinesDatabase>;
const version = (token: string) => createHash('sha256').update(token).digest('hex');

/** Called again while the admission transaction holds the definition lock. */
export function webhookAddressMatches(row: Raw, proof: WebhookAddressProof): boolean {
  return (proof.generation === undefined || row.webhook_health_generation === proof.generation) && (proof.kind === 'task' ? row.webhook_address_token === proof.token : row.webhook_legacy_enabled);
}

export function createWebhookAddressStore(db: DB, helpers: {
  lockLiveAgent: (trx: Transaction<RoutinesDatabase>, agentId: string) => Promise<boolean>;
  rowToRoutine: (row: Raw) => StoredRoutine;
}) {
  async function address(input: RoutineKey & { actorUserId: string; expectedVersion?: string }) {
    return serializeAdmission(db, () => db.transaction().execute(async trx => {
      if (!await helpers.lockLiveAgent(trx, input.agentId)) throw new SafeToolError('not-found', 'routineId');
      const row = await trx.selectFrom('routines_v1_definitions').selectAll().where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
      if (!row || row.owner_user_id !== input.actorUserId || row.definition_id !== null || row.webhook_spec === null) throw new SafeToolError('not-found', 'routineId');
      if (input.expectedVersion !== undefined && (row.webhook_address_token === null || version(row.webhook_address_token) !== input.expectedVersion)) throw new SafeToolError('revision-conflict', 'expectedRevision');
      const replace = input.expectedVersion !== undefined;
      const token = replace || row.webhook_address_token === null ? `rt_${randomBytes(32).toString('base64url')}` : row.webhook_address_token;
      const legacyActive = !replace && row.webhook_legacy_enabled;
      await trx.updateTable('routines_v1_definitions').set({ webhook_address_token: token, webhook_legacy_enabled: legacyActive, ...(replace ? { webhook_health: null, webhook_health_generation: sql<string>`gen_random_uuid()::text` } : {}) }).where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).execute();
      return { token, version: version(token), legacyActive };
    }));
  }
  return {
    ensureWebhookAddress: (input: RoutineKey & { actorUserId: string }) => address(input),
    replaceWebhookAddress: (input: RoutineKey & { actorUserId: string; expectedVersion: string }) => address(input),
    async findWebhookByToken(input: { token: string; path: string }) {
      const row = await db.selectFrom('routines_v1_definitions').selectAll().where('webhook_address_token', '=', input.token).where('webhook_spec', 'is not', null).executeTakeFirst();
      const routine = row ? helpers.rowToRoutine(row) : null;
      return routine?.webhook?.path === input.path ? routine : null;
    },
  };
}
