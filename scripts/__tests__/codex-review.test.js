// Tests for scripts/codex-review.sh — the non-interactive whole-branch Codex
// reviewer behind yolo-ship Phase 5. The script wraps `codex review` and closes
// stdin so the review can never hang on an interactive prompt in a headless run.
//
// Runs under vitest as a plain assertion harness (mirrors memory-write-target),
// spawning the real shell script against a STUB `codex` placed first on PATH so
// no real review (or auth, or quota) is touched.
//
// Contract under test:
//   - invokes `codex review --base <base>` (default base `main`)
//   - `--base X` and `--base=X` both set the base
//   - trailing positional args become a single custom review prompt
//   - stdin is redirected from /dev/null — codex sees EOF, never the caller's
//     stdin (the load-bearing anti-hang property: input fed to the script must
//     NOT reach codex)
//   - forwards codex's exit code
//   - exits 127 with a clear error when `codex` is not on PATH

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'codex-review.sh');

describe('codex-review.sh', () => {
  let fakeDir; // holds the stub `codex` (first on PATH)
  let argsFile; // NUL-delimited argv the stub received
  let stdinFile; // bytes the stub read from stdin

  beforeAll(() => {
    fakeDir = mkdtempSync(join(tmpdir(), 'codex-review-'));
    argsFile = join(fakeDir, 'argv');
    stdinFile = join(fakeDir, 'stdin');
    // Stub `codex`: record argv (NUL-delimited so spaces survive) and stdin,
    // then exit with FAKE_CODEX_EXIT (default 0).
    const stub = [
      '#!/usr/bin/env bash',
      'printf "%s\\0" "$@" > "$CODEX_ARGS_FILE"',
      'cat > "$CODEX_STDIN_FILE"',
      'exit "${FAKE_CODEX_EXIT:-0}"',
      '',
    ].join('\n');
    writeFileSync(join(fakeDir, 'codex'), stub);
    chmodSync(join(fakeDir, 'codex'), 0o755);
  });

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
  });

  /** Run the script with the stub codex first on PATH. */
  function run(args = [], { input = '', exit } = {}) {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        PATH: `${fakeDir}:${process.env.PATH}`,
        CODEX_ARGS_FILE: argsFile,
        CODEX_STDIN_FILE: stdinFile,
        ...(exit === undefined ? {} : { FAKE_CODEX_EXIT: String(exit) }),
      },
    });
    let argv = [];
    try {
      argv = readFileSync(argsFile, 'utf8').split('\0').filter((s) => s.length > 0);
    } catch {
      /* stub never ran */
    }
    let stdin = null;
    try {
      stdin = readFileSync(stdinFile, 'utf8');
    } catch {
      /* stub never ran */
    }
    return { status: r.status ?? 1, stderr: r.stderr ?? '', argv, stdin };
  }

  it('reviews HEAD vs main by default', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.argv).toEqual(['review', '--base', 'main']);
  });

  it('--base sets the base branch', () => {
    expect(run(['--base', 'release-2']).argv).toEqual(['review', '--base', 'release-2']);
  });

  it('--base=X form also sets the base branch', () => {
    expect(run(['--base=release-2']).argv).toEqual(['review', '--base', 'release-2']);
  });

  it('trailing args become a single custom review prompt', () => {
    const r = run(['--base', 'main', 'Challenge the approach; focus on IPC leaks']);
    expect(r.argv).toEqual(['review', '--base', 'main', 'Challenge the approach; focus on IPC leaks']);
  });

  it('closes stdin — caller input never reaches codex (anti-hang)', () => {
    const r = run([], { input: 'SHOULD_NOT_REACH_CODEX\n' });
    expect(r.status).toBe(0);
    expect(r.stdin).toBe('');
  });

  it("forwards codex's exit code", () => {
    expect(run([], { exit: 3 }).status).toBe(3);
  });

  it('exits 127 with an error when codex is not on PATH', () => {
    // Absolute bash + a PATH with no `codex` (and no system bins) — the missing-
    // codex branch uses only shell builtins before exiting.
    const empty = mkdtempSync(join(tmpdir(), 'codex-review-nopath-'));
    try {
      const r = spawnSync('/bin/bash', [SCRIPT], {
        encoding: 'utf8',
        env: { PATH: empty },
      });
      expect(r.status).toBe(127);
      expect(r.stderr).toMatch(/codex.*not found/i);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
