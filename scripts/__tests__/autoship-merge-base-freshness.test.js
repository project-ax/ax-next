// Guard: auto-ship's merge queue re-verifies a PR against CURRENT main before merging it
// -- by RUNNING the two documented `ax-merge-freshness` blocks, not by grepping for them.
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-853).
//
// On 2026-10-04 two PRs that each passed their own CI broke main together. #918 added
// chat-orchestrator keepalive tests with a `proxy:open-session` stub; #920 made
// `proxyAuthToken` required. #920's only ci.yml run started at 16:29Z, #918 merged at
// 16:35Z, #920 merged at 17:02Z -- `git merge-tree` was clean, so the queue merged it,
// and main's full suite failed 4 keepalive tests until #924 added one stub line.
//
// The fix is a gate: the head you merge must CONTAIN origin/main (so its CI ran against
// every merged PR); if it does not, `gh pr update-branch` merges main in, CI re-runs, and
// a second block proves the update commit is nothing but a clean merge of main -- so
// the review gate's verdict on the builder's head still covers everything that lands.
//
// ---------------------------------------------------------------------------------
// WHY IT EXECUTES AGAINST REAL GIT.
//
// Both blocks decide on git's answers: `merge-base --is-ancestor`'s rc, a merge commit's
// parents, and whether its tree equals `merge-tree --write-tree` of those parents. A stub
// would only check that the doc branches on whatever the stub returned. So each case
// runs the extracted block in a throwaway clone whose `origin/main` is deliberately
// STALE until the block fetches it -- a block that skipped the fetch, or read local
// `main`, would call a stale head fresh, which is the incident.
//
// Extraction keys on the `# ax-merge-freshness: <name>` marker line and requires exactly
// one block per name, so a deleted or duplicated block reddens instead of vacuously
// passing.
//
// MUTANTS RUN against the committed doc, 2026-10-04, bash+zsh (36 tests): check reads
// local `main` -> 4 red; check drops the fetch -> 6 red; STALE arm exits 0 -> 2 red;
// verify drops the tree comparison -> 2 red (evil merge); drops the main-parent ancestry
// -> 2 red; drops its fetch -> 2 red; merge loses --match-head-commit -> 1 red. Two
// mutants SURVIVE by design, each covered by a later gate in the same block: dropping
// the parent-count check (a non-two-parent head still fails "neither parent is PRE" or
// the tree check), and dropping the record's hex check (the 40-char length check
// still rejects every non-sha record, and the value is only ever used quoted). A
// third, dropping `cat-file -e`, survived the first run (merge-base fails on a missing
// object anyway); the missing-head case now pins the actionable message, which kills it.
// ---------------------------------------------------------------------------------

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUTO_SHIP_DOC = join(REPO_ROOT, '.claude', 'skills', 'auto-ship', 'SKILL.md');

function binExists(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_ZSH = binExists('zsh');
const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])];

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

function markedBlocks(name) {
  const md = readFileSync(AUTO_SHIP_DOC, 'utf8');
  const marker = new RegExp(`^# ax-merge-freshness: ${name}\\b`, 'm');
  return bashBlocks(md).filter((b) => marker.test(b));
}

// ---------------------------------------------------------------------------------
// Fixture. A bare origin; a BUILDER clone that makes every branch and moves main; a WORK
// clone (where the blocks run) that has every branch's objects but an origin/main reset
// to the OLD main before each case, so only a real `git fetch origin main` sees the move.
// ---------------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), 'autoship-freshness-'));
const ORIGIN = join(ROOT, 'origin.git');
const BUILDER = join(ROOT, 'builder');
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
const write = (dir, file, body) => writeFileSync(join(dir, file), body);

