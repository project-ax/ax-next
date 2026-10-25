import { describe, it, expect } from 'vitest';
import { fixture, createInput, now } from './store-fixture.js';
import { sql } from 'kysely';
const f = fixture();
const outcome = { status: 'ok' as const, conversationId: 'conversation', error: null, renderedPrompt: 'ran', warning: null };
const accept = (row: { agentId: string; routineId: string; revision: string }, requestId = 'fire') => ({ agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'editor', source: 'manual' as const, requestId, now });
describe('durable dispatch', () => {
  it('commits acceptance before invoke and returns the same dispatch for concurrent retries', async () => {
    const row = await f.store.createAuthored(createInput()); const [a, b] = await Promise.all([f.store.acceptDispatch(accept(row)), f.store.acceptDispatch(accept(row))]);
    expect(a?.accepted).toEqual(b?.accepted); expect([a?.replayed, b?.replayed].sort()).toEqual([false, true]); expect(a?.accepted.row.ownerUserId).toBe('owner');
    expect((await sql`SELECT * FROM routines_v1_dispatches`.execute(f.db)).rows).toHaveLength(1);
    expect(await f.store.recentFires(row)).toEqual([]);
    await expect(f.store.acceptDispatch({ ...accept(row), source: 'webhook' })).rejects.toMatchObject({ toolCode: 'request-conflict' });
  });
  it('records exactly one terminal row under competing finish callbacks', async () => {
    const row = await f.store.createAuthored(createInput()); const dispatch = (await f.store.acceptDispatch(accept(row)))!.accepted;
    expect((await Promise.all([f.store.finishDispatch({ dispatchId: dispatch.dispatchId, outcome }), f.store.finishDispatch({ dispatchId: dispatch.dispatchId, outcome: { ...outcome, status: 'silenced' } })])).sort()).toEqual([false, true]);
    expect(await f.store.recentFires(row)).toHaveLength(1);
    expect((await f.store.findOne(row))?.lastStatus).toBe((await f.store.recentFires(row))[0]?.status);
  });
  it('caps rendered prompt bytes and prevents an older completion overwriting newer status', async () => {
    const row = await f.store.createAuthored(createInput());
    const old = (await f.store.acceptDispatch(accept(row, 'older')))!.accepted;
    const recent = (await f.store.acceptDispatch({ ...accept(row, 'newer'), now: new Date(now.getTime() + 1000) }))!.accepted;
    await f.store.finishDispatch({ dispatchId: recent.dispatchId, outcome: { ...outcome, status: 'silenced', warning: 'connector unavailable', renderedPrompt: '😀'.repeat(20000) } });
    await f.store.finishDispatch({ dispatchId: old.dispatchId, outcome });
    expect((await f.store.findOne(row))?.lastStatus).toBe('silenced');
    expect((await f.store.findOne(row))?.lastWarning).toBe('connector unavailable');
    const latest = (await f.store.recentFires(row))[0]!;
    expect(new TextEncoder().encode(latest.renderedPrompt!).length).toBeLessThanOrEqual(65536);
    expect(latest.renderedPrompt).toMatch(/😀…$/u);
  });
  it('rechecks revision and enabled; old acceptance remains finishable after edit and delete', async () => {
    const row = await f.store.createAuthored(createInput()); const dispatch = (await f.store.acceptDispatch(accept(row)))!.accepted;
    const disabled = await f.store.updateAuthored({ ...accept(row), patch: { enabled: false }, requestId: 'disable', stopOnly: true });
    expect(await f.store.acceptDispatch(accept(row, 'stale'))).toBeNull();
    expect(await f.store.acceptDispatch(accept(disabled, 'disabled'))).toBeNull();
    expect(await f.store.acceptDispatch(accept(row))).toEqual({ accepted: dispatch, replayed: true });
    await f.store.finishDispatch({ dispatchId: dispatch.dispatchId, outcome });
    expect((await f.store.findOne(row))?.lastStatus).toBeNull();
    await f.store.deleteAuthored({ ...accept(disabled), requestId: 'delete' });
    expect(await f.store.recentFires(row)).toHaveLength(1);
  });
  it('finishes after deletion without recreating a definition, and rejects finish after agent purge', async () => {
    const row = await f.store.createAuthored(createInput()); const dispatch = (await f.store.acceptDispatch(accept(row)))!.accepted;
    await f.store.deleteAuthored({ ...accept(row), requestId: 'delete' });
    expect(await f.store.finishDispatch({ dispatchId: dispatch.dispatchId, outcome })).toBe(true);
    expect(await f.store.findOne(row)).toBeNull(); expect(await f.store.recentFires(row)).toHaveLength(1);
    await f.store.purgeAgent('a');
    expect(await f.store.finishDispatch({ dispatchId: dispatch.dispatchId, outcome })).toBe(false);
    expect(await f.store.recentFires(row)).toEqual([]);
    expect((await sql`SELECT * FROM routines_v1_requests`.execute(f.db)).rows).toHaveLength(0);
  });
  it('acceptedDispatchId finds the check-in a request started, whatever the revision is now (TASK-937)', async () => {
    const row = await f.store.createAuthored(createInput());
    const started = (await f.store.acceptDispatch(accept(row, 'r1')))!.accepted;
    const key = { agentId: 'a', actorUserId: 'editor', requestId: 'r1' };
    expect(await f.store.acceptedDispatchId(key)).toBe(started.dispatchId);
    // A new revision: an accept under 'r1' now would be a request-conflict, and the read still finds it.
    const disabled = await f.store.updateAuthored({ ...accept(row), patch: { enabled: false }, requestId: 'disable', stopOnly: true });
    expect(await f.store.acceptedDispatchId(key)).toBe(started.dispatchId);
    // A refused accept leaves no receipt.
    expect(await f.store.acceptDispatch(accept(disabled, 'r2'))).toBeNull();
    expect(await f.store.acceptedDispatchId({ ...key, requestId: 'r2' })).toBeNull();
    // Someone else's request id, another agent's, and one never sent.
    expect(await f.store.acceptedDispatchId({ ...key, actorUserId: 'owner' })).toBeNull();
    expect(await f.store.acceptedDispatchId({ ...key, agentId: 'b' })).toBeNull();
    expect(await f.store.acceptedDispatchId({ ...key, requestId: 'never-sent' })).toBeNull();
  });
});

