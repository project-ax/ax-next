// Guard: yolo-ship Phase 5 scopes the reviewer's diff range with `origin/main`, never a
// bare local `main`.
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-452).
//
// Phase 5 used to say, in prose: "review the whole-branch diff against `main`
// (merge-base `main...HEAD`) … name the diff range explicitly (`git diff main...HEAD`)".
//
// In a dispatched worktree that range is wrong. `git worktree add <path> -b <branch>
// origin/main` bases the branch on `origin/main` and leaves the shared checkout's `main`
// ref exactly where it stood; nothing in the skill ever moves it. Under parallel drain
// `main` advances several times an hour, so `main...HEAD` resolves its merge-base to a
// stale commit and hands the reviewer every PR merged since as part of the diff.
//
// Six independent sightings on 2026-09-19, all measured:
//
//   - PR #599's reviewer: the range pulled in 5 already-merged PRs (~50 files) against a
//     real delta of 10. It re-scoped itself, which is luck, not a control.
//   - TASK-399's reviewer did a partial pass over 4 unrelated merged PRs before anyone
//     noticed.
//   - TASK-402 measured local `main` 4 PRs stale: 16 files / 1300 lines reported against
//     a real delta of 5 files / 262. (Also on file: `.claude/memory/mistakes.md`.)
//   - Both of those builders, plus this repo's auto-memory, asked for the same two-word
//     fix independently.
//
// Reproduced from scratch here rather than taken on trust, in the fixtures below
// (git 2.52.0): a branch whose own delta is 2 files, with 3 PRs merged upstream after the
// branch point, reports 2 files for `origin/main...HEAD` and **5** for `main...HEAD`.
//
// A CORRECTION TO THE CARD, since a brief is a hypothesis. The card implies a `git fetch`
// is needed for correctness. It is not: `A...B` resolves through the merge-base, and your
// branch point cannot be newer than the `origin/main` already on disk, so the range is
// right with or without one.
//
// What the tests below actually PROVE about that is fetch-INDEPENDENCE, and the difference
// is worth stating rather than blurring: `stale` (a working fetch) and `brokenRemote` (a
// fetch that fails outright) both answer 2 files. That the fetch moves the ref at all is a
// separate fact, measured by hand on git 2.52.0 — `refs/remotes/origin/main` advanced by
// one commit — and independently re-measured during review. It is NOT asserted anywhere
// here, and nothing in this file would notice if a future git stopped doing it.
//
// So the fetch earns its place only by keeping the printed range in parity with the surface
// GitHub shows on the PR, the block says exactly that and no more, and that is why a failed
// fetch is a note rather than a fatal: the range it leaves behind is still correct.
//
// ---------------------------------------------------------------------------------
// WHY THIS GUARD EXECUTES THE SNIPPET RATHER THAN GREPPING THE PROSE.
//
// TASK-392's lesson, restated by this card: a text scan for the right words passes
// against a doc that says them and branches on nothing. "Mentions `origin/main`" is
// satisfied by a paragraph sitting above an unchanged command — and this doc's own prose
// quotes the BROKEN range half a dozen times, on purpose, because it is explaining it.
//
// So the fix is not prose. Phase 5 now carries a fenced, runnable pre-dispatch block that
// binds the range, prints `git diff --stat` and the commit list, and refuses to guess when
// `origin/main` is missing. The tests below extract that block and RUN it, under bash AND
// zsh, against real throwaway git repositories built to the shape above. The doc is the
// single implementation; there is no second copy in a script for it to drift from.
// Modelled on `autoship-ci-run-lookup-full-sha.test.js` and
// `autoship-triage-title-draft-id.test.js`, which pin other runnable blocks the same way.
//
// WHAT THIS FILE DOES **NOT** VERIFY, stated rather than implied away. The sibling edits
// in `.claude/skills/auto-ship/SKILL.md` (the orchestrator's independent-pass range) and
// `.claude/agents/ax-code-reviewer.md` (the reviewer's own default range) are prose inside
// sentences, with no runnable snippet to execute. They are held only by the text
// consistency check at the bottom of this file, which is weaker on purpose and labelled as
// such. The executable core is the yolo-ship block, which is the one an agent actually
// runs.
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-19; each applied to the committed text and
// executed, then restored; baseline 20 passed on a machine with zsh, git 2.52.0). Every
// mutant still COLLECTS 20 — the number to distrust is a red count that arrives with a
// shrunken total.
//
// The sibling card #610 got burned on exactly this: it reported a 3-red mutant that was
// really 7-red, because it had spliced an artificial line into the mutant instead of
// restoring the previous version. A mutant's CONSTRUCTION is a claim as much as its count
// is, so each one below says which kind it is.
//
//   M1. RESTORED VERBATIM — `git show origin/main:.claude/skills/yolo-ship/SKILL.md >`
//       the file, i.e. the pre-fix text exactly as it stands on `main`, where the range is
//       prose saying `git diff main...HEAD` and `rangeBlocks` finds NO block (that file
//       does carry two bash blocks, in Phases 6 and 7; neither runs `git diff`)
//       -> **18 red of 20**. `BLOCK` is undefined, `runBlock` throws by design naming the
//       reason, and the 14 behavioural cases red out with the extraction guard, both
//       block-structure checks, and the text-consistency check (on the literal
//       `git diff main...HEAD`). The two survivors are `states its shell coverage` and
//       `logicalLines keeps a command a comment tried to swallow` — neither reads the doc. This is the mutant the card asks for: the guard fails against
//       the skill text as it stands on `main`. (Independently re-derived during review
//       from `rangeBlocks` against the pre-fix text: 0 blocks found, head 1.)
//   M2. CONSTRUCTED, one token: keep the whole block, change `RANGE="origin/main...HEAD"`
//       to `RANGE="main...HEAD"` -> **11 red of 20**. The plausible future regression —
//       someone "simplifies" the range while every word of the surrounding prose argues
//       against them. 10 behavioural (`excludes PRs merged after the branch point`,
//       `prints a --stat and the exact range`, `flags an oversized range`, `failed
//       fetch`, `empty range` x 2 shells) plus the `no bare-main range endpoint`
//       structure check. `lists the commits in range` stays GREEN, because the commit
//       list is a separate `origin/main..HEAD` that M2 does not touch — which is
//       precisely why it is a separate test rather than another assertion in the first.
//   M3. CONSTRUCTED: delete the `git rev-parse --verify --quiet origin/main` guard
//       -> **2 red**, `missing origin/main is FATAL` x 2 shells. Without it the block
//       computes a range against a ref that does not exist, and the reader gets git's
//       message instead of the skill's instruction NOT to fall back to `main`.
//   M4. CONSTRUCTED: delete the `git diff --stat "$RANGE"` line -> **4 red**: `prints a
//       --stat` AND `excludes PRs merged after the branch point`, x 2 shells. The second
//       pair is a real coupling worth naming rather than tidying away: `--stat` is the
//       only thing that prints file NAMES, so without it the "no merged-*.txt in range"
//       assertions have nothing to match against and would pass vacuously — they are
//       held shut by the `mine.txt` presence assertion beside them, which is the
//       fail-CLOSED direction. (This mutant first measured 15 red, because the block
//       extractor was keyed on `git diff --stat`; see `rangeBlocks`.)
//   M5. CONSTRUCTED: pipe the binding, `FILES=$(git diff --name-only "$RANGE" | cat)`
//       -> **1 red**, the `pipes no git invocation` structure check, and nothing else.
//       Deliberately the shape no behavioural test here can see: a pipe launders git's
//       exit status, so a FAILED diff reports "0 files", which is a plausible-looking
//       number. #610 shipped this exact defect one line under the comment forbidding it.
//   M6. CONSTRUCTED: raise the oversize threshold from 25 to 1000 -> **2 red**, `flags an
//       oversized range` x 2 shells.
//   M7. CONSTRUCTED, and it SURVIVED the first version of this file — replace the
//       `printf | grep -c` count with a second, piped `N=$(git diff --name-only "$RANGE"
//       | wc -l | tr -d " ")` -> **GREEN on every test**, then **1 red** once the
//       structure check was fixed. The check used `.find()` on `git diff --name-only`, so it pinned the
//       block's first (correct, unpiped) binding and never looked at the piped line added
//       below it. Behaviourally the two counts agree whenever git succeeds, so nothing
//       else could see it either. The lesson generalises past this file: **a structural
//       check that inspects one occurrence is a check on that occurrence, not on the
//       property.** It now scans every `git` line in the block.
//   M8. CONSTRUCTED, and it is a mutant of this FILE rather than of the doc: put
//       `logicalLines` back to join-continuations-then-filter-comments, the original triage
//       guard's order -> **1 red**, `logicalLines keeps a command a comment tried to
//       swallow`. Found in review, and the same lesson as M7 one layer down: the helper
//       every structural check reads through could DELETE a command line before the check
//       ever saw it. See `logicalLines` for the measured shape.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally — no
// network, no Docker, no build. Every git repository it touches is created under a
// temp dir and removed afterwards; it never runs git against this repository.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YOLO_SKILL = join(REPO_ROOT, '.claude', 'skills', 'yolo-ship', 'SKILL.md');
const AUTOSHIP_SKILL = join(REPO_ROOT, '.claude', 'skills', 'auto-ship', 'SKILL.md');
const REVIEWER_AGENT = join(REPO_ROOT, '.claude', 'agents', 'ax-code-reviewer.md');

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

