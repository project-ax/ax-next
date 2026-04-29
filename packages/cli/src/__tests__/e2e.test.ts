import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeScript, stubRunnerPath } from '@ax/test-harness';

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

  // Default-config canary: spawns the CLI binary with the stub runner +
  // test-proxy plugin (env-gated) to drive a full chat through
  // bootstrap → orchestrator → IPC → assistant text print — without
  // touching the wire or seeding real credentials. Rebuilt in Phase 6.6.
  //
  // Phase 7 Slice A: dropped the SQLite chat-row assertion. audit-log
  // no longer subscribes to chat:end (I24), so there's no `chat:<reqId>`
  // row to read back. The "did the chat actually run" canary is now
  // carried entirely by the stdout assertion (the CLI prints the last
  // assistant message on success). The dbPath existence check stays —
  // it's the cheap-but-load-bearing proof that storage-sqlite wired up
  // and opened the file (vs. a silent init failure).
  it('runs a full chat through the default CLI config', () => {
    workDir = mkdtempSync(join(tmpdir(), 'ax-next-e2e-'));
    const dbPath = join(workDir, 'e2e.sqlite');

    // The CLI prints the LAST message from outcome.messages on success, so
    // the script must end with an assistant-text 'hello' followed by finish.
    const script = encodeScript({
      entries: [
        { kind: 'assistant-text', content: 'hello' },
        { kind: 'finish', reason: 'end_turn' },
      ],
    });

    const result = spawnSync('node', [cliEntry, 'hi'], {
      env: {
        ...process.env,
        AX_DB: dbPath,
        // @ax/credentials is wired into the chat path; init() requires this.
        AX_CREDENTIALS_KEY: '42'.repeat(32),
        AX_TEST_RUNNER_BINARY_OVERRIDE: stubRunnerPath,
        AX_TEST_STUB_PROXY: '1',
        AX_TEST_STUB_SCRIPT_BASE64: script,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hello');

    // storage-sqlite booted (file exists). We don't assert on row contents
    // post-Phase 7 — audit-log doesn't write a chat:* row any more, and
    // nothing else in the default chat path persists for this canary to
    // read back.
    expect(existsSync(dbPath)).toBe(true);
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
