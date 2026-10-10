import { randomUUID } from 'node:crypto';
import { PluginError, type AgentContext } from '@ax/core';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { isOwnerId } from './egress-allowlist.js';
import type { ToolPolicyDatabase } from './migrations.js';
import type { GrantRoutineConsentInput, GrantRoutineConsentOutput, RoutineConsent } from './types.js';

/** Host invocation capability ONLY. Decisions mints/removes it around awaited
 * delivery from its stored approved create/update intent, never IPC input.
 * The durable decision and delivery rows remain the authority source. */
export const ROUTINE_CONSENT_GRANT_CONTEXT_KEY = 'decisions:routine-consent-grant';
const GrantContextSchema = z.object({
  decisionId: z.string().min(1).max(256), agentId: z.string().min(1).max(256),
  userId: z.string().min(1).max(128),
  toolName: z.enum(['routine_create', 'routine_update']),
  expectedRevision: z.string().min(1).max(256),
}).strict();

export function consentError(code: string): PluginError {
  const messages: Record<string, string> = {
    'consent-unavailable': 'Routine permission storage is unavailable.',
    'consent-revision-conflict': 'Routine permission changed. Approve a new request.',
    'forbidden': 'This request cannot change routine permission.',
    'not-found': 'This agent is no longer available.',
    'invalid-payload': 'Routine permission input is invalid.',
  };
  return new PluginError({ plugin: '@ax/tool-policy', code, message: messages[code] ?? 'Routine permission failed.' });
}

export function requireGrantContext(ctx: AgentContext, input: GrantRoutineConsentInput): void {
  const parsed = GrantContextSchema.safeParse(ctx.state.get(ROUTINE_CONSENT_GRANT_CONTEXT_KEY));
  if (!parsed.success || !isOwnerId(ctx.userId)) throw consentError('forbidden');
  const grant = parsed.data;
  if (grant.decisionId !== input.decisionId || grant.expectedRevision !== input.expectedRevision ||
      grant.agentId !== ctx.agentId || grant.userId !== ctx.userId) throw consentError('forbidden');
}

export interface RoutineConsentStore {
  get(agentId: string, userId: string): Promise<RoutineConsent>;
  grant(agentId: string, userId: string, input: GrantRoutineConsentInput): Promise<GrantRoutineConsentOutput>;
  revoke(agentId: string, userId: string): Promise<RoutineConsent>;
  purgeAgent(agentId: string): Promise<void>;
}

/** Missing scope is revision 0. Every query binds both agent and real person. */
export async function readConsent(db: Kysely<ToolPolicyDatabase>, agentId: string, userId: string): Promise<RoutineConsent> {
  const row = await db.selectFrom('tool_policy_v1_routine_consent').select(['enabled', 'revision'])
    .where('agent_id', '=', agentId).where('owner_user_id', '=', userId).executeTakeFirst();
  return row ?? { enabled: false, revision: '0' };
}

export function createDbRoutineConsentStore(db: Kysely<ToolPolicyDatabase>): RoutineConsentStore {
  // Consistent lock order: shared agent fence -> decision (grant only) -> person
  // scope. Purge takes the exclusive agent fence. Advisory locks also serialize
  // absent rows, where FOR UPDATE alone cannot protect first grant vs revoke.
  async function agentFence(trx: Kysely<ToolPolicyDatabase>, agentId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${agentId}, 18427141))`.execute(trx);
    const retired = await trx.selectFrom('tool_policy_v1_routine_consent_retired_agents')
      .select('agent_id').where('agent_id', '=', agentId).executeTakeFirst();
    if (retired) throw consentError('not-found');
  }
  async function scopeLock(trx: Kysely<ToolPolicyDatabase>, agentId: string, userId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([agentId, userId])}, 18427142))`.execute(trx);
  }
  async function write(trx: Kysely<ToolPolicyDatabase>, agentId: string, userId: string, enabled: boolean): Promise<RoutineConsent> {
    const consent = { enabled, revision: randomUUID() };
    await trx.insertInto('tool_policy_v1_routine_consent')
      .values({ agent_id: agentId, owner_user_id: userId, ...consent })
      .onConflict(oc => oc.columns(['agent_id', 'owner_user_id']).doUpdateSet(consent)).execute();
    return consent;
  }
  return {
    get: (agentId, userId) => readConsent(db, agentId, userId),
    grant: (agentId, userId, input) => db.transaction().execute(async trx => {
      await agentFence(trx, agentId);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.decisionId}, 18427143))`.execute(trx);
      await scopeLock(trx, agentId, userId);
      const delivery = await trx.selectFrom('tool_policy_v1_routine_consent_deliveries').selectAll()
        .where('decision_id', '=', input.decisionId).executeTakeFirst();
      if (delivery) {
        if (delivery.agent_id !== agentId || delivery.owner_user_id !== userId) throw consentError('forbidden');
        return { ...await readConsent(trx, agentId, userId), delivered: true };
      }
      const current = await readConsent(trx, agentId, userId);
      if (current.revision !== input.expectedRevision) throw consentError('consent-revision-conflict');
      const consent = await write(trx, agentId, userId, true);
      await trx.insertInto('tool_policy_v1_routine_consent_deliveries').values({
        decision_id: input.decisionId, agent_id: agentId, owner_user_id: userId,
      }).execute();
      return { ...consent, delivered: true };
    }),
    revoke: (agentId, userId) => db.transaction().execute(async trx => {
      await agentFence(trx, agentId);
      await scopeLock(trx, agentId, userId);
      // Revoke even an absent grant: its new revision fences a pending delivery.
      return write(trx, agentId, userId, false);
    }),
    purgeAgent: agentId => db.transaction().execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${agentId}, 18427141))`.execute(trx);
      await trx.insertInto('tool_policy_v1_routine_consent_retired_agents').values({ agent_id: agentId })
        .onConflict(oc => oc.column('agent_id').doNothing()).execute();
      await trx.deleteFrom('tool_policy_v1_routine_consent_deliveries').where('agent_id', '=', agentId).execute();
      await trx.deleteFrom('tool_policy_v1_routine_consent').where('agent_id', '=', agentId).execute();
    }),
  };
}
