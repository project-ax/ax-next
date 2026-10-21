import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineDefinitionSchema, editableDefinition } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { createRoutinesStore } from '../store.js';
import type { AcceptedDispatch } from '../types.js';
import { runTickOnce } from '../tick.js';
import { createFireRoutine } from '../fire.js';
import { purgeRoutineAgent } from '../cleanup.js';
import { sql } from 'kysely';
let h: RoutineHarness;
afterEach(async () => { await h?.close(); });
const now = new Date('2031-01-01T00:00:00Z');
async function setup() {
  h = await createRoutineHarness();
  const store = createRoutinesStore(h.db);
  await store.materializeMissing({ agents: [{ agentId: h.agentId, ownerUserId: h.owner.userId }, { agentId: h.teamAgentId, ownerUserId: h.owner.userId }], now });
  return { store, row: (await store.list({ agentId: h.agentId })).find(r => r.name === 'heartbeat')! };
}
describe('default DB scheduler canary', () => {
  it('preserves stable default identity, current owner and conversation key through refresh and completion', async () => {
    const { store, row } = await setup();
    expect(row.routineId).toBe(`default:${row.definitionId}`);
    expect(row.ownerUserId).toBe(h.owner.userId);
    const pending = new Map();
    const fire = createFireRoutine({ bus: h.bus, store, pending, purgeAgent: agentId => purgeRoutineAgent({ bus: h.bus, store, pending, agentId }) });
    const shared = vi.spyOn(h.bus, 'call');
    const dispatch = (await store.acceptDispatch({ ...row, expectedRevision: row.revision, actorUserId: h.owner.userId, requestId: 'fire', source: 'manual', now }))!;
    await fire(dispatch.accepted);
    expect(h.invokeCalls).toHaveLength(1);
    expect(shared).toHaveBeenCalledWith('conversations:find-or-create', expect.objectContaining({ userId: h.owner.userId }), expect.objectContaining({ externalKey: row.routineId }));
    shared.mockRestore();
    await store.finishDispatch({ dispatchId: dispatch.accepted.dispatchId, outcome: { status: 'silenced', conversationId: 'conversation', error: null, renderedPrompt: row.promptBody, warning: null } });
    const original = (await store.getDefault(row.definitionId!))!;
    await store.upsertDefault({ ...editableDefinition(original), kind: 'repeat', goodWhen: null, trigger: { kind: 'interval', every: '1h' }, promptBody: 'updated' });
    await store.refreshStale({ now });
    const changed = (await store.findOne(row))!;
    expect(changed.routineId).toBe(row.routineId);
    expect(changed.revision).not.toBe(row.revision);
    expect(changed.promptBody).toBe('updated');
    expect((await store.recentFires(row))[0]?.status).toBe('silenced');
  });
  it.each([true, false])('an authored heartbeat shadows the default even when enabled=%s', async (enabled) => {
    const { store } = await setup();
    await store.createAuthored({ agentId: h.agentId, actorUserId: h.owner.userId, ownerUserId: h.owner.userId, requestId: 'shadow', now, definition: RoutineDefinitionSchema.parse({ name: 'heartbeat', promptBody: 'authored', enabled, trigger: { kind: 'interval', every: '1h' } }) });
    const fire = vi.fn(async (_dispatch: AcceptedDispatch) => ({ status: 'ok' as const, error: null, renderedPrompt: null, recordedAtTurnEnd: true }));
    await runTickOnce({ store, fire, now: new Date(now.getTime() + 86400000), claimBatchSize: 50, claimWindowMinutes: 5 });
    const own = fire.mock.calls.map(([d]) => d).filter(d => d.row.agentId === h.agentId);
    expect(own.some(d => d.row.name === 'heartbeat' && d.row.definitionId !== null)).toBe(false);
    expect(own.some(d => d.row.name === 'heartbeat' && d.row.definitionId === null)).toBe(enabled);
  });
  it('does not claim disabled overrides or accept a stale materialized row after the catalog kill switch', async () => {
    const { store, row } = await setup();
    await store.setAgentDefaultEnabled({ agentId: h.agentId, defaultRoutineId: row.definitionId!, ownerUserId: h.owner.userId, enabled: false });
    const claim = { now: new Date(now.getTime() + 86400000), limit: 50, claimWindowMinutes: 5 };
    expect((await store.claimDue(claim)).some(r => r.agentId === h.agentId && r.routineId === row.routineId)).toBe(false);
    expect(await store.acceptDispatch({ ...row, expectedRevision: row.revision, actorUserId: h.owner.userId, requestId: 'disabled', source: 'manual', now })).toBeNull();
    await store.setAgentDefaultEnabled({ agentId: h.agentId, defaultRoutineId: row.definitionId!, ownerUserId: h.owner.userId, enabled: true });
    await sql `UPDATE default_routines_v1 SET enabled=false WHERE default_routine_id=${row.definitionId}`.execute(h.db);
    expect(await store.acceptDispatch({ ...row, expectedRevision: row.revision, actorUserId: h.owner.userId, requestId: 'catalog-disabled', source: 'manual', now })).toBeNull();
    expect((await store.claimDue(claim)).some(r => r.routineId === row.routineId)).toBe(false);
  });
});