// ---------------------------------------------------------------------------------
// Extracting the runnable shell out of the doc.
// ---------------------------------------------------------------------------------

/**
 * Every fenced ```bash block in `md`, dedented by the fence's own indent.
 *
 * Same rule, and the same duplication-rather-than-sharing decision, as
 * `autoship-ci-run-lookup-full-sha.test.js` and `autoship-triage-title-draft-id.test.js`:
 * a block nested in a bullet carries leading spaces, and dedenting by the fence's own
 * indent handles nested and top-level blocks with one rule. A shared helper module would
 * be a third thing to keep in step with three pinned subjects in two different docs.
 */
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

/**
 * A block's lines with whole-line comments dropped and `\`-continuations joined.
 *
 * **In that order.** The original triage guard joined continuations first and filtered
 * comments second, and that is fail-OPEN here: a comment line ending in a backslash
 * absorbs the line below it. The joined result starts with `#` and is dropped — so a real
 * command DISAPPEARS from the scan. Measured during review on exactly the shape that matters:
 *
 *     # a note \
 *     N=$(git diff --name-only "$R" | wc -l)
 *
 * The old order returned NEITHER line, so the piped `git` was invisible to the check —
 * while both bash and zsh happily RUN it, because a `#` comment does not continue across a
 * backslash. Filtering first cannot lose code that way: a dropped comment takes nothing
 * with it, and a genuine `\`-continuation between two code lines still joins.
 *
 * Pinned by `logicalLines keeps a command a comment tried to swallow` below.
 */
