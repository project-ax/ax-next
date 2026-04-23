import { describe, it, expect } from 'vitest';
import { HookBus } from '../hook-bus.js';
import { PluginError } from '../errors.js';
import { makeChatContext } from '../context.js';

const silentCtx = () => {
  const ctx = makeChatContext({
    sessionId: 's', agentId: 'a', userId: 'u',
  });
  (ctx.logger as unknown as { info: () => void }).info = () => {};
  (ctx.logger as unknown as { error: () => void }).error = () => {};
  (ctx.logger as unknown as { warn: () => void }).warn = () => {};
  (ctx.logger as unknown as { debug: () => void }).debug = () => {};
  return ctx;
};

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
});
