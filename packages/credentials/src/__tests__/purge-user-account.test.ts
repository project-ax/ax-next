/**
 * purge-user-account.test.ts — agent-owned sign-ins, slice 5.
 *
 * A one-time boot step removes every person-level connector credential
 * (user-scope `account:` row). It is marker-guarded like the pre-redesign
 * wipe, fails toward keeping data, and never fails the boot.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, bootstrap, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';
import { WIPE_MARKER_KEY } from '../wipe-pre-redesign.js';
import { USER_ACCOUNT_PURGE_MARKER_KEY, purgeUserAccountCredentials } from '../purge-user-account.js';
import { putLegacyRow } from './legacy-rows.js';

const TEST_KEY_HEX = '42'.repeat(32);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function memStoragePlugin(store: Map<string, Uint8Array>) {
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set', 'storage:list-prefix', 'storage:delete-prefix'],
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

interface LogLine {
  level: string;
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function recordingCtx(): { ctx: AgentContext; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger: Logger = {
    debug: (msg, bindings) => void lines.push({ level: 'debug', msg, bindings }),
    info: (msg, bindings) => void lines.push({ level: 'info', msg, bindings }),
    warn: (msg, bindings) => void lines.push({ level: 'warn', msg, bindings }),
    error: (msg, bindings) => void lines.push({ level: 'error', msg, bindings }),
    child: () => logger,
  };
  return { ctx: makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'system', logger }), lines };
}

const adminCtx = () => makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });

describe('purgeUserAccountCredentials (unit)', () => {
  /** A bus with only the storage hooks the boot step uses (or none). */
  function storageBus(store: Map<string, Uint8Array> | undefined): HookBus {
    const bus = new HookBus();
    if (store !== undefined) {
      bus.registerService('storage:get', 'mem', async (_ctx, { key }: { key: string }) => ({ value: store.get(key) }));
      bus.registerService('storage:set', 'mem', async (_ctx, { key, value }: { key: string; value: Uint8Array }) => {
        store.set(key, value);
      });
    }
    return bus;
  }

  it('runs the purge once, logs the count, and writes the marker', async () => {
    const store = new Map<string, Uint8Array>();
    const calls: AgentContext[] = [];
    const { ctx, lines } = recordingCtx();
    const out = await purgeUserAccountCredentials(storageBus(store), ctx, async (c) => {
      calls.push(c);
      return { purged: 3 };
    });
    expect(out).toEqual({ ran: true, purged: 3 });
    expect(calls).toHaveLength(1);
    expect(store.get(USER_ACCOUNT_PURGE_MARKER_KEY)?.length).toBeGreaterThan(0);
    expect(lines).toContainEqual({
      level: 'info',
      msg: 'credentials_user_account_purged',
      bindings: { purged: 3 },
    });
  });

  it('is a no-op once the marker is set: the purge is not called', async () => {
    const store = new Map<string, Uint8Array>([[USER_ACCOUNT_PURGE_MARKER_KEY, enc('2026-10-08')]]);
    let called = 0;
    const out = await purgeUserAccountCredentials(storageBus(store), recordingCtx().ctx, async () => {
      called++;
      return { purged: 0 };
    });
    expect(out).toEqual({ ran: false, purged: 0 });
    expect(called).toBe(0);
  });

  it('skips when the storage hooks are absent (purge not called, nothing thrown)', async () => {
    let called = 0;
    const out = await purgeUserAccountCredentials(storageBus(undefined), recordingCtx().ctx, async () => {
      called++;
      return { purged: 0 };
    });
    expect(out).toEqual({ ran: false, purged: 0 });
    expect(called).toBe(0);
  });

  it('skips when only storage:get is present (no way to record the marker)', async () => {
    const bus = new HookBus();
    bus.registerService('storage:get', 'mem', async () => ({ value: undefined }));
    let called = 0;
    const out = await purgeUserAccountCredentials(bus, recordingCtx().ctx, async () => {
      called++;
      return { purged: 0 };
    });
    expect(out).toEqual({ ran: false, purged: 0 });
    expect(called).toBe(0);
  });

  it('a purge throw writes no marker, does not throw, warns without detail, and the next boot retries', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = storageBus(store);
    const { ctx, lines } = recordingCtx();
    const out = await purgeUserAccountCredentials(bus, ctx, async () => {
      throw new Error('store down: user:bob account:linear');
    });
    expect(out).toEqual({ ran: false, purged: 0 });
    expect(store.has(USER_ACCOUNT_PURGE_MARKER_KEY)).toBe(false);
    const warn = lines.find((l) => l.level === 'warn');
    expect(warn?.msg).toBe('credentials_user_account_purge_failed');
    expect(JSON.stringify(lines)).not.toContain('bob');

    let retried = 0;
    const again = await purgeUserAccountCredentials(bus, ctx, async () => {
      retried++;
      return { purged: 2 };
    });
    expect(retried).toBe(1);
    expect(again).toEqual({ ran: true, purged: 2 });
    expect(store.has(USER_ACCOUNT_PURGE_MARKER_KEY)).toBe(true);
  });

  it('a marker-read throw does not throw and does not purge', async () => {
    const bus = new HookBus();
    bus.registerService('storage:get', 'mem', async () => {
      throw new Error('db down');
    });
    bus.registerService('storage:set', 'mem', async () => undefined);
    let called = 0;
    const out = await purgeUserAccountCredentials(bus, recordingCtx().ctx, async () => {
      called++;
      return { purged: 0 };
    });
    expect(out).toEqual({ ran: false, purged: 0 });
    expect(called).toBe(0);
  });
});