function logicalLines(block) {
  return block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n');
}

/**
 * Phase 5's pre-dispatch range block: the only fenced block in yolo-ship/SKILL.md that
 * runs `git diff` at all (Phases 6 and 7 carry `gh` and `git checkout`/`push` blocks).
 *
 * Located by `git diff`, and by nothing narrower, for two separate reasons.
 *
 * It must not key on `origin/`, or the extractor would vanish the moment the fix is
 * reverted and every execution test would pass by iterating nothing — the precise failure
 * the sibling guard's header records as its own mutant #1.
 *
 * It must also not key on anything a single test OWNS, which cost a round here: the
 * locator was `git diff --stat`, so deleting the `--stat` line — the mutant for the
 * `prints a --stat` test — un-found the whole block and reddened 15 instead of 2. A
 * locator that overlaps a subject turns every mutant of that subject into an extraction
 * failure, which is loud but tells you the wrong thing. Measured before and after: 15 red,
 * then 2.
 */
function rangeBlocks(md) {
  return bashBlocks(md).filter((b) => logicalLines(b).some((l) => /git diff/.test(l)));
}

const BLOCKS = rangeBlocks(readFileSync(YOLO_SKILL, 'utf8'));
const BLOCK = BLOCKS.length === 1 ? BLOCKS[0] : undefined;

// ---------------------------------------------------------------------------------
// The fixtures: real, throwaway git repositories.
// ---------------------------------------------------------------------------------

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'yolo-ship-range-'));

