import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HookBus, bootstrap, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { runCredentialsCommand } from '../commands/credentials.js';

const TEST_KEY_HEX = '42'.repeat(32);

let tmp: string;

function emptyStdin(): NodeJS.ReadableStream {
  return Readable.from([]);
}

beforeEach(() => {
  process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  tmp = mkdtempSync(join(tmpdir(), 'ax-cred-mig-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ax-next credentials migrate', () => {
  it('copies v1 keys to v2 with scope=user', async () => {
    const dbPath = join(tmp, 'db.sqlite');

    // Seed a v1 row by writing through storage:set directly (bypasses
    // the credentials facade — the migrate command works at the bytes
    // level so we don't need to construct an envelope here).
    {
      const bus = new HookBus();
      const handle = await bootstrap({
        bus,
        plugins: [createStorageSqlitePlugin({ databasePath: dbPath })],
        config: {},
      });
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'cli' });
      await bus.call('storage:set', ctx, {
        key: 'credential:cli:legacy-ref',
        value: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      });
      await handle.shutdown();
    }

    const lines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['migrate', '--yes'],
      stdin: emptyStdin(),
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
      sqlitePath: dbPath,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/migrated 1 credential/i);

    // Verify v2 row exists with same bytes.
    const bus = new HookBus();
    const handle = await bootstrap({
      bus,
      plugins: [createStorageSqlitePlugin({ databasePath: dbPath })],
      config: {},
    });
    try {
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'cli' });
      const v2 = await bus.call('storage:get', ctx, {
        key: 'credential:v2:user:cli:legacy-ref',
      });
      expect((v2 as { value: Uint8Array | undefined }).value).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      );
    } finally {
      await handle.shutdown();
    }
  });

  it('without --yes refuses to mutate and exits non-zero', async () => {
    const dbPath = join(tmp, 'db.sqlite');
    {
      const bus = new HookBus();
      const handle = await bootstrap({
        bus,
        plugins: [createStorageSqlitePlugin({ databasePath: dbPath })],
        config: {},
      });
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'cli' });
      await bus.call('storage:set', ctx, {
        key: 'credential:cli:legacy-ref',
        value: new Uint8Array([0x01]),
      });
      await handle.shutdown();
    }

    const lines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['migrate'],
      stdin: emptyStdin(),
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
      sqlitePath: dbPath,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/--yes/);

    // v2 row must NOT have been written.
    const bus = new HookBus();
    const handle = await bootstrap({
      bus,
      plugins: [createStorageSqlitePlugin({ databasePath: dbPath })],
      config: {},
    });
    try {
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'cli' });
      const v2 = await bus.call('storage:get', ctx, {
        key: 'credential:v2:user:cli:legacy-ref',
      });
      expect((v2 as { value: Uint8Array | undefined }).value).toBeUndefined();
    } finally {
      await handle.shutdown();
    }
  });

  it('reports nothing-to-do when no v1 rows exist', async () => {
    const dbPath = join(tmp, 'db.sqlite');
    // Seed a v2 row only.
    {
      const bus = new HookBus();
      const handle = await bootstrap({
        bus,
        plugins: [createStorageSqlitePlugin({ databasePath: dbPath })],
        config: {},
      });
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'cli' });
      await bus.call('storage:set', ctx, {
        key: 'credential:v2:user:cli:already',
        value: new Uint8Array([0x09]),
      });
      await handle.shutdown();
    }

    const lines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['migrate', '--yes'],
      stdin: emptyStdin(),
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
      sqlitePath: dbPath,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/nothing to migrate/i);
  });
});
