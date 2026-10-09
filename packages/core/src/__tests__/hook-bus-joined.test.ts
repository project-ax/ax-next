import { describe, it, expect } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { makeAgentContext } from '../context.js';
const ctx = makeAgentContext({ sessionId: 'test', agentId: 'agent', userId: 'owner' });
describe('joined service settlement', () => {
  it('retains nested effects beyond timeout, while ordinary calls still time out', async () => {
    const bus = new HookBus({ defaultServiceTimeoutMs: 10 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let written = false;
    bus.registerService('storage:write', 'test', async () => { await gate; written = true; });
    bus.registerService('vault:write', 'test', async c => bus.call('storage:write', c, {}));
    let settled = false;
    const joined = bus.callJoined('vault:write', ctx, {}).catch(e => e).finally(() => { settled = true; });
    await expect(bus.call('vault:write', ctx, {})).rejects.toMatchObject({ code: 'timeout' });
    expect(settled).toBe(false);
    expect(written).toBe(false);
    release();
    expect(await joined).toMatchObject({ code: 'timeout' });
    expect(written).toBe(true);
  });
  it('keeps each joined boundary locked even when another joined caller surrounds it', async () => {
    const bus = new HookBus({ defaultServiceTimeoutMs: 10 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let innerSettled = false;
    bus.registerService('write', 'test', async () => { await gate; });
    bus.registerService('locked', 'test', async c => {
      try { await bus.callJoined('write', c, {}); }
      finally { innerSettled = true; }
    });
    const result = bus.callJoined('locked', ctx, {}).catch(e => e);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(innerSettled).toBe(false);
    release(); expect(await result).toMatchObject({ code: 'timeout' });
    expect(innerSettled).toBe(true);
  });

});