git(ROOT, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
git(ROOT, 'init', '-q', '-b', 'main', BUILDER);
git(BUILDER, 'remote', 'add', 'origin', ORIGIN);
write(BUILDER, 'shared.md', 'line one\n');
git(BUILDER, 'add', '.');
git(BUILDER, 'commit', '-q', '-m', 'base');
git(BUILDER, 'push', '-q', 'origin', 'main');
const BASE = git(BUILDER, 'rev-parse', 'HEAD');

// The PR as the builder left it: branched from BASE, CI ran on BASE (the #920 shape).
git(BUILDER, 'checkout', '-q', '-b', 'pr', BASE);
write(BUILDER, 'pr.txt', 'the PR\n');
git(BUILDER, 'add', '.');
git(BUILDER, 'commit', '-q', '-m', 'pr work');
const PRE = git(BUILDER, 'rev-parse', 'HEAD');

// A PR that edits the line main is about to edit (needs a hand-resolved update).
git(BUILDER, 'checkout', '-q', '-b', 'cpr', BASE);
write(BUILDER, 'shared.md', 'line one -- pr\n');
git(BUILDER, 'commit', '-q', '-am', 'conflicting pr work');
const CPRE = git(BUILDER, 'rev-parse', 'HEAD');

// main moves (the #918 shape): another PR lands.
git(BUILDER, 'checkout', '-q', 'main');
write(BUILDER, 'shared.md', 'line one -- main\n');
write(BUILDER, 'main.txt', 'landed meanwhile\n');
git(BUILDER, 'add', '.');
git(BUILDER, 'commit', '-q', '-m', 'main moves');
git(BUILDER, 'push', '-q', 'origin', 'main');
const MAIN = git(BUILDER, 'rev-parse', 'HEAD');

// A clean update: what `gh pr update-branch` does -- merge main INTO the PR branch.
git(BUILDER, 'checkout', '-q', '-b', 'update', PRE);
git(BUILDER, 'merge', '-q', '--no-ff', '--no-edit', MAIN);
const UPDATE = git(BUILDER, 'rev-parse', 'HEAD');

// Same clean merge, parents in the other order (main first).
git(BUILDER, 'checkout', '-q', '-b', 'update-rev', MAIN);
git(BUILDER, 'merge', '-q', '--no-ff', '--no-edit', PRE);
const UPDATE_REV = git(BUILDER, 'rev-parse', 'HEAD');

// An evil merge: the "update" also carries a hand edit nobody reviewed.
git(BUILDER, 'checkout', '-q', '-b', 'evil', PRE);
git(BUILDER, 'merge', '-q', '--no-ff', '--no-commit', MAIN);
write(BUILDER, 'smuggled.txt', 'unreviewed\n');
git(BUILDER, 'add', '.');
git(BUILDER, 'commit', '-q', '--no-edit');
const EVIL = git(BUILDER, 'rev-parse', 'HEAD');

// A conflict resolved by hand inside the update merge.
git(BUILDER, 'checkout', '-q', '-b', 'cupdate', CPRE);
spawnSync('git', ['merge', '-q', '--no-ff', '--no-edit', MAIN], { cwd: BUILDER, env: GIT_ENV });
write(BUILDER, 'shared.md', 'line one -- resolved by hand\n');
git(BUILDER, 'add', '.');
git(BUILDER, 'commit', '-q', '--no-edit');
const CUPDATE = git(BUILDER, 'rev-parse', 'HEAD');

// A builder push AFTER the clean update.
git(BUILDER, 'checkout', '-q', '-b', 'post', UPDATE);
write(BUILDER, 'pr.txt', 'the PR, changed after review\n');
git(BUILDER, 'commit', '-q', '-am', 'late change');
const POST = git(BUILDER, 'rev-parse', 'HEAD');

// A "merge" whose other parent is NOT on main.
git(BUILDER, 'checkout', '-q', '-b', 'side', BASE);
write(BUILDER, 'side.txt', 'not main\n');
git(BUILDER, 'add', '.');
git(BUILDER, 'commit', '-q', '-m', 'side');
const SIDE = git(BUILDER, 'rev-parse', 'HEAD');
git(BUILDER, 'checkout', '-q', '-b', 'offmain', PRE);
git(BUILDER, 'merge', '-q', '--no-ff', '--no-edit', SIDE);
const OFFMAIN = git(BUILDER, 'rev-parse', 'HEAD');

const BRANCHES = ['pr', 'cpr', 'update', 'update-rev', 'evil', 'cupdate', 'post', 'offmain'];
git(BUILDER, 'push', '-q', 'origin', ...BRANCHES);

git(ROOT, 'clone', '-q', ORIGIN, WORK);

// A clone with no remote: the fetch itself fails.
const NO_REMOTE = join(ROOT, 'no-remote');
git(ROOT, 'clone', '-q', ORIGIN, NO_REMOTE);
git(NO_REMOTE, 'remote', 'remove', 'origin');

const MISSING = 'deadbeef'.repeat(5);
const PRE_FILE = (dir) => join(dir, '.git', 'auto-ship-pre-update-123');

/** Put origin/main back to the OLD main: only a real fetch can see the move. */
function staleOriginMain(dir) {
  git(dir, 'update-ref', 'refs/remotes/origin/main', BASE);
  git(dir, 'update-ref', 'refs/heads/main', BASE);
}

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

describe('base-freshness gate: the blocks exist exactly once', () => {
  it('finds exactly one `check` and one `verify-update` block', () => {
    expect(markedBlocks('check'), 'the freshness check block').toHaveLength(1);
    expect(markedBlocks('verify-update'), 'the verify-update block').toHaveLength(1);
  });

  it('zsh is present on CI, so the zsh half is not silently skipped', () => {
    if (process.env.CI) expect(HAS_ZSH, 'ci.yml installs zsh for these guards').toBe(true);
  });

  it('fixture controls: the work clone starts with a stale origin/main', () => {
    staleOriginMain(WORK);
    expect(git(WORK, 'rev-parse', 'origin/main')).toBe(BASE);
    // PRE contains the STALE origin/main -- a block that skipped the fetch says FRESH.
    const rc = spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', PRE], {
      cwd: WORK,
      env: GIT_ENV,
    }).status;
    expect(rc).toBe(0);
    // the clean update really is a clean merge; the conflicting one really conflicts
    const mt = (a, b) =>
      spawnSync('git', ['merge-tree', '--write-tree', a, b], { cwd: WORK, env: GIT_ENV });
    expect(mt(MAIN, PRE).stdout.toString().split('\n')[0]).toBe(
      git(WORK, 'rev-parse', `${UPDATE}^{tree}`),
    );
    expect(mt(MAIN, CPRE).status).toBe(1);
  });
});

