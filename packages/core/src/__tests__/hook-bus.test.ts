import { describe, it, expect, vi, afterEach } from 'vitest';
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

  it('honors a per-hook stallWarnMs over the bus default', async () => {
    // A hook that legitimately runs long says so at registration, the same way
    // it already says so with `timeoutMs`. Without this, the whole-turn frame
    // (`agent:invoke`) and every LLM generation would warn on the HEALTHY case
    // and teach everyone to filter the message.
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 20 });
    bus.registerService(
      'slow-but-fine',
      'p',
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 120)),
      { stallWarnMs: 5_000 },
    );
    await expect(bus.call('slow-but-fine', capturingCtx(logged), {})).resolves.toBe('done');
    expect(logged).toEqual([]);
  });

  it('fires at a per-hook threshold TIGHTER than the bus default', async () => {
    // The twin of the test above, in the other direction. Without it the suite
    // only pins that an override can SUPPRESS the warning — an override that
    // was read but never actually used as the deadline would still pass.
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 5_000 });
    bus.registerService(
      'impatient',
      'p',
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 120)),
      { stallWarnMs: 20 },
    );
    await expect(bus.call('impatient', capturingCtx(logged), {})).resolves.toBe('done');
    expect(logged.map((l) => l.msg)).toEqual(['hook_call_stalled', 'hook_call_slow']);
    expect(logged[0]?.bindings.hook).toBe('impatient');
  });

  it('treats a per-hook stallWarnMs of 0 as "warn immediately", not "unset"', async () => {
    // `isValidTimeoutMs` accepts 0, so 0 is a legal override — and it is the
    // one value where `??` and `||` disagree. Written down so a future
    // simplification to `||` fails here instead of silently falling back to
    // the bus default for the one caller who meant "tell me right away".
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 5_000 });
    bus.registerService(
      'tell-me-now',
      'p',
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 60)),
      { stallWarnMs: 0 },
    );
    await expect(bus.call('tell-me-now', capturingCtx(logged), {})).resolves.toBe('done');
    expect(logged.map((l) => l.msg)).toEqual(['hook_call_stalled', 'hook_call_slow']);
  });

  it('lets a hook opt out entirely with stallWarnMs:Infinity', async () => {
    // `agent:invoke`'s case: its own 120s timeout is its report, and there is
    // no threshold that separates a healthy long turn from a hung one.
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 20 });
    bus.registerService('whole-turn', 'p', () => new Promise<never>(() => {}), {
      stallWarnMs: Number.POSITIVE_INFINITY,
      timeoutMs: 5_000,
    });
    const inFlight = bus.call('whole-turn', capturingCtx(logged), {});
    inFlight.catch(() => undefined);
    await tick(120);
    expect(logged).toEqual([]);
  });

  it('rejects a nonsense per-hook stallWarnMs at registration', () => {
    const bus = new HookBus();
    expect(() =>
      bus.registerService('bad', 'p', async () => 'x', { stallWarnMs: Number.NaN }),
    ).toThrow(PluginError);
    expect(() =>
      bus.registerService('bad2', 'p', async () => 'x', { stallWarnMs: -1 }),
    ).toThrow(PluginError);
  });

  it('leaves subscribers on the default when their hook overrides it', async () => {
    // The override is per SERVICE registration; `fire` has no registration to
    // carry one, so subscribers keep the bus default. That asymmetry is the
    // point — subscribers are the untimed half, and 15s is right for them.
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 20 });
    bus.registerService('whole-turn', 'p', async () => 'ok', {
      stallWarnMs: Number.POSITIVE_INFINITY,
    });
    bus.subscribe('chat:start', '@ax/test-hanger', () => new Promise<never>(() => {}));

    void bus.fire('chat:start', capturingCtx(logged), {});
    await tick(120);
    expect(logged.map((l) => l.msg)).toEqual(['hook_subscriber_stalled']);
  });

  it('never fails a service call because the ctx had no usable logger', async () => {
    // Canaries and synthetic contexts hand the bus a partial ctx. A watchdog
    // that threw on one would be a new silent-failure source bolted onto the
    // fix for one.
    //
    // Scoped to the STALL WATCH. `fire`'s `hook_subscriber_failed` log has its
    // own guard and its own tests (TASK-512, below).
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

describe('HookBus — a subscriber failure is reported without breaking fire (TASK-512)', () => {
  // `fire()` used to log a subscriber throw through a bare `ctx.logger.error`.
  // Under a ctx with no usable logger that line itself threw a TypeError out of
  // the catch block: every REMAINING subscriber was skipped, and the caller saw
  // the TypeError instead of anything about the subscriber that actually failed.

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Capture what the last-resort path writes to stderr. */
  const captureStderr = (): string[] => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return lines;
  };

  const loggerless = () =>
    ({ reqId: 'req-t512', sessionId: 's', agentId: 'a', userId: 'u' }) as unknown as ReturnType<
      typeof silentCtx
    >;

  const throwingLoggerCtx = () => {
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        throw new Error('logger is broken');
      },
      child: () => logger,
    };
    return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger });
  };

  for (const [label, makeCtx] of [
    ['a ctx with no logger', loggerless],
    ['a ctx whose logger.error throws', throwingLoggerCtx],
  ] as const) {
    describe(label, () => {
      it('still runs every remaining subscriber and resolves with their payload', async () => {
        captureStderr();
        const bus = new HookBus();
        const ran: string[] = [];
        bus.subscribe<{ n: number }>('h', 'bad', async () => {
          ran.push('bad');
          throw new Error('original subscriber failure');
        });
        bus.subscribe<{ n: number }>('h', 'good', async (_ctx, p) => {
          ran.push('good');
          return { n: p.n + 1 };
        });
        bus.subscribe<{ n: number }>('h', 'also-good', async (_ctx, p) => {
          ran.push('also-good');
          return { n: p.n * 10 };
        });

        // (c) the log path does not throw: fire resolves rather than rejecting.
        const res = await bus.fire<{ n: number }>('h', makeCtx(), { n: 1 });
        // (a) the subscribers after the failing one all ran.
        expect(ran).toEqual(['bad', 'good', 'also-good']);
        expect(res).toEqual({ rejected: false, payload: { n: 20 } });
      });

      it('surfaces the ORIGINAL subscriber error, not a logging TypeError', async () => {
        const lines = captureStderr();
        const bus = new HookBus();
        bus.subscribe('h', '@ax/test-bad', async () => {
          throw new Error('original subscriber failure');
        });
        await bus.fire('h', makeCtx(), {});

        // (b) exactly one last-resort line, naming the hook, the plugin and the
        // subscriber's own error — the failure that started it is not erased.
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(entry).toMatchObject({
          level: 'error',
          msg: 'hook_subscriber_failed',
          hook: 'h',
          plugin: '@ax/test-bad',
          err: { name: 'Error', message: 'original subscriber failure' },
        });
        expect(JSON.stringify(entry)).not.toContain('TypeError');
      });
    });
  }

  it('does not throw even when the last-resort stderr write itself throws', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const bus = new HookBus();
    const ran: string[] = [];
    bus.subscribe('h', 'bad', async () => {
      throw new Error('original subscriber failure');
    });
    bus.subscribe('h', 'good', async () => {
      ran.push('good');
      return undefined;
    });
    await expect(bus.fire('h', loggerless(), {})).resolves.toEqual({
      rejected: false,
      payload: {},
    });
    expect(ran).toEqual(['good']);
  });

  it('uses ctx.logger when it works, and writes nothing to stderr', async () => {
    const lines = captureStderr();
    const errors: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (msg: string) => {
        errors.push(msg);
      },
      child: () => logger,
    };
    const bus = new HookBus();
    bus.subscribe('h', 'bad', async () => {
      throw new Error('original subscriber failure');
    });
    await bus.fire(
      'h',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger }),
      {},
    );
    expect(errors).toEqual(['hook_subscriber_failed']);
    expect(lines).toEqual([]);
  });
});

