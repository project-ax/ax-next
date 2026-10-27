import { afterEach, expect, it } from 'vitest';
import { makeAgentContext, type ToolCall } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { sql } from 'kysely';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';

let h: RoutineHarness;
afterEach(async () => { await h?.close(); });
async function approvedStaleEdit(advance = true) {
  h = await createRoutineHarness();
  const ctx = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'conversation' });
  const row = await h.bus.call<unknown, RoutineView>('routines:create', ctx, {
    agentId: h.agentId, requestId: 'create',
    definition: RoutineDefinitionSchema.parse({ name: 'Job', promptBody: 'Review.', schedule: { kind: 'interval', every: '1h' } }),
  });
  const call: ToolCall = { id: 'edit', name: 'routine_update', input: {
    requestId: 'stale-approved-edit', routineId: row.routineId, expectedRevision: row.revision,
    patch: { description: 'Approved change' },
  } };
  expect(await h.bus.fire('tool:pre-call', ctx, call)).toMatchObject({ rejected: true });
  const { decisions } = await h.bus.call<unknown, { decisions: Array<{ id: string }> }>('decisions:list', ctx, { userId: ctx.userId });
  const decisionId = decisions[0]!.id;
  await h.bus.call('routines:update', ctx, { agentId: h.agentId, routineId: row.routineId,
    requestId: 'intervening-edit', expectedRevision: row.revision, patch: { description: 'Owner edit' } });
  await h.bus.call('decisions:approve', ctx, { decisionId, userId: ctx.userId, approvalScope: 'once' });
  if (advance) h.advance(11_000);
  return { ctx, call, decisionId, routineId: row.routineId };
}
it('settles an approved edit rejected by preflight after the owner changes its revision', async () => {
  const { ctx, call, decisionId, routineId } = await approvedStaleEdit();
  expect(await h.bus.fire('tool:pre-call', ctx, call)).toMatchObject({ rejected: true });
  const result = await sql<{ status: string; routine_outcome: string | null; routine_failure_code: string | null }>`
    SELECT status,routine_outcome,routine_failure_code FROM decisions_v1_decisions WHERE decision_id=${decisionId}`.execute(h.db);
  expect(result.rows[0]).toEqual({ status: 'failed', routine_outcome: 'failed', routine_failure_code: 'revision-conflict' });
  const current = await h.bus.call<unknown, RoutineView>('routines:get', ctx, { agentId: h.agentId, routineId });
  expect(current.description).toBe('Owner edit');
});
it('does not settle an execution that already claimed its authority', async () => {
  const { ctx, call, decisionId } = await approvedStaleEdit();
  await h.bus.call('decisions:authorize-routine-call', ctx, { call });
  expect(await h.bus.fire('tool:pre-call', ctx, call)).toMatchObject({ rejected: true });
  const result = await sql<{ routine_outcome: string | null }>`SELECT routine_outcome FROM decisions_v1_decisions WHERE decision_id=${decisionId}`.execute(h.db);
  expect(result.rows[0]!.routine_outcome).toBeNull();
});
it('cannot settle another owner, changed input, or an approval still inside its undo window', async () => {
  const { ctx, call, decisionId } = await approvedStaleEdit(false);
  const reject = (who = ctx, value = call) => h.bus.call('decisions:reject-unstarted-routine-call', who, { call: value, failureCode: 'revision-conflict' });
  expect(await reject()).toEqual({ recorded: false });
  h.advance(11_000);
  expect(await reject(makeAgentContext({ ...ctx, userId: 'peer' }))).toEqual({ recorded: false });
  expect(await reject(ctx, { ...call, input: { ...call.input, patch: { description: 'Different intent' } } })).toEqual({ recorded: false });
  expect((await sql<{ routine_outcome: string | null }>`SELECT routine_outcome FROM decisions_v1_decisions WHERE decision_id=${decisionId}`.execute(h.db)).rows[0]!.routine_outcome).toBeNull();
  expect(await reject()).toEqual({ recorded: true });
});
it('records the same refusal when a host executor is called without another preflight', async () => {
  const { ctx, call, decisionId } = await approvedStaleEdit();
  await expect(h.bus.call(`tool:execute:${call.name}`, ctx, call)).rejects.toMatchObject({ toolCode: 'revision-conflict' });
  expect((await sql<{ routine_outcome: string | null }>`SELECT routine_outcome FROM decisions_v1_decisions WHERE decision_id=${decisionId}`.execute(h.db)).rows[0]!.routine_outcome).toBe('failed');
});
it('serializes a refusal against a concurrent authority claim', async () => {
  const { ctx, call, decisionId } = await approvedStaleEdit();
  await Promise.allSettled([
    h.bus.call('decisions:reject-unstarted-routine-call', ctx, { call, failureCode: 'revision-conflict' }),
    h.bus.call('decisions:authorize-routine-call', makeAgentContext({ ...ctx }), { call }),
  ]);
  const row = (await sql<{ routine_outcome: string | null; routine_authorization_id: string | null }>`
    SELECT routine_outcome,routine_authorization_id FROM decisions_v1_decisions WHERE decision_id=${decisionId}`.execute(h.db)).rows[0]!;
  if (row.routine_authorization_id === null) expect(row.routine_outcome).toBe('failed');
  else expect(row.routine_outcome).toBeNull();
});