afterAll(() => {
  // Several small repos; leaving them would be litter on a long-lived runner but is
  // otherwise harmless, so removal is best-effort.
  try {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * A git environment fully isolated from the machine's own config.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at /dev/null so a developer's
 * `commit.gpgsign`, `init.defaultBranch` or any hook path cannot reach these repos;
 * `GIT_TERMINAL_PROMPT=0` so the deliberately-broken remote fails instead of asking for
 * credentials; `GIT_PAGER=cat` so `git log` never tries to page.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

/**
 * Build the shape that produces the bug, as a pair of repositories:
 *
 *   upstream: base -> "upstream: PR a" -> "PR b" -> "PR c"   (and later "PR d")
 *   work:     cloned at `base`, so its LOCAL `main` stays pinned there forever;
 *             `origin/main` fetched to `PR c`; branch `feature` cut from `origin/main`
 *             and carrying one commit of its own.
 *
 * That is the dispatched-worktree shape exactly: the branch point is current, the local
 * `main` ref is not, and nothing will ever move it. `origin/main...HEAD` is the branch's
 * own delta; `main...HEAD` additionally sweeps in PRs a/b/c.
 *
 * `extraFiles` inflates the branch's own commit, for the oversize-warning case.
 * `ownCommit: false` leaves the branch sitting exactly on `origin/main`, for the
 * empty-range case.
 */
function makeFixture(name, { extraFiles = 0, ownCommit = true } = {}) {
  const dir = join(FIXTURE_ROOT, name);
  const upstream = join(dir, 'upstream');
  const work = join(dir, 'work');

  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', upstream], { env: GIT_ENV });
  writeFileSync(join(upstream, 'base.txt'), 'base\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-qm', 'base');

  execFileSync('git', ['clone', '-q', upstream, work], { env: GIT_ENV });

  // Three PRs merged into origin/main AFTER this checkout's `main` was last updated.
  for (const p of ['a', 'b', 'c']) {
    writeFileSync(join(upstream, `merged-${p}.txt`), `${p}\n`);
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-qm', `upstream: PR ${p}`);
  }
  git(work, 'fetch', '-q', 'origin');

  git(work, 'switch', '-q', '-c', 'feature', 'origin/main');
  if (ownCommit) {
    writeFileSync(join(work, 'mine.txt'), 'mine\n');
    writeFileSync(join(work, 'base.txt'), 'base\nchanged\n');
    for (let i = 0; i < extraFiles; i++) {
      writeFileSync(join(work, `mine-${String(i).padStart(2, '0')}.txt`), `${i}\n`);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'mine: the only commit this card wrote');
  }

  // One more PR lands upstream AFTER the branch was cut and is NOT fetched, so the block's
  // own fetch has something real to pick up. Note what this does and does not establish:
  // the tests assert the ANSWER, which is the same whether the fetch runs or fails, so
  // they prove fetch-independence. That the fetch advances the ref is measured by hand
  // (see the header) and is not asserted here.
  writeFileSync(join(upstream, 'merged-d.txt'), 'd\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-qm', 'upstream: PR d');

  return work;
}

const FX = {
  /** The ordinary case: 2 files of real delta, 3 merged PRs sitting behind local `main`. */
  stale: makeFixture('stale'),
  /** 32 files of real delta, to exercise the oversize warning. */
  big: makeFixture('big', { extraFiles: 30 }),
  /** Same as `stale`, but `origin`'s URL is broken so the block's fetch fails. */
  brokenRemote: makeFixture('broken-remote'),
  /** A repo with a local `main` and no `origin/main` at all. */
  noOrigin: makeFixture('no-origin'),
  /** A branch sitting exactly on `origin/main`: the range is legitimately empty. */
  empty: makeFixture('empty', { ownCommit: false }),
};

git(FX.brokenRemote, 'remote', 'set-url', 'origin', join(FIXTURE_ROOT, 'does-not-exist'));
git(FX.noOrigin, 'remote', 'remove', 'origin');
git(FX.noOrigin, 'update-ref', '-d', 'refs/remotes/origin/main');

/**
 * Run the extracted block in a fixture and hand back its combined output.
 *
 * spawnSync rather than execFileSync so a non-zero exit is data: the block exits 1 on its
 * FATAL arms, and a helper that threw would make "the block refused loudly" hard to tell
 * apart from "the test crashed". The explicit throw on a missing BLOCK is the other half —
 * without it, `spawnSync(shell, ['-c', undefined])` fails in a way that names nothing.
 */
function runBlock(shell, cwd) {
  if (BLOCK === undefined) {
    throw new Error(
      `no runnable pre-dispatch range block in ${YOLO_SKILL} (found ${BLOCKS.length}). ` +
        'Phase 5 must carry exactly one fenced bash block running `git diff --stat`; ' +
        'prose naming a range is not executable and is what this guard exists to reject.',
    );
  }
  const r = spawnSync(shell, ['-c', BLOCK], { cwd, encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------------

describe('yolo-ship Phase 5 scopes the reviewer range with origin/main (TASK-452)', () => {
  it('extracts exactly one runnable pre-dispatch range block (the suite must not be vacuous)', () => {
    // Every execution test below runs BLOCK. If extraction breaks — or if the block is
    // removed and Phase 5 goes back to naming a range in prose — this failure has to be
    // the loud one rather than a silently empty iteration.
    expect(
      BLOCKS.length,
      'expected exactly one fenced bash block in .claude/skills/yolo-ship/SKILL.md ' +
        'that runs `git diff --stat` (Phase 5 › "Before you dispatch: scope the range"). ' +
        'Either the block is missing, or a second one appeared and both now need this guard.',
    ).toBe(1);
    expect(BLOCK, 'the block must bind a RANGE the dispatch prompt can quote').toMatch(
      /RANGE=/,
    );
  });

  it('uses no bare-`main` range endpoint anywhere in the block', () => {
    // The structural companion to the behavioural tests: it names the CAUSE. A
    // behavioural failure says "the range contained a file you never touched"; this says
    // which token did it. Every `main..`/`main...` in the runnable lines must be reached
    // through `origin/`. Prose elsewhere in the doc is free to quote the broken form —
    // it spends four paragraphs explaining it — which is exactly why this scan is scoped
    // to the block's own logical lines and not to the file.
    expect(BLOCK, 'no block to scan').toBeTruthy();
    const offenders = [];
    for (const line of logicalLines(BLOCK)) {
      for (const m of line.matchAll(/([\w./@{}-]*)main(\.\.\.?)/g)) {
        if (!m[1].endsWith('origin/')) offenders.push(line.trim());
      }
    }
    expect(
      offenders,
      'a bare local `main` is used as a range endpoint. In a dispatched worktree that ' +
        'ref is a snapshot nothing updates, so the range silently grows by every PR ' +
        'merged since the worktree was created.',
    ).toEqual([]);
  });

  it('logicalLines keeps a command a comment tried to swallow', () => {
    // Regression test for the helper's own bug, found in review. The original triage guard
    // joined `\`-continuations BEFORE dropping comments, so a comment line ending in a
    // backslash absorbs the command below it and the joined line is then thrown away as a
    // comment. Both shells run that command — `#` does not continue across a backslash —
    // so the pipe check above would scan a block it had silently shortened.
    //
    // Against the old order this returns neither line and both assertions fail.
    const lines = logicalLines('# a note \\\nN=$(git diff --name-only "$R" | wc -l)\nx=1');
    expect(
      lines.some((l) => /git diff --name-only/.test(l)),
      'a comment ending in a backslash swallowed the command under it, so the scans ' +
        'below would never see that line — while bash and zsh both execute it.',
    ).toBe(true);
    // The genuine continuation case still has to work, or the fix trades one hole for
    // another: two CODE lines joined by a backslash must come back as one logical line.
    // Whitespace-insensitive on purpose: how many spaces the join leaves behind is an
    // artifact, and pinning it would make this test fail for a reason nobody cares about.
    const joined = logicalLines('git diff \\\n  --stat "$R"');
    expect(joined).toHaveLength(1);
    expect(joined[0].replace(/\s+/g, ' ')).toBe('git diff --stat "$R"');
  });

  it('pipes no git invocation in the block, so every exit status is git\'s own', () => {
    // Not this card's bug; it is the one the sibling card #610 introduced one line under
    // its own comment forbidding it, and it rides in this very block. `git diff
    // --name-only … | wc -l` answers "0 files" for a diff that FAILED, and 0 is a
    // plausible-looking number no behavioural test here can tell apart from a genuinely
    // empty range.
    //
    // EVERY git line, not the first one that matches. The earlier version of this check
    // used `.find()` on `git diff --name-only`, which pinned the block's first (correct,
    // unpiped) binding and never looked further — a mutant that ADDED a piped
    // `git diff --name-only … | wc -l` count below it passed the whole suite, 19/19.
    // A structural check that inspects one occurrence is a check on that occurrence, not
    // on the property.
    expect(BLOCK, 'no block to scan').toBeTruthy();
    const gitLines = logicalLines(BLOCK).filter((l) => /\bgit\s/.test(l));
    expect(gitLines.length, 'the block runs no git at all').toBeGreaterThanOrEqual(4);
    expect(
      gitLines.filter((l) => /\|/.test(l.replace(/\|\|/g, ''))),
      'a git call in the block is piped, so `$?` belongs to the pipeline tail rather ' +
        'than to git — a failed call then reports a plausible-looking answer instead of ' +
        'failing.',
    ).toEqual([]);
  });

  it('states its shell coverage out loud rather than skipping silently', () => {
    // The Bash tool on the maintainer's machine runs zsh, so this block is executed by
    // zsh in real life; zsh is not guaranteed on a CI runner, so that arm is conditional
    // and this test says which arms exist. Unlike the sibling triage guard this file
    // needs no jq — only git, which the checkout step already guarantees.
    expect(SHELLS).toContain('bash');
    expect(SHELLS).toEqual(HAS_ZSH ? ['bash', 'zsh'] : ['bash']);
  });

  for (const shell of SHELLS) {
    it(`${shell}: the range excludes PRs merged after the branch point`, () => {
      const { out } = runBlock(shell, FX.stale);
      expect(
        out,
        'the range is not the branch\'s own delta. The fixture branch touches exactly ' +
          'two files; anything more means the merge-base resolved to the stale local ' +
          '`main` and swept in the PRs merged after this checkout last updated it.',
      ).toMatch(/files in range: 2$/m);
      expect(out, 'the branch\'s own file is missing from the range').toMatch(/mine\.txt/);
      for (const p of ['a', 'b', 'c']) {
        expect(
          out,
          `merged-${p}.txt is an already-merged sibling PR and must not be in the ` +
            "reviewer's range — a finding reported against it reads as \"this PR broke it\".",
        ).not.toMatch(new RegExp(`merged-${p}\\.txt`));
      }
    });

    it(`${shell}: lists the commits in range, and they are only the branch's own`, () => {
      const { out } = runBlock(shell, FX.stale);
      expect(out, 'no commit list was printed').toMatch(/commits in range:/);
      expect(out).toMatch(/mine: the only commit this card wrote/);
      expect(
        out,
        'an already-merged upstream commit is listed as part of this branch. The commit ' +
          'subjects are the cheapest tell there is: a subject you did not write means ' +
          'the range is wrong, before you have read a single hunk.',
      ).not.toMatch(/upstream: PR /);
    });

    it(`${shell}: prints a --stat and the exact range it wants pasted`, () => {
      const { out } = runBlock(shell, FX.stale);
      expect(
        out,
        'no `reviewer range:` line — the dispatch prompt has nothing to copy, and a ' +
          'retyped range is how this bug got in.',
      ).toMatch(/reviewer range: origin\/main\.\.\.HEAD/);
      expect(
        out,
        'no `git diff --stat` summary. The whole point of the pre-dispatch check is that ' +
          'an oversized range is visible NOW rather than discovered mid-review.',
      ).toMatch(/\d+ files? changed/);
    });

    it(`${shell}: flags an oversized range, and stays quiet on an ordinary one`, () => {
      const big = runBlock(shell, FX.big);
      expect(big.out).toMatch(/files in range: 32$/m);
      expect(
        big.out,
        '32 files went past the pre-dispatch check without a word. Both builders who hit ' +
          'this asked for the size to be surfaced at dispatch time.',
      ).toMatch(/is large for one card/);

      const ordinary = runBlock(shell, FX.stale);
      expect(
        ordinary.out,
        'a 2-file range was flagged as large — a warning that always fires is noise, and ' +
          'noise is how the real one gets skimmed past.',
      ).not.toMatch(/is large for one card/);
    });

    it(`${shell}: a failed fetch is a note, not a wrong answer and not a fatal`, () => {
      // origin's URL points at nothing. `origin/main` is still on disk from the clone,
      // and it is still no older than the branch point — so the range stays correct and
      // the block must carry on. The note exists so a reader knows the printed range may
      // lag what GitHub will show, which is the only thing the fetch actually buys.
      const { out } = runBlock(shell, FX.brokenRemote);
      expect(out, 'a failed fetch passed silently').toMatch(/note: fetch failed/);
      expect(
        out,
        'the block gave up on a failed fetch, or fell back to a range it could still ' +
          'have computed correctly from the origin/main already on disk.',
      ).toMatch(/files in range: 2$/m);
      expect(out).not.toMatch(/merged-a\.txt/);
    });

    it(`${shell}: an empty range reports 0 files rather than tripping over grep`, () => {
      // `grep -c` EXITS 1 when it matches nothing. The block consumes its stdout, not its
      // status, so an empty range must come out as a plain `files in range: 0` — no FATAL,
      // no spurious oversize warning, and a zero exit. Worth pinning because an `|| exit`
      // on the count, or a `set -e` at the top, each turns a legitimately empty range into
      // a failure — and this is the ONLY fixture that can see either, since every other
      // one has a non-empty range where `grep -c` exits 0 and the mutation stays invisible.
      //
      // It does NOT cover swapping the count for `git diff --name-only | wc -l`: for a
      // genuinely empty range that answers 0 too, which is correct. That variant only lies
      // when the diff FAILS, and it is the structural pipe check above that catches it.
      const { out, code } = runBlock(shell, FX.empty);
      expect(out, 'an empty range was not reported as empty').toMatch(
        /files in range: 0$/m,
      );
      expect(out, 'an empty range produced a FATAL').not.toMatch(/FATAL/);
      expect(out, 'an empty range was flagged as oversized').not.toMatch(
        /is large for one card/,
      );
      expect(code, 'grep -c exiting 1 on zero matches leaked into the block\'s status').toBe(
        0,
      );
    });

    it(`${shell}: a missing origin/main is FATAL, never a quiet fall back to main`, () => {
      // The one case where there is no right answer. Falling back to `main` here is
      // precisely the bug, so the block has to stop and say so rather than produce a
      // number that looks like every other run's.
      const { out, code } = runBlock(shell, FX.noOrigin);
      expect(out, 'the block did not refuse an unscopeable range').toMatch(
        /FATAL: no origin\/main/,
      );
      expect(
        out,
        'the block printed a file count with no origin/main to scope it against.',
      ).not.toMatch(/files in range:/);
      expect(code, 'a FATAL that exits 0 is not a FATAL').not.toBe(0);
    });
  }

  it('no sibling instruction still spells a bare-`main` diff base', () => {
    // The weak one, and labelled so. `.claude/skills/auto-ship/SKILL.md` and
    // `.claude/agents/ax-code-reviewer.md` carry the same instruction as prose inside a
    // sentence — there is no snippet to execute, so this is a text scan and it inherits
    // every limitation a text scan has. It is a negative assertion on one exact command
    // spelling, which is the shape a text scan is least bad at: it cannot be satisfied by
    // a paragraph that merely says the right words nearby.
    for (const path of [YOLO_SKILL, AUTOSHIP_SKILL, REVIEWER_AGENT]) {
      const text = readFileSync(path, 'utf8');
      expect(
        text.match(/git diff\s+(?:--\S+\s+)*main\.\.\.?/g),
        `${path} instructs a diff against a bare local \`main\`. In any worktree that ref ` +
          'is a snapshot nothing updates; use `origin/main`.',
      ).toBeNull();
    }
    expect(
      readFileSync(REVIEWER_AGENT, 'utf8'),
      'the reviewer agent no longer names the range it should default to, so an ' +
        'under-specified dispatch has nothing to fall back on.',
    ).toMatch(/origin\/main\.\.\.HEAD/);
  });
});
