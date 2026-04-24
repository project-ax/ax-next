import { describe, it, expect } from 'vitest';
import { HookBus, bootstrap, makeChatContext, PluginError } from '@ax/core';
import {
  parseConfig,
  saveConfig,
  loadConfigs,
  deleteConfig,
  type McpServerConfig,
} from '../config.js';

// Minimal in-memory storage plugin mirroring the helper in
// packages/credentials/src/__tests__/plugin.test.ts.
function memStoragePlugin() {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService('storage:get', 'mem-storage', async (_ctx, { key }: { key: string }) => ({
        value: store.get(key),
      }));
      bus.registerService(
        'storage:set',
        'mem-storage',
        async (_ctx, { key, value }: { key: string; value: Uint8Array }) => {
          store.set(key, value);
        },
      );
    },
  };
}

function ctx() {
  return makeChatContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

async function makeBus(): Promise<HookBus> {
  const bus = new HookBus();
  await bootstrap({ bus, plugins: [memStoragePlugin()], config: {} });
  return bus;
}

const validStdio: McpServerConfig = {
  id: 'fs',
  enabled: true,
  transport: 'stdio',
  command: 'mcp-server-filesystem',
  args: ['/tmp'],
};

const validHttp: McpServerConfig = {
  id: 'github',
  enabled: true,
  transport: 'streamable-http',
  url: 'https://api.github.com/mcp',
};

const validSse: McpServerConfig = {
  id: 'sse-demo',
  enabled: true,
  transport: 'sse',
  url: 'https://example.com/sse',
};

describe('McpServerConfigSchema', () => {
  it('parses a valid stdio config unchanged', () => {
    const parsed = parseConfig(validStdio);
    expect(parsed).toEqual(validStdio);
  });

  it('parses a valid streamable-http config unchanged', () => {
    const parsed = parseConfig(validHttp);
    expect(parsed).toEqual(validHttp);
  });

  it('parses a valid sse config unchanged', () => {
    const parsed = parseConfig(validSse);
    expect(parsed).toEqual(validSse);
  });

  it('rejects a stdio config missing `command`', () => {
    expect(() =>
      parseConfig({ id: 'fs', enabled: true, transport: 'stdio', args: [] }),
    ).toThrow();
  });

  it('rejects an http config missing `url`', () => {
    expect(() =>
      parseConfig({ id: 'gh', enabled: true, transport: 'streamable-http' }),
    ).toThrow();
  });

  it('rejects an unknown transport value via the discriminator', () => {
    expect(() =>
      parseConfig({ id: 'x', enabled: true, transport: 'invalid', url: 'https://x/' }),
    ).toThrow();
  });

  it('rejects an id with a space', () => {
    expect(() =>
      parseConfig({ ...validStdio, id: 'has space' }),
    ).toThrow();
  });

  it('rejects an uppercase id', () => {
    expect(() =>
      parseConfig({ ...validStdio, id: 'UPPERCASE' }),
    ).toThrow();
  });

  it('rejects a file:// url on http transport', () => {
    expect(() =>
      parseConfig({
        id: 'bad',
        enabled: true,
        transport: 'streamable-http',
        url: 'file:///etc/passwd',
      }),
    ).toThrow();
  });

  it('rejects a ws:// url on sse transport', () => {
    expect(() =>
      parseConfig({ id: 'bad', enabled: true, transport: 'sse', url: 'ws://example.com/' }),
    ).toThrow();
  });

  it('rejects a top-level inline `password` field', () => {
    expect(() =>
      parseConfig({ ...validStdio, password: 'hunter2' }),
    ).toThrow(PluginError);
  });

  it('rejects a top-level inline `apiKey` field', () => {
    expect(() =>
      parseConfig({ ...validHttp, apiKey: 'sk-xxx' }),
    ).toThrow(PluginError);
  });

  it('rejects an inline `token` nested inside env', () => {
    expect(() =>
      parseConfig({
        ...validStdio,
        env: { TOKEN: 'ghp_xxx' },
      }),
    ).toThrow(PluginError);
  });

  it('rejects an inline secret nested two levels deep', () => {
    // Not a valid schema shape, but the secret scan happens first — so it
    // should still be caught before the schema even sees it.
    expect(() =>
      parseConfig({
        ...validHttp,
        extra: { nested: { secret: 'shh' } },
      }),
    ).toThrow(PluginError);
  });

  it('rejects `api_key` (snake_case variant)', () => {
    expect(() =>
      parseConfig({ ...validHttp, api_key: 'sk-xxx' }),
    ).toThrow(PluginError);
  });

  it('does not infinite-loop on cyclic input', () => {
    const a: Record<string, unknown> = {
      id: 'x',
      enabled: true,
      transport: 'stdio',
      command: 'foo',
      args: [],
    };
    a.self = a;
    // We don't care whether it parses or rejects — only that it returns
    // without blowing the stack. Zod's strict mode will reject `self` as an
    // unrecognized key, but that's a PluginError/ZodError, not a RangeError.
    expect(() => parseConfig(a)).not.toThrow(/Maximum call stack/);
  });
});

describe('storage I/O', () => {
  it('saveConfig + loadConfigs round-trips a stdio config', async () => {
    const bus = await makeBus();
    await saveConfig(bus, ctx(), validStdio);
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded).toEqual([validStdio]);
  });

  it('loadConfigs returns [] when index is absent', async () => {
    const bus = await makeBus();
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded).toEqual([]);
  });

  it('deleteConfig removes the config from subsequent loads', async () => {
    const bus = await makeBus();
    await saveConfig(bus, ctx(), validStdio);
    await saveConfig(bus, ctx(), validHttp);
    await deleteConfig(bus, ctx(), 'fs');
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded.map((c) => c.id)).toEqual(['github']);
  });

  it('saveConfig with the same id updates (no duplicate index entry)', async () => {
    const bus = await makeBus();
    await saveConfig(bus, ctx(), validStdio);
    const updated: McpServerConfig = { ...validStdio, args: ['/tmp', '/var'] };
    await saveConfig(bus, ctx(), updated);
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(updated);
  });
});
