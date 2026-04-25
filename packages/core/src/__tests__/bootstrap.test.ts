import { describe, it, expect } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { HookBus } from '../hook-bus.js';
import type { Plugin } from '../plugin.js';

const makePlugin = (
  m: Partial<Plugin['manifest']> & { name: string },
  init?: Plugin['init'],
): Plugin => ({
  manifest: {
    version: '0.0.0',
    registers: [],
    calls: [],
    subscribes: [],
    ...m,
  },
  init: init ?? (() => {}),
});

describe('bootstrap', () => {
  it('calls init on every plugin with a shared bus', async () => {
    const called: string[] = [];
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        makePlugin({ name: 'a' }, () => { called.push('a'); }),
        makePlugin({ name: 'b' }, () => { called.push('b'); }),
      ],
      config: {},
    });
    expect(called).toEqual(['a', 'b']);
  });

  it('rejects invalid manifest with PluginError{code:"invalid-manifest"}', async () => {
    const badPlugin = { manifest: { name: '' }, init: () => {} } as unknown as Plugin;
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [badPlugin], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'invalid-manifest' });
  });

  it('fails with missing-service when a plugin calls a hook nobody registers', async () => {
    const plugin = makePlugin({ name: 'user', calls: ['storage:get'] });
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [plugin], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'missing-service' });
  });

  it('passes when the declared call is satisfied by another plugin', async () => {
    const provider = makePlugin(
      { name: 'provider', registers: ['storage:get'] },
      ({ bus }) => { bus.registerService('storage:get', 'provider', async () => 'v'); },
    );
    const consumer = makePlugin({ name: 'consumer', calls: ['storage:get'] });
    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [provider, consumer],
      config: {},
    });
    expect(typeof handle.shutdown).toBe('function');
  });

  it('detects cycles in declared calls', async () => {
    const a = makePlugin(
      { name: 'a', registers: ['a:do'], calls: ['b:do'] },
      ({ bus }) => bus.registerService('a:do', 'a', async () => 0),
    );
    const b = makePlugin(
      { name: 'b', registers: ['b:do'], calls: ['a:do'] },
      ({ bus }) => bus.registerService('b:do', 'b', async () => 0),
    );
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'cycle' });
  });

  it('wraps init errors as PluginError{code:"init-failed"}', async () => {
    const bad = makePlugin({ name: 'bad' }, () => { throw new Error('oops'); });
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [bad], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'init-failed', plugin: 'bad' });
  });

  it('rejects two plugins registering the same service hook (duplicate-service)', async () => {
    const a = makePlugin({ name: 'a', registers: ['storage:get'] });
    const b = makePlugin({ name: 'b', registers: ['storage:get'] });
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b], config: {} }),
    ).rejects.toMatchObject({
      name: 'PluginError',
      code: 'duplicate-service',
      hookName: 'storage:get',
    });
  });

  it('rejects two plugins with the same manifest.name (duplicate-plugin)', async () => {
    const a = makePlugin({ name: 'dup' });
    const b = makePlugin({ name: 'dup' });
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'duplicate-plugin', plugin: 'dup' });
  });

  it('inits producers before consumers regardless of plugin array order', async () => {
    const called: string[] = [];
    const consumer = makePlugin(
      { name: 'consumer', calls: ['storage:get'] },
      () => { called.push('consumer'); },
    );
    const producer = makePlugin(
      { name: 'producer', registers: ['storage:get'] },
      ({ bus }) => {
        called.push('producer');
        bus.registerService('storage:get', 'producer', async () => 'v');
      },
    );
    // consumer is listed first to prove that init order follows the call graph,
    // not the array order: producer must still init first.
    await bootstrap({ bus: new HookBus(), plugins: [consumer, producer], config: {} });
    expect(called).toEqual(['producer', 'consumer']);
  });
});

