import { describe, it, expect } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { PluginError } from '../errors.js';
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
    optionalCalls: [],
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

  it('optionalCalls with no producer boots fine (no missing-service)', async () => {
    // The whole distinction from `calls`: an absent optional producer must NOT
    // fail the boot. The plugin is expected to degrade (e.g. via hasService).
    const consumer = makePlugin({
      name: 'consumer',
      optionalCalls: [{ hook: 'storage:get', degradation: 'in-memory only; no persistence' }],
    });
    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [consumer],
      config: {},
    });
    expect(typeof handle.shutdown).toBe('function');
  });

  it('inits the producer before an optionalCalls consumer when the producer IS present', async () => {
    // When a producer for an optional hook exists, the optional call is a real
    // edge: the consumer must init AFTER the producer so hasService() is true
    // by the time the consumer's init runs.
    const called: string[] = [];
    const consumer = makePlugin(
      {
        name: 'consumer',
        optionalCalls: [{ hook: 'storage:get', degradation: 'falls back to memory' }],
      },
      () => { called.push('consumer'); },
    );
    const producer = makePlugin(
      { name: 'producer', registers: ['storage:get'] },
      ({ bus }) => {
        called.push('producer');
        bus.registerService('storage:get', 'producer', async () => 'v');
      },
    );
    // consumer listed first to prove ordering follows the (optional) call graph.
    await bootstrap({ bus: new HookBus(), plugins: [consumer, producer], config: {} });
    expect(called).toEqual(['producer', 'consumer']);
  });

  it('detects a cycle closed by an optionalCalls edge when the producer is present', async () => {
    // a requires b; b optionally calls a. Both producers present → the optional
    // edge is real and closes the cycle, which must still be detected.
    const a = makePlugin(
      { name: 'a', registers: ['a:do'], calls: ['b:do'] },
      ({ bus }) => bus.registerService('a:do', 'a', async () => 0),
    );
    const b = makePlugin(
      {
        name: 'b',
        registers: ['b:do'],
        optionalCalls: [{ hook: 'a:do', degradation: 'skips the a:do enrichment step' }],
      },
      ({ bus }) => bus.registerService('b:do', 'b', async () => 0),
    );
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'cycle' });
  });

  it('an optionalCalls edge whose producer is absent creates no cycle and no reorder', async () => {
    // a requires b; b optionally calls a:other which NOBODY registers. The
    // absent optional producer adds no edge, so there is no cycle and init
    // order is the plain producer-before-consumer (b before a).
    const called: string[] = [];
    const a = makePlugin(
      { name: 'a', registers: ['a:do'], calls: ['b:do'] },
      ({ bus }) => {
        called.push('a');
        bus.registerService('a:do', 'a', async () => 0);
      },
    );
    const b = makePlugin(
      {
        name: 'b',
        registers: ['b:do'],
        optionalCalls: [{ hook: 'a:other', degradation: 'no a:other enrichment' }],
      },
      ({ bus }) => {
        called.push('b');
        bus.registerService('b:do', 'b', async () => 0);
      },
    );
    await bootstrap({ bus: new HookBus(), plugins: [a, b], config: {} });
    // b registers b:do which a calls → b inits before a. The dangling optional
    // edge a:other does not flip this.
    expect(called).toEqual(['b', 'a']);
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

  it.each(['bounded', 'joined'] as const)('a throwing %s shutdown does not block peer plugins; failure is reported', async mode => {
    const order: string[] = [];
    const errors: { plugin: string; err: unknown }[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a'); };
    const b = makePlugin({ name: 'b' });
    b.shutdownMode = mode;
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

  it('joined shutdown reports its deadline once and waits before closing dependencies', async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dependency = makePlugin({ name: 'dependency', registers: ['resource:get'] }, ({ bus }) => {
      bus.registerService('resource:get', 'dependency', async () => ({}));
    });
    dependency.shutdown = () => { order.push('dependency'); };
    const consumer = makePlugin({ name: 'consumer', calls: ['resource:get'] });
    consumer.shutdownMode = 'joined';
    consumer.shutdown = async () => { await gate; order.push('consumer'); };
    const handle = await bootstrap({ bus: new HookBus(), plugins: [consumer, dependency], config: {},
      shutdownTimeoutMs: 5, onShutdownError: (_name, error) => { errors.push(error); } });
    const shuttingDown = handle.shutdown();
    try {
      await expect.poll(() => errors.length).toBe(1);
      expect(String(errors[0])).toContain('exceeded 5ms');
      expect(order).toEqual([]);
    } finally { release(); await shuttingDown; }
    expect(order).toEqual(['consumer', 'dependency']);
    expect(errors).toHaveLength(1);
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

describe('bootstrap admission', () => {
  it('opens admission only after every init() resolved, in init order', async () => {
    const events: string[] = [];
    const a = makePlugin({ name: 'a', registers: ['a:do'] }, ({ bus }) => {
      events.push('init:a');
      bus.registerService('a:do', 'a', async () => 0);
    });
    // Async, like a real bind: bootstrap() has to await it.
    a.startAdmission = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      events.push('start:a');
    };
    const b = makePlugin({ name: 'b', calls: ['a:do'] }, () => { events.push('init:b'); });
    b.startAdmission = () => { events.push('start:b'); };

    // b is listed first: admission follows init order, not array order.
    await bootstrap({ bus: new HookBus(), plugins: [b, a], config: {} });
    expect(events).toEqual(['init:a', 'init:b', 'start:a', 'start:b']);
  });

  it.each([
    {
      when: "b's init() throws",
      code: 'init-failed',
      makeB: () => makePlugin({ name: 'b' }, () => { throw new Error('b-init-failed'); }),
    },
    {
      when: 'b calls a hook nobody registers',
      code: 'missing-service',
      makeB: () => makePlugin({ name: 'b', calls: ['missing:hook'] }),
    },
  ])('never opens admission when $when', async ({ code, makeB }) => {
    const events: string[] = [];
    const a = makePlugin({ name: 'a' });
    const b = makeB();
    for (const p of [a, b]) {
      const name = p.manifest.name;
      p.startAdmission = () => { events.push(`start:${name}`); };
      p.shutdown = () => { events.push(`down:${name}`); };
    }

    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code });
    expect(events.filter((e) => e.startsWith('start:'))).toEqual([]);
    // The existing rollback still runs.
    expect(events).toContain('down:a');
  });

  it('a startAdmission() throw unwinds: admitted plugins stop, then every initialized plugin shuts down', async () => {
    const events: string[] = [];
    const traced = (name: string): Plugin => {
      const p = makePlugin({ name });
      p.startAdmission = () => { events.push(`start:${name}`); };
      p.stopAdmission = () => { events.push(`stop:${name}`); };
      p.shutdown = () => { events.push(`down:${name}`); };
      return p;
    };
    const a = traced('a');
    const b = traced('b');
    const c = traced('c');
    // Rejects asynchronously, the way a failed bind does.
    b.startAdmission = async () => { throw new Error('bind failed'); };

    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b, c], config: {} }),
    ).rejects.toMatchObject({
      name: 'PluginError',
      code: 'init-failed',
      plugin: 'b',
      message: expect.stringMatching(/startAdmission failed: bind failed/),
    });
    // Only a was admitted, so only a stops. b failed and c never started, but
    // all three initialized, so all three shut down.
    expect(events).toEqual(['start:a', 'stop:a', 'down:c', 'down:b', 'down:a']);
  });

  it('rethrows a PluginError from startAdmission() unchanged', async () => {
    const thrown = new PluginError({ code: 'custom-code', plugin: 'b', message: 'x' });
    const b = makePlugin({ name: 'b' });
    b.startAdmission = () => { throw thrown; };

    await expect(
      bootstrap({ bus: new HookBus(), plugins: [b], config: {} }),
    ).rejects.toBe(thrown);
  });

  it('shutdown() stops admission on every plugin, in reverse, before the first shutdown(), once', async () => {
    const events: string[] = [];
    const a = makePlugin({ name: 'a', registers: ['a:do'] }, ({ bus }) => {
      bus.registerService('a:do', 'a', async () => 0);
    });
    a.stopAdmission = () => { events.push('stop:a'); };
    a.shutdown = () => { events.push('down:a'); };
    const b = makePlugin({ name: 'b', calls: ['a:do'] });
    b.stopAdmission = () => { events.push('stop:b'); };
    b.shutdown = () => { events.push('down:b'); };

    // Listed [b, a] so reverse init order (b, a) differs from reverse array order.
    const handle = await bootstrap({ bus: new HookBus(), plugins: [b, a], config: {} });
    await handle.shutdown();
    await handle.shutdown();
    expect(events).toEqual(['stop:b', 'stop:a', 'down:b', 'down:a']);
  });

  it('a throwing or hanging stopAdmission() is reported and never blocks shutdown()', async () => {
    const events: string[] = [];
    const errors: { plugin: string; err: unknown }[] = [];
    const a = makePlugin({ name: 'a' });
    a.stopAdmission = () => { throw new Error('boom'); };
    a.shutdown = () => { events.push('down:a'); };
    const b = makePlugin({ name: 'b' });
    b.stopAdmission = () => new Promise<void>(() => {}); // never resolves
    b.shutdown = () => { events.push('down:b'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b],
      config: {},
      shutdownTimeoutMs: 50,
      onShutdownError: (plugin, err) => errors.push({ plugin, err }),
    });
    await handle.shutdown();
    expect(errors.map((e) => e.plugin)).toEqual(['b', 'a']);
    expect(String(errors[0]!.err)).toMatch(/stopAdmission exceeded 50ms/);
    expect((errors[1]!.err as Error).message).toBe('boom');
    expect(events).toEqual(['down:b', 'down:a']);
  });

  it('a throwing onShutdownError sink in the stop phase does not abort shutdown()', async () => {
    const events: string[] = [];
    const a = makePlugin({ name: 'a' });
    a.stopAdmission = () => { events.push('stop:a'); };
    a.shutdown = () => { events.push('down:a'); };
    const b = makePlugin({ name: 'b' });
    b.stopAdmission = () => { throw new Error('boom'); };
    b.shutdown = () => { events.push('down:b'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b],
      config: {},
      onShutdownError: () => { throw new Error('sink itself broken'); },
    });
    await handle.shutdown();
    expect(events).toEqual(['stop:a', 'down:b', 'down:a']);
  });
});