for (const shell of SHELLS) {
  describe(`(${shell}) freshness check`, () => {
    const [check] = markedBlocks('check');
    beforeEach(() => {
      staleOriginMain(WORK);
      rmSync(PRE_FILE(WORK), { force: true });
    });

    it('a head built on an OLD main is BASE-STALE, exits non-zero, and records the head', () => {
      const { code, out } = run(shell, check, WORK, PRE);
      expect(out, out).toMatch(/BASE-STALE #123/);
      expect(out).not.toMatch(/BASE-FRESH/);
      expect(out, 'must say how to update, and never by rebase').toMatch(
        /gh pr update-branch 123/,
      );
      expect(code).not.toBe(0);
      expect(readFileSync(PRE_FILE(WORK), 'utf8').trim()).toBe(PRE);
    });

    it('a head that already contains origin/main is BASE-FRESH, rc 0', () => {
      const { code, out } = run(shell, check, WORK, UPDATE);
      expect(out, out).toMatch(/BASE-FRESH #123/);
      expect(out).not.toMatch(/BASE-STALE/);
      expect(code).toBe(0);
      expect(existsSync(PRE_FILE(WORK)), 'FRESH records nothing').toBe(false);
    });

    it('a failed fetch is UNDECIDED, never FRESH', () => {
      staleOriginMain(NO_REMOTE);
      const { code, out } = run(shell, check, NO_REMOTE, PRE);
      expect(out, out).toMatch(/FRESHNESS-UNDECIDED/);
      expect(out).not.toMatch(/BASE-FRESH|BASE-STALE/);
      expect(code).not.toBe(0);
    });

    it('a head missing from the clone is UNDECIDED, never STALE or FRESH', () => {
      const { code, out } = run(shell, check, WORK, MISSING);
      expect(out, out).toMatch(/FRESHNESS-UNDECIDED/);
      // The actionable reason, not merge-base's bare rc: the reader must fetch the branch.
      expect(out).toMatch(/not in this clone/);
      expect(out).not.toMatch(/BASE-FRESH|BASE-STALE/);
      expect(code).not.toBe(0);
    });

    it('an abbreviated or empty sha is UNDECIDED', () => {
      for (const bad of [UPDATE.slice(0, 8), '', 'HEAD']) {
        const { code, out } = run(shell, check, WORK, bad);
        expect(out, `${JSON.stringify(bad)}: ${out}`).toMatch(/FRESHNESS-UNDECIDED/);
        expect(out).not.toMatch(/BASE-FRESH/);
        expect(code).not.toBe(0);
      }
    });
  });

  describe(`(${shell}) verify-update`, () => {
    const [verify] = markedBlocks('verify-update');
    const [check] = markedBlocks('check');
    beforeEach(() => {
      staleOriginMain(WORK);
      writeFileSync(PRE_FILE(WORK), `${PRE}\n`);
    });

    const clean = (sha) => {
      const { code, out } = run(shell, verify, WORK, sha);
      expect(out, out).toMatch(/UPDATE-CLEAN #123/);
      expect(out).not.toMatch(/UPDATE-UNVERIFIED/);
      expect(code).toBe(0);
    };
    const unverified = (sha, why) => {
      const { code, out } = run(shell, verify, WORK, sha);
      expect(out, `${why}\n${out}`).toMatch(/UPDATE-UNVERIFIED #123/);
      expect(out).not.toMatch(/UPDATE-CLEAN/);
      expect(out, 'must route to an independent pass').toMatch(/independent pass/);
      expect(code).not.toBe(0);
    };

    it('end to end: STALE records the head, the clean update then verifies', () => {
      rmSync(PRE_FILE(WORK), { force: true });
      expect(run(shell, check, WORK, PRE).out).toMatch(/BASE-STALE/);
      clean(UPDATE);
      expect(run(shell, check, WORK, UPDATE).out).toMatch(/BASE-FRESH/);
    });

    it('a clean update with main as the FIRST parent also verifies', () => clean(UPDATE_REV));

    it('an evil merge (hand edit folded into the update) is UNVERIFIED', () =>
      unverified(EVIL, 'tree differs from a clean merge'));

    it('a hand-resolved conflict inside the update is UNVERIFIED', () => {
      writeFileSync(PRE_FILE(WORK), `${CPRE}\n`);
      unverified(CUPDATE, 'merge-tree of the parents conflicts');
    });

    it('a builder commit pushed after the update is UNVERIFIED', () =>
      unverified(POST, 'not a two-parent merge'));

    it('a merge whose other parent is not on main is UNVERIFIED', () =>
      unverified(OFFMAIN, 'merged-in parent off main'));

    it('the un-updated head itself is UNVERIFIED (nothing was merged)', () =>
      unverified(PRE, 'single parent'));

    it('a missing or garbage pre-update record is UNVERIFIED', () => {
      rmSync(PRE_FILE(WORK), { force: true });
      unverified(UPDATE, 'no record');
      writeFileSync(PRE_FILE(WORK), '$(touch PWNED)\n');
      unverified(UPDATE, 'non-hex record');
      expect(existsSync(join(WORK, 'PWNED'))).toBe(false);
      writeFileSync(PRE_FILE(WORK), `${PRE.slice(0, 8)}\n`);
      unverified(UPDATE, 'abbreviated record');
    });

    it('a failed fetch is UNVERIFIED', () => {
      staleOriginMain(NO_REMOTE);
      writeFileSync(PRE_FILE(NO_REMOTE), `${PRE}\n`);
      const { code, out } = run(shell, verify, NO_REMOTE, UPDATE);
      expect(out, out).toMatch(/UPDATE-UNVERIFIED/);
      expect(out).not.toMatch(/UPDATE-CLEAN/);
      expect(code).not.toBe(0);
    });

    it('a head missing from the clone is UNVERIFIED', () => unverified(MISSING, 'missing'));
  });
}

describe('the skill wires the gate into the merge', () => {
  const md = readFileSync(AUTO_SHIP_DOC, 'utf8');

  it('the merge command is pinned to the verified head', () => {
    const merges = md
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && /^\s*gh pr merge <n>/.test(l));
    expect(merges.length).toBeGreaterThan(0);
    for (const l of merges) expect(l).toMatch(/--match-head-commit "\$HEAD_SHA"/);
  });

  it('never tells the queue to update by rebase', () => {
    const offenders = md
      .split('\n')
      .filter((l) => /gh pr update-branch/.test(l) && /--rebase/.test(l) && !/NEVER|without/i.test(l));
    expect(offenders).toEqual([]);
  });

  it('names the motivating incident', () => {
    expect(md).toMatch(/#918/);
    expect(md).toMatch(/#920/);
  });
});
