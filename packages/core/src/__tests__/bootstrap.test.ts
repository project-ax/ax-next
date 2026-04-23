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
    await expect(
      bootstrap({ bus: new HookBus(), plugins: [provider, consumer], config: {} }),
    ).resolves.toBeUndefined();
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
