import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { HookBus } from '../hook-bus.js';
import { isRejection, isHold, PluginError, reject, hold } from '../errors.js';
import { makeAgentContext, createLogger, type Logger } from '../context.js';
import type { FireResult } from '../types.js';

const silentCtx = () =>
  makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
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

  it('listServices returns the registered service names in registration order', () => {
    const bus = new HookBus();
    expect(bus.listServices()).toEqual([]);
    bus.registerService('a', 'p1', async () => undefined);
    bus.registerService('b', 'p2', async () => undefined);
    expect(bus.listServices()).toEqual(['a', 'b']);
  });

  it('listServices returns a fresh array (mutation does not affect bus state)', () => {
    const bus = new HookBus();
    bus.registerService('a', 'p1', async () => undefined);
    const list = bus.listServices();
    list.pop();
    expect(bus.listServices()).toEqual(['a']);
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

  it('preserves the .hold field through a hold rejection (not flattened to a plain deny)', async () => {
    const bus = new HookBus();
    bus.subscribe('h', 'a', async () =>
      hold({ decisionId: 'dec_1', note: 'Held for approval' }),
    );
    const res = await bus.fire('h', silentCtx(), {});
    expect(isRejection(res)).toBe(true);
    expect(isHold(res)).toBe(true);
    expect(res).toMatchObject({
      rejected: true,
      reason: 'Held for approval',
      source: 'a',
      hold: { decisionId: 'dec_1', note: 'Held for approval' },
    });
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
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u',
      logger: mockLogger,
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

  it('unsubscribe removes a plugin\'s subscriber and returns the count', async () => {
    const bus = new HookBus();
    const calls: string[] = [];
    bus.subscribe('h', 'plugin-a', async (_ctx, p) => { calls.push('a'); return p; });
    bus.subscribe('h', 'plugin-b', async (_ctx, p) => { calls.push('b'); return p; });

    const removed = bus.unsubscribe('h', 'plugin-a');
    expect(removed).toBe(1);

    await bus.fire('h', silentCtx(), {});
    expect(calls).toEqual(['b']);
  });

  it('unsubscribe of a never-registered plugin returns 0', () => {
    const bus = new HookBus();
    bus.subscribe('h', 'plugin-a', async (_ctx, p) => p);
    expect(bus.unsubscribe('h', 'plugin-z')).toBe(0);
    expect(bus.unsubscribe('other-hook', 'plugin-a')).toBe(0);
  });

  it('unsubscribe removes ALL handlers a plugin registered on the same hook', async () => {
    const bus = new HookBus();
    let counter = 0;
    bus.subscribe('h', 'shared', async (_ctx, p) => { counter += 1; return p; });
    bus.subscribe('h', 'shared', async (_ctx, p) => { counter += 10; return p; });

    expect(bus.unsubscribe('h', 'shared')).toBe(2);

    await bus.fire('h', silentCtx(), {});
    expect(counter).toBe(0);
  });
});

describe('HookBus — service-boundary enforcement', () => {
  it('returns the value when the handler resolves within the timeout', async () => {
    const bus = new HookBus({ defaultServiceTimeoutMs: 1000 });
    bus.registerService('fast', 'p', async () => 'ok');
    await expect(bus.call('fast', silentCtx(), {})).resolves.toBe('ok');
  });

  it('rejects PluginError{code:"timeout"} when the handler exceeds the default', async () => {
    const bus = new HookBus({ defaultServiceTimeoutMs: 20 });
    bus.registerService('hang', 'p', () => new Promise<never>(() => {}));
    await expect(bus.call('hang', silentCtx(), {})).rejects.toMatchObject({
      name: 'PluginError',
      code: 'timeout',
      hookName: 'hang',
    });
  });

  it('honors a per-hook timeoutMs override over the default', async () => {
    const bus = new HookBus({ defaultServiceTimeoutMs: 10_000 });
    bus.registerService('hang', 'p', () => new Promise<never>(() => {}), { timeoutMs: 20 });
    await expect(bus.call('hang', silentCtx(), {})).rejects.toMatchObject({ code: 'timeout' });
  });

  it('treats timeoutMs:Infinity as no timeout', async () => {
    const bus = new HookBus({ defaultServiceTimeoutMs: 10 });
    bus.registerService(
      'slow',
      'p',
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 40)),
      { timeoutMs: Number.POSITIVE_INFINITY },
    );
    await expect(bus.call('slow', silentCtx(), {})).resolves.toBe('done');
  });

  it('returns the parsed value when a declared returns schema matches', async () => {
    const bus = new HookBus();
    bus.registerService('typed', 'p', async () => 'hello', { returns: z.string() });
    await expect(bus.call('typed', silentCtx(), {})).resolves.toBe('hello');
  });

  it('rejects PluginError{code:"invalid-return"} when the return shape is wrong', async () => {
    const bus = new HookBus();
    // handler lies about its shape at runtime (number, not the declared string)
    bus.registerService('typed', 'p', async () => 123 as unknown as string, { returns: z.string() });
    await expect(bus.call('typed', silentCtx(), {})).rejects.toMatchObject({
      name: 'PluginError',
      code: 'invalid-return',
      hookName: 'typed',
    });
  });

  it('3-arg registration is unchanged: no validation, default timeout, value passes through', async () => {
    const bus = new HookBus();
    bus.registerService('legacy', 'p', async () => ({ anything: true }));
    await expect(bus.call('legacy', silentCtx(), {})).resolves.toEqual({ anything: true });
  });

  it('rejects an invalid defaultServiceTimeoutMs at construction', () => {
    for (const bad of [NaN, -1, Number.NEGATIVE_INFINITY]) {
      let thrown: unknown;
      try {
        new HookBus({ defaultServiceTimeoutMs: bad });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ name: 'PluginError', code: 'invalid-payload' });
    }
  });

  it('accepts Infinity and a finite >= 0 default at construction', () => {
    expect(() => new HookBus({ defaultServiceTimeoutMs: Number.POSITIVE_INFINITY })).not.toThrow();
    expect(() => new HookBus({ defaultServiceTimeoutMs: 0 })).not.toThrow();
  });

  it('rejects an invalid per-hook timeoutMs at registration', () => {
    const bus = new HookBus();
    for (const bad of [NaN, -1, Number.NEGATIVE_INFINITY]) {
      let thrown: unknown;
      try {
        bus.registerService(`h-${bad}`, 'p', async () => 1, { timeoutMs: bad });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ name: 'PluginError', code: 'invalid-payload', hookName: `h-${bad}` });
    }
  });
});

