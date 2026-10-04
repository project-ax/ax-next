// ---------------------------------------------------------------------------
// @ax/mcp-client plugin wiring.
//
// Host MCP servers were retired 2026-10-04 (TASK-792). The plugin now does
// two things: a boot sweep that hard-deletes stored `mcp-server:<id>` rows
// (and their `mcp:<id>:` credentials), and the opt-in connector tool
// inventory (covered by the connector-inventory-* suites). These tests pin
// the manifest and prove, through a real `bootstrap()`, that a stored legacy
// row is gone after boot and nothing MCP-shaped is registered.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createToolDispatcherPlugin } from '../tool-dispatcher-plugin.js';
import { createMcpClientPlugin } from '../plugin.js';

const TEST_KEY_HEX = '42'.repeat(32);
const enc = new TextEncoder();

function ctx(): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

/** In-memory storage plugin with the full storage surface the sweep and the vault use. */
function memStoragePlugin(store: Map<string, Uint8Array>): Plugin {
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: [
        'storage:get',
        'storage:set',
        'storage:list-prefix',
        'storage:delete-prefix',
        'storage:delete',
      ],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
        'storage:get',
        'mem-storage',
        async (_c, { key }) => ({ value: store.get(key) }),
      );
      bus.registerService<{ key: string; value: Uint8Array }, void>(
        'storage:set',
        'mem-storage',
        async (_c, { key, value }) => {
          store.set(key, value);
        },
      );
      bus.registerService<
        { prefix: string },
        { entries: Array<{ key: string; value: Uint8Array }> }
      >('storage:list-prefix', 'mem-storage', async (_c, { prefix }) => ({
        entries: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }));
      bus.registerService<{ prefix: string }, { deleted: number }>(
        'storage:delete-prefix',
        'mem-storage',
        async (_c, { prefix }) => {
          let deleted = 0;
          for (const k of [...store.keys()]) {
            if (k.startsWith(prefix)) {
              store.delete(k);
              deleted++;
            }
          }
          return { deleted };
        },
      );
      bus.registerService<{ key: string }, { deleted: number }>(
        'storage:delete',
        'mem-storage',
        async (_c, { key }) => ({ deleted: store.delete(key) ? 1 : 0 }),
      );
    },
  };
}

/** Records every route anyone tries to mount. */
function recordingHttpPlugin(paths: string[]): Plugin {
  return {
    manifest: {
      name: 'recording-http',
      version: '0.0.0',
      registers: ['http:register-route'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<{ path: string }, { unregister: () => void }>(
        'http:register-route',
        'recording-http',
        async (_c, { path }) => {
          paths.push(path);
          return { unregister: () => {} };
        },
      );
    },
  };
}

const SWEEP_DEGRADATION =
  'boot sweep deletes retired host MCP server rows without purging their mcp:<id>: credentials';

describe('@ax/mcp-client plugin', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });
  afterEach(() => {
    delete process.env.AX_CREDENTIALS_KEY;
  });

  it('manifest (default): storage sweep calls, optional credentials, nothing registered', () => {
    expect(createMcpClientPlugin().manifest).toEqual({
      name: '@ax/mcp-client',
      version: '0.0.0',
      registers: [],
      calls: ['storage:list-prefix', 'storage:delete'],
      optionalCalls: [
        { hook: 'credentials:list', degradation: SWEEP_DEGRADATION },
        { hook: 'credentials:delete', degradation: SWEEP_DEGRADATION },
      ],
      subscribes: [],
    });
  });

  it('manifest (connectorToolInventory): adds the inventory hooks and nothing host-server shaped', () => {
    expect(createMcpClientPlugin({ connectorToolInventory: true }).manifest).toEqual({
      name: '@ax/mcp-client',
      version: '0.0.0',
      registers: [
        'connectors:describe-tools',
        'connectors:inventory-status-batch',
        'connectors:inventory-tool-titles',
      ],
      calls: [
        'storage:list-prefix',
        'storage:delete',
        'database:get-instance',
        'connectors:resolve',
        'agents:resolve',
        // describe-tools spends the connector's credential plan.
        'credentials:get',
      ],
      optionalCalls: [
        { hook: 'credentials:list', degradation: SWEEP_DEGRADATION },
        { hook: 'credentials:delete', degradation: SWEEP_DEGRADATION },
      ],
      subscribes: ['agents:deleted'],
    });
  });

  it('boot sweeps a stored legacy host server: row, index and its credentials gone; no mcp.* tools; no admin route', async () => {
    const store = new Map<string, Uint8Array>();
    store.set('mcp-server-index', enc.encode(JSON.stringify(['legacy'])));
    store.set(
      'mcp-server:legacy',
      enc.encode(
        JSON.stringify({
          id: 'legacy',
          enabled: true,
          transport: 'streamable-http',
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: { credentialRef: 'mcp:legacy:header:Authorization' } },
        }),
      ),
    );

    // Seed the vault on a separate bus over the SAME backing map, so the
    // credential exists before the real boot below.
    const seedBus = new HookBus();
    await bootstrap({
      bus: seedBus,
      plugins: [memStoragePlugin(store), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    for (const ref of ['mcp:legacy:header:Authorization', 'mcp:legacyx:header:A']) {
      await seedBus.call('credentials:set', ctx(), {
        scope: 'global',
        ownerId: null,
        ref,
        kind: 'api-key',
        payload: enc.encode('s3cret'),
      });
    }

    // Real boot. mcp-client is listed FIRST: its optionalCalls edge on
    // credentials:list/delete must still order its init after @ax/credentials,
    // or the purge would silently be skipped.
    const routes: string[] = [];
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createMcpClientPlugin(),
        createToolDispatcherPlugin(),
        recordingHttpPlugin(routes),
        memStoragePlugin(store),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
      ],
      config: {},
    });

    expect(store.has('mcp-server:legacy')).toBe(false);
    expect(store.has('mcp-server-index')).toBe(false);

    const { credentials } = await bus.call<
      Record<string, never>,
      { credentials: Array<{ ref: string }> }
    >('credentials:list', ctx(), {});
    expect(credentials.map((c) => c.ref)).toEqual(['mcp:legacyx:header:A']);

    const { tools } = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(tools.filter((t) => t.name.startsWith('mcp.'))).toEqual([]);
    expect(routes.filter((p) => p.startsWith('/admin/mcp-servers'))).toEqual([]);
    expect(routes).toEqual([]);
  });

  it('boots without a credentials plugin and still deletes the row', async () => {
    const store = new Map<string, Uint8Array>([
      ['mcp-server:legacy', enc.encode('{"id":"legacy","transport":"sse","url":"https://x.test"}')],
    ]);
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [createMcpClientPlugin(), memStoragePlugin(store)],
      config: {},
    });
    expect(store.size).toBe(0);
  });
});
