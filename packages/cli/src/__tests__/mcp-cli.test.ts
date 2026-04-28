import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HookBus, bootstrap, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
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
    plugins: [createStorageSqlitePlugin({ databasePath: sqlitePath }), createCredentialsPlugin()],
    config: {},
  });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  for (const c of configs) {
    await saveConfig(bus, ctx, c);
  }
}

async function readStoredConfigs(sqlitePath: string): Promise<McpServerConfig[]> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createStorageSqlitePlugin({ databasePath: sqlitePath }), createCredentialsPlugin()],
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
      transport: 'stdio',
      command: 'mcp-server-filesystem',
      args: ['/tmp'],
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

  it('exits 1 when saveConfig rejects (inline secret in payload)', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stderrLines: string[] = [];

    // A stdio config with an inline `password` field will trip the
    // inline-secret scan in parseConfig / saveConfig.
    const bad = {
      id: 'fs',
      enabled: true,
      transport: 'stdio',
      command: 'mcp-server-filesystem',
      args: [],
      env: { password: 'hunter2' },
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
        transport: 'stdio',
        command: 'mcp-server-filesystem',
        args: ['/tmp'],
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
    expect(stdoutAll).toContain('stdio');
    expect(stdoutAll).toContain('streamable-http');
    expect(stdoutAll).toContain('mcp-server-filesystem');
    expect(stdoutAll).toContain('https://api.github.com/mcp');
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
        transport: 'stdio',
        command: 'mcp-server-filesystem',
        args: [],
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
