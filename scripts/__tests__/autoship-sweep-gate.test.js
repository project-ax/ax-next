// Tests for scripts/auto-ship-sweep-gate.sh — the gate in front of auto-ship §7's
// irreversible abandoned-branch sweep (`git worktree remove -f -f` + `git branch -D`
// + `git push origin --delete`).
//
// WHY THIS EXISTS (TASK-506). §7 took "the card has no PR" as proof that the branch
// held nothing worth keeping. The watchdog that reaps a stalled builder fires on
// SILENCE, not on failure, so it has no relationship to how far the builder got. On
// 2026-09-20 the same protocol ran four times and produced three DIFFERENT shapes of
// live work, all of which §7-as-written would have destroyed:
//
//   Case A — TASK-455: worktree held 5 uncommitted paths, 0 commits ahead. Committed
//            as WIP, resumed, merged as #650.
//   Case B — TASK-482 / TASK-479: `git status --porcelain` EMPTY — tree pristine —
//            but 2 (resp. 3) commits ahead of main with no PR. Merged as #653/#654.
//   Case C — TASK-498: the same clean-tree shape at scale — 15 commits over 22 files,
//            a reviewer already run, builder killed by an account-level HTTP 429.
//            Merged as #656.
//   Case D — the genuinely-empty branch, which MUST still be swept. The opposite
//            failure is real: worktrees and branches piling up redden `pnpm lint`,
//            and this repo has watched a cleanup block silently accomplish nothing
//            across a whole run.
//
// Note what that list rules out. The fix the card originally proposed — "check
// `git status --porcelain`, commit if non-empty" — covers A and D and walks B and C
// straight into the shredder, which is two of the three saves. So the tests below
// pin the GENERAL predicate (is there anything here that exists nowhere else?),
// case by measured case, against real throwaway git repos with real worktrees.
//
// Lives in scripts/__tests__/, which CI's `pnpm test:scripts` runs unconditionally —
// no network, no build, no Docker.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'auto-ship-sweep-gate.sh');

/** Exit codes the gate's contract pins. Only 0 authorizes destruction. */
const SWEEP = 0;
const PRESERVE = 10;
const ERROR = 2;

const trash = [];
afterAll(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Run the gate against `repo` for `branch`; returns { status, fields, stdout }. */
function gate(repo, branch, extraArgs = []) {
  const r = spawnSync('bash', [SCRIPT, ...extraArgs, ...(branch ? [branch] : [])], {
    cwd: repo,
    encoding: 'utf8',
  });
  const stdout = (r.stdout ?? '').trim();
  const fields = Object.fromEntries(
    stdout
      .split(/\s+/)
      .filter((t) => t.includes('='))
      .map((t) => {
        const i = t.indexOf('=');
        return [t.slice(0, i), t.slice(i + 1)];
      }),
  );
  return { status: r.status ?? 1, stderr: r.stderr ?? '', stdout, fields };
}

/**
 * A throwaway fixture that mirrors the real topology: a bare `origin`, a primary
 * clone whose `main` is the base ref, and a linked worktree per agent branch —
 * because the uncommitted-work case only exists in a worktree, and the sweep the
 * gate protects is a worktree removal.
 */
function makeFixture(name) {
  const base = mkdtempSync(join(tmpdir(), `sweepgate-${name}-`));
  trash.push(base);
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  return { base, origin, repo };
}

/** Create `branch` at main and check it out in a linked worktree. Returns its path. */
function addAgentWorktree(fx, branch) {
  const wt = join(fx.base, `wt-${branch.replace(/[^A-Za-z0-9]/g, '_')}`);
  git(fx.repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  // git records the resolved path; macOS hands mkdtemp a /var -> /private/var symlink.
  return realpathSync(wt);
}

function commitFiles(wt, message, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, name)), { recursive: true });
    writeFileSync(join(wt, name), body);
  }
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', message);
}