describe('agent retirement serialization', () => {
  it('refuses a create that resolved agent access before purge but arrives after it', async () => {
    const late = createInput(); await f.store.purgeAgent('a');
    await expect(f.store.createAuthored(late)).rejects.toMatchObject({ toolCode: 'not-found' });
    expect(await f.store.list({ agentId: 'a' })).toEqual([]);
  });
  it('serializes an in-flight create before purge and leaves no definition or receipt', async () => {
    let release!: () => void; let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const blocker = f.db.transaction().execute(async trx => { await sql`SELECT pg_advisory_xact_lock(hashtextextended('a',18427132))`.execute(trx); locked(); await wait; });
    await ready;
    const create = f.store.createAuthored(createInput());
    await expect.poll(async () => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted`.execute(f.db)).rows[0]!.n)).toBe(1);
    const purge = f.store.purgeAgent('a');
    release(); await blocker; await create; await purge;
    expect(await f.store.list({ agentId: 'a' })).toEqual([]);
    expect((await sql`SELECT * FROM routines_v1_requests`.execute(f.db)).rows).toEqual([]);
  });
  it('serializes a finishing dispatch with purge without history resurrection', async () => {
    const row = await f.store.createAuthored(createInput()); const dispatch = (await f.store.acceptDispatch(accept(row)))!.accepted;
    let release!: () => void; let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const blocker = f.db.transaction().execute(async trx => { await trx.selectFrom('routines_v1_dispatches').selectAll().where('dispatch_id', '=', dispatch.dispatchId).forUpdate().execute(); locked(); await wait; });
    await ready;
    const finish = f.store.finishDispatch({ dispatchId: dispatch.dispatchId, outcome });
    await expect.poll(async () => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%routines_v1_dispatches%'`.execute(f.db)).rows[0]!.n)).toBeGreaterThan(0);
    const purge = f.store.purgeAgent('a'); release(); await blocker; await finish; await purge;
    expect(await f.store.recentFires(row)).toEqual([]);
    expect(await f.store.finishDispatch({ dispatchId: dispatch.dispatchId, outcome })).toBe(false);
  });
});
