// Guard: when the ci.yml existence gate HALTs, the documented diagnosis block tells a
// CONFLICTING head apart from one that merges cleanly -- by RUNNING it, not by grepping.
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-463).
//
// The merge gates halt when a PR head has no ci.yml run (the "partial check set": six
// CodeQL checks, all green, no `test` job, `gh pr checks` exit 0). For a month the docs
// said the CAUSE was "[INFERRED, not measured] never diagnosed", and the only remedy on
// record was "rebase-push to create one". That remedy always worked -- which is exactly
// why nobody found out why.
//
// MEASURED 2026-09-26: every PR head CodeQL analysed from 2026-08-21 to 2026-09-26 (666
// shas, from `code-scanning/analyses`, which records refs/pull/<n>/head) was checked
// against every ci.yml run in the same window. 49 heads had no ci.yml run. All 49
// conflicted with origin/main at push time -- `git merge-tree --write-tree`, rc=1,
// against the last first-parent main commit before the analysis timestamp. 611 heads
// had a run, and every one of them merged cleanly into the main it was pushed onto
// (607 directly; 3 more conflict with main-at-analysis-time, but their run was created
// 4-20 seconds BEFORE the conflicting main commit landed, and they are clean against the
// commit before it; 6 more were unfetchable). So:
//
//   no merge ref  =>  no `pull_request` event  =>  no ci.yml run,
//
// while CodeQL analyses refs/pull/<n>/head on its own trigger and reports a confident
// green. "A rebase push creates the run" because the rebase RESOLVES THE CONFLICT.
// A push that does not resolve it gets no run either (PR #603: two no-run heads 7 min
// apart, both conflicting; PR #620: f70f6f7f conflicting / runs=0, then 7dd96d1d
// resolved / runs=1 on the first poll).
//
// The converse is NOT closed by construction, only by observation: a PR opened against a
// non-main base gets no ci.yml run (ci.yml's `pull_request` filter is `branches: [main]`)
// and retargeting it with `gh pr edit --base` fires no event -- a no-run head that
// merges cleanly. None appeared in the sweep, but the doc keeps that branch and this
// file asserts it says something OTHER than "rebase-push" there, because a rebase push
// on a clean head is a wasted CI cycle that fixes nothing.
//
// ---------------------------------------------------------------------------------
// WHY IT EXECUTES AGAINST REAL GIT, NOT A STUB.
//
// The block's whole decision is `git merge-tree`'s exit code: 0 clean, 1 conflict,
// anything else an error. A stub would just assert that the doc branches on the numbers
// the stub was told to return -- it could not catch a doc that had 0 and 1 the wrong way
// round, or one that folded "error" into "clean". So each case builds a throwaway repo
// with a bare `origin`, a real conflicting branch and a real clean one, and runs the
// extracted block in it. The block also `git fetch`es origin/main first, so a removed
// remote exercises the fetch-failure path for real.
//
// `merge-tree`'s rc=1 is AMBIGUOUS, and that was found by this file's own control, not
// by reading the man page: for a head object that is not in the clone, git 2.52 prints
// "not something we can merge" and exits **1** -- the same code as a real conflict. So a
// block that branched on the rc alone would call a missing object a CONFLICT and send
// the reader to rebase a PR it never looked at (the 2026-09-26 sweep was not affected:
// it `cat-file -e`'d every head before merging). The documented block therefore checks
// that both objects exist first, and the UNDIAGNOSED cases pin that: neither a missing
// head nor a failed fetch may come out as CONFLICT or NOT-CONFLICT.
//
// MUTANTS RUN against the committed doc, 2026-09-26, bash+zsh (15 tests collected each
// time): swap the 0/1 case arms -> 4 red (conflict + clean, both shells); replace the
// `cat-file -e` check with `false` -> 2 red (missing head); replace the fetch check with
// `false` -> 2 red (failed fetch); merge-tree against local `main` instead of
// `origin/main` -> 2 red (conflicting head, because local main is stale by design).
// On a runner without zsh each figure halves.
//
// Extraction does not use a `logicalLines` helper (TASK-454: two earlier guards joined
// continuations AFTER filtering comments, which fails open). It takes the one fenced
// ```bash block whose NON-COMMENT lines call `git merge-tree`, and requires exactly one.
// ---------------------------------------------------------------------------------

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');
const AUTO_SHIP_DOC = join(SKILLS_DIR, 'auto-ship', 'SKILL.md');
const YOLO_SHIP_DOC = join(SKILLS_DIR, 'yolo-ship', 'SKILL.md');