describe('auto-ship-sweep-gate.sh — case A: uncommitted work (TASK-455 → #650)', () => {
  it('refuses to authorize a sweep of a worktree holding uncommitted paths', () => {
    const fx = makeFixture('caseA');
    const branch = 'auto-ship/TASK-455-transcript';
    const wt = addAgentWorktree(fx, branch);

    // The measured shape: 5 uncommitted paths, nothing committed. `--porcelain`
    // non-empty, `rev-list main..branch` == 0.
    writeFileSync(join(wt, 'README.md'), 'edited\n'); // modified, tracked
    for (const n of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
      writeFileSync(join(wt, n), `// ${n}\n`); // untracked
    }

    const r = gate(fx.repo, branch);
    expect(r.status).toBe(PRESERVE);
    expect(r.fields.verdict).toBe('preserve');
    expect(r.fields.reason).toBe('uncommitted');
    expect(Number(r.fields.dirty)).toBe(5);
    expect(r.fields.ahead).toBe('0');
    expect(r.fields.worktree).toBe(wt);
  });

  it('counts untracked-only work as work (a builder that never staged anything)', () => {
    const fx = makeFixture('caseA-untracked');
    const branch = 'auto-ship/TASK-455b-x';
    const wt = addAgentWorktree(fx, branch);
    writeFileSync(join(wt, 'new-plugin.ts'), 'export const x = 1;\n');

    const r = gate(fx.repo, branch);
    expect(r.status).toBe(PRESERVE);
    expect(r.fields.reason).toBe('uncommitted');
  });

  it('does not count gitignored build output as work', () => {
    // A fresh agent worktree runs `pnpm install && pnpm build` before its first test
    // run, so node_modules/ and dist/ are always present. If those counted, EVERY
    // branch would preserve and the sweep would never run again — the exact opposite
    // failure this card must not cause.
    const fx = makeFixture('caseA-ignored');
    const branch = 'auto-ship/TASK-000-ignored';
    const wt = addAgentWorktree(fx, branch);
    writeFileSync(join(wt, '.gitignore'), 'node_modules/\ndist/\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'ignore build output');
    git(wt, 'push', '-q', 'origin', `${branch}:main`); // fold it into the base
    git(fx.repo, 'fetch', '-q', 'origin');
    mkdirSync(join(wt, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(wt, 'node_modules', 'pkg', 'index.js'), '//\n');
    mkdirSync(join(wt, 'dist'), { recursive: true });
    writeFileSync(join(wt, 'dist', 'main.js'), '//\n');

    const r = gate(fx.repo, branch);
    expect(r.fields.dirty).toBe('0');
    expect(r.status).toBe(SWEEP);
  });
});

describe('auto-ship-sweep-gate.sh — case B: clean tree, commits ahead (TASK-482/479 → #653/#654)', () => {
  it('preserves a PRISTINE worktree whose branch is 2 commits ahead with no PR', () => {
    const fx = makeFixture('caseB');
    const branch = 'auto-ship/TASK-482-decline-markers';
    const wt = addAgentWorktree(fx, branch);
    commitFiles(wt, 'scan reclaims decline markers', { 'scan.ts': 'a\n' });
    commitFiles(wt, 'test for the reclaim', { 'scan.test.ts': 'b\n' });

    // This is the assertion that separates the real fix from the card's original
    // proposal: `git status --porcelain` is EMPTY here.
    expect(git(wt, 'status', '--porcelain')).toBe('');

    const r = gate(fx.repo, branch);
    expect(r.status).toBe(PRESERVE);
    expect(r.fields.verdict).toBe('preserve');
    expect(r.fields.reason).toBe('commits-ahead');
    expect(r.fields.dirty).toBe('0');
    expect(r.fields.ahead).toBe('2');
  });

  it('preserves an unpushed branch with commits even when no worktree holds it', () => {
    // A preserve step that removes the worktree (to free the checkout for a resuming
    // builder) must not turn the branch into a sweep candidate on the next pass.
    const fx = makeFixture('caseB-nowt');
    const branch = 'auto-ship/TASK-479-review-gate';
    const wt = addAgentWorktree(fx, branch);
    commitFiles(wt, 'one', { 'a.ts': '1\n' });
    commitFiles(wt, 'two', { 'b.ts': '2\n' });
    commitFiles(wt, 'three', { 'c.ts': '3\n' });
    git(fx.repo, 'worktree', 'remove', '--force', wt);

    const r = gate(fx.repo, branch);
    expect(r.status).toBe(PRESERVE);
    expect(r.fields.reason).toBe('commits-ahead');
    expect(r.fields.ahead).toBe('3');
    expect(r.fields.worktree).toBe('-');
    expect(r.fields.pushed).toBe('no');
  });

  it('reports both signals when the tree is dirty AND the branch is ahead', () => {
    const fx = makeFixture('caseB-both');
    const branch = 'auto-ship/TASK-479b-both';
    const wt = addAgentWorktree(fx, branch);
    commitFiles(wt, 'committed part', { 'a.ts': '1\n' });
    writeFileSync(join(wt, 'wip.ts'), 'in flight\n');

    const r = gate(fx.repo, branch);
    expect(r.status).toBe(PRESERVE);
    expect(r.fields.reason).toBe('uncommitted+commits-ahead');
    expect(r.fields.dirty).toBe('1');
    expect(r.fields.ahead).toBe('1');
  });
});

describe('auto-ship-sweep-gate.sh — case C: 15 commits / 22 files, pushed, no PR (TASK-498 → #656)', () => {
  it('preserves a large clean-tree build and reports it as already pushed', () => {
    const fx = makeFixture('caseC');
    const branch = 'auto-ship/TASK-498-failed-turn';
    const wt = addAgentWorktree(fx, branch);
    for (let i = 0; i < 15; i++) {
      const files = {};
      // 22 distinct files across the 15 commits, as measured.
      files[`src/f${i}.ts`] = `export const a${i} = ${i};\n`;
      if (i < 7) files[`src/f${i}.test.ts`] = `// test ${i}\n`;
      commitFiles(wt, `step ${i}`, files);
    }
    git(wt, 'push', '-q', 'origin', branch);
    git(fx.repo, 'fetch', '-q', 'origin');

    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'ls-files').split('\n').length).toBe(23); // 22 + README.md

    const r = gate(fx.repo, branch);
    expect(r.status).toBe(PRESERVE);
    expect(r.fields.reason).toBe('commits-ahead');
    expect(r.fields.ahead).toBe('15');
    // Pushed is reported but is NOT what saved it — a copy on origin is still
    // destroyed by §7's `git push origin --delete`.
    expect(r.fields.pushed).toBe('yes');
  });
});