describe('HookBus — a scoped rejection survives the fire (TASK-287)', () => {
  it('spreads offendingPaths through, like it does Hold', () => {
    // Same mechanism `Hold` depends on. A bus that reconstructed
    // `{rejected, reason, source}` would silently drop this field and the
    // workspace veto would go back to being unscoped — with nothing going red.
    const bus = new HookBus();
    bus.subscribe('workspace:pre-apply', '@ax/test-scoped-rejecter', async () =>
      reject({ reason: 'CLAUDE.md: host-only', offendingPaths: ['CLAUDE.md'] }),
    );
    return bus
      .fire('workspace:pre-apply', silentCtx(), { changes: [] })
      .then((result) => {
        expect(isRejection(result)).toBe(true);
        if (result.rejected !== true) return;
        expect(result.offendingPaths).toEqual(['CLAUDE.md']);
        expect(result.source).toBe('@ax/test-scoped-rejecter');
      });
  });
});

/**
 * TASK-505 — the bug this block exists for was an ABSENCE.
 *
 * `agent:invoke` sat for the full 120 s service timeout, created no sandbox
 * pod, and wrote nothing to the log at any level. Four rounds of diagnosis
 * could only narrow it by elimination, because the one frame that was actually
 * stuck never identified itself: `fire()` has no timeout, and `call()` only
 * speaks on settle — which, for a hang, is never.
 *
 * These tests pin the observable behaviour, not the mechanism: a stalled hook
 * NAMES ITSELF (hook + plugin) while it is still stalled.
 */
