import { afterEach, describe, expect, it } from 'vitest';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { sql } from 'kysely';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { createRoutinesStore } from '../store.js';
let h: RoutineHarness;
afterEach(async () => { await h?.close(); });
const definition = RoutineDefinitionSchema.parse({ name: 'Check', promptBody: 'Check', trigger: { kind: 'interval', every: '1h' } });
const key = (r: RoutineView) => ({ agentId: r.agentId, routineId: r.routineId, expectedRevision: r.revision });
async function create(team = false) { return h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: team ? h.teamAgentId : h.agentId, requestId: 'create', definition }); }
describe('execution ownership', () => {
  it('keeps a team creator pinned when another admin stops it', async () => {
    h = await createRoutineHarness();
    const row = await create(true);
    await h.bus.call('routines:update', h.teamAdmin, { ...key(row), requestId: 'stop', patch: { enabled: false } });
    expect((await createRoutinesStore(h.db).findOne(row))?.ownerUserId).toBe(h.owner.userId);
  });
  it('reconciles only current personal owners and invalidates stale revisions', async () => {
    h = await createRoutineHarness();
    const personal = await create();
    const team = await create(true);
    const store = createRoutinesStore(h.db);
    await sql `UPDATE agents_v1_agents SET owner_id='admin' WHERE agent_id=${h.agentId}`.execute(h.db);
    expect(await store.reconcileOwners({ agents: [{ agentId: h.agentId, ownerUserId: 'admin' }] })).toBe(1);
    const changed = (await store.findOne(personal))!;
    expect(changed.ownerUserId).toBe('admin');
    expect(changed.revision).not.toBe(personal.revision);
    expect((await store.findOne(team))?.ownerUserId).toBe(h.owner.userId);
    expect(await store.acceptDispatch({ ...key(personal), actorUserId: 'owner', source: 'tick', requestId: 'old', now: new Date() })).toBeNull();
  });
  it('refuses invocation after team membership is removed, records failure and keeps the routine', async () => {
    h = await createRoutineHarness();
    const row = await create(true);
    const store = createRoutinesStore(h.db);
    const accepted = (await store.acceptDispatch({ ...key(row), actorUserId: 'owner', source: 'tick', requestId: 'fire', now: new Date() }))!.accepted;
    h.setTeamFailure('missing');
    const { createFireRoutine } = await import('../fire.js');
    const fire = createFireRoutine({ bus: h.bus, store, pending: new Map(), purgeAgent: async () => { throw new Error('must not purge'); } });
    expect((await fire(accepted)).status).toBe('error');
    expect(h.invokeCalls).toEqual([]);
    expect(await store.findOne(row)).not.toBeNull();
    expect((await store.recentFires(row))[0]?.status).toBe('error');
  });
});