function binExists(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const SHELLS = ['bash', ...(binExists('zsh') ? ['zsh'] : [])];

/** Every fenced ```bash block, dedented by its fence's indent. */
function bashBlocks(md) {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```bash\s*$/.exec(lines[i]);
    if (!open) continue;
    const indent = open[1];
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (new RegExp(`^${indent}\`\`\`\\s*$`).test(lines[j])) break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
    }
    out.push(body.join('\n'));
    i = j;
  }
  return out;
}

const isComment = (l) => /^\s*#/.test(l);

/** Blocks that RUN merge-tree (comment lines quoting it do not count). */
function diagnosisBlocks() {
  const md = readFileSync(AUTO_SHIP_DOC, 'utf8');
  return bashBlocks(md).filter((b) =>
    b.split('\n').some((l) => !isComment(l) && /git merge-tree --write-tree/.test(l)),
  );
}

// ---------------------------------------------------------------------------------
// A real repo with a bare origin: main, a branch that conflicts with it, one that
// merges cleanly.
// ---------------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), 'autoship-norun-diag-'));
const ORIGIN = join(ROOT, 'origin.git');
const WORK = join(ROOT, 'work');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

git(ROOT, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
git(ROOT, 'init', '-q', '-b', 'main', WORK);
git(WORK, 'remote', 'add', 'origin', ORIGIN);
writeFileSync(join(WORK, 'shared.md'), 'line one\n');
git(WORK, 'add', '.');
git(WORK, 'commit', '-q', '-m', 'base');
const BASE = git(WORK, 'rev-parse', 'HEAD');

// conflicting: edits the same line main is about to edit
git(WORK, 'checkout', '-q', '-b', 'conflicting');
writeFileSync(join(WORK, 'shared.md'), 'line one -- branch\n');
git(WORK, 'commit', '-q', '-am', 'branch edit');
const CONFLICT_SHA = git(WORK, 'rev-parse', 'HEAD');

// clean: touches a different file
git(WORK, 'checkout', '-q', BASE);
git(WORK, 'checkout', '-q', '-b', 'clean');
writeFileSync(join(WORK, 'other.md'), 'unrelated\n');
git(WORK, 'add', '.');
git(WORK, 'commit', '-q', '-m', 'clean edit');
const CLEAN_SHA = git(WORK, 'rev-parse', 'HEAD');

// main moves on the shared line, and ONLY origin knows it -- the local `main` stays at
// BASE, so a block that forgot to fetch (or read local main) would call the conflicting
// branch clean. That is the stale-main trap the merge-queue doc warns about.
git(WORK, 'checkout', '-q', BASE);
git(WORK, 'checkout', '-q', '-b', 'mover');
writeFileSync(join(WORK, 'shared.md'), 'line one -- main\n');
git(WORK, 'commit', '-q', '-am', 'main edit');
git(WORK, 'push', '-q', 'origin', 'mover:main');
git(WORK, 'checkout', '-q', 'clean');

// A 40-char sha no object in this clone has: merge-tree answers rc=128.
const MISSING_SHA = 'deadbeef'.repeat(5);

// A second clone with no `origin` remote: the fetch itself fails.
const NO_REMOTE = join(ROOT, 'no-remote');
git(ROOT, 'clone', '-q', ORIGIN, NO_REMOTE);
git(NO_REMOTE, 'remote', 'remove', 'origin');

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

function run(shell, script, cwd, headSha) {
  const r = spawnSync(shell, ['-c', script.replace(/<n>/g, '123')], {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_ENV, HEAD_SHA: headSha },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------------

describe('no-run diagnosis: conflict vs clean, executed against real git', () => {
  const blocks = diagnosisBlocks();

  it('finds exactly one diagnosis block (the cases below must not be vacuous)', () => {
    expect(
      blocks,
      'expected exactly one fenced bash block in auto-ship/SKILL.md whose non-comment ' +
        'lines run `git merge-tree --write-tree` -- the no-run diagnosis. Every case ' +
        'below runs it; zero blocks would make them all pass by not existing.',
    ).toHaveLength(1);
  });

  it('the fixture really has one conflicting and one clean head (control)', () => {
    // Without this, a fixture that accidentally made both branches clean would let a
    // block that ALWAYS says NOT-CONFLICT pass the clean case and fail only one test.
    git(WORK, 'fetch', '-q', 'origin', 'main');
    const rc = (sha) =>
      spawnSync('git', ['merge-tree', '--write-tree', 'origin/main', sha], {
        cwd: WORK,
        env: GIT_ENV,
      }).status;
    expect(rc(CONFLICT_SHA)).toBe(1);
    expect(rc(CLEAN_SHA)).toBe(0);
    // The trap the block has to step around: a MISSING head does not exit 0, and on
    // git 2.52 it exits 1 -- the same code as a real conflict.
    expect(rc(MISSING_SHA)).not.toBe(0);
    // local main is stale on purpose (see the fixture comment)
    const localRc = spawnSync('git', ['merge-tree', '--write-tree', 'main', CONFLICT_SHA], {
      cwd: WORK,
      env: GIT_ENV,
    }).status;
    expect(localRc, 'local main must NOT know about the conflicting main edit').toBe(0);
  });

  for (const shell of SHELLS) {
    it(`(${shell}) a CONFLICTING head is diagnosed as a conflict and sent to rebase`, () => {
      const [script] = blocks;
      const { out } = run(shell, script, WORK, CONFLICT_SHA);
      expect(out, `expected the conflict verdict\n${out}`).toMatch(/NO-RUN-CONFLICT/);
      expect(out).toMatch(/rebase/i);
      expect(out, 'must not also claim the head is clean').not.toMatch(/NO-RUN-NOT-CONFLICT/);
      expect(out).not.toMatch(/NO-RUN-UNDIAGNOSED/);
    });

    it(`(${shell}) a CLEAN head is NOT sent to rebase-push`, () => {
      // The converse. No conflict means a rebase push resolves nothing and costs a CI
      // cycle; the doc must point at the other known cause (a non-main base / retarget).
      const [script] = blocks;
      const { out } = run(shell, script, WORK, CLEAN_SHA);
      expect(out, `expected the not-a-conflict verdict\n${out}`).toMatch(
        /NO-RUN-NOT-CONFLICT/,
      );
      expect(out).not.toMatch(/NO-RUN-CONFLICT\b/);
      expect(out, 'a clean head must not be told to rebase-push').toMatch(
        /will NOT help|not help/i,
      );
      expect(out, 'must name the base-branch cause').toMatch(/base/i);
    });

    it(`(${shell}) a head missing from the clone is UNDIAGNOSED, never a verdict`, () => {
      // merge-tree exits 1 for a missing object -- the same code as a conflict -- so
      // the block must notice the missing object BEFORE it reads the rc, or it reports
      // a conflict nobody measured.
      const [script] = blocks;
      const { out } = run(shell, script, WORK, MISSING_SHA);
      expect(out, `expected UNDIAGNOSED\n${out}`).toMatch(/NO-RUN-UNDIAGNOSED/);
      expect(out).not.toMatch(/NO-RUN-NOT-CONFLICT|NO-RUN-CONFLICT\b/);
    });

    it(`(${shell}) a failed fetch is UNDIAGNOSED -- a stale origin/main decides nothing`, () => {
      const [script] = blocks;
      const { code, out } = run(shell, script, NO_REMOTE, CONFLICT_SHA);
      expect(out, `expected UNDIAGNOSED on fetch failure\n${out}`).toMatch(
        /NO-RUN-UNDIAGNOSED/,
      );
      expect(out).not.toMatch(/NO-RUN-NOT-CONFLICT|NO-RUN-CONFLICT\b/);
      expect(code, 'a fetch failure must exit non-zero').not.toBe(0);
    });
  }
});

describe('the docs name the measured cause, not the retired inference', () => {
  for (const path of [AUTO_SHIP_DOC, YOLO_SHIP_DOC]) {
    const name = path.split('/').slice(-2).join('/');

    it(`${name} no longer says the cause was never diagnosed`, () => {
      const md = readFileSync(path, 'utf8');
      expect(
        md,
        'TASK-463 measured the cause (49/49 no-run heads conflicted with main). ' +
          'Leaving "never diagnosed" next to the gate sends the next reader to ' +
          'rebase-push without checking why.',
      ).not.toMatch(/cause was never\s+diagnosed|CAUSE was never\s+diagnosed/i);
    });

    it(`${name} names the conflict as the measured cause, with its numbers`, () => {
      const md = readFileSync(path, 'utf8');
      expect(md).toMatch(/no merge ref/i);
      expect(md, 'the sweep figure is the evidence; keep it at the rule').toMatch(/49/);
    });
  }

  it('auto-ship/SKILL.md keeps UNKNOWN as "ask merge-tree", and says it settles', () => {
    const md = readFileSync(AUTO_SHIP_DOC, 'utf8');
    const idx = md.search(/UNKNOWN/);
    expect(idx).toBeGreaterThan(-1);
    const near = md.slice(idx, idx + 600);
    expect(near).toMatch(/merge-tree/);
    expect(near).toMatch(/re-read|settles/i);
  });
});
