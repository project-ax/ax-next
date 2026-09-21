// Executes auto-ship §7a's abandoned-branch cleanup block — the literal shell the
// orchestrator runs — against real throwaway git repos (TASK-506).
//
// The block is DATA to this repo: no linter, type checker or test ever looked at it,
// and it is the procedure other agents execute verbatim. The previous version deleted
// a branch on one piece of evidence ("the card has no PR"), which on 2026-09-20 came
// within one command of shredding four live builds in a single session.
//
// A text scan is not enough here, and this repo has learned that twice: TASK-498's
// discipline scan could be satisfied by a COMMENT quoting the call, and #640 shipped a
// comment whose grep hint failed its own grep. So this file does not scan the block —
// it PARSES it out of the doc, runs it with `bash`, and asserts on what survives on
// disk afterwards. A comment cannot commit a file, and prose cannot delete a branch.
//
// `gh` is stubbed on PATH (the block's only network call is the merged-PR lookup);
// `origin` is a local bare repo, so `git push` is real but offline. No Docker.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 'auto-ship-sweep-gate.sh');
const DOC = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'auto-ship',
  'references',
  'github-project.md',
);

const trash = [];
afterAll(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * The cleanup block, pulled out of the doc by the command it must contain.
 * Deliberately NOT a regex over prose: it takes only ```bash fences, so a sentence
 * or a comment elsewhere in the file can never stand in for the real block.
 */
function cleanupBlock() {
  const md = readFileSync(DOC, 'utf8');
  const fences = [...md.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
  const hits = fences.filter((b) =>
    b.split('\n').some((l) => !/^\s*#/.test(l) && l.includes('git worktree remove')),
  );
  return { fences, hits };
}

describe('auto-ship §7a cleanup block: found, and it is the gated one', () => {
  it('has exactly one runnable block that removes a worktree', () => {
    const { fences, hits } = cleanupBlock();
    expect(fences.length).toBeGreaterThan(5); // the scan is not vacuous
    expect(hits).toHaveLength(1);
  });

  it('calls the gate on a REAL line before any destructive command', () => {
    // The guard a comment must not be able to satisfy: both the gate call and the
    // destructive commands are matched only on non-comment lines, and the gate has
    // to come first. Negative controls below prove the checker rejects prose.
    const [block] = cleanupBlock().hits;
    expect(firstRealLine(block, 'auto-ship-sweep-gate.sh')).toBeGreaterThanOrEqual(0);
    for (const cmd of ['git worktree remove', 'git branch -D', 'git push origin --delete']) {
      expect(firstRealLine(block, cmd), cmd).toBeGreaterThan(
        firstRealLine(block, 'auto-ship-sweep-gate.sh'),
      );
    }
  });

  it('rejects a block where the gate appears only as a comment (negative control)', () => {
    const commented = [
      '# run scripts/auto-ship-sweep-gate.sh first, it is important',
      'git worktree remove -f -f "$wt"',
    ].join('\n');
    expect(firstRealLine(commented, 'auto-ship-sweep-gate.sh')).toBe(-1);
    expect(firstRealLine(commented, 'git worktree remove')).toBe(1);
  });

  it('names a gate script that exists and is executable', () => {
    // Renaming or deleting the script must break this test, not just the docs.
    expect(existsSync(GATE)).toBe(true);
    const mode = execFileSync('git', ['ls-files', '-s', 'scripts/auto-ship-sweep-gate.sh'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    // git tracks the exec bit as mode 100755.
    expect(mode.startsWith('100755'), `tracked mode: ${mode || '(untracked)'}`).toBe(true);
  });

  it('states the RESUME-not-restart rule in §7a prose', () => {
    const md = readFileSync(DOC, 'utf8');
    const section = md.slice(md.indexOf('### 7a.'), md.indexOf('## 8.'));
    expect(section).toMatch(/RESUME/);
    expect(section.toLowerCase()).toMatch(/not a restart|do not restart|do NOT restart/i);
  });
});

/** Index of the first non-comment line containing `needle`, or -1. */
function firstRealLine(block, needle) {
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    if (lines[i].includes(needle)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Execution harness
// ---------------------------------------------------------------------------

/** Fixture: bare origin + primary clone on main + a stub `gh` on PATH. */
function makeFixture(name, mergedHeadRefs = []) {
  const base = mkdtempSync(join(tmpdir(), `sweepblk-${name}-`));
  trash.push(base);
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  const bin = join(base, 'bin');

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

  // The block invokes the gate by its repo-relative path, as the orchestrator does.
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(GATE, join(repo, 'scripts', 'auto-ship-sweep-gate.sh'));
  chmodSync(join(repo, 'scripts', 'auto-ship-sweep-gate.sh'), 0o755);

  // Stub `gh`: the block's only network call is the merged-PR lookup.
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\n${mergedHeadRefs.map((r) => `echo '${r}'`).join('\n') || 'true'}\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);

  return { base, origin, repo, bin };
}

function addAgentWorktree(fx, branch) {
  const wt = join(fx.base, `wt-${branch.replace(/[^A-Za-z0-9]/g, '_')}`);
  git(fx.repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  return realpathSync(wt);
}

/** Run the doc's cleanup block for `taskId` inside the fixture. */
function runCleanup(fx, taskId) {
  const [block] = cleanupBlock().hits;
  const r = spawnSync('bash', ['-c', block], {
    cwd: fx.repo,
    encoding: 'utf8',
    env: { ...process.env, TASK_ID: taskId, PATH: `${fx.bin}:${process.env.PATH}` },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const localBranches = (repo) =>
  git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
const remoteBranches = (origin) =>
  git(origin, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);

describe('auto-ship §7a cleanup block: run for real', () => {
  it('case A — uncommitted work: commits it, pushes it, keeps the branch', () => {
    const fx = makeFixture('caseA');
    const branch = 'auto-ship/TASK-455-transcript';
    const wt = addAgentWorktree(fx, branch);
    writeFileSync(join(wt, 'README.md'), 'edited\n');
    for (const n of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) writeFileSync(join(wt, n), `// ${n}\n`);

    const r = runCleanup(fx, 'TASK-455');

    expect(localBranches(fx.repo)).toContain(branch);
    expect(remoteBranches(fx.origin)).toContain(branch);
    // The 5 uncommitted paths survived, as a commit, on origin.
    const files = git(fx.repo, 'ls-tree', '-r', '--name-only', `origin/${branch}`).split('\n');
    expect(files).toEqual(expect.arrayContaining(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'README.md']));
    expect(git(fx.repo, 'show', `origin/${branch}:README.md`)).toBe('edited');
    expect(r.stderr).toMatch(/PRESERVING/);
    // Checkout released so a fresh worktree builder can RESUME on this branch.
    expect(git(fx.repo, 'worktree', 'list')).not.toContain(wt);
  });

  it('case B — clean tree, 2 commits, no PR: branch and commits survive', () => {
    const fx = makeFixture('caseB');
    const branch = 'auto-ship/TASK-482-decline-markers';
    const wt = addAgentWorktree(fx, branch);
    for (const [msg, f] of [
      ['scan reclaims decline markers', 'scan.ts'],
      ['test for the reclaim', 'scan.test.ts'],
    ]) {
      writeFileSync(join(wt, f), 'x\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', msg);
    }
    const tip = git(wt, 'rev-parse', 'HEAD');
    expect(git(wt, 'status', '--porcelain')).toBe(''); // the shape --porcelain misses

    runCleanup(fx, 'TASK-482');

    expect(localBranches(fx.repo)).toContain(branch);
    expect(git(fx.repo, 'rev-parse', `origin/${branch}`)).toBe(tip);
    expect(git(fx.repo, 'rev-list', '--count', `main..${branch}`)).toBe('2');
  });

  it('case C — clean tree, 15 commits already pushed: nothing is deleted', () => {
    const fx = makeFixture('caseC');
    const branch = 'auto-ship/TASK-498-failed-turn';
    const wt = addAgentWorktree(fx, branch);
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(wt, `f${i}.ts`), `export const a${i} = ${i};\n`);
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', `step ${i}`);
    }
    git(wt, 'push', '-q', 'origin', branch);
    git(fx.repo, 'fetch', '-q', 'origin');
    const tip = git(wt, 'rev-parse', 'HEAD');

    runCleanup(fx, 'TASK-498');

    expect(localBranches(fx.repo)).toContain(branch);
    expect(remoteBranches(fx.origin)).toContain(branch);
    expect(git(fx.repo, 'rev-parse', `origin/${branch}`)).toBe(tip);
  });

  it('case D — genuinely empty: the sweep STILL happens (branch + worktree gone)', () => {
    // The opposite failure is real: worktrees and branches piling up across a run
    // redden `pnpm lint`. A gate that never authorizes a sweep is also broken.
    const fx = makeFixture('caseD');
    const branch = 'auto-ship/TASK-999-nothing';
    const wt = addAgentWorktree(fx, branch);
    git(fx.repo, 'push', '-q', 'origin', `${branch}:${branch}`);

    const r = runCleanup(fx, 'TASK-999');

    expect(localBranches(fx.repo)).not.toContain(branch);
    expect(remoteBranches(fx.origin)).not.toContain(branch);
    expect(existsSync(wt)).toBe(false);
    expect(r.stdout).toMatch(/sweeping/);
  });

  it('a MERGED PR still sweeps, despite squash-orphaned commits reading as ahead', () => {
    // This repo squash-merges, so a shipped branch keeps commits main cannot reach.
    // Without the merged-PR lookup the gate would preserve every shipped branch and
    // the sweep would never run again.
    const fx = makeFixture('merged', ['auto-ship/TASK-500-shipped']);
    const branch = 'auto-ship/TASK-500-shipped';
    const wt = addAgentWorktree(fx, branch);
    writeFileSync(join(wt, 'shipped.ts'), '1\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'shipped work');
    expect(git(fx.repo, 'rev-list', '--count', `main..${branch}`)).toBe('1');

    runCleanup(fx, 'TASK-500');

    expect(localBranches(fx.repo)).not.toContain(branch);
    expect(existsSync(wt)).toBe(false);
  });

  it('touches no branch belonging to a different task id', () => {
    const fx = makeFixture('scoped');
    const mine = 'auto-ship/TASK-999-nothing';
    const theirs = 'auto-ship/TASK-888-someone-else';
    addAgentWorktree(fx, mine);
    const otherWt = addAgentWorktree(fx, theirs);
    writeFileSync(join(otherWt, 'their-wip.ts'), '1\n');

    runCleanup(fx, 'TASK-999');

    expect(localBranches(fx.repo)).not.toContain(mine);
    expect(localBranches(fx.repo)).toContain(theirs);
    expect(existsSync(join(otherWt, 'their-wip.ts'))).toBe(true);
  });

  it('keeps the worktree when the push fails — never a single-copy sweep', () => {
    // If the work cannot be made durable on origin, releasing the checkout is the one
    // thing that must not happen.
    const fx = makeFixture('pushfail');
    const branch = 'auto-ship/TASK-987-pushfail';
    const wt = addAgentWorktree(fx, branch);
    writeFileSync(join(wt, 'wip.ts'), 'in flight\n');
    rmSync(fx.origin, { recursive: true, force: true }); // origin unreachable

    const r = runCleanup(fx, 'TASK-987');

    expect(r.stderr).toMatch(/PRESERVE INCOMPLETE/);
    expect(localBranches(fx.repo)).toContain(branch);
    expect(existsSync(join(wt, 'wip.ts'))).toBe(true);
    expect(git(fx.repo, 'worktree', 'list')).toContain(wt);
  });
});
