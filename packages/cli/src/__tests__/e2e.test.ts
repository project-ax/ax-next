import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

const repoRoot = join(__dirname, '..', '..', '..', '..');
const cliEntry = join(__dirname, '..', '..', 'dist', 'main.js');

describe('@ax/cli end-to-end', () => {
  let workDir: string;

  beforeAll(() => {
    // Ensure the CLI and its workspace deps are built. spawnSync with an
    // argv array avoids shell quoting / injection — there is no user input
    // here, but keeping shell: false is the repo's safer-by-default pattern.
    const built = spawnSync(
      'pnpm',
      ['--filter', '@ax/cli...', 'build'],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit' },
    );
    if (built.status !== 0) {
      throw new Error(`workspace build failed (exit ${built.status})`);
    }
    if (!existsSync(cliEntry)) {
      throw new Error(`CLI entry not found at ${cliEntry}; build must have failed`);
    }
  }, 120000);

  afterEach(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('runs a full chat and persists the outcome to SQLite', () => {
    workDir = mkdtempSync(join(tmpdir(), 'ax-next-e2e-'));
    const dbPath = join(workDir, 'e2e.sqlite');

    const result = spawnSync('node', [cliEntry, 'hi'], {
      env: {
        ...process.env,
        AX_DB: dbPath,
        // @ax/credentials is wired into the chat path; init() requires this.
        AX_CREDENTIALS_KEY: '42'.repeat(32),
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hello');

    expect(existsSync(dbPath)).toBe(true);
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT key, value FROM kv')
        .all() as Array<{ key: string; value: Buffer }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const chatRow = rows.find((r) => r.key.startsWith('chat:'));
      expect(chatRow).toBeDefined();
      const decoded = JSON.parse(chatRow!.value.toString('utf8'));
      expect(decoded).toMatchObject({
        sessionId: 'cli-session',
        outcome: {
          kind: 'complete',
          messages: expect.arrayContaining([
            { role: 'assistant', content: 'hello' },
          ]),
        },
      });
      expect(chatRow!.key).toMatch(/^chat:.+/);
      expect(typeof decoded.timestamp).toBe('string');
    } finally {
      db.close();
    }
  });

  it('non-zero exit when a plugin init fails', () => {
    workDir = mkdtempSync(join(tmpdir(), 'ax-next-e2e-'));
    // Pointing AX_DB at a directory (not a file) forces SQLite open to fail
    // at init, which bubbles up as `init-failed` → non-zero CLI exit.
    const result = spawnSync('node', [cliEntry, 'hi'], {
      env: { ...process.env, AX_DB: workDir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/fatal:/);
  });
});
