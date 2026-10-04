import { describe, it, expect } from 'vitest';
import { HookBus, bootstrap, makeAgentContext, PluginError } from '@ax/core';
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
      registers: ['storage:get', 'storage:set', 'storage:list-prefix'],
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
      bus.registerService(
        'storage:list-prefix',
        'mem-storage',
        async (_ctx, { prefix }: { prefix: string }) => {
          const entries: Array<{ key: string; value: Uint8Array }> = [];
          for (const [k, v] of store.entries()) {
            if (k.startsWith(prefix)) entries.push({ key: k, value: v });
          }
          return { entries };
        },
      );
    },
  };
}

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

async function makeBus(): Promise<HookBus> {
  const bus = new HookBus();
  await bootstrap({ bus, plugins: [memStoragePlugin()], config: {} });
  return bus;
}

// `ownerId` (Week 9.5 — Task 10) defaults to `null` (admin-global / legacy)
// when the input doesn't supply it. Tests that round-trip through parseConfig
// or saveConfig/loadConfigs see the normalized value back, so we declare
// ownerId here too.
const validFs: McpServerConfig = {
  id: 'fs',
  enabled: true,
  transport: 'streamable-http',
  url: 'https://mcp.example.com/fs',
  ownerId: null,
};

// What a pre-removal database (or an old `ax mcp add` payload) looks like.
// stdio MCP servers spawned a process on the host; they are gone.
const legacyStdio = {
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
  ownerId: null,
};

const validSse: McpServerConfig = {
  id: 'sse-demo',
  enabled: true,
  transport: 'sse',
  url: 'https://example.com/sse',
  ownerId: null,
};

describe('McpServerConfigSchema', () => {
  it('parses a valid streamable-http config unchanged', () => {
    const parsed = parseConfig(validHttp);
    expect(parsed).toEqual(validHttp);
  });

  it('parses a valid sse config unchanged', () => {
    const parsed = parseConfig(validSse);
    expect(parsed).toEqual(validSse);
  });

  it('rejects a stdio config with the migration hint', () => {
    expect(() =>
      parseConfig({ id: 'x', enabled: true, transport: 'stdio', command: 'npx', args: [] }),
    ).toThrow(/no longer supported/);
  });

  it('names the supported transports in the stdio rejection, as an invalid-payload PluginError', () => {
    const err = (() => {
      try {
        parseConfig(legacyStdio);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(PluginError);
    expect(err).toMatchObject({ code: 'invalid-payload' });
    expect((err as PluginError).message).toContain('streamable-http');
    expect((err as PluginError).message).toContain('sse');
  });

  it('rejects stdio with the migration hint even when the payload also carries other stdio-only fields', () => {
    // env / credentialRefs used to be valid stdio fields; the hint, not a
    // strict-mode "unrecognized key" or inline-secret error, is what the
    // caller needs to see.
    expect(() =>
      parseConfig({ ...legacyStdio, env: { GH_TOKEN: '' }, credentialRefs: { GH_TOKEN: 'x' } }),
    ).toThrow(/no longer supported/);
    expect(() => parseConfig({ ...legacyStdio, password: 'hunter2' })).toThrow(
      /no longer supported/,
    );
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
      parseConfig({ ...validFs, id: 'has space' }),
    ).toThrow();
  });

  it('rejects an uppercase id', () => {
    expect(() =>
      parseConfig({ ...validFs, id: 'UPPERCASE' }),
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
      parseConfig({ ...validFs, password: 'hunter2' }),
    ).toThrow(PluginError);
  });

  it('rejects a top-level inline `apiKey` field', () => {
    expect(() =>
      parseConfig({ ...validHttp, apiKey: 'sk-xxx' }),
    ).toThrow(PluginError);
  });

  it('rejects an inline `token` nested inside headerCredentialRefs', () => {
    expect(() =>
      parseConfig({
        ...validFs,
        headerCredentialRefs: { TOKEN: 'ghp_xxx' },
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
      transport: 'streamable-http',
      url: 'https://x.example/mcp',
    };
    a.self = a;
    // We don't care whether it parses or rejects — only that it returns
    // without blowing the stack. Zod's strict mode will reject `self` as an
    // unrecognized key, but that's a PluginError/ZodError, not a RangeError.
    expect(() => parseConfig(a)).not.toThrow(/Maximum call stack/);
  });
});

describe('storage I/O', () => {
  it('saveConfig + loadConfigs round-trips an http config', async () => {
    const bus = await makeBus();
    await saveConfig(bus, ctx(), validFs);
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded).toEqual([validFs]);
  });

  it('saveConfig refuses a stdio config and writes nothing', async () => {
    const bus = await makeBus();
    await expect(saveConfig(bus, ctx(), legacyStdio)).rejects.toThrow(/no longer supported/);
    expect(await loadConfigs(bus, ctx())).toEqual([]);
  });

  it('loadConfigs skips a leftover stdio row (and keeps the rest) instead of failing the load', async () => {
    const bus = await makeBus();
    await saveConfig(bus, ctx(), validHttp);
    // Hand-write a stdio row the way a pre-removal database holds it.
    const enc = new TextEncoder();
    await bus.call('storage:set', ctx(), {
      key: 'mcp-server:fs',
      value: enc.encode(JSON.stringify(legacyStdio)),
    });
    await bus.call('storage:set', ctx(), {
      key: 'mcp-server-index',
      value: enc.encode(JSON.stringify(['github', 'fs'])),
    });
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded.map((c) => c.id)).toEqual(['github']);
  });

  it('loadConfigs returns [] when index is absent', async () => {
    const bus = await makeBus();
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded).toEqual([]);
  });

  it('deleteConfig removes the config from subsequent loads', async () => {
    const bus = await makeBus();
    await saveConfig(bus, ctx(), validFs);
    await saveConfig(bus, ctx(), validHttp);
    await deleteConfig(bus, ctx(), 'fs');
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded.map((c) => c.id)).toEqual(['github']);
  });

  it('saveConfig refuses an id in the reserved connector-namespace form and writes nothing (TASK-752)', async () => {
    const bus = await makeBus();
    for (const id of ['c5e0235982f', 'c0123456789', 'cabcdef0123']) {
      const err = await saveConfig(bus, ctx(), { ...validFs, id }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PluginError);
      expect(err).toMatchObject({ code: 'reserved-id' });
    }
    expect(await loadConfigs(bus, ctx())).toEqual([]);
    // Near misses stay legal: wrong length, non-hex, other prefix, a suffix.
    for (const id of ['c5e0235982', 'c5e0235982f0', 'c5e0235982g', 'd5e0235982f', 'cabcdefabcd-x']) {
      await expect(saveConfig(bus, ctx(), { ...validFs, id })).resolves.toMatchObject({ id });
    }
  });

  it('saveConfig with the same id updates (no duplicate index entry)', async () => {
    const bus = await makeBus();
    await saveConfig(bus, ctx(), validFs);
    const updated: McpServerConfig = { ...validFs, url: 'https://mcp.example.com/fs2' };
    await saveConfig(bus, ctx(), updated);
    const loaded = await loadConfigs(bus, ctx());
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(updated);
  });
});
