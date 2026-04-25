import { describe, it, expect } from 'vitest';
import { createTestHarness, MockServices } from '../index.js';
import type { Plugin } from '@ax/core';

describe('createTestHarness', () => {
  it('provides a bus and a ctx factory', async () => {
    const h = await createTestHarness({});
    expect(h.bus).toBeDefined();
    const ctx = h.ctx();
    expect(ctx.reqId).toMatch(/^req-/);
  });

  it('loads additional plugins passed in', async () => {
    let initCalled = false;
    const p: Plugin = {
      manifest: { name: 'p', version: '0.0.0', registers: [], calls: [], subscribes: [] },
      init: () => { initCalled = true; },
    };
    const h = await createTestHarness({ plugins: [p] });
    expect(initCalled).toBe(true);
    expect(h.bus).toBeDefined();
  });

  it('registers MockServices.basics when requested', async () => {
    const h = await createTestHarness({ services: MockServices.basics() });
    expect(h.bus.hasService('storage:get')).toBe(true);
    expect(h.bus.hasService('storage:set')).toBe(true);
    expect(h.bus.hasService('audit:write')).toBe(true);
    expect(h.bus.hasService('eventbus:emit')).toBe(true);
  });

  it('overrides a single service', async () => {
    const h = await createTestHarness({
      services: {
        ...MockServices.basics(),
        'storage:get': async () => 'mocked-value',
      },
    });
    const v = await h.bus.call('storage:get', h.ctx(), { key: 'anything' });
    expect(v).toBe('mocked-value');
  });

  it('does not register chat:run by default (orchestrator is an explicit plugin in 6.5a)', async () => {
    const h = await createTestHarness({});
    expect(h.bus.hasService('chat:run')).toBe(false);
  });
});

describe('TestHarness.close()', () => {
  function makePlugin(
    name: string,
    opts: { onShutdown?: () => Promise<void> | void } = {},
  ): Plugin {
    const p: Plugin = {
      manifest: { name, version: '0.0.0', registers: [], calls: [], subscribes: [] },
      init: () => undefined,
    };
    if (opts.onShutdown !== undefined) {
      p.shutdown = opts.onShutdown;
    }
    return p;
  }

  it('no-op when there are no plugins', async () => {
    const h = await createTestHarness({});
    await expect(h.close()).resolves.toBeUndefined();
  });

  it('skips plugins that do not implement shutdown', async () => {
    const p = makePlugin('p1');
    const h = await createTestHarness({ plugins: [p] });
    await expect(h.close()).resolves.toBeUndefined();
  });

  it('calls shutdown on each plugin that implements it', async () => {
    const calls: string[] = [];
    const a = makePlugin('a', { onShutdown: () => { calls.push('a'); } });
    const b = makePlugin('b', { onShutdown: () => { calls.push('b'); } });
    const h = await createTestHarness({ plugins: [a, b] });
    await h.close();
    // Reverse load order: input was [a, b]; shutdown is [b, a].
    expect(calls).toEqual(['b', 'a']);
  });

  it('awaits async shutdown handlers', async () => {
    const completed: string[] = [];
    const slow = makePlugin('slow', {
      onShutdown: async () => {
        await new Promise((r) => setTimeout(r, 5));
        completed.push('slow');
      },
    });
    const fast = makePlugin('fast', {
      onShutdown: () => { completed.push('fast'); },
    });
    const h = await createTestHarness({ plugins: [slow, fast] });
    await h.close();
    // fast first (reverse of [slow, fast]), then slow runs to completion
    // before close() returns. If close() didn't await, completed would
    // be ['fast'] only.
    expect(completed).toEqual(['fast', 'slow']);
  });

  it('a throwing plugin does not block other shutdowns', async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const ok = makePlugin('ok', { onShutdown: () => { calls.push('ok'); } });
    const broken = makePlugin('broken', {
      onShutdown: () => { throw new Error('boom'); },
    });
    const h = await createTestHarness({ plugins: [ok, broken] });
    await h.close({ onError: (name) => { errors.push(name); } });
    // `broken` runs first (reverse order) and throws; `ok` still runs.
    expect(calls).toEqual(['ok']);
    expect(errors).toEqual(['broken']);
  });

  it('a hanging plugin times out per timeoutMs without blocking others', async () => {
    const calls: string[] = [];
    const errors: { name: string; msg: string }[] = [];
    const hangs = makePlugin('hangs', {
      // Returns a Promise that never resolves.
      onShutdown: () => new Promise<void>(() => undefined),
    });
    const ok = makePlugin('ok', { onShutdown: () => { calls.push('ok'); } });
    const h = await createTestHarness({ plugins: [ok, hangs] });
    const start = Date.now();
    await h.close({
      timeoutMs: 50,
      onError: (name, err) => {
        errors.push({ name, msg: err instanceof Error ? err.message : String(err) });
      },
    });
    const elapsed = Date.now() - start;
    // hangs runs first (reverse order), times out at 50ms; ok still runs.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    expect(calls).toEqual(['ok']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.name).toBe('hangs');
    expect(errors[0]!.msg).toMatch(/exceeded 50ms/);
  });

  it('is idempotent — second close() is a no-op', async () => {
    let count = 0;
    const p = makePlugin('p', { onShutdown: () => { count++; } });
    const h = await createTestHarness({ plugins: [p] });
    await h.close();
    await h.close();
    await h.close();
    expect(count).toBe(1);
  });

  it('default onError writes to stderr when not provided', async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      const broken = makePlugin('broken', {
        onShutdown: () => { throw new Error('explosion'); },
      });
      const h = await createTestHarness({ plugins: [broken] });
      await h.close();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
    const matched = written.find((line) =>
      line.includes("plugin 'broken' shutdown failed: explosion"),
    );
    expect(matched).toBeDefined();
  });
});
