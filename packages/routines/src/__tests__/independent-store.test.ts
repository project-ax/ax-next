import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { RoutineCreateInputSchema, RoutineUpdateInputSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { createRequestHashes, credentialRef, inputHash, nextRun, updateRequestHashes } from '../definition.js';
const f = fixture();
const frozen = JSON.parse(readFileSync(new URL('./fixtures/schema-v14-operations.json', import.meta.url), 'utf8'));
const schedule = { kind: 'interval' as const, every: '60s' };
const webhook = { kind: 'webhook' as const, path: '/dual', events: ['push'], hmac: { header: 'X-Signature', algorithm: 'sha256' as const } };
const dual = (requestId = 'dual') => ({ ...createInput(requestId), definition: { ...createInput().definition, schedule, webhook } });
const edit = (row: { agentId: string; routineId: string; revision: string }, patch: Record<string, unknown>, requestId = crypto.randomUUID()) => ({ ...row, expectedRevision: row.revision, actorUserId: 'editor', requestId, patch, now: new Date(now.getTime() + 5000), stopOnly: false });
const seedReceipt = async (row: Record<string, unknown>) => {
  await sql`INSERT INTO routines_v1_requests (agent_id,owner_user_id,operation,request_id,input_hash,result)
    VALUES (${row.agent_id},${row.owner_user_id},${row.operation},${row.request_id},${row.input_hash},${JSON.stringify(row.result)}::jsonb)`.execute(f.db);
};

describe('independent authored methods in the durable store', () => {
  it('persists both methods and claims only repeats with a schedule', async () => {
    const row = await f.store.createAuthored(dual());
    const onlyHook = await f.store.createAuthored({ ...dual('only-hook'), definition: { ...dual().definition, schedule: null, webhook: { kind: 'webhook', path: '/only' } } });
    expect(row).toMatchObject({ schedule, webhook, nextRunAt: new Date(now.getTime() + 60_000) });
    expect(onlyHook.nextRunAt).toBeNull();
    expect((await f.store.findWebhook({ agentId: row.agentId, path: webhook.path }))?.routineId).toBe(row.routineId);
    expect((await f.store.claimDue({ now: new Date(now.getTime() + 60_000), limit: 20, claimWindowMinutes: 1 })).map(value => value.routineId)).toEqual([row.routineId]);
  });
  it('preserves a timer and its credential when changing only app-update settings', async () => {
    const row = await f.store.createAuthored(dual());
    const changedHook = { ...webhook, path: '/renamed', events: ['release'] };
    const changed = await f.store.updateAuthored(edit(row, { webhook: changedHook }));
    expect(changed).toMatchObject({ schedule, webhook: changedHook, nextRunAt: row.nextRunAt });
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([]);
    const changedSchedule = await f.store.updateAuthored(edit(changed, { schedule: { kind: 'interval', every: '2h' } }));
    expect(changedSchedule.webhook).toEqual(changedHook);
    expect(changedSchedule.nextRunAt).toEqual(new Date(now.getTime() + 7_205_000));
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([]);
    const removed = await f.store.updateAuthored(edit(changedSchedule, { webhook: null }));
    expect(removed.schedule).toEqual(changedSchedule.schedule);
    expect(removed.nextRunAt).toEqual(changedSchedule.nextRunAt);
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([{ agentId: row.agentId, routineId: row.routineId, ownerUserId: row.ownerUserId, credentialRef: credentialRef(row) }]);
    await expect(f.store.updateAuthored(edit(removed, { schedule: null }))).rejects.toMatchObject({ toolCode: 'validation' });
  });
  it('atomically reserves a webhook path for dual and webhook-only repeats', async () => {
    const results = await Promise.allSettled([
      f.store.createAuthored(dual('both')),
      f.store.createAuthored({ ...dual('hook'), definition: { ...dual().definition, schedule: null } }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { toolCode: 'webhook-path-conflict' } });
    await expect(f.store.createAuthored({ ...dual('other-agent'), agentId: 'b' })).resolves.toMatchObject({ agentId: 'b' });
  });
  it('preserves a stored fast cron on reads and unrelated edits but refuses new or changed fast schedules', async () => {
    const row = await f.store.createAuthored(createInput());
    const fast = { kind: 'cron' as const, expr: '*/10 * * * * *', tz: 'UTC' };
    await sql`UPDATE routines_v1_definitions SET schedule_spec=${JSON.stringify(fast)}::jsonb WHERE routine_id=${row.routineId}`.execute(f.db);
    const legacy = (await f.store.findOne(row))!;
    expect(legacy.schedule).toEqual(fast);
    expect(nextRun(legacy, now)).toEqual(new Date(now.getTime() + 10_000));
    const renamed = await f.store.updateAuthored(edit(legacy, { name: 'Renamed legacy', schedule: { ...fast } }));
    expect(renamed.schedule).toEqual(fast);
    expect(renamed.nextRunAt).toEqual(row.nextRunAt);
    await expect(f.store.updateAuthored(edit(renamed, { schedule: { ...fast, expr: '*/20 * * * * *' } }))).rejects.toMatchObject({ toolCode: 'validation', field: 'schedule.expr' });
    await expect(f.store.createAuthored({ ...createInput('fresh-fast'), definition: { ...createInput().definition, schedule: fast } })).rejects.toMatchObject({ toolCode: 'validation', field: 'schedule.expr' });
  });
});

describe('v14 receipt retries through current storage', () => {
  it.each(['create', 'update', 'dispatch'])('replays an old %s after its live row is gone without resurrecting or dispatching it', async operation => {
    const old = frozen.receipts.find((row: { operation: string }) => row.operation === operation);
    const oldOperation = frozen.operations.find((row: { operation: string; input: { requestId: string } }) => row.operation === operation && row.input.requestId === old.request_id);
    await seedReceipt(old);
    expect(await f.store.findOperationReceipt({ agentId: old.agent_id, actorUserId: 'another-actor', operation, requestId: old.request_id, inputHash: old.input_hash })).toBeNull();
    const actor = { actorUserId: old.owner_user_id, now };
    if (operation === 'create') {
      const input = RoutineCreateInputSchema.parse(oldOperation.input);
      const hashes = createRequestHashes(input);
      expect(await f.store.findOperationReceipt({ ...input, ...actor, operation, inputHash: hashes[0]!, compatibleInputHashes: hashes.slice(1) })).toMatchObject({ routineId: old.result.routineId });
      expect(await f.store.createAuthored({ ...input, ...actor, ownerUserId: old.owner_user_id })).toMatchObject({ routineId: old.result.routineId });
    } else if (operation === 'update') {
      const input = RoutineUpdateInputSchema.parse(oldOperation.input);
      const hashes = updateRequestHashes(input);
      expect(await f.store.findOperationReceipt({ ...input, ...actor, operation, inputHash: hashes[0]!, compatibleInputHashes: hashes.slice(1) })).toMatchObject({ routineId: old.result.routineId });
      expect(await f.store.updateAuthored({ ...input, ...actor, stopOnly: false })).toMatchObject({ routineId: old.result.routineId });
      const { webhook: _null, ...additive } = input.patch;
      await expect(f.store.updateAuthored({ ...input, ...actor, patch: additive, stopOnly: false })).rejects.toMatchObject({ toolCode: 'request-conflict' });
    } else {
      const replay = await f.store.acceptDispatch({ ...oldOperation.input, ...actor });
      expect(replay).toMatchObject({ replayed: true, accepted: { dispatchId: old.result.dispatchId, row: { routineId: old.result.row.routineId } } });
    }
    expect(await f.store.list({ agentId: old.agent_id })).toEqual([]);
    expect((await sql`SELECT * FROM routines_v1_dispatches`.execute(f.db)).rows).toEqual([]);
  });
  it('replays a completed legacy fast-cron create before the new authoring floor', async () => {
    const operation = frozen.operations.find((row: { operation: string; input: { definition?: { name: string } } }) => row.operation === 'create' && row.input.definition?.name === 'Legacy fast cron');
    const old = frozen.receipts.find((row: { request_id: string }) => row.request_id === operation.input.requestId);
    await seedReceipt(old);
    const replay = await f.store.createAuthored({ ...RoutineCreateInputSchema.parse(operation.input), actorUserId: old.owner_user_id, ownerUserId: old.owner_user_id, now });
    expect(replay.schedule).toMatchObject({ kind: 'cron', expr: '*/10 * * * * *' });
    await expect(f.store.createAuthored({ ...RoutineCreateInputSchema.parse(operation.input), actorUserId: 'another-actor', ownerUserId: 'another-actor', now })).rejects.toMatchObject({ toolCode: 'validation', field: 'schedule.expr' });
    expect(await f.store.list({ agentId: old.agent_id })).toEqual([]);
  });
  it('rehydrates an exact 64 KiB legacy brief without counting receipt metadata', async () => {
    const old = frozen.receipts.find((row: { operation: string }) => row.operation === 'create');
    const operation = frozen.operations.find((row: { input: { requestId: string } }) => row.input.requestId === old.request_id);
    const definition = { ...operation.input.definition, promptBody: '' };
    definition.promptBody = 'x'.repeat(65_536 - new TextEncoder().encode(JSON.stringify(definition)).length);
    const input = { ...operation.input, requestId: 'sized-receipt', definition };
    const stored = { ...old.result, promptBody: definition.promptBody };
    await seedReceipt({ ...old, request_id: input.requestId, input_hash: inputHash({ agentId: input.agentId, definition }), result: stored });
    const replay = await f.store.createAuthored({ ...RoutineCreateInputSchema.parse(input), actorUserId: old.owner_user_id, ownerUserId: old.owner_user_id, now });
    expect(replay.promptBody).toBe(definition.promptBody);
    expect(replay).not.toHaveProperty('trigger');
    expect(replay.schedule).toEqual(definition.trigger);
    expect(replay.agentId).toBe(old.agent_id);
  });
});
