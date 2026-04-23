import { describe, it, expect } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { isRejection, PluginError, reject } from '../errors.js';
import { makeChatContext, createLogger } from '../context.js';
import type { FireResult } from '../types.js';

const silentCtx = () =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
    workspaceRoot: process.cwd(),
  });

describe('HookBus — service hooks', () => {
  it('register + call returns the handler result', async () => {
    const bus = new HookBus();
    bus.registerService('greet', 'greeter', async (_ctx, { name }: { name: string }) => ({
      text: `hello ${name}`,
    }));

    const result = await bus.call<{ name: string }, { text: string }>(
      'greet',
      silentCtx(),
      { name: 'world' },
    );
    expect(result).toEqual({ text: 'hello world' });
  });

  it('call on an unregistered service throws PluginError{code:"no-service"}', async () => {
    const bus = new HookBus();
    await expect(bus.call('missing', silentCtx(), {})).rejects.toMatchObject({
      name: 'PluginError',
      code: 'no-service',
    });
  });

  it('duplicate registerService throws PluginError{code:"duplicate-service"}', () => {
    const bus = new HookBus();
    bus.registerService('svc', 'plugin-a', async () => 1);
    expect(() => bus.registerService('svc', 'plugin-b', async () => 2)).toThrow(PluginError);
  });

  it('service handler that throws propagates as PluginError with cause', async () => {
    const bus = new HookBus();
    bus.registerService('boom', 'boomer', async () => {
      throw new Error('bang');
    });
    await expect(bus.call('boom', silentCtx(), {})).rejects.toMatchObject({
      name: 'PluginError',
      plugin: 'boomer',
    });
  });

  it('hasService reflects registration', () => {
    const bus = new HookBus();
    expect(bus.hasService('x')).toBe(false);
    bus.registerService('x', 'p', async () => 0);
    expect(bus.hasService('x')).toBe(true);
  });

  it("handler's PluginError passes through unchanged (not re-wrapped)", async () => {
    const bus = new HookBus();
    const original = new PluginError({
      code: 'timeout',
      plugin: 'sandbox',
      message: 'exec timeout',
    });
    bus.registerService('run', 'sandbox', async () => {
      throw original;
    });
    await expect(bus.call('run', silentCtx(), {})).rejects.toBe(original);
  });
});

describe('HookBus — subscriber hooks', () => {
  it('fire with no subscribers returns payload unchanged', async () => {
    const bus = new HookBus();
    const res = await bus.fire<{ x: number }>('h', silentCtx(), { x: 1 });
    expect(res).toEqual({ rejected: false, payload: { x: 1 } });
  });

  it('subscribers run in registration order', async () => {
    const bus = new HookBus();
    const calls: string[] = [];
    bus.subscribe('h', 'a', async () => {
      calls.push('a');
      return undefined;
    });
    bus.subscribe('h', 'b', async () => {
      calls.push('b');
      return undefined;
    });
    await bus.fire('h', silentCtx(), {});
    expect(calls).toEqual(['a', 'b']);
  });

  it('returning a modified payload chains into the next subscriber', async () => {
    const bus = new HookBus();
    bus.subscribe<{ n: number }>('h', 'inc', async (_ctx, p) => ({ n: p.n + 1 }));
    bus.subscribe<{ n: number }>('h', 'dbl', async (_ctx, p) => ({ n: p.n * 2 }));
    const res = await bus.fire<{ n: number }>('h', silentCtx(), { n: 1 });
    expect(res).toEqual({ rejected: false, payload: { n: 4 } });
  });

  it('returning undefined is pass-through', async () => {
    const bus = new HookBus();
    bus.subscribe<{ n: number }>('h', 'noop', async () => undefined);
    bus.subscribe<{ n: number }>('h', 'inc', async (_ctx, p) => ({ n: p.n + 1 }));
    const res = await bus.fire<{ n: number }>('h', silentCtx(), { n: 1 });
    expect(res).toEqual({ rejected: false, payload: { n: 2 } });
  });

  it('reject short-circuits the chain and fills in source', async () => {
    const bus = new HookBus();
    let bCalled = false;
    bus.subscribe('h', 'a', async () => reject({ reason: 'blocked' }));
    bus.subscribe('h', 'b', async () => {
      bCalled = true;
      return undefined;
    });
    const res = await bus.fire('h', silentCtx(), {});
    expect(bCalled).toBe(false);
    expect(res).toMatchObject({ rejected: true, reason: 'blocked', source: 'a' });
    expect(isRejection(res)).toBe(true);
  });

  it('subscriber throw is isolated: logged, chain continues', async () => {
    const bus = new HookBus();
    const logs: Array<{ level: string; msg: string; bindings?: unknown }> = [];
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string, bindings?: Record<string, unknown>) => {
        logs.push({ level: 'error', msg, bindings });
      },
      child(_bindings: Record<string, unknown>) {
        return mockLogger;
      },
    };
    const ctx = makeChatContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u',
      logger: mockLogger,
      workspaceRoot: process.cwd(),
    });
    bus.subscribe<{ n: number }>('h', 'bad', async () => {
      throw new Error('oops');
    });
    bus.subscribe<{ n: number }>('h', 'good', async (_ctx, p) => ({ n: p.n + 1 }));
    const res = await bus.fire<{ n: number }>('h', ctx, { n: 1 });
    expect(res).toEqual({ rejected: false, payload: { n: 2 } });
    expect(logs.find((l) => l.level === 'error')).toBeDefined();
  });

  it('FireResult type: consumers can discriminate via .rejected', async () => {
    const bus = new HookBus();
    bus.subscribe('h', 'a', async () => reject({ reason: 'nope' }));
    const res: FireResult<{ n: number }> = await bus.fire('h', silentCtx(), { n: 1 });
    if (res.rejected) {
      expect(res.reason).toBe('nope');
    } else {
      throw new Error('should be rejected');
    }
  });

  it('preserves a source explicitly set by reject(); falls back to subscriber plugin name', async () => {
    const bus = new HookBus();
    bus.subscribe('explicit', 'actual-plugin', async () =>
      reject({ reason: 'blocked', source: 'something-else' }),
    );
    bus.subscribe('default', 'actual-plugin', async () => reject({ reason: 'blocked' }));
    const explicit = await bus.fire('explicit', silentCtx(), {});
    const fallback = await bus.fire('default', silentCtx(), {});
    expect(explicit).toMatchObject({
      rejected: true,
      reason: 'blocked',
      source: 'something-else',
    });
    expect(fallback).toMatchObject({
      rejected: true,
      reason: 'blocked',
      source: 'actual-plugin',
    });
  });

  it('independent fires on the same bus do not leak state', async () => {
    const bus = new HookBus();
    bus.subscribe<{ n: number }>('h', 'inc', async (_ctx, p) => ({ n: p.n + 1 }));
    const first = await bus.fire<{ n: number }>('h', silentCtx(), { n: 1 });
    const second = await bus.fire<{ n: number }>('h', silentCtx(), { n: 1 });
    expect(first).toEqual({ rejected: false, payload: { n: 2 } });
    expect(second).toEqual({ rejected: false, payload: { n: 2 } });
  });
});
