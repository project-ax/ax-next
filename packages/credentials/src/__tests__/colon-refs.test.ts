/**
 * colon-refs.test.ts — verifies that credential refs containing ':' are
 * accepted by the credentials facade (credentials:set / credentials:get).
 *
 * The destination-first ref design uses ':' as a separator:
 *   provider:anthropic         (global provider credential)
 *   skill:<id>:<slot>          (per-skill per-slot credential)
 *   mcp:<id>:env:<name>        (MCP server env var)
 *
 * These were rejected by the pre-change REF_RE which only allowed [a-z0-9_.-].
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

// Minimal in-memory storage plugin (mirrors plugin.test.ts harness).
function memStoragePlugin() {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: [
        'storage:get',
        'storage:set',
        'storage:list-prefix',
        'storage:delete-prefix',
      ],
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
      bus.registerService(
        'storage:delete-prefix',
        'mem-storage',
        async (_ctx, { prefix }: { prefix: string }) => {
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
    },
  };
}

const TEST_KEY_HEX = '42'.repeat(32);

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('colon-bearing credential refs', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });

  it('accepts provider:anthropic as a global ref', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:set', ctx(), {
        scope: 'global',
        ownerId: null,
        ref: 'provider:anthropic',
        kind: 'api-key',
        payload: bytes('sk-ant-test'),
      }),
    ).resolves.not.toThrow();
  });

  it('accepts skill:<id>:<slot> as an agent-scoped ref', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:set', ctx(), {
        scope: 'agent',
        ownerId: 'a',
        ref: 'skill:linear-tracker:linear-token',
        kind: 'api-key',
        payload: bytes('lin_api_secret'),
      }),
    ).resolves.not.toThrow();
  });

  it('accepts uppercase slot names like LINEAR_TOKEN', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:set', ctx(), {
        scope: 'agent',
        ownerId: 'a',
        ref: 'skill:linear-tracker:LINEAR_TOKEN',
        kind: 'api-key',
        payload: bytes('lin_api_secret'),
      }),
    ).resolves.not.toThrow();
  });

  it('rejects refs containing spaces (REF_RE unchanged boundary)', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await expect(
      bus.call('credentials:set', ctx(), {
        scope: 'global',
        ownerId: null,
        ref: 'foo bar',
        kind: 'api-key',
        payload: bytes('v'),
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/credential ref must match/),
    });
  });

  it('round-trips a colon-bearing ref through set+get', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    await bus.call('credentials:set', ctx(), {
      scope: 'user',
      ownerId: 'u',
      ref: 'mcp:github:env:github-token',
      kind: 'api-key',
      payload: bytes('ghp_roundtrip'),
    });
    const got = await bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      ctx(),
      { ref: 'mcp:github:env:github-token', userId: 'u' },
    );
    expect(got).toBe('ghp_roundtrip');
  });
});
