import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { createRoutinesStore } from '../store.js';

let h: RoutineHarness;
afterEach(async () => { await h?.close(); vi.restoreAllMocks(); });
async function create() {
  const row = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
    agentId: h.agentId, requestId: 'create',
    definition: RoutineDefinitionSchema.parse({ name: 'Check', promptBody: 'Check', trigger: { kind: 'interval', every: '1h' } }),
  });
  return { row, input: { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: 'fire' } };
}

describe('production routine effect lifetime', () => {
  it.each([120000, 5])('joins a deferred invoke and its terminal write through a %s ms hook deadline', async timeout => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ended = false;
    h = await createRoutineHarness({ invokeTimeoutMs: timeout, invoke: async (ctx, bus) => {
      await gate;
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
      ended = true;
      return { kind: 'complete' };
    } });
    const { row, input } = await create();
    await h.bus.call('routines:fire-now', h.owner, input);
    let shut = false;
    const shutdown = h.shutdownRoutines().then(() => { shut = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(shut).toBe(false);
      await expect(h.bus.call('routines:fire-now', h.owner, { ...input, requestId: 'after-close' })).rejects.toMatchObject({ toolCode: 'unavailable' });
    } finally { release(); await shutdown; }
    expect(ended).toBe(true);
    expect((await createRoutinesStore(h.db).recentFires(row))[0]?.status).toBe('ok');
  });

  it('settles the missing-turn fallback during shutdown and leaves no future completion timer', async () => {
    h = await createRoutineHarness({ invoke: async () => ({ kind: 'complete' }) });
    const { row, input } = await create();
    const diagnostic = captureExpectedStderr(message => message.startsWith(`[ax/routines] agent:invoke failed for ${row.agentId}/${row.routineId}: the run finished without reporting a result`));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clears = vi.spyOn(globalThis, 'clearTimeout');
    await h.bus.call('routines:fire-now', h.owner, input);
    await expect.poll(() => timers.mock.calls.some(([, ms]) => ms === 60_000)).toBe(true);
    const index = timers.mock.calls.findIndex(([, ms]) => ms === 60_000);
    const fallback = timers.mock.results[index]!.value;
    await h.shutdownRoutines();
    expect(clears).toHaveBeenCalledWith(fallback);
    expect(diagnostic.messages).toHaveLength(1);
    const store = createRoutinesStore(h.db);
    expect((await store.recentFires(row))[0]).toMatchObject({ status: 'error', error: expect.stringContaining('without reporting') });
  });

  it('keeps the database alive through the real kernel outer shutdown deadline', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ended = false;
    const errors: Array<{ name: string; error: unknown }> = [];
    h = await createRoutineHarness({ shutdownTimeoutMs: 50, onShutdownError: (name, error) => { errors.push({ name, error }); }, invoke: async (ctx, bus) => {
      await gate;
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
      ended = true;
      return { kind: 'complete' };
    } });
    const { row, input } = await create();
    const store = createRoutinesStore(h.db);
    const destroy = h.db.destroy.bind(h.db);
    let terminalBeforeDestroy: string | undefined;
    const teardown = vi.spyOn(h.db, 'destroy').mockImplementation(async () => {
      terminalBeforeDestroy = (await store.recentFires(row))[0]?.status;
      expect(ended).toBe(true);
      await destroy();
    });
    await h.bus.call('routines:fire-now', h.owner, input);
    const shutdown = h.shutdownKernel();
    try {
      await expect.poll(() => errors.length).toBe(1);
      expect(errors[0]!.name).toBe('@ax/routines');
      expect(String(errors[0]!.error)).toContain('exceeded 50ms');
      expect(teardown).not.toHaveBeenCalled();
    } finally { release(); await shutdown; }
    expect(teardown).toHaveBeenCalledOnce();
    expect(terminalBeforeDestroy).toBe('ok');
    expect(errors).toHaveLength(1);
  });
});
