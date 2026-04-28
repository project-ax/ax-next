import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, bootstrap, type Plugin } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialProxyPlugin } from '@ax/credential-proxy';

// This test asserts that `@ax/credentials` is available on the chat-path bus.
// It mirrors the storage-then-credentials push ordering in main.ts but stops
// short of bootstrapping the full chat plugin set — the wiring contract is
// "credentials:get is registered before any later plugin (mcp-client in Task
// 16) would try to call it," which we verify via hasService on the bus after
// bootstrap.

const TEST_KEY_HEX = '42'.repeat(32);

let tmp: string;
let originalCredKey: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ax-cred-wiring-'));
  originalCredKey = process.env.AX_CREDENTIALS_KEY;
  process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
});
afterEach(() => {
  if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
  else process.env.AX_CREDENTIALS_KEY = originalCredKey;
  rmSync(tmp, { recursive: true, force: true });
});

describe('credentials wiring on the chat-path bus', () => {
  it('registers credentials:get/set/delete after bootstrap', async () => {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: join(tmp, 'db.sqlite') }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
      ],
      config: {},
    });

    expect(bus.hasService('credentials:get')).toBe(true);
    expect(bus.hasService('credentials:set')).toBe(true);
    expect(bus.hasService('credentials:delete')).toBe(true);
  });

  it('observer plugin pushed after credentials sees credentials:get already registered', async () => {
    // Mirrors how a future mcp-client plugin will sit further down the init
    // order: by the time its init() runs, credentials:get must already be on
    // the bus. The bus enforces topological order via manifest.calls, but
    // main.ts also pushes in declaration order — both orderings must agree.
    let observedHasCredentialsGet = false;
    const observerPlugin: Plugin = {
      manifest: {
        name: '@ax/test-credentials-observer',
        version: '0.0.0',
        registers: [],
        // Declaring `calls: ['credentials:get']` forces the topological
        // sorter to init credentials first, matching the runtime contract
        // a real consumer (e.g. mcp-client) would establish.
        calls: ['credentials:get'],
        subscribes: [],
      },
      async init({ bus }: { bus: HookBus }) {
        observedHasCredentialsGet = bus.hasService('credentials:get');
      },
    };

    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: join(tmp, 'db.sqlite') }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        observerPlugin,
      ],
      config: {},
    });

    expect(observedHasCredentialsGet).toBe(true);
  });

  it('loads @ax/credential-proxy and registers proxy:open-session / :close-session', async () => {
    // Phase 2 — the chat-orchestrator gates on bus.hasService('proxy:open-
    // session'); if this assertion fails, the orchestrator silently falls
    // back to the legacy llm-proxy path (which lets the IPC bearer be sent
    // upstream as ANTHROPIC_API_KEY). That regression is the bug to catch
    // here, before it's a security-shaped runtime surprise.
    const bus = new HookBus();
    const tmpCaDir = mkdtempSync(join(tmpdir(), 'ax-proxy-ca-'));
    try {
      const handle = await bootstrap({
        bus,
        plugins: [
          createStorageSqlitePlugin({ databasePath: join(tmp, 'db.sqlite') }),
          createCredentialsStoreDbPlugin(),
          createCredentialsPlugin(),
          createCredentialProxyPlugin({
            listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
            caDir: tmpCaDir,
          }),
        ],
        config: {},
      });
      try {
        expect(bus.hasService('proxy:open-session')).toBe(true);
        expect(bus.hasService('proxy:close-session')).toBe(true);
        expect(bus.hasService('proxy:rotate-session')).toBe(true);
      } finally {
        await handle.shutdown();
      }
    } finally {
      rmSync(tmpCaDir, { recursive: true, force: true });
    }
  });
});
