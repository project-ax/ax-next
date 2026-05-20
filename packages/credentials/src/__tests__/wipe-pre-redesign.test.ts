import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';
import { WIPE_MARKER_KEY, CREDENTIAL_PREFIX } from '../wipe-pre-redesign.js';

// Minimal in-memory storage plugin that accepts a shared Map so the same
// backing store can be reused across two separate bootstraps (simulating
// server restart against persisted storage).
function memStoragePlugin(store: Map<string, Uint8Array>) {
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
      bus.registerService(
        'storage:get',
        'mem-storage',
        async (_ctx, { key }: { key: string }) => ({ value: store.get(key) }),
      );
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

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

describe('credentials wipe-once on first boot', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });

  it('drops all pre-existing credential rows the first time a server boots', async () => {
    // Shared backing store simulates persistent storage across two boots.
    const store = new Map<string, Uint8Array>();

    // Boot 1: storage-only stack (no @ax/credentials). Seed a legacy row
    // directly at a key that starts with `credential:` — the shape that
    // existed before the v2 redesign.
    {
      const bus = new HookBus();
      await bootstrap({
        bus,
        plugins: [memStoragePlugin(store)],
        config: {},
      });
      await bus.call('storage:set', ctx(), {
        key: 'credential:legacy:old-ref',
        value: bytes('old-encrypted-blob'),
      });
    }

    // Verify the seed is visible.
    expect(store.get('credential:legacy:old-ref')).toBeDefined();

    // Boot 2: full stack including @ax/credentials. The wipe-once routine
    // fires on init because the marker is absent.
    {
      const bus = new HookBus();
      await bootstrap({
        bus,
        plugins: [
          memStoragePlugin(store),
          createCredentialsStoreDbPlugin(),
          createCredentialsPlugin(),
        ],
        config: {},
      });

      // All `credential:*` rows must be gone.
      const { entries } = await bus.call<
        { prefix: string },
        { entries: Array<{ key: string; value: Uint8Array }> }
      >('storage:list-prefix', ctx(), { prefix: CREDENTIAL_PREFIX });
      expect(entries).toHaveLength(0);
    }

    // The marker must now be set.
    const markerValue = store.get(WIPE_MARKER_KEY);
    expect(markerValue).toBeDefined();
    expect(markerValue!.length).toBeGreaterThan(0);
  });

  it('does not re-wipe on subsequent boots', async () => {
    const store = new Map<string, Uint8Array>();

    // Boot 1: full stack. Wipe fires (storage empty → marker set).
    {
      const bus = new HookBus();
      await bootstrap({
        bus,
        plugins: [
          memStoragePlugin(store),
          createCredentialsStoreDbPlugin(),
          createCredentialsPlugin(),
        ],
        config: {},
      });

      // Seed a real credential via credentials:set AFTER the wipe has run.
      await bus.call('credentials:set', ctx(), {
        scope: 'user',
        ownerId: 'u',
        ref: 'provider:anthropic',
        kind: 'api-key',
        payload: bytes('sk-live-key'),
      });
    }

    // Marker must be present before second boot.
    expect(store.get(WIPE_MARKER_KEY)).toBeDefined();

    // Boot 2: same store. The wipe must NOT fire (marker present).
    let bus2!: HookBus;
    {
      bus2 = new HookBus();
      await bootstrap({
        bus: bus2,
        plugins: [
          memStoragePlugin(store),
          createCredentialsStoreDbPlugin(),
          createCredentialsPlugin(),
        ],
        config: {},
      });
    }

    // The credential seeded in Boot 1 must survive Boot 2.
    const result = await bus2.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      ctx(),
      { ref: 'provider:anthropic', userId: 'u' },
    );
    expect(result).toBe('sk-live-key');
  });
});
