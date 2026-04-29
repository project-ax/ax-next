import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HookBus, bootstrap, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { runCredentialsCommand } from '../commands/credentials.js';

const TEST_KEY_HEX = '42'.repeat(32);

let tmp: string;

function stdinFromString(s: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(s, 'utf8')]);
}

beforeEach(() => {
  process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  tmp = mkdtempSync(join(tmpdir(), 'ax-cred-cli-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ax-next credentials set <id>', () => {
  it('writes the secret from stdin and exits 0', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const code = await runCredentialsCommand({
      argv: ['set', 'gh-token'],
      stdin: stdinFromString('ghp_abc123'),
      stdout: (l) => stdoutLines.push(l),
      stderr: (l) => stderrLines.push(l),
      sqlitePath,
    });
    expect(code).toBe(0);
    expect(stdoutLines.join('\n')).toContain("'gh-token'");
    expect(stderrLines).toEqual([]);

    // Independently round-trip via the plugin to confirm what's stored.
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
    const got = await bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' }),
      { ref: 'gh-token', userId: 'cli' },
    );
    expect(got).toBe('ghp_abc123');
  });

  it('strips a single trailing newline from stdin', async () => {
    const sqlitePath = join(tmp, 'db.sqlite');
    const code = await runCredentialsCommand({
      argv: ['set', 'gh-token'],
      stdin: stdinFromString('ghp_abc123\n'),
      stdout: () => {},
      stderr: () => {},
      sqlitePath,
    });
    expect(code).toBe(0);

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
    const got = await bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' }),
      { ref: 'gh-token', userId: 'cli' },
    );
    expect(got).toBe('ghp_abc123'); // newline stripped
  });

  it('exits 2 with usage when the verb is unknown', async () => {
    const stderrLines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['frobnicate', 'gh-token'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
    });
    expect(code).toBe(2);
    expect(stderrLines.join('\n').toLowerCase()).toContain('usage');
  });

  it('exits 2 with usage when the id is missing for set', async () => {
    const stderrLines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['set'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
    });
    expect(code).toBe(2);
    expect(stderrLines.join('\n').toLowerCase()).toContain('usage');
  });

  it('exits 1 and reports a redacted error when id is invalid', async () => {
    const stderrLines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['set', 'has space'],
      stdin: stdinFromString('UNIQUE-SECRET-MARKER'),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
    });
    expect(code).toBe(1);
    const stderrAll = stderrLines.join('\n');
    expect(stderrAll.toLowerCase()).toContain('error');
    // The secret must NEVER appear in stderr.
    expect(stderrAll).not.toContain('UNIQUE-SECRET-MARKER');
  });
});
