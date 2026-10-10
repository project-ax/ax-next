import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { fixture, createInput, now } from './store-fixture.js';
const f = fixture();
const agents = [{ agentId: 'a', ownerUserId: 'owner' }, { agentId: 'b', ownerUserId: 'owner-b' }];
describe('canonical default store', () => {
  it('materializes stable legacy conversation identities, host revisions and true owners idempotently', async () => {
    await f.store.materializeMissing({ agents, now }); await f.store.materializeMissing({ agents, now });
    const a = await f.store.list({ agentId: 'a' }), b = await f.store.list({ agentId: 'b' });
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    expect(a[0]?.routineId).toBe('default:default-heartbeat-2026-05-19'); expect(a[0]?.ownerUserId).toBe('owner');
    expect(a[0]?.revision).not.toBe(b[0]?.revision); expect(a[0]?.nextRunAt).toBeNull();
    expect(a[0]?.definitionId).toBe('default-heartbeat-2026-05-19');
    expect(await f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId: 'new-owner' }] })).toBe(1);
    expect((await f.store.findOne(a[0]!))?.ownerUserId).toBe('new-owner');
  });
  it('upserts canonical fields by name and preserves omitted enabled; refresh invalidates old revision', async () => {
    const input = { ...createInput().definition, name: 'custom-default', trigger: { kind: 'interval' as const, every: '60s' }, enabled: false };
    const first = await f.store.upsertDefault(input); expect(first.created).toBe(true);
    const { enabled: _, ...omitted } = input;
    const second = await f.store.upsertDefault({ ...omitted, promptBody: '\nnew\n' }); expect(second).toEqual({ ...first, created: false });
    expect((await f.store.getDefault(first.defaultRoutineId))?.enabled).toBe(false);
    await f.store.upsertDefault({ ...input, enabled: true }); await f.store.materializeMissing({ agents, now });
    const before = (await f.store.list({ agentId: 'a' })).find(r => r.name === input.name)!;
    await f.store.upsertDefault({ ...input, enabled: true, promptBody: 'edited' }); await f.store.refreshStale({ now });
    const after = await f.store.findOne(before); expect(after?.promptBody).toBe('edited'); expect(after?.revision).not.toBe(before.revision);
    expect(await f.store.acceptDispatch({ agentId: 'a', routineId: before.routineId, expectedRevision: before.revision, actorUserId: 'owner', source: 'tick', requestId: 'old-default', now })).toBeNull();
    await f.store.deleteDefault(first.defaultRoutineId); expect(await f.store.findOne(before)).toBeNull();
  });
  it('stores every contract-valid interval without a narrower database integer limit', async () => {
    const saved = await f.store.upsertDefault({ ...createInput().definition, name: 'long-interval', trigger: { kind: 'interval', every: '100000d' } });
    expect((await f.store.getDefault(saved.defaultRoutineId))?.trigger).toEqual({ kind: 'interval', every: '100000d' });
  });
  it('disabled authored names shadow defaults; enabled flags and overrides gate due work', async () => {
    await f.store.materializeMissing({ agents, now });
    const defaultRow = (await f.store.list({ agentId: 'a' }))[0]!;
    const shadow = await f.store.createAuthored({ ...createInput(), definition: { ...createInput().definition, name: 'heartbeat', enabled: false } });
    const future = new Date(now.getTime() + 86400001);
    const due = await f.store.claimDue({ now: future, limit: 10, claimWindowMinutes: 5 });
    expect(due.map(r => r.agentId)).toEqual(['b']);
    expect(await f.store.acceptDispatch({ agentId: 'a', routineId: defaultRow.routineId, expectedRevision: defaultRow.revision, actorUserId: 'owner', source: 'manual', requestId: 'shadowed', now })).toBeNull();
    await f.store.deleteAuthored({ agentId: 'a', routineId: shadow.routineId, expectedRevision: shadow.revision, actorUserId: 'owner', requestId: 'remove-shadow', now });
    expect((await f.store.claimDue({ now: future, limit: 10, claimWindowMinutes: 5 })).map(r => r.agentId).sort()).toEqual(['a', 'b']);
    await f.store.setAgentDefaultEnabled({ agentId: 'a', defaultRoutineId: defaultRow.definitionId!, ownerUserId: 'owner', enabled: false });
    expect(await f.store.acceptDispatch({ agentId: 'a', routineId: defaultRow.routineId, expectedRevision: defaultRow.revision, actorUserId: 'owner', source: 'manual', requestId: 'override-window', now })).toBeNull();
    expect((await f.store.claimDue({ now: future, limit: 10, claimWindowMinutes: 5 })).some(r => r.agentId === 'a')).toBe(false);
    await f.store.removeMaterializedDefault({ agentId: 'a', defaultRoutineId: defaultRow.definitionId! });
    await f.store.materializeMissing({ agents, now }); expect(await f.store.list({ agentId: 'a' })).toEqual([]);
    expect(await f.store.isAgentDefaultEnabled({ agentId: 'a', defaultRoutineId: defaultRow.definitionId! })).toBe(false);
    await f.store.setAgentDefaultEnabled({ agentId: 'a', defaultRoutineId: defaultRow.definitionId!, ownerUserId: 'owner', enabled: true });
    await f.store.materializeMissing({ agents, now }); expect(await f.store.list({ agentId: 'a' })).toHaveLength(1);
  });
  it('preserves authored pinned owner on edits while authoritative personal-owner reconciliation heals transfers', async () => {
    const row = await f.store.createAuthored(createInput());
    await f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId: 'transferred' }] });
    expect((await f.store.findOne(row))?.ownerUserId).toBe('transferred');
    expect(await f.store.reconcileOwners({ agents: [] })).toBe(0);
  });
  it('purged agents never re-materialize from a stale owner list', async () => {
    await f.store.purgeAgent('a'); await f.store.materializeMissing({ agents, now });
    expect(await f.store.list({ agentId: 'a' })).toEqual([]); expect(await f.store.list({ agentId: 'b' })).toHaveLength(1);
    await expect(f.store.setAgentDefaultEnabled({ agentId: 'a', defaultRoutineId: 'skill-reflection', ownerUserId: 'owner', enabled: false })).rejects.toMatchObject({ toolCode: 'not-found' });
    await f.store.refreshStale({ now }); await f.store.reconcileOwners({ agents });
    expect(await f.store.list({ agentId: 'a' })).toEqual([]);
    expect((await sql`SELECT * FROM routines_v1_credential_cleanup`.execute(f.db)).rows).toEqual([]);
  });
});
