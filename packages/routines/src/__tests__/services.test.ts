import { afterEach, describe, expect, it } from 'vitest';
import { makeAgentContext } from '@ax/core';
import { RoutineDefinitionSchema, RoutineViewSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, materializePersonalDefaults, type RoutineHarness } from './support/routine-harness.js';
const definition = RoutineDefinitionSchema.parse({ name: 'Daily', promptBody: 'Summarize', trigger: { kind: 'interval', every: '1h' } });
let h: RoutineHarness;
afterEach(async () => { await h?.close(); });
async function create(agentId = h.agentId, requestId = 'create') { return h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId, requestId, definition }); }
describe('registered routine services with real agents', () => {
  it('scopes reads and returns complete safe projections', async () => {
    h = await createRoutineHarness(); await materializePersonalDefaults(h); const row = await create();
    expect(RoutineViewSchema.parse(row)).toEqual(row);
    expect(row).not.toHaveProperty('ownerUserId');
    expect(row.permissions).toEqual({ edit: true, stop: true, fire: true, manageSecret: true });
    const { routines } = await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', h.owner, { agentId: h.agentId });
    expect(routines.filter(r => r.origin === 'authored')).toEqual([row]);
    expect(routines.filter(r => r.origin === 'default').map(r => r.name)).toEqual(['heartbeat']);
    await expect(h.bus.call('routines:get', h.owner, { agentId: h.teamAgentId, routineId: row.routineId })).rejects.toMatchObject({ toolCode: 'not-found' });
    await expect(h.bus.call('routines:list', h.teamAdmin, { agentId: h.agentId })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('a created task round-trips kind and goodWhen through routines:get, routines:list and routine_get', async () => {
    h = await createRoutineHarness();
    const task = RoutineDefinitionSchema.parse({ name: 'Inbox', promptBody: 'Keep the inbox under control.', trigger: { kind: 'interval', every: '15m' }, kind: 'stay-on-top', goodWhen: 'Nothing waits more than a day.' });
    const created = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: h.agentId, requestId: 'task', definition: task });
    expect(created).toMatchObject({ kind: 'stay-on-top', goodWhen: 'Nothing waits more than a day.' });
    await expect(h.bus.call('routines:get', h.owner, { agentId: h.agentId, routineId: created.routineId })).resolves.toEqual(created);
    await materializePersonalDefaults(h);
    const { routines } = await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', h.owner, { agentId: h.agentId });
    expect(routines.filter(r => r.origin === 'authored')).toEqual([created]);
    expect(routines.filter(r => r.origin === 'default')).toEqual([expect.objectContaining({ name: 'heartbeat', kind: 'repeat', goodWhen: null })]);
    const agentCtx = makeAgentContext({ ...h.owner, agentId: h.agentId });
    await expect(h.bus.call('tool:execute:routine_get', agentCtx, { id: 'get', name: 'routine_get', input: { routineId: created.routineId } })).resolves.toEqual(created);
  });
  it('pins team creator, lets another admin stop only, and denies ordinary member mutations', async () => {
    h = await createRoutineHarness(); const row = await create(h.teamAgentId);
    const key = { agentId: h.teamAgentId, routineId: row.routineId, expectedRevision: row.revision };
    await expect(h.bus.call('routines:create', h.teamMember, { agentId: h.teamAgentId, requestId: 'member', definition })).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(h.bus.call('routines:get', h.teamMember, keyWithoutRevision(key))).resolves.toMatchObject({ permissions: { edit: false, stop: false, fire: false, manageSecret: false } });
    await expect(h.bus.call('routines:update', h.teamAdmin, { ...key, requestId: 'edit', patch: { promptBody: 'Changed' } })).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(h.bus.call('routines:fire-now', h.teamAdmin, { ...key, requestId: 'fire' })).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(h.bus.call('routines:update', h.teamMember, { ...key, requestId: 'member-stop', patch: { enabled: false } })).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(h.bus.call('routines:delete', h.teamMember, { ...key, requestId: 'member-delete' })).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(h.bus.call('routines:fire-now', h.teamMember, { ...key, requestId: 'member-fire' })).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(h.bus.call('routines:set-webhook-secret', h.teamAdmin, { ...key, operation: 'set', secret: new Uint8Array([1]) })).rejects.toMatchObject({ toolCode: 'forbidden' });
    const stopped = await h.bus.call<unknown, RoutineView>('routines:update', h.teamAdmin, { ...key, requestId: 'stop', patch: { enabled: false } });
    await expect(h.bus.call('routines:update', h.teamAdmin, { ...key, expectedRevision: stopped.revision, requestId: 'enable', patch: { enabled: true } })).rejects.toMatchObject({ toolCode: 'forbidden' });
    const { createRoutinesStore } = await import('../store.js');
    expect((await createRoutinesStore(h.db).findOne(key))?.ownerUserId).toBe(h.owner.userId);
    await expect(h.bus.call('routines:delete', h.teamAdmin, { ...key, expectedRevision: stopped.revision, requestId: 'delete' })).resolves.toMatchObject({ deleted: true });
  });
  it('reconciles transferred personal ownership on management reads', async () => {
    h = await createRoutineHarness(); const row = await create();
    const { sql } = await import('kysely');
    await sql`UPDATE agents_v1_agents SET owner_id = ${h.teamAdmin.userId} WHERE agent_id = ${h.agentId}`.execute(h.db);
    const current = await h.bus.call<unknown, RoutineView>('routines:get', h.teamAdmin, { agentId: h.agentId, routineId: row.routineId });
    expect(current.revision).not.toBe(row.revision); expect(current.permissions.edit).toBe(true);
    await expect(h.bus.call('routines:get', h.owner, { agentId: h.agentId, routineId: row.routineId })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('propagates directory outages and denies when the team provider is absent', async () => {
    h = await createRoutineHarness();
    h.setTeamFailure('outage');
    await expect(h.bus.call('routines:list', h.owner, { agentId: h.teamAgentId })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(h.bus.call('agents:can-manage-routines', h.owner, { agentId: h.teamAgentId })).rejects.toMatchObject({ code: 'unavailable' });
    h.setTeamFailure('missing');
    await expect(h.bus.call('routines:list', h.owner, { agentId: h.teamAgentId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.bus.call('agents:can-manage-routines', h.owner, { agentId: h.teamAgentId })).resolves.toEqual({ allowed: false });
  });
  it('replays updates and deletes after response loss while rechecking actor access', async () => {
    h = await createRoutineHarness(); const row = await create();
    const input = { agentId: h.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: 'edit', patch: { promptBody: 'Updated' } };
    const updated = await h.bus.call<unknown, RoutineView>('routines:update', h.owner, input);
    const deletion = { agentId: h.agentId, routineId: row.routineId, expectedRevision: updated.revision, requestId: 'delete' };
    const deleted = await h.bus.call('routines:delete', h.owner, deletion);
    await expect(h.bus.call('routines:update', h.owner, input)).resolves.toEqual(updated);
    await expect(h.bus.call('routines:delete', h.owner, deletion)).resolves.toEqual(deleted);
    await expect(h.bus.call('routines:update', h.teamAdmin, input)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('accepts concurrent identical fire requests once and does not invoke on response-loss replay', async () => {
    h = await createRoutineHarness({ dispatch: true }); const row = await create();
    const input = { agentId: h.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: 'fire' };
    const { sql } = await import('kysely');
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const blocker = h.db.transaction().execute(async trx => {
      await trx.selectFrom('routines_v1_definitions').selectAll().where('routine_id', '=', row.routineId).forUpdate().execute(); entered(); await wait;
    });
    await ready;
    const calls = Promise.all([h.bus.call('routines:fire-now', h.owner, input), h.bus.call('routines:fire-now', h.owner, input)]);
    await expect.poll(async () => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%routines_v1_%'`.execute(h.db)).rows[0]!.n)).toBeGreaterThanOrEqual(2);
    release(); await blocker;
    expect(await calls).toEqual([{ status: 'ok' }, { status: 'ok' }]); expect(h.invokeCalls).toHaveLength(1);
    await expect(h.bus.call('routines:fire-now', h.owner, input)).resolves.toEqual({ status: 'ok' });
    expect(h.invokeCalls).toHaveLength(1);
    await expect(h.bus.call('routines:recent-fires', h.owner, { agentId: h.agentId, routineId: row.routineId })).resolves.toMatchObject({ fires: [{ triggerSource: 'manual', status: 'ok' }] });
  });
  it('requires actual auth admin status for the structured catalog', async () => {
    h = await createRoutineHarness();
    await expect(h.bus.call('routines:list-defaults', h.owner, {})).rejects.toMatchObject({ toolCode: 'forbidden' });
    const saved = await h.bus.call<unknown, { defaultRoutineId: string }>('routines:upsert-default', h.teamAdmin, definition);
    await expect(h.bus.call('routines:get-default', h.teamAdmin, { defaultRoutineId: saved.defaultRoutineId })).resolves.toMatchObject(definition);
    await expect(h.bus.call('routines:list-defaults', h.teamAdmin, {})).resolves.toHaveProperty('defaults');
    await expect(h.bus.call('routines:set-agent-default-enabled', h.owner, { agentId: h.agentId, defaultRoutineId: saved.defaultRoutineId, enabled: false })).resolves.toEqual({});
    await expect(h.bus.call('routines:list-agent-defaults', h.owner, { agentId: h.agentId })).resolves.toMatchObject({ defaults: expect.arrayContaining([{ defaultRoutineId: saved.defaultRoutineId, name: definition.name, enabled: false }]) });
    await expect(h.bus.call('routines:delete-default', h.teamAdmin, { defaultRoutineId: saved.defaultRoutineId })).resolves.toEqual({});
  });
});
function keyWithoutRevision({ agentId, routineId }: { agentId: string; routineId: string }) { return { agentId, routineId }; }
