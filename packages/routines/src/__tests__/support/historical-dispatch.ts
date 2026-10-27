import { SafeToolError } from '@ax/core';
import type { Kysely } from 'kysely';
import type { RoutinesDatabase } from '../../migrations.js';
import type { AcceptDispatchInput, RoutinesStore } from '../../store.js';
import { opaqueId } from '../../definition.js';

/**
 * Reports/notes/steps must still safely read pre-TASK983 overlapping dispatches
 * after upgrade or rollback. Normal fixtures use real admission. Only an explicit
 * busy refusal inserts an old unleased dispatch directly; production cannot admit it.
 * Admission/idempotency tests call the store directly and never use this helper.
 */
export async function acceptHistoricalDispatch(db:Kysely<RoutinesDatabase>,store:RoutinesStore,input:AcceptDispatchInput) {
  try { return await store.acceptDispatch(input); }
  catch(error) {
    if (!(error instanceof SafeToolError) || error.toolCode!=='busy') throw error;
    const row=await store.findOne(input);
    if (!row || !row.enabled || row.revision!==input.expectedRevision) throw error;
    const accepted={dispatchId:opaqueId('legacy_dispatch'),reqId:opaqueId('legacy_run'),row,source:input.source,acceptedAt:input.now};
    await db.insertInto('routines_v1_dispatches').values({dispatch_id:accepted.dispatchId,req_id:accepted.reqId,agent_id:row.agentId,routine_id:row.routineId,revision:row.revision,accepted_at:input.now,trigger_source:input.source,kind:row.kind,run_as_user_id:row.ownerUserId,completed_at:null}).execute();
    return {accepted,replayed:false};
  }
}
