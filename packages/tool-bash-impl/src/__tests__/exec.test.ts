import { describe, it, expect } from 'vitest';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBash } from '../exec.js';

// ---------------------------------------------------------------------------
// Ported from Week 4-6's sandbox-subprocess spawn.test.ts, adapted for the
// bash-specific surface: argv is fixed, caller supplies a command string.
// ---------------------------------------------------------------------------

describe('executeBash', () => {
  it('runs a happy-path command and captures stdout', async () => {
    const result = await executeBash({ command: 'echo hi' }, { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toEqual({ stdout: false, stderr: false });
  });

  it('surfaces a nonzero exit code', async () => {
    const result = await executeBash({ command: 'exit 7' }, { cwd: '/tmp' });
    expect(result.exitCode).toBe(7);
  });

  it('enforces timeoutMs by killing the child with SIGKILL', async () => {
    const result = await executeBash(
      { command: 'sleep 5', timeoutMs: 100 },
      { cwd: '/tmp' },
    );
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('caps stdout and marks truncated.stdout', async () => {
    // `yes x | head -c 2000` is a reliable way to force a large-ish stream;
    // maxStdoutBytes=500 truncates mid-stream.
    const result = await executeBash(
      { command: 'yes x | head -c 2000' },
      { cwd: '/tmp', maxStdoutBytes: 500 },
    );
    expect(result.stdout.length).toBe(500);
    expect(result.truncated.stdout).toBe(true);
  });

  it('scrubs non-allowlisted env vars (I2 / I5): ANTHROPIC_API_KEY never reaches child', async () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'secret-parent';
    try {
      const result = await executeBash(
        { command: 'printf "%s" "${ANTHROPIC_API_KEY:-GONE}"' },
        { cwd: '/tmp' },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('GONE');
      expect(result.stdout).not.toContain('secret-parent');
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prior;
    }
  });

  it('honors cwd', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ax-bash-cwd-'));
    const expected = await realpath(tmp);
    const result = await executeBash({ command: 'pwd' }, { cwd: tmp });
    expect(result.stdout.trim()).toBe(expected);
  });

  it('throws on empty command', async () => {
    await expect(executeBash({ command: '' }, { cwd: '/tmp' })).rejects.toThrow(
      /non-empty string/,
    );
  });

  it('throws on oversized command before spawning', async () => {
    // 16 KiB + 1 byte; we check by byte-length so repeating a 1-byte char
    // gets us there exactly.
    const oversized = 'a'.repeat(16_385);
    await expect(
      executeBash({ command: oversized }, { cwd: '/tmp' }),
    ).rejects.toThrow(/exceeds 16384 bytes/);
  });

  it('throws on non-integer or out-of-range timeoutMs', async () => {
    await expect(
      executeBash({ command: 'true', timeoutMs: 0 }, { cwd: '/tmp' }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      executeBash({ command: 'true', timeoutMs: 1.5 }, { cwd: '/tmp' }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      executeBash({ command: 'true', timeoutMs: 10_000_000 }, { cwd: '/tmp' }),
    ).rejects.toThrow(/positive integer/);
  });

  it('does not inherit a Node IPC channel', async () => {
    // If some ambient channel leaks through, `node -e` would see a defined
    // process.channel. We shell out through bash -c and spawn a tiny node
    // one-liner — robust enough since PATH is in the allowlist.
    const result = await executeBash(
      { command: 'node -e \'console.log(typeof process.channel)\'' },
      { cwd: '/tmp' },
    );
    expect(result.stdout.trim()).toBe('undefined');
  });
});