describe('bootstrap shutdown', () => {
  it('returns a KernelHandle whose shutdown calls plugins in reverse topological order', async () => {
    const order: string[] = [];
    const a = makePlugin(
      { name: 'a', registers: ['a:do'] },
      ({ bus }) => { bus.registerService('a:do', 'a', async () => 0); },
    );
    (a as Plugin).shutdown = () => { order.push('a'); };

    const b = makePlugin(
      { name: 'b', registers: ['b:do'], calls: ['a:do'] },
      ({ bus }) => { bus.registerService('b:do', 'b', async () => 0); },
    );
    (b as Plugin).shutdown = () => { order.push('b'); };

    const c = makePlugin(
      { name: 'c', calls: ['b:do'] },
    );
    (c as Plugin).shutdown = () => { order.push('c'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b, c],
      config: {},
    });
    await handle.shutdown();
    // Init order: a, b, c (topological). Reverse: c, b, a.
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('skips plugins without a shutdown method', async () => {
    const order: string[] = [];
    const a = makePlugin({ name: 'a' });
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => { order.push('b'); };
    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b],
      config: {},
    });
    await handle.shutdown();
    expect(order).toEqual(['b']);
  });

  it('a throwing shutdown does not block peer plugins; failure is reported', async () => {
    const order: string[] = [];
    const errors: { plugin: string; err: unknown }[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a'); };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = async () => { throw new Error('boom'); };
    const c = makePlugin({ name: 'c' });
    (c as Plugin).shutdown = () => { order.push('c'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b, c],
      config: {},
      onShutdownError: (plugin, err) => errors.push({ plugin, err }),
    });
    await handle.shutdown();
    // Reverse order: c (ok), b (throws), a (ok). All three slots run.
    expect(order).toEqual(['c', 'a']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.plugin).toBe('b');
    expect((errors[0]!.err as Error).message).toBe('boom');
  });

  it('a hanging shutdown is timed out; peer plugins still run', async () => {
    const order: string[] = [];
    const errors: { plugin: string; err: unknown }[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a'); };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => new Promise<void>(() => {}); // never resolves
    const c = makePlugin({ name: 'c' });
    (c as Plugin).shutdown = () => { order.push('c'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b, c],
      config: {},
      shutdownTimeoutMs: 50,
      onShutdownError: (plugin, err) => errors.push({ plugin, err }),
    });
    await handle.shutdown();
    expect(order).toEqual(['c', 'a']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.plugin).toBe('b');
    expect(String(errors[0]!.err)).toMatch(/exceeded 50ms/);
  });

  it('handle.shutdown is idempotent — second call resolves without re-running plugins', async () => {
    let count = 0;
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { count++; };
    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a],
      config: {},
    });
    await handle.shutdown();
    await handle.shutdown();
    await handle.shutdown();
    expect(count).toBe(1);
  });

  it('init failure runs shutdown on plugins 0..N-1 in reverse order before re-throwing', async () => {
    const order: string[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a-down'); };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => { order.push('b-down'); };
    const c = makePlugin({ name: 'c' }, () => { throw new Error('c-init-failed'); });
    (c as Plugin).shutdown = () => { order.push('c-down'); };
    const d = makePlugin({ name: 'd' });
    (d as Plugin).shutdown = () => { order.push('d-down'); };

    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b, c, d], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'init-failed', plugin: 'c' });
    // Plugins a, b initialized; c failed (its shutdown is NOT called); d never
    // initialized. Rollback runs b then a.
    expect(order).toEqual(['b-down', 'a-down']);
  });

  it('init-failure rollback isolates throwing/timing-out shutdowns', async () => {
    const errors: { plugin: string; err: unknown }[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { /* ok */ };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => { throw new Error('b-down-failed'); };
    const c = makePlugin({ name: 'c' }, () => { throw new Error('c-init-failed'); });

    await expect(
      bootstrap({
        bus: new HookBus(),
        plugins: [a, b, c],
        config: {},
        onShutdownError: (plugin, err) => errors.push({ plugin, err }),
      }),
    ).rejects.toMatchObject({ code: 'init-failed', plugin: 'c' });
    // Both rollback shutdowns ran; b's failure went to onShutdownError.
    expect(errors.map((e) => e.plugin)).toEqual(['b']);
  });

  it('verifyCalls failure rolls back already-initialized plugins', async () => {
    // Both plugins init successfully — but the consumer declares calls:['x:do']
    // with no producer, so verifyCalls throws missing-service AFTER init. The
    // initialized plugins must still get shut down so we don't leak resources
    // (the same gap the in-loop rollback at lines 83-94 protects against).
    const order: string[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a-down'); };
    const consumer = makePlugin({ name: 'consumer', calls: ['x:do'] });
    (consumer as Plugin).shutdown = () => { order.push('consumer-down'); };

    await expect(
      bootstrap({
        bus: new HookBus(),
        plugins: [a, consumer],
        config: {},
      }),
    ).rejects.toMatchObject({
      name: 'PluginError',
      code: 'missing-service',
      plugin: 'consumer',
    });
    // Both plugins initialized, then verifyCalls threw. Reverse order: consumer, a.
    expect(order).toEqual(['consumer-down', 'a-down']);
  });

  it('a throwing onShutdownError sink does not abort the shutdown loop', async () => {
    // I2 says "per-plugin failures never block peer plugins." A misbehaving
    // host-supplied sink (e.g., a structured logger that asserts on schema)
    // throwing inside onShutdownError must NOT prevent the next plugin's
    // shutdown from running.
    const order: string[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a'); };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => { throw new Error('boom'); };
    const c = makePlugin({ name: 'c' });
    (c as Plugin).shutdown = () => { order.push('c'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b, c],
      config: {},
      onShutdownError: () => {
        throw new Error('sink itself broken');
      },
    });
    // Should resolve, not reject — sink failure is swallowed.
    await handle.shutdown();
    // c (ok), b (throws — sink throws — swallowed), a (ok) all run.
    expect(order).toEqual(['c', 'a']);
  });
});