describe('auto-ship-sweep-gate.sh — case D: the genuinely-empty branch MUST be swept', () => {
  it('authorizes the sweep for a clean worktree with no commits ahead', () => {
    const fx = makeFixture('caseD');
    const branch = 'auto-ship/TASK-999-nothing';
    const wt = addAgentWorktree(fx, branch);

    expect(git(wt, 'status', '--porcelain')).toBe('');
    const r = gate(fx.repo, branch);
    expect(r.status).toBe(SWEEP);
    expect(r.fields.verdict).toBe('sweep');
    expect(r.fields.reason).toBe('nothing-unique');
    expect(r.fields.dirty).toBe('0');
    expect(r.fields.ahead).toBe('0');
  });

  it('authorizes the sweep for a bare branch with no worktree at all', () => {
    const fx = makeFixture('caseD-bare');
    const branch = 'auto-ship/TASK-998-bare';
    git(fx.repo, 'branch', branch, 'main');

    const r = gate(fx.repo, branch);
    expect(r.status).toBe(SWEEP);
    expect(r.fields.worktree).toBe('-');
  });

  it('authorizes the sweep for a branch that is BEHIND the base', () => {
    const fx = makeFixture('caseD-behind');
    const branch = 'auto-ship/TASK-997-behind';
    git(fx.repo, 'branch', branch, 'main');
    writeFileSync(join(fx.repo, 'moved-on.md'), 'x\n');
    git(fx.repo, 'add', '-A');
    git(fx.repo, 'commit', '-q', '-m', 'main moves on');
    git(fx.repo, 'push', '-q', 'origin', 'main');
    git(fx.repo, 'fetch', '-q', 'origin');

    const r = gate(fx.repo, branch);
    expect(r.status).toBe(SWEEP);
    expect(r.fields.ahead).toBe('0');
  });
});

