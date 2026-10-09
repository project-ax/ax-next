import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { createRoutinesStore } from '../store.js';

let h: RoutineHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });
async function create(overrides = {}) {
  return h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
    agentId: h.agentId, requestId: randomUUID(),
    definition: RoutineDefinitionSchema.parse({ name: 'Canary', promptBody: 'Check in', trigger: { kind: 'interval', every: '60s' }, silenceToken: 'HEARTBEAT_OK', ...overrides }),
  });
}
async function fire(row: RoutineView) {
  await h.bus.call('routines:fire-now', h.owner, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: randomUUID() });
}

describe('DB routine canary — real ACL, durable dispatch and turn completion', () => {
  it.each(['per-fire', 'shared'] as const)('creates, fires and silences a %s conversation without workspace writes', async conversation => {
    h = await createRoutineHarness({ invoke: async (ctx, bus) => {
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, turnId: 'turn', contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }] });
      return { kind: 'complete' };
    } });
    const calls = vi.spyOn(h.bus, 'call');
    const row = await create({ conversation });
    expect(row.routineId).not.toContain('/');
    const store = createRoutinesStore(h.db);
    await fire(row);
    await expect.poll(async () => (await store.recentFires(row)).length).toBe(1);
    expect((await store.recentFires(row))[0]).toMatchObject({ status: 'silenced', conversationId: 'conversation', error: null });
    expect((await store.findOne(row))?.lastStatus).toBe('silenced');
    expect(calls.mock.calls.some(([hook]) => hook === 'conversations:drop-turn')).toBe(true);
    expect(calls.mock.calls.some(([hook]) => hook === 'conversations:hide')).toBe(conversation === 'per-fire');
    if (conversation === 'shared') expect(calls).toHaveBeenCalledWith('conversations:find-or-create', expect.anything(), expect.objectContaining({ externalKey: row.routineId }));
    expect(calls.mock.calls.some(([hook]) => hook === 'workspace:apply')).toBe(false);
    expect(h.invokeCalls).toHaveLength(1);
  });
  it('keeps ordinary output visible and returns history through the current opaque identity', async () => {
    h = await createRoutineHarness();
    const row = await create();
    await fire(row);
    await expect.poll(async () => (await createRoutinesStore(h.db).recentFires(row))[0]?.status).toBe('ok');
    expect(await h.bus.call('routines:recent-fires', h.owner, { agentId: row.agentId, routineId: row.routineId })).toMatchObject({ fires: [expect.objectContaining({ status: 'ok' })] });
    await expect(h.bus.call('routines:fire-now', h.teamAdmin, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: randomUUID() })).rejects.toThrow();
    expect(h.invokeCalls).toHaveLength(1);
  });
  it('persists connector warnings even when the response is silenced, then clears them on the next clean run', async () => {
    let skipped = true;
    h = await createRoutineHarness({ invoke: async (ctx, bus) => {
      if (skipped) await bus.fire('chat:connectors-skipped', ctx, { reqId: ctx.reqId, connectors: [{ connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' }] });
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, turnId: 'turn', contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }] });
      return { kind: 'complete' };
    } });
    const row = await create(); const store = createRoutinesStore(h.db);
    await fire(row);
    await expect.poll(async () => (await store.recentFires(row)).length).toBe(1);
    expect((await store.findOne(row))?.lastWarning).toContain('Gmail');
    skipped = false;
    await fire(row);
    await expect.poll(async () => (await store.recentFires(row)).length).toBe(2);
    expect((await store.findOne(row))?.lastWarning).toBeNull();
  });
  it('stops a saved definition without editing its prompt and deletes it through DB services', async () => {
    h = await createRoutineHarness();
    const row = await create();
    const stopped = await h.bus.call<unknown, RoutineView>('routines:update', h.owner, { agentId: row.agentId, routineId: row.routineId, requestId: randomUUID(), expectedRevision: row.revision, patch: { enabled: false } });
    expect(stopped.promptBody).toBe(row.promptBody);
    await expect(fire(stopped)).rejects.toMatchObject({ toolCode: 'disabled' });
    expect(await h.bus.call('routines:delete', h.owner, { agentId: row.agentId, routineId: row.routineId, requestId: randomUUID(), expectedRevision: stopped.revision })).toEqual({ deleted: true, cleanupPending: false });
    expect(await createRoutinesStore(h.db).findOne(row)).toBeNull();
  });
});
