import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';

const repoRoot = join(__dirname, '..', '..', '..', '..');
const cliEntry = join(__dirname, '..', '..', 'dist', 'main.js');
const fixturePath = join(__dirname, 'fixtures', 'anthropic-fixture.mjs');

describe('@ax/cli real-LLM e2e (mocked Anthropic via fixture)', () => {
  let workDir: string;

  beforeAll(() => {
    const built = spawnSync('pnpm', ['--filter', '@ax/cli...', 'build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (built.status !== 0) {
      throw new Error(`workspace build failed (exit ${built.status})`);
    }
    if (!existsSync(cliEntry)) {
      throw new Error(`CLI entry not found at ${cliEntry}; build must have failed`);
    }
  }, 120_000);

  afterEach(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('drives a tool-calling turn through the real sandbox', () => {
    workDir = mkdtempSync(join(tmpdir(), 'ax-next-real-llm-'));
    const dbPath = join(workDir, 'e2e.sqlite');

    // Select the anthropic LLM + bash tool via an ax.config.mjs in the cwd.
    writeFileSync(
      join(workDir, 'ax.config.mjs'),
      `export default { llm: 'anthropic', tools: ['bash'] };\n`,
    );

    const result = spawnSync('node', [cliEntry, 'please run a command'], {
      cwd: workDir,
      env: {
        ...process.env,
        AX_DB: dbPath,
        // resolveClient() checks the fixture env var first, so the key value
        // below is never consulted — we set it defensively so the "missing
        // API key" path definitely isn't what makes the test pass.
        ANTHROPIC_API_KEY: 'fake-test-key',
        AX_TEST_ANTHROPIC_FIXTURE: pathToFileURL(fixturePath).href,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toContain('ran bash, got the output');

    // Verify that bash ACTUALLY ran: the real sandbox's stdout ("fixture-hello")
    // must have been injected back into the message history by the chat loop
    // as a synthetic user tool-output message.
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT key, value FROM kv')
        .all() as Array<{ key: string; value: Buffer }>;
      const chatRow = rows.find((r) => r.key.startsWith('chat:'));
      expect(chatRow).toBeDefined();
      const decoded = JSON.parse(chatRow!.value.toString('utf8'));
      expect(decoded.outcome.kind).toBe('complete');

      const messages = decoded.outcome.messages as Array<{
        role: string;
        content: string;
      }>;
      const toolResultMsg = messages.find(
        (m) => typeof m.content === 'string' && m.content.includes('fixture-hello'),
      );
      expect(toolResultMsg).toBeDefined();
    } finally {
      db.close();
    }
  }, 60_000);
});