describe('boot purge of person-level connector credentials (integration)', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });

  /** The vault as a deployment holds it before slice 5: seeded with no credentials facade loaded. */
  async function seedVault(store: Map<string, Uint8Array>): Promise<void> {
    // Pretend the pre-redesign wipe already happened long ago, so it doesn't
    // clear the rows we are about to plant.
    store.set(WIPE_MARKER_KEY, enc('2026-05-19'));
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [memStoragePlugin(store), createCredentialsStoreDbPlugin()], config: {} });
    await putLegacyRow(bus, 'user', 'alice', 'account:linear', 'ALICE-LINEAR');
    await putLegacyRow(bus, 'user', 'bob', 'account:zendesk:API_TOKEN', 'BOB-ZENDESK', 'api-key');
    await putLegacyRow(bus, 'user', 'bob', 'account:gmail', 'BOB-GMAIL', 'mcp-oauth');
    await putLegacyRow(bus, 'user', 'alice', 'provider:anthropic', 'ALICE-ANTHROPIC');
    await putLegacyRow(bus, 'user', 'bob', 'skill:s1:KEY', 'BOB-SKILL');
    await putLegacyRow(bus, 'user', 'bob', 'routine:r1:KEY', 'BOB-ROUTINE');
    await putLegacyRow(bus, 'user', 'bob', 'mcp:legacy', 'BOB-MCP');
    await putLegacyRow(bus, 'agent', 'team-agent', 'account:linear', 'TEAM-LINEAR');
    await putLegacyRow(bus, 'global', null, 'account:zendesk', 'COMPANY-ZENDESK');
  }

  async function boot(store: Map<string, Uint8Array>): Promise<HookBus> {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [memStoragePlugin(store), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
      config: {},
    });
    return bus;
  }

  async function liveRows(bus: HookBus): Promise<string[]> {
    const out = await bus.call<object, { credentials: Array<{ scope: string; ownerId: string | null; ref: string }> }>(
      'credentials:list',
      adminCtx(),
      {},
    );
    return out.credentials.map((c) => `${c.scope}:${c.ownerId ?? '_'}:${c.ref}`).sort();
  }

  const KEPT = [
    'agent:team-agent:account:linear',
    'global:_:account:zendesk',
    'user:alice:provider:anthropic',
    'user:bob:mcp:legacy',
    'user:bob:routine:r1:KEY',
    'user:bob:skill:s1:KEY',
  ];

  it('removes every person-level account: row across owners and keeps everything else', async () => {
    const store = new Map<string, Uint8Array>();
    await seedVault(store);
    const bus = await boot(store);
    expect(await liveRows(bus)).toEqual(KEPT);
    expect(store.get(USER_ACCOUNT_PURGE_MARKER_KEY)?.length).toBeGreaterThan(0);
  });

  it('a second boot is a no-op: a person-level row planted after the first boot survives it', async () => {
    const store = new Map<string, Uint8Array>();
    await seedVault(store);
    await boot(store);
    const markerAfterFirst = store.get(USER_ACCOUNT_PURGE_MARKER_KEY);

    const between = new HookBus();
    await bootstrap({ bus: between, plugins: [memStoragePlugin(store), createCredentialsStoreDbPlugin()], config: {} });
    await putLegacyRow(between, 'user', 'carol', 'account:linear', 'CAROL-LINEAR');

    const bus = await boot(store);
    expect(await liveRows(bus)).toEqual([...KEPT, 'user:carol:account:linear'].sort());
    expect(store.get(USER_ACCOUNT_PURGE_MARKER_KEY)).toBe(markerAfterFirst);
  });

  it('a purge that fails midway does not fail the boot, writes no marker, keeps what it tombstoned, and the next boot finishes', async () => {
    // A store whose writes to bob's account: rows fail while `broken` is set.
    let broken = true;
    class FlakyMap extends Map<string, Uint8Array> {
      override set(key: string, value: Uint8Array): this {
        if (broken && key.includes('bob') && key.includes('account:')) throw new Error('write failed');
        return super.set(key, value);
      }
    }
    const store = new FlakyMap();
    broken = false;
    await seedVault(store);
    broken = true;

    const first = await boot(store); // must not throw
    expect(store.has(USER_ACCOUNT_PURGE_MARKER_KEY)).toBe(false);
    const afterFirst = await liveRows(first);
    expect(afterFirst).not.toContain('user:alice:account:linear'); // tombstoned before the failure
    expect(afterFirst.some((r) => r.startsWith('user:bob:account:'))).toBe(true);

    broken = false;
    const second = await boot(store);
    expect(await liveRows(second)).toEqual(KEPT);
    expect(store.has(USER_ACCOUNT_PURGE_MARKER_KEY)).toBe(true);
  });
});