/**
 * TASK-514 — a caller can put a clock on its subscribers.
 *
 * `fire()` used to have no timeout at all, so one subscriber that never
 * settled left the caller pending forever: no throw, no settle, no clock.
 * `subscriberTimeoutMs` bounds EACH subscriber. A subscriber that blows it is
 * named in a `hook_subscriber_timed_out` warning, its effect is dropped, and
 * the chain carries on without it.
 */
describe('HookBus — per-fire subscriber timeout (TASK-514)', () => {
  interface Logged {
    level: 'warn' | 'error';
    msg: string;
    bindings: Record<string, unknown>;
  }

  const capturingCtx = (sink: Logged[]) => {
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string, bindings?: Record<string, unknown>) => {
        sink.push({ level: 'warn', msg, bindings: bindings ?? {} });
      },
      error: (msg: string, bindings?: Record<string, unknown>) => {
        sink.push({ level: 'error', msg, bindings: bindings ?? {} });
      },
      child: () => logger,
    };
    return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger });
  };

  const tick = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** Resolve to 'pending' if `p` has not settled within `ms`. */
  const settledWithin = async <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
    Promise.race([p, tick(ms).then(() => 'pending' as const)]);

  it('a subscriber that never settles cannot leave the fire pending', async () => {
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    const ran: string[] = [];
    bus.subscribe('chat:start', '@ax/test-hanger', () => new Promise<never>(() => {}));
    bus.subscribe<{ n: number }>('chat:start', 'after', async (_ctx, p) => {
      ran.push('after');
      return { n: p.n + 1 };
    });

    const res = await settledWithin(
      bus.fire('chat:start', capturingCtx(logged), { n: 1 }, { subscriberTimeoutMs: 20 }),
      500,
    );

    expect(res, 'the bound must end the wait').toEqual({ rejected: false, payload: { n: 2 } });
    // The subscriber after the hung one still ran.
    expect(ran).toEqual(['after']);
    // And the hung one is NAMED, so the skip is not silent.
    expect(logged).toEqual([
      {
        level: 'warn',
        msg: 'hook_subscriber_timed_out',
        bindings: { hook: 'chat:start', plugin: '@ax/test-hanger', timeoutMs: 20 },
      },
    ]);
  });

  it('without the option, fire is unbounded exactly as before', async () => {
    // Back-compat: every existing fire site passes no option and must keep
    // waiting for its subscribers.
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe(
      'h',
      'slow',
      () => new Promise<undefined>((r) => setTimeout(() => r(undefined), 80)),
    );
    const res = await settledWithin(bus.fire('h', silentCtx(), {}), 40);
    expect(res).toBe('pending');
  });

  it('a subscriber that settles inside the bound is untouched', async () => {
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe<{ n: number }>('h', 'quick', async (_ctx, p) => {
      await tick(5);
      return { n: p.n * 3 };
    });
    await expect(
      bus.fire('h', capturingCtx(logged), { n: 2 }, { subscriberTimeoutMs: 200 }),
    ).resolves.toEqual({ rejected: false, payload: { n: 6 } });
    expect(logged).toEqual([]);
  });

  it('a veto that settles inside the bound still short-circuits', async () => {
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe('h', 'vetoer', async () => reject({ reason: 'no' }));
    const res = await bus.fire('h', silentCtx(), {}, { subscriberTimeoutMs: 200 });
    expect(res).toMatchObject({ rejected: true, reason: 'no', source: 'vetoer' });
  });

  it('a late veto or transform from a timed-out subscriber is discarded', async () => {
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe('h', 'late-veto', async () => {
      await tick(60);
      return reject({ reason: 'too late' });
    });
    bus.subscribe<{ n: number }>('h', 'late-transform', async () => {
      await tick(60);
      return { n: 999 };
    });
    const res = await bus.fire('h', silentCtx(), { n: 1 }, { subscriberTimeoutMs: 10 });
    expect(res).toEqual({ rejected: false, payload: { n: 1 } });
  });

  it('a timed-out subscriber that later throws is still reported, flagged as late', async () => {
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe('h', '@ax/test-late-thrower', async () => {
      await tick(40);
      throw new Error('late failure');
    });
    await bus.fire('h', capturingCtx(logged), {}, { subscriberTimeoutMs: 10 });
    await tick(80);
    expect(logged.map((l) => l.msg)).toEqual([
      'hook_subscriber_timed_out',
      'hook_subscriber_failed',
    ]);
    expect(logged[1]!.bindings).toMatchObject({
      hook: 'h',
      plugin: '@ax/test-late-thrower',
      timedOut: true,
    });
    expect((logged[1]!.bindings.err as Error).message).toBe('late failure');
  });

  it('keeps the stall/slow pair truthful for a subscriber that outlives its bound', async () => {
    // `_stalled` with no `_slow` means "never finished". A timed-out subscriber
    // that DOES finish later must still emit its `_slow`, and only then.
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: 20 });
    bus.subscribe('h', 'p', async () => {
      await tick(100);
      return undefined;
    });
    await bus.fire('h', capturingCtx(logged), {}, { subscriberTimeoutMs: 50 });
    expect(logged.map((l) => l.msg)).toEqual([
      'hook_subscriber_stalled',
      'hook_subscriber_timed_out',
    ]);
    await tick(120);
    expect(logged.map((l) => l.msg)).toEqual([
      'hook_subscriber_stalled',
      'hook_subscriber_timed_out',
      'hook_subscriber_slow',
    ]);
  });

  it('never fails the fire because the ctx had no usable logger', async () => {
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe('h', 'hanger', () => new Promise<never>(() => {}));
    const loggerless = { sessionId: 's', agentId: 'a', userId: 'u' } as unknown as ReturnType<
      typeof silentCtx
    >;
    await expect(
      bus.fire('h', loggerless, { n: 1 }, { subscriberTimeoutMs: 10 }),
    ).resolves.toEqual({ rejected: false, payload: { n: 1 } });
  });

  for (const bad of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    it(`rejects subscriberTimeoutMs=${bad} loudly instead of silently unbounding`, async () => {
      const bus = new HookBus();
      bus.subscribe('h', 'p', async () => undefined);
      await expect(
        bus.fire('h', silentCtx(), {}, { subscriberTimeoutMs: bad }),
      ).rejects.toMatchObject({ name: 'PluginError', code: 'invalid-payload' });
    });
  }

  it('Infinity is the explicit "no bound" value', async () => {
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe(
      'h',
      'slow',
      () => new Promise<undefined>((r) => setTimeout(() => r(undefined), 80)),
    );
    const res = await settledWithin(
      bus.fire('h', silentCtx(), {}, { subscriberTimeoutMs: Number.POSITIVE_INFINITY }),
      40,
    );
    expect(res).toBe('pending');
  });
});