describe('HookBus — stall watch (TASK-505)', () => {
  interface Logged {
    msg: string;
    bindings: Record<string, unknown>;
  }

  const capturingCtx = (sink: Logged[]) => {
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string, bindings?: Record<string, unknown>) => {
        sink.push({ msg, bindings: bindings ?? {} });
      },
      error: () => undefined,
      child: () => logger,
    };
    return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger });
  };

  const tick = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('names a subscriber that hangs, WHILE the fire is still in flight', async () => {
    // The card's exact shape: a subscriber that never resolves. `fire` has no
    // timeout, so before this watch nothing was ever emitted — the caller's
    // whole budget burned in silence, and the outer call's timeout named only
    // itself.
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 20 });
    bus.subscribe('chat:start', '@ax/test-hanger', () => new Promise<never>(() => {}));

    void bus.fire('chat:start', capturingCtx(logged), {});
    await tick(120);

    const stall = logged.find((l) => l.msg === 'hook_subscriber_stalled');
    expect(
      stall,
      'a hung subscriber must report itself before the caller gives up',
    ).toBeDefined();
    expect(stall?.bindings.hook).toBe('chat:start');
    expect(stall?.bindings.plugin).toBe('@ax/test-hanger');
    expect(stall?.bindings.stalledForMs).toBeTypeOf('number');
    // Still hung: no settle line. That asymmetry IS the diagnosis — a
    // `_stalled` with no matching `_slow` is a hang, not mere slowness.
    expect(logged.some((l) => l.msg === 'hook_subscriber_slow')).toBe(false);
  });

  it('names a service call that hangs, before its timeout fires', async () => {
    const logged: Logged[] = [];
    // Timeout far enough out that the watch is demonstrably speaking first.
    const bus = new HookBus({ defaultServiceTimeoutMs: 5_000, stallWarnMs: 20 });
    bus.registerService(
      'sandbox:open-session',
      '@ax/test-sandbox',
      () => new Promise<never>(() => {}),
    );

    const inFlight = bus.call('sandbox:open-session', capturingCtx(logged), {});
    inFlight.catch(() => undefined);
    await tick(120);

    const stall = logged.find((l) => l.msg === 'hook_call_stalled');
    expect(stall).toBeDefined();
    expect(stall?.bindings.hook).toBe('sandbox:open-session');
    expect(stall?.bindings.plugin).toBe('@ax/test-sandbox');
  });

  it('follows a stall with a settle line carrying the real duration', async () => {
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 20 });
    bus.registerService(
      'slow',
      'p',
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 120)),
    );

    await expect(bus.call('slow', capturingCtx(logged), {})).resolves.toBe('done');
    expect(logged.map((l) => l.msg)).toEqual(['hook_call_stalled', 'hook_call_slow']);
    expect(logged[1]?.bindings.durationMs).toBeTypeOf('number');
  });

  it('stays quiet for hooks that finish promptly', async () => {
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 5_000 });
    bus.registerService('fast', 'p', async () => 'ok');
    bus.subscribe('chat:start', 'p', async () => undefined);

    await bus.call('fast', capturingCtx(logged), {});
    await bus.fire('chat:start', capturingCtx(logged), {});
    expect(logged).toEqual([]);
  });

  it('still reports a subscriber that stalls and then throws', async () => {
    // The `catch` branch must not skip the settle — otherwise a slow-then-
    // failing subscriber leaves a live timer and no settle line.
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 20 });
    bus.subscribe(
      'chat:start',
      '@ax/test-slow-thrower',
      () =>
        new Promise<never>((_resolve, rejectLate) => {
          setTimeout(() => rejectLate(new Error('boom')), 120);
        }),
    );

    await bus.fire('chat:start', capturingCtx(logged), {});
    expect(logged.map((l) => l.msg)).toEqual([
      'hook_subscriber_stalled',
      'hook_subscriber_slow',
    ]);
  });

  it('treats stallWarnMs:Infinity as "never warn"', async () => {
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.registerService(
      'slow',
      'p',
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 60)),
    );
    await expect(bus.call('slow', capturingCtx(logged), {})).resolves.toBe('done');
    expect(logged).toEqual([]);
  });

  it('rejects a nonsense stallWarnMs at construction, not per call', () => {
    expect(() => new HookBus({ stallWarnMs: Number.NaN })).toThrow(PluginError);
    expect(() => new HookBus({ stallWarnMs: -1 })).toThrow(PluginError);
  });

  it('never fails a hook because the ctx had no usable logger', async () => {
    // Canaries and synthetic contexts hand the bus a partial ctx. A watchdog
    // that threw on one would be a new silent-failure source bolted onto the
    // fix for one.
    const bus = new HookBus({ stallWarnMs: 20 });
    bus.registerService(
      'slow',
      'p',
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 120)),
    );
    const loggerless = { sessionId: 's', agentId: 'a', userId: 'u' } as unknown as ReturnType<
      typeof silentCtx
    >;
    await expect(bus.call('slow', loggerless, {})).resolves.toBe('done');
  });
});
