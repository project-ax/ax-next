import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HookBus, bootstrap, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { loadConfigs, saveConfig, type McpServerConfig } from '@ax/mcp-client';
import { runMcpCommand } from '../commands/mcp.js';

const TEST_KEY_HEX = '42'.repeat(32);

let tmp: string;

function stdinFromString(s: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(s, 'utf8')]);
}

async function seedConfigs(sqlitePath: string, configs: McpServerConfig[]): Promise<void> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [
      createStorageSqlitePlugin({ databasePath: sqlitePath }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
    ],
    config: {},
  });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  for (const c of configs) {
    await saveConfig(bus, ctx, c);
  }
}

// Write a raw row + index entry, bypassing saveConfig's validation — the shape
// a pre-removal database still holds (e.g. a stdio config).
async function seedRawRow(sqlitePath: string, id: string, row: unknown): Promise<void> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [
      createStorageSqlitePlugin({ databasePath: sqlitePath }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
    ],
    config: {},
  });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  const enc = new TextEncoder();
  await bus.call('storage:set', ctx, {
    key: `mcp-server:${id}`,
    value: enc.encode(JSON.stringify(row)),
  });
  await bus.call('storage:set', ctx, {
    key: 'mcp-server-index',
    value: enc.encode(JSON.stringify([id])),
  });
}

async function readStoredConfigs(sqlitePath: string): Promise<McpServerConfig[]> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [
      createStorageSqlitePlugin({ databasePath: sqlitePath }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
    ],
    config: {},
  });
  return loadConfigs(bus, makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' }));
}

beforeEach(() => {
  process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  tmp = mkdtempSync(join(tmpdir(), 'ax-mcp-cli-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ax-next mcp add', () => {
  it('reads JSON config from stdin, saves it, and exits 0', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const config: McpServerConfig = {
      id: 'fs',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/fs',
    };

    const code = await runMcpCommand({
      argv: ['add'],
      stdin: stdinFromString(JSON.stringify(config)),
      stdout: (l) => stdoutLines.push(l),
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });

    expect(code).toBe(0);
    expect(stdoutLines.join('\n')).toContain("'fs'");
    expect(stderrLines).toEqual([]);

    // Round-trip verify.
    const stored = await readStoredConfigs(sqlitePath);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe('fs');
  });

  it('exits 1 with a redacted error when stdin is malformed JSON', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['add'],
      stdin: stdinFromString('{ not json'),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n').toLowerCase()).toContain('json');
  });

  it('rejects a stdio config with the migration hint and stores nothing', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['add'],
      stdin: stdinFromString(
        JSON.stringify({
          id: 'fs',
          enabled: true,
          transport: 'stdio',
          command: 'mcp-server-filesystem',
          args: ['/tmp'],
        }),
      ),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });

    expect(code).toBe(1);
    const stderrAll = stderrLines.join('\n');
    expect(stderrAll).toContain('no longer supported');
    expect(stderrAll).toContain('streamable-http');
    expect(await readStoredConfigs(sqlitePath)).toEqual([]);
  });

  it('exits 1 when saveConfig rejects (inline secret in payload)', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stderrLines: string[] = [];

    // An http config with an inline `password` field will trip the
    // inline-secret scan in parseConfig / saveConfig.
    const bad = {
      id: 'fs',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/fs',
      password: 'hunter2',
    };

    const code = await runMcpCommand({
      argv: ['add'],
      stdin: stdinFromString(JSON.stringify(bad)),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });

    expect(code).toBe(1);
    const stderrAll = stderrLines.join('\n').toLowerCase();
    expect(stderrAll).toContain('error');
    // Must not echo the secret value.
    expect(stderrLines.join('\n')).not.toContain('hunter2');
  });
});

describe('ax-next mcp list', () => {
  it('prints a table with one line per configured server', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    await seedConfigs(sqlitePath, [
      {
        id: 'fs',
        enabled: true,
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
      },
      {
        id: 'gh',
        enabled: false,
        transport: 'streamable-http',
        url: 'https://api.github.com/mcp',
      },
    ]);

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['list'],
      stdin: stdinFromString(''),
      stdout: (l) => stdoutLines.push(l),
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });

    expect(code).toBe(0);
    expect(stderrLines).toEqual([]);
    const stdoutAll = stdoutLines.join('\n');
    expect(stdoutAll).toContain('fs');
    expect(stdoutAll).toContain('gh');
    expect(stdoutAll).toContain('sse');
    expect(stdoutAll).toContain('streamable-http');
    expect(stdoutAll).toContain('https://mcp.example.com/sse');
    expect(stdoutAll).toContain('https://api.github.com/mcp');
    // One tab-separated line per server: id, status, transport, url.
    expect(stdoutLines).toEqual([
      'fs\tenabled\tsse\thttps://mcp.example.com/sse',
      'gh\tdisabled\tstreamable-http\thttps://api.github.com/mcp',
    ]);
  });

  it('skips a leftover stdio row instead of crashing or printing it', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    await seedRawRow(sqlitePath, 'old', {
      id: 'old',
      enabled: true,
      transport: 'stdio',
      command: 'mcp-server-filesystem',
      args: [],
    });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['list'],
      stdin: stdinFromString(''),
      stdout: (l) => stdoutLines.push(l),
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });

    expect(code).toBe(0);
    expect(stderrLines).toEqual([]);
    // The unusable row is skipped (loadConfigs logs it), never listed.
    expect(stdoutLines.join('\n')).not.toContain('mcp-server-filesystem');
    expect(stdoutLines.join('\n')).not.toContain('undefined');
  });

  it('prints a friendly empty-state line when no configs exist', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stdoutLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['list'],
      stdin: stdinFromString(''),
      stdout: (l) => stdoutLines.push(l),
      stderr: () => {},
      sqlitePath,
    });

    expect(code).toBe(0);
    expect(stdoutLines.join('\n').toLowerCase()).toContain('no mcp');
  });
});

describe('ax-next mcp rm', () => {
  it('removes a configured server and exits 0', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    await seedConfigs(sqlitePath, [
      {
        id: 'fs',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://mcp.example.com/fs',
      },
    ]);

    const stdoutLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['rm', 'fs'],
      stdin: stdinFromString(''),
      stdout: (l) => stdoutLines.push(l),
      stderr: () => {},
      sqlitePath,
    });

    expect(code).toBe(0);
    expect(stdoutLines.join('\n')).toContain("'fs'");

    const remaining = await readStoredConfigs(sqlitePath);
    expect(remaining).toEqual([]);
  });

  it('exits 2 with usage when id is missing', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['rm'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });

    expect(code).toBe(2);
    expect(stderrLines.join('\n').toLowerCase()).toContain('usage');
  });
});

describe('ax-next mcp test', () => {
  it('exits 1 with error when the id is not found', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['test', 'nonexistent'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n').toLowerCase()).toContain('not found');
  });

  it('exits 2 with usage when id is missing', async () => {
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['test'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
    });

    expect(code).toBe(2);
    expect(stderrLines.join('\n').toLowerCase()).toContain('usage');
  });
});

describe('ax-next mcp (unknown verb)', () => {
  it('exits 2 with usage for an unknown subcommand', async () => {
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: ['frobnicate'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
    });

    expect(code).toBe(2);
    expect(stderrLines.join('\n').toLowerCase()).toContain('usage');
  });

  it('exits 2 with usage when no verb is given', async () => {
    const stderrLines: string[] = [];

    const code = await runMcpCommand({
      argv: [],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
    });

    expect(code).toBe(2);
    expect(stderrLines.join('\n').toLowerCase()).toContain('usage');
  });
});