/**
 * TASK-552 — a timed-out subscriber is told to stop.
 *
 * TASK-514 bounded a subscriber's say over the fire but not its work: past the
 * bound it kept running, holding whatever it was doing (network, disk, spend).
 * Every subscriber now receives `{ signal }` as a third argument, and the bus
 * aborts that signal at the moment it gives up on the subscriber — so a
 * well-behaved one can actually stop.
 */
describe('HookBus — subscriber abort signal (TASK-552)', () => {
  interface Logged {
    level: 'debug' | 'warn' | 'error';
    msg: string;
    bindings: Record<string, unknown>;
  }

  const capturingCtx = (sink: Logged[]) => {
    const logger: Logger = {
      debug: (msg: string, bindings?: Record<string, unknown>) => {
        sink.push({ level: 'debug', msg, bindings: bindings ?? {} });
      },
      info: () => undefined,
      warn: (msg: string, bindings?: Record<string, unknown>) => {
        sink.push({ level: 'warn', msg, bindings: bindings ?? {} });
      },
      error: (msg: string, bindings?: Record<string, unknown>) => {
        sink.push({ level: 'error', msg, bindings: bindings ?? {} });
      },
      child: () => logger,
    };
    return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger });
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the signal exactly at the bound — not a millisecond before', async () => {
    vi.useFakeTimers();
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    let seen: AbortSignal | undefined;
    bus.subscribe('h', '@ax/test-hanger', (_ctx, _p, { signal }) => {
      seen = signal;
      return new Promise<never>(() => {});
    });

    const fired = bus.fire('h', silentCtx(), {}, { subscriberTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(99);
    expect(seen, 'the subscriber must receive a signal').toBeInstanceOf(AbortSignal);
    expect(seen!.aborted, 'aborted before the bound').toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(seen!.aborted, 'not aborted AT the bound').toBe(true);
    expect(seen!.reason).toBeInstanceOf(DOMException);
    expect((seen!.reason as DOMException).name).toBe('TimeoutError');
    await expect(fired).resolves.toEqual({ rejected: false, payload: {} });
  });

  it('abort listeners run while the fire moves on, so a subscriber can stop its work', async () => {
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    let stoppedWork = false;
    bus.subscribe('h', 'honours', (_ctx, _p, { signal }) => {
      return new Promise<undefined>((resolve) => {
        const work = setTimeout(() => resolve(undefined), 10_000);
        signal.addEventListener('abort', () => {
          clearTimeout(work);
          stoppedWork = true;
          resolve(undefined);
        });
      });
    });
    await bus.fire('h', silentCtx(), {}, { subscriberTimeoutMs: 10 });
    expect(stoppedWork).toBe(true);
  });

  it('a subscriber that settles inside the bound never sees an abort', async () => {
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    let seen: AbortSignal | undefined;
    bus.subscribe('h', 'quick', async (_ctx, _p, { signal }) => {
      seen = signal;
      return undefined;
    });
    await bus.fire('h', silentCtx(), {}, { subscriberTimeoutMs: 20 });
    // Well past the bound: the timer was cleared, so nothing aborts later.
    await new Promise((r) => setTimeout(r, 50));
    expect(seen!.aborted).toBe(false);
  });

  it('each subscriber gets its own signal; only the timed-out one is aborted', async () => {
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    const signals: AbortSignal[] = [];
    bus.subscribe('h', 'hanger', (_ctx, _p, { signal }) => {
      signals.push(signal);
      return new Promise<never>(() => {});
    });
    bus.subscribe('h', 'after', async (_ctx, _p, { signal }) => {
      signals.push(signal);
      return undefined;
    });
    await bus.fire('h', silentCtx(), {}, { subscriberTimeoutMs: 10 });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
  });

  it('an unbounded fire still hands every subscriber a live, never-aborted signal', async () => {
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    const signals: AbortSignal[] = [];
    for (const name of ['a', 'b']) {
      bus.subscribe('h', name, async (_ctx, _p, { signal }) => {
        signals.push(signal);
        return undefined;
      });
    }
    await bus.fire('h', silentCtx(), {});
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((s) => s instanceof AbortSignal && !s.aborted)).toBe(true);
  });

  it('a subscriber that stops by throwing the abort reason is not reported as a failure', async () => {
    // Honouring the signal with `signal.throwIfAborted()` is the idiomatic
    // stop. The timeout was already warned; an error line on top would page
    // someone for a subscriber that did exactly what it was asked.
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe('h', '@ax/test-honours', async (_ctx, _p, { signal }) => {
      await new Promise((r) => setTimeout(r, 40));
      signal.throwIfAborted();
      return undefined;
    });
    await bus.fire('h', capturingCtx(logged), {}, { subscriberTimeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 80));
    expect(logged.map((l) => [l.level, l.msg])).toEqual([
      ['warn', 'hook_subscriber_timed_out'],
      ['debug', 'hook_subscriber_aborted'],
    ]);
    expect(logged[1]!.bindings).toEqual({ hook: 'h', plugin: '@ax/test-honours' });
  });

  it('a timed-out subscriber that throws something ELSE is still reported', async () => {
    const logged: Logged[] = [];
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    bus.subscribe('h', '@ax/test-late-thrower', async () => {
      await new Promise((r) => setTimeout(r, 40));
      throw new Error('late failure');
    });
    await bus.fire('h', capturingCtx(logged), {}, { subscriberTimeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 80));
    expect(logged.map((l) => l.msg)).toEqual([
      'hook_subscriber_timed_out',
      'hook_subscriber_failed',
    ]);
  });
});
