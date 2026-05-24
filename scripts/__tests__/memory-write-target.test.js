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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
  let root; // primary working tree
  let primary; // realpath'd primary toplevel (macOS /var -> /private/var etc.)
  let worktree; // linked worktree path

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mwt-'));
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
    rmSync(root, { recursive: true, force: true });
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
      worktree = join(root, '..', `mwt-wt-${Date.now()}`);
      git(root, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    });

    afterAll(() => {
      // Best-effort: remove the linked worktree before the temp dir is nuked.
      try {
        git(root, 'worktree', 'remove', '--force', worktree);
      } catch {
        /* ignore */
      }
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
});
