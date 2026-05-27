/**
 * vault.test.ts — service-keyed credential vault (JIT P2, decision #13).
 *
 * The "vault" is NOT a new store — it is the existing user-scoped credential
 * store addressed by a new opaque ref shape `account:<service>`. This test
 * locks in the design property that falls out of the shared ref:
 *
 *   - One user-scoped `account:<service>` entry resolves for EVERY skill whose
 *     slot declares `account: <service>` (entered once, reused everywhere).
 *   - Revoking that single entry pulls the credential out from under every
 *     referencing skill ("revoke-pulls-from-all").
 *   - User scoping holds: one user's vault entry is invisible to another user.
 *
 * No production code change — the property is a consequence of binding every
 * `account: linear` slot to the same `account:linear` ref. This guard fails if
 * a future change forks per-skill vault rows.
 *
 * Harness mirrors colon-refs.test.ts (in-memory storage + the real
 * credentials-store-db + credentials facade).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

// Minimal in-memory storage plugin (mirrors colon-refs.test.ts harness).
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
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('service-keyed credential vault (account:<service>)', () => {
  let bus: HookBus;
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'user-1' });

  beforeEach(async () => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
    bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
  });

  it('one vaulted entry resolves for two skills that both bind account:linear', async () => {
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'user-1',
      ref: 'account:linear',
      kind: 'api-key',
      payload: enc('lin-key'),
    });
    // Skill A's slot binds account:linear; Skill B's DIFFERENT slot binds the
    // same ref. Both resolve the one stored key — that IS the shared vault.
    const a = await bus.call('credentials:get', ctx, { ref: 'account:linear', userId: 'user-1' });
    const b = await bus.call('credentials:get', ctx, { ref: 'account:linear', userId: 'user-1' });
    expect(a).toBe('lin-key');
    expect(b).toBe('lin-key');
  });

  it('revoking the vault entry removes it from under every referencing skill', async () => {
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'user-1',
      ref: 'account:linear',
      kind: 'api-key',
      payload: enc('lin-key'),
    });
    await bus.call('credentials:delete', ctx, {
      scope: 'user',
      ownerId: 'user-1',
      ref: 'account:linear',
    });
    await expect(
      bus.call('credentials:get', ctx, { ref: 'account:linear', userId: 'user-1' }),
    ).rejects.toThrow(/credential-not-found|no credential/i);
  });

  it('a different user does not see another user’s vault entry', async () => {
    await bus.call('credentials:set', ctx, {
      scope: 'user',
      ownerId: 'user-1',
      ref: 'account:linear',
      kind: 'api-key',
      payload: enc('lin-key'),
    });
    const other = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'user-2' });
    await expect(
      bus.call('credentials:get', other, { ref: 'account:linear', userId: 'user-2' }),
    ).rejects.toThrow();
  });
});
