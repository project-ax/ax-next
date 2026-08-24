// Tests for scripts/memory-write-target.sh — the helper that tells a
// (possibly parallel) agent WHERE to write `.claude/memory/` so concurrent
// auto-ship agents stop racing on the shared main-checkout copy (TASK-7).
//
// Runs under vitest as a plain assertion harness (mirrors eslint-rules/),
// spawning the real shell script against throwaway git repos in os.tmpdir().
//
// Contract under test:
//   - prints `<git toplevel>/.claude/memory` for the current cwd (so each
//     working tree resolves to ITS OWN copy — primary tree or linked worktree)
//   - in a LINKED worktree: always safe → exit 0, no warning
//   - in the PRIMARY working tree WHILE >=1 linked worktree exists: prints a
//     stderr warning (shared-checkout write hazard); with `--check`, exits 1
//   - in the primary working tree with NO linked worktrees: safe → exit 0
//   - outside any git repo: exit nonzero with an error on stderr

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'memory-write-target.sh');

/**
 * Run the helper in `cwd` with `args`. Returns { stdout, status, stderr }.
 * Uses spawnSync so stderr is captured regardless of exit code — the helper
 * warns on stderr while still exiting 0 by default, and execFileSync would
 * hide that stderr on a successful exit.
 */
function run(cwd, args = []) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return {
    stdout: (r.stdout ?? '').trim(),
    status: r.status ?? 1,
    stderr: r.stderr ?? '',
  };
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('memory-write-target.sh', () => {
  let base; // the throwaway dir afterAll removes: the primary tree + its linked worktree
  let root; // primary working tree
  let primary; // realpath'd primary toplevel (macOS /var -> /private/var etc.)
  let worktree; // linked worktree path — a sibling of `root`, also under `base`

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'mwt-'));
    root = join(base, 'primary');
    mkdirSync(root);
    // Hermetic git: no global config, deterministic identity.
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    mkdirSync(join(root, '.claude', 'memory'), { recursive: true });
    writeFileSync(join(root, '.claude', 'memory', 'decisions.md'), '# Decisions\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'seed');
    primary = realpathSync(root);
  });

  afterAll(() => {
    // One cleanup path for the two shared fixtures: `base` holds the primary tree AND
    // the linked worktree, so this single call reaches both — no second, git-dependent
    // teardown that can quietly fail and strand a directory in the OS temp dir. (The
    // two single-test fixtures below own their own `finally` cleanup.) Guarded because
    // a failed `mkdtempSync` would otherwise raise a TypeError that buries the real
    // error.
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('prints <toplevel>/.claude/memory for the primary tree (no worktrees yet)', () => {
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(join(primary, '.claude', 'memory'));
    expect(r.stderr).toBe('');
  });

  it('--check passes (exit 0) in the primary tree when no linked worktree exists', () => {
    const r = run(root, ['--check']);
    expect(r.status).toBe(0);
  });

  describe('once a linked worktree exists', () => {
    beforeAll(() => {
      // A sibling of `root` (so the helper sees two separate working trees), but
      // still inside `base` — that is what lets the suite's single rmSync remove it.
      worktree = join(base, 'linked');
      git(root, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    });

    it('linked worktree resolves to ITS OWN memory copy and is always safe', () => {
      const wtReal = realpathSync(worktree);
      const r = run(worktree);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(join(wtReal, '.claude', 'memory'));
      expect(r.stderr).toBe('');
    });

    it('linked worktree --check exits 0 (safe target)', () => {
      expect(run(worktree, ['--check']).status).toBe(0);
    });

    it('primary tree now WARNS on stderr (shared-checkout hazard) but still exits 0 by default', () => {
      const r = run(root);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(join(primary, '.claude', 'memory'));
      expect(r.stderr).toMatch(/worktree/i);
    });

    it('primary tree --check exits nonzero while a linked worktree exists', () => {
      const r = run(root, ['--check']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/worktree/i);
    });
  });

  it('exits nonzero with an error outside any git repo', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'mwt-norepo-'));
    try {
      const r = run(notRepo);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/git/i);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  // Regression guards for a leak this file used to have. The linked worktree was
  // created at `join(root, '..', …)` — a sibling of `root` but OUTSIDE it — so the
  // suite's `rmSync(root)` could not reach it, and its only cleanup was a
  // best-effort `git worktree remove` inside a swallowed try/catch. Every run where
  // that command failed left the directory in the OS temp dir forever.
  //
  // What these CANNOT see, by construction:
  //   - the two single-test temp dirs (`notRepo` above, `b` below) live outside
  //     `base` deliberately and are removed by their own `finally`, so the first
  //     guard does not — and should not — cover them;
  //   - no `afterAll`-based cleanup survives a worker crash or a hard timeout.
  describe('temp-dir hygiene', () => {
    it('keeps the primary tree and its linked worktree under the dir afterAll removes', () => {
      // The structural fix is nesting both trees under `base`; this is the tripwire
      // for a future edit that puts one of them back OUTSIDE the removed dir.
      // Declared after the suite above, so `worktree` is already assigned — and if it
      // ever were not, `undefined.startsWith` throws rather than passing vacuously.
      for (const p of [root, worktree]) {
        expect(p.startsWith(base + sep)).toBe(true);
      }
    });

    it('removes a primary tree AND its linked worktree with a single rmSync', () => {
      // Self-contained proof of the mechanism the suite now relies on: git's
      // read-only object files do not block the recursive remove, so no
      // `git worktree remove` step is needed to avoid stranding the worktree.
      const b = mkdtempSync(join(tmpdir(), 'mwt-rmsync-'));
      try {
        const r = join(b, 'primary');
        mkdirSync(r);
        git(r, 'init', '-q', '-b', 'main');
        git(r, 'config', 'user.email', 'test@example.com');
        git(r, 'config', 'user.name', 'Test');
        writeFileSync(join(r, 'seed.txt'), 'seed\n');
        git(r, 'add', '-A');
        git(r, 'commit', '-q', '-m', 'seed');
        const wt = join(b, 'linked');
        git(r, 'worktree', 'add', '-q', '-b', 'feature', wt);
        expect(existsSync(wt)).toBe(true);

        rmSync(b, { recursive: true, force: true });
        expect(existsSync(b)).toBe(false);
      } finally {
        // Net for a git command throwing above, which would skip the `rmSync` under
        // test and strand a whole repo — the very failure class this file closes.
        // `force: true` makes the already-removed happy path a no-op, so this can
        // never mask the assertion.
        rmSync(b, { recursive: true, force: true });
      }
    });
  });
});
