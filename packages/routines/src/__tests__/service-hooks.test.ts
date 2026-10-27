import { afterEach, describe, expect, it } from 'vitest';
import { RoutineDefinitionSchema, RoutineUpsertDefaultInputSchema, type RoutineView, type RoutineGetDefaultOutput } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { createRoutinesStore } from '../store.js';
let h: RoutineHarness;
afterEach(async () => { await h?.close(); });
describe('registered default services with real ACL', () => {
  it('lists seeds, toggles an agent override, and prevents another person from managing them', async () => {
    h = await createRoutineHarness();
    const store = createRoutinesStore(h.db);
    const seed = (await store.listDefaults()).find(r => r.name === 'heartbeat')!;
    expect(await h.bus.call('routines:list-agent-defaults', h.owner, { agentId: h.agentId })).toMatchObject({ defaults: expect.arrayContaining([expect.objectContaining({ defaultRoutineId: seed.defaultRoutineId, enabled: true })]) });
    const input = { agentId: h.agentId, defaultRoutineId: seed.defaultRoutineId, enabled: false };
    await expect(h.bus.call('routines:set-agent-default-enabled', h.teamAdmin, input)).rejects.toThrow();
    await h.bus.call('routines:set-agent-default-enabled', h.owner, input);
    expect(await store.isAgentDefaultEnabled(input)).toBe(false);
    await h.bus.call('routines:set-agent-default-enabled', h.owner, { ...input, enabled: true });
    expect(await store.isAgentDefaultEnabled(input)).toBe(true);
    await expect(h.bus.call('routines:set-agent-default-enabled', h.owner, { ...input, defaultRoutineId: 'missing' })).rejects.toMatchObject({ toolCode: 'not-found' });
  });
  it('admin edits structured defaults, controls Enabled, and deletion removes materialized rows', async () => {
    h = await createRoutineHarness();
    const definition = RoutineUpsertDefaultInputSchema.parse({ name: 'Admin check', promptBody: 'body', trigger: { kind: 'interval', every: '1h' } });
    await expect(h.bus.call('routines:upsert-default', h.owner, definition)).rejects.toThrow();
    const created = await h.bus.call<unknown, {
      defaultRoutineId: string;
    }>('routines:upsert-default', h.teamAdmin, definition);
    const read = await h.bus.call<unknown, RoutineGetDefaultOutput>('routines:get-default', h.teamAdmin, { defaultRoutineId: created.defaultRoutineId });
    expect(read.promptBody).toBe('body');
    const { defaultRoutineId: _id, updatedAt: _updatedAt, ...defaultFields } = read;
    await h.bus.call('routines:upsert-default', h.teamAdmin, { ...defaultFields, enabled: false });
    const store = createRoutinesStore(h.db);
    expect((await store.getDefault(created.defaultRoutineId))?.enabled).toBe(false);
    await h.bus.call('routines:upsert-default', h.teamAdmin, { ...definition, enabled: true });
    await store.materializeMissing({ agents: [{ agentId: h.agentId, ownerUserId: h.owner.userId }], now: new Date() });
    expect((await store.list({ agentId: h.agentId })).some(r => r.definitionId === created.defaultRoutineId)).toBe(true);
    await h.bus.call('routines:delete-default', h.teamAdmin, { defaultRoutineId: created.defaultRoutineId });
    expect((await store.list({ agentId: h.agentId })).some(r => r.definitionId === created.defaultRoutineId)).toBe(false);
  });
  it.each([{ kind: 'webhook', path: '/hook' }, { kind: 'cron', expr: '* * * * *', tz: 'UTC' }])('rejects unsupported default trigger $kind', async (trigger) => {
    h = await createRoutineHarness();
    const definition = { name: 'Invalid', promptBody: 'body', trigger };
    await expect(h.bus.call('routines:upsert-default', h.teamAdmin, definition)).rejects.toMatchObject({ toolCode: 'validation' });
  });
  it('lists DB definitions only and reports a missing fire target distinctly', async () => {
    h = await createRoutineHarness();
    const definition = RoutineDefinitionSchema.parse({ name: 'Check', promptBody: 'body', trigger: { kind: 'interval', every: '1h' } });
    const row = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: h.agentId, requestId: 'create', definition });
    expect(await h.bus.call('routines:list', h.owner, { agentId: h.agentId })).toMatchObject({ routines: expect.arrayContaining([expect.objectContaining({ routineId: row.routineId })]) });
    await expect(h.bus.call('routines:fire-now', h.owner, { agentId: h.agentId, routineId: 'missing', expectedRevision: 'v', requestId: 'fire' })).rejects.toMatchObject({ toolCode: 'not-found' });
  });
});