describe('auto-ship-sweep-gate.sh — fails closed', () => {
  it('prefers origin/main over a diverged local main as the base', () => {
    // A stale local `main` in a worktree is a measured hazard in this repo. If the
    // gate fell back to it while origin/main was available, a branch already merged
    // upstream would read as `ahead>0` (harmless) — but a local main that has run
    // AHEAD of origin would hide real commits. Pin the precedence either way.
    const fx = makeFixture('base-precedence');
    const branch = 'auto-ship/TASK-996-base';
    const wt = addAgentWorktree(fx, branch);
    commitFiles(wt, 'branch work', { 'x.ts': '1\n' });
    // Local main advances past origin/main without pushing.
    writeFileSync(join(fx.repo, 'local-only.md'), 'y\n');
    git(fx.repo, 'add', '-A');
    git(fx.repo, 'commit', '-q', '-m', 'local only');

    const r = gate(fx.repo, branch);
    expect(r.fields.base).toBe('origin/main');
    expect(r.status).toBe(PRESERVE);
  });

  it('falls back to local main when there is no origin at all', () => {
    const fx = makeFixture('no-origin');
    git(fx.repo, 'remote', 'remove', 'origin');
    git(fx.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    const branch = 'auto-ship/TASK-995-noorigin';
    addAgentWorktree(fx, branch);

    const r = gate(fx.repo, branch);
    expect(r.fields.base).toBe('main');
    expect(r.fields.pushed).toBe('no-origin');
    expect(r.status).toBe(SWEEP);
  });

  it('errors (does NOT sweep) when no base ref resolves', () => {
    const base = mkdtempSync(join(tmpdir(), 'sweepgate-nobase-'));
    trash.push(base);
    git(base, 'init', '-q', '-b', 'trunk');
    git(base, 'config', 'user.email', 'test@example.com');
    git(base, 'config', 'user.name', 'Test');
    writeFileSync(join(base, 'a'), 'a\n');
    git(base, 'add', '-A');
    git(base, 'commit', '-q', '-m', 'a');
    git(base, 'branch', 'auto-ship/TASK-994-x');

    const r = gate(base, 'auto-ship/TASK-994-x');
    expect(r.status).toBe(ERROR);
    expect(r.status).not.toBe(SWEEP);
    expect(r.fields.verdict).toBe('error');
    expect(r.fields.reason).toBe('no-base-ref');
  });

  it('errors (does NOT sweep) on an unknown branch', () => {
    const fx = makeFixture('unknown');
    const r = gate(fx.repo, 'auto-ship/TASK-993-never-existed');
    expect(r.status).toBe(ERROR);
    expect(r.fields.reason).toBe('no-such-branch');
  });

  it('errors (does NOT sweep) outside a git repository', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sweepgate-norepo-'));
    trash.push(empty);
    const r = gate(empty, 'auto-ship/TASK-992-x', ['--repo', empty]);
    expect(r.status).toBe(ERROR);
    expect(r.fields.reason).toBe('not-a-repo');
  });

  it('errors (does NOT sweep) when given no branch', () => {
    const fx = makeFixture('nobranch');
    const r = gate(fx.repo, null);
    expect(r.status).toBe(ERROR);
    expect(r.fields.reason).toBe('usage');
  });

  it('always prints exactly one parseable verdict line, on every path', () => {
    const fx = makeFixture('shape');
    const branch = 'auto-ship/TASK-991-shape';
    addAgentWorktree(fx, branch);
    for (const r of [
      gate(fx.repo, branch),
      gate(fx.repo, 'auto-ship/TASK-990-missing'),
      gate(fx.repo, null),
    ]) {
      expect(r.stdout.split('\n')).toHaveLength(1);
      for (const k of ['verdict', 'reason', 'branch', 'base', 'worktree', 'dirty', 'ahead', 'pushed']) {
        expect(r.fields, `${k} missing from: ${r.stdout}`).toHaveProperty(k);
      }
    }
  });

  it('resolves the repo from --repo, not just cwd', () => {
    const fx = makeFixture('repoflag');
    const branch = 'auto-ship/TASK-989-repoflag';
    const wt = addAgentWorktree(fx, branch);
    commitFiles(wt, 'work', { 'a.ts': '1\n' });
    const elsewhere = mkdtempSync(join(tmpdir(), 'sweepgate-elsewhere-'));
    trash.push(elsewhere);

    const r = gate(elsewhere, branch, ['--repo', fx.repo]);
    expect(r.status).toBe(PRESERVE);
    expect(r.fields.ahead).toBe('1');
  });
});
