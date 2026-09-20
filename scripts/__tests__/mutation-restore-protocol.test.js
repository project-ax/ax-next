// Guard: the mutation-restore protocol in `yolo-ship` Phase 4 is RUNNABLE and correct,
// and the code-lane dispatch prompt carries it.
//
// ---------------------------------------------------------------------------------
// WHY THIS EXISTS (TASK-468).
//
// Mutation testing is now standard practice on this board — nearly every card dispatched
// asks the builder to "revert the fix, watch it go red, restore". Writing the mutant is
// safe. **Putting the file back is where the damage has happened** — five measured
// instances on 2026-09-18/19, in four distinct shapes, across two restore mechanisms (a
// file copy, and `git checkout --`), each reported first-hand by the agent it happened to:
//
//   1. A builder restored a mutated file FROM A FILE COPY and silently reverted a fix
//      another agent had COMMITTED to the same worktree in between (TASK-406). Caught only
//      because a checksum moved underneath it; the clobber never reached a commit.
//   2. A REVIEWER SUBAGENT SHARES THE BUILDER'S WORKTREE, and its `git checkout -- <file>`
//      silently reverted SIX of the builder's uncommitted edits. The builder then debugged
//      the reviewer's mutant as its own code. (TASK-471 owns the reviewer-side dispatch
//      protocol; this guard owns the per-role rule underneath it.)
//   3. Two builders, independently, lost work to `git checkout -- <path>` because it
//      reverts the WHOLE FILE, not just the mutation — one a 25-line comment, one its
//      entire uncommitted fix.
//   4. One reviewer, handed the hazard in its brief, restored from its own copy and kept
//      `git status --porcelain` clean before, between and after every mutation.
//
// Shapes (1)-(3) are why the remedy prescribed after (1) — "use `git checkout --`" — is
// only half an answer: it is the RECOMMENDED restore for the agent that owns the worktree
// and committed first, and the DESTRUCTIVE one for anyone else sharing the tree. The rule
// that reconciles them is the precondition, not the command:
//
//     `git checkout -- <path>` restores exactly what you mutated and nothing else IF AND
//     ONLY IF that path was committed-clean before you mutated it.
//
// "Commit before you mutate" is how the OWNER satisfies that precondition, and from the
// owner's chair it covers all four shapes. It is the wrong instruction for a subagent in
// a tree it does not own, which may neither commit someone else's work-in-progress nor
// restore over it. Hence two roles, one precondition. (4) shows the behaviour is achievable
// — but it only happened because a human typed it into that brief by hand, which is the
// defect this card fixes: `MEASURED-BY-PROBE` 2026-09-19, the dispatch template contained
// no `git checkout --` text at all, so the rule was reaching builders only as an
// orchestrator habit.
//
// ---------------------------------------------------------------------------------
// WHY THIS GUARD EXECUTES THE BLOCKS RATHER THAN GREPPING THE PROSE.
//
// TASK-392's lesson: a text scan for the right words passes against a doc that says them
// and branches on nothing. It is especially hollow here, because the doc's prose QUOTES
// both dangerous commands on purpose — file copies and bare `git checkout --` — in order
// to explain them. "Mentions `git checkout --`" is satisfied by the broken text.
//
// So the fix is not prose. Phase 4 carries two fenced, runnable blocks, marked
// `# ax-mutation-restore: precondition` and `# ax-mutation-restore: restore`. The tests
// below EXTRACT those blocks and RUN them, under bash (and under zsh when the machine has
// it — see below) against throwaway git repositories built to THREE of the four shapes
// above: shapes (2) and (3) share the dirty-path fixture, and shape (4) is the *absence*
// of a failure, so it has no fixture at all. The doc is the single
// implementation; there is no second copy in a script for it to drift from. Modelled on
// `yolo-ship-review-range-origin-main.test.js`, which pins Phase 5's block the same way.
//
// WHAT THIS FILE DOES **NOT** VERIFY, stated rather than implied away:
//
//   - It cannot make a restore protocol safe against a SECOND WRITER touching the path
//     during the mutation window. Nothing can; the fix for that is one writer per window,
//     which is TASK-471's scope. What `restore keeps a commit that landed during the
//     window` does pin is the part that IS in this card's control: the restore target is
//     the index/HEAD, so a commit that lands during the window survives — and the same
//     fixture run through a file copy loses it.
//   - **The zsh half does not run in CI.** `SHELLS` is `['bash', ...zsh if present]`, and
//     the GitHub runner has no zsh, so it collects materially fewer tests than a macOS
//     machine does — roughly a seventh fewer, measured once on this branch's own PR run.
//     **No exact pair is quoted here on purpose**: the count moves every time a case is
//     added, and a figure nobody re-measures is the stale-count trap this file's own header
//     warns about (it went stale twice during review). What matters and does not drift:
//     every `zsh` assertion here is a LOCAL result, and only the bash half is continuously
//     enforced. Same shape as every sibling shell guard in this directory; written down
//     here, and in the doc, rather than left for someone to infer from a test count.
//   - **Pathspec edge cases, MEASURED on git 2.52.0 rather than reasoned about**, because
//     the `:(literal)` hardening itself shipped a Critical (see M12) and "it's only a
//     pathspec" is exactly the reasoning that produced it. Probed with the block's own
//     three commands against a throwaway repo:
//       * `""`                -> `ls-files` rc=0, `status` lists EVERY dirty file. The
//                                Critical. `[ -z ]` stops it, and so does the scope gate.
//       * a directory         -> `ls-files` rc=0, `status` reports the whole subtree ->
//                                REFUSED by the scope gate.
//       * a DELETED directory -> identical, and this is why the gate asks git rather than
//                                the filesystem: `[ -d ]` is FALSE once the directory is
//                                gone from disk, while git still expands the pathspec to
//                                the subtree. An earlier `[ -d ]` guard missed exactly
//                                this and reverted a bystander's work with exit 0.
//       * a DELETED file      -> `ls-files` answers from the INDEX, so the gate passes and
//                                `checkout --` recreates it. Deletion stays a legal mutant.
//       * a symlink to a dir  -> `ls-files --error-unmatch` rc=1 -> REFUSED as untracked.
//       * an ABSOLUTE path    -> rc=0, `status` reports exactly the one file. Works; no
//                                guard needed, and none added.
//       * `../escape`         -> rc=128 -> REFUSED by the tracked check.
//       * a name starting `:` -> resolves to itself; `status` reports only it, and
//                                `checkout --` restores only it, leaving siblings alone.
//     The four that can destroy a bystander's work (`""`, directory, deleted directory,
//     and the glob-bearing name) have behavioural tests below. The rest are properties of
//     git rather than of the blocks, and are recorded here so nobody re-derives them.
//   - The templates.md assertions at the bottom are TEXT checks, deliberately weaker than
//     the executable core, and labelled as such. There is no second runnable copy of the
//     block in the dispatch prompt to execute; what the prompt must carry is the pointer
//     and the per-role rule, and text is the only surface that has ever carried those.
//
// MUTANTS RUN, NOT REASONED ABOUT (2026-09-19, macOS + zsh + git 2.52.0; baseline **45
// passed**). Re-measured in full after EACH review round — three of them — because a round
// changes the test set and a stale count is worse than none. (Round 3 caught this file
// breaking its own rule: two tests had been added without re-running the table.) Each
// mutant was applied to the COMMITTED text and restored with `git checkout --` afterwards,
// which is the rule this file is about; `git status --porcelain` was empty before and after
// every one. Every mutant still COLLECTS 45 — the number to distrust is a red count that
// arrives with a shrunken total. A mutant's CONSTRUCTION is a claim as much as its count
// is, so each says which kind it is:
//
//   M1. RESTORED VERBATIM — `git show origin/main:.claude/skills/yolo-ship/SKILL.md >` the
//       file, i.e. the pre-fix text, which carries NEITHER marked block -> **41 red of 45**.
//       The extractor finds 0 of each, `runBlock` throws by design naming the reason, and
//       every behavioural case plus every block-structure check reds out. The 4 survivors
//       are `logicalLines keeps a command a comment tried to swallow` and the three
//       templates.md text checks — none of which read this skill file. This is the mutant
//       the card asks for: the guard fails against the text as it stands on `main`.
//   M2. CONSTRUCTED, one token: drop ONLY the dirty-branch `exit 1` from the precondition
//       -> **5 red**. The plausible regression: someone "softens" a refusal into a warning.
//       **This mutant is why the structure check counts instead of using `.some()`.** In an
//       earlier round it PASSED that check — one surviving `exit 1` satisfied
//       `some(/^exit 1$/)` — and the mutant had been WIDENED to "drop both" so that it would
//       redden. That is measuring backwards: the test was shaping the mutant.
//   M3. CONSTRUCTED: replace the restore's `git checkout -- "$P"` with `cp "$BACKUP" "$F"`,
//       recorded here WITH ITS FLAW rather than as a result. It did NOT redden the
//       incident-1 case: `$BACKUP` is unbound in the harness, so the copy fails and leaves
//       the file where it was — the right answer by accident. **A mutant that errors out is
//       a no-op in a mutant's costume.** Hence M3b. (The same trap bit M8 in round 3: a
//       line-count-based deletion left a dangling `fi`, every block failed to parse, and
//       the "33 red" it produced measured a syntax error rather than the missing gate.
//       Re-done brace-matched, it is 5.)
//   M3b.CONSTRUCTED, the honest version of M3: `git show HEAD~1:"$F" > "$F"`, a restore that
//       SUCCEEDS at writing back a stale snapshot, i.e. what a copy taken before a sibling's
//       commit does -> **12 red**, including `keeps a commit that landed during the window`
//       x2. Incident (1) re-introduced.
//   M4. CONSTRUCTED: delete the restore's post-restore `git status --porcelain` check ->
//       **3 red**. Without it, a restore that brought the mutant straight back out of the
//       index reports success.
//   M5. CONSTRUCTED: delete the dispatch-prompt bullet -> **2 red**, two of the three
//       templates.md text checks. The third passes either way and says so.
//   M6. CONSTRUCTED: pipe a git invocation inside both blocks -> **1 red**, `pipe no git
//       invocation`, and nothing else. Deliberately the shape no behavioural test here can
//       see: a pipe launders git's exit status, so a FAILED status call reads as "clean".
//   M7. CONSTRUCTED, a mutant of THIS FILE rather than of the doc: put `logicalLines` back
//       to join-continuations-then-filter-comments, the ordering TASK-454 found in two
//       sibling guards -> **1 red**. The helper every structural check reads through could
//       otherwise DELETE a command line before the check ever saw it.
//   M8. CONSTRUCTED: delete the `git ls-files --error-unmatch` tracked block from both
//       blocks -> **5 red**. Found by running mutants, not by reading: `git status` on a
//       path git does not know prints nothing and errors, which is indistinguishable from
//       "clean", so an UNSUBSTITUTED `F="<the file you are about to mutate>"` sailed through.
//   M9. CONSTRUCTED: delete the restore's already-clean gate -> **3 red**. `git commit -am
//       wip` between mutating and restoring makes `git checkout --` a genuine no-op, leaves
//       `git status` empty, and the block would print `ok` over a mutant on the branch.
//  M10. CONSTRUCTED: take the restore block's own `F=` binding away -> **1 red**. Agent Bash
//       calls do not share shell state, so the restore — a red test-run later — would run
//       with `$F` unset.
//  M11. CONSTRUCTED: drop the `:(literal)` pathspec, addressing `"$F"` directly -> **6 red**,
//       FOUR of them behavioural (the `[`-bracketed name, both blocks x both shells). In
//       round 2 this mutant reddened only text checks; a reviewer was right that a claim
//       enforced by a text match is not enforced, and the two glob fixtures are what closed
//       it. The precondition half fails OPEN without it — `status --porcelain "we[i]rd.js"`
//       matches the CLEAN sibling, prints nothing, and the block announces `committed-clean`
//       over a dirty file.
//  M12. CONSTRUCTED: delete the empty-`$F` guard from both blocks -> **5 red**. The CRITICAL
//       a reviewer caught in my own hardening: with `$F` empty, `":(literal)"` addresses
//       EVERY tracked file, so the restore block exits **0** having reverted a bystander's
//       uncommitted work, and prints `ok`. Literal magic disables wildcards, not scope. The
//       unhardened `-- ""` failed CLOSED, so the hardening had converted a refusal into a
//       silent whole-worktree revert.
//  M14. CONSTRUCTED: delete the git-side scope gate (`ONE=$(git ls-files -- "$P")`) from
//       both blocks -> **9 red**, including the deleted-directory case x2 blocks x2 shells.
//       This replaced an earlier `[ -d "$F" ]` filesystem guard (M13, retired) that a
//       reviewer showed was blind in exactly the Critical's shape: `[ -d ]` is FALSE for a
//       directory removed from disk, while git still expands the pathspec to the whole
//       subtree — so the restore reverted a bystander's work and printed `ok`, at subtree
//       scale. Ask git what the pathspec addresses, not the filesystem what `$F` looks like.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally — no network,
// no Docker, no build. Every git repository it touches is created under a temp dir and
// removed afterwards; it never runs git against this repository.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YOLO_SKILL = join(REPO_ROOT, '.claude', 'skills', 'yolo-ship', 'SKILL.md');
const TEMPLATES = join(
  REPO_ROOT,
  '.claude',
  'skills',
  'auto-ship',
  'references',
  'templates.md',
);

const yoloText = readFileSync(YOLO_SKILL, 'utf8');
const templatesText = readFileSync(TEMPLATES, 'utf8');

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
 * Same rule, and the same duplication-rather-than-sharing decision, as the sibling guards
 * that pin other runnable blocks: a block nested in a bullet carries leading spaces, and
 * dedenting by the fence's own indent handles nested and top-level blocks with one rule.
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
 * **In that order.** TASK-454 measured the opposite ordering as fail-OPEN in two sibling
 * guards: joining continuations first lets a comment line ending in a backslash absorb the
 * code line below it, the joined result starts with `#`, and the real command DISAPPEARS
 * from the scan — while both bash and zsh happily RUN it, because a `#` comment does not
 * continue across a backslash. Filtering first cannot lose code that way.
 *
 * Pinned by `logicalLines keeps a command a comment tried to swallow` below.
 */
function logicalLines(block) {
  return block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const PRECONDITION_MARK = '# ax-mutation-restore: precondition';
const RESTORE_MARK = '# ax-mutation-restore: restore';

/**
 * The single ```bash block carrying `mark`, or `undefined` if it is missing or duplicated.
 *
 * Keyed on an explicit marker comment rather than on any command inside the block. That is
 * deliberate: a sibling guard measured a mutant whose red count was wrong because its
 * extractor was keyed on a command the mutant had edited, so the extractor and the thing
 * under test moved together. A marker is inert — no mutant of the protocol itself touches
 * it — and a mutant that DELETES the block makes this return `undefined`, which `runBlock`
 * turns into a loud failure rather than a skipped test.
 */
function markedBlock(mark) {
  const hits = bashBlocks(yoloText).filter((b) => b.includes(mark));
  return hits.length === 1 ? hits[0] : undefined;
}

const PRECONDITION = markedBlock(PRECONDITION_MARK);
const RESTORE = markedBlock(RESTORE_MARK);

/**
 * Run one extracted block in `cwd` with `F` bound to `file`.
 *
 * The doc's precondition block opens with a placeholder `F="<the file you are about to
 * mutate>"`; that one assignment is the only thing substituted, and the substitution is
 * mechanical (drop every line starting `F=`, prepend the real binding). The structure check
 * below pins that there is exactly one such line, so the substitution cannot silently start
 * meaning something else.
 */
function runBlock(shell, block, { cwd, file, mark }) {
  if (!block) {
    throw new Error(
      `no single \`\`\`bash block in ${YOLO_SKILL} carries "${mark}" — the protocol ` +
        `block is missing, duplicated, or its marker was edited`,
    );
  }
  const body = block
    .split('\n')
    .filter((l) => !/^F=/.test(l))
    .join('\n');
  const script = `F=${JSON.stringify(file)}\n${body}\n`;
  const p = spawnSync(shell, ['-c', script], { cwd, encoding: 'utf8' });
  return { status: p.status, out: `${p.stdout ?? ''}${p.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------------
// Throwaway git repositories.
// ---------------------------------------------------------------------------------

const tmpDirs = [];

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const TARGET = 'guard.js';
const V1 = ['// baseline', 'export const answer = 42;', ''].join('\n');
/** What a concurrent agent commits to the same file mid-window (incident 1). */
const V2 = [
  '// baseline',
  '// SIBLING-FIX: a fix another agent committed',
  'export const answer = 42;',
  '',
].join('\n');
const MUTANT = ['// baseline', 'export const answer = 43;', ''].join('\n');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ax-mutation-restore-'));
  tmpDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'guard@example.invalid');
  git(dir, 'config', 'user.name', 'Guard Fixture');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, TARGET), V1);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline');
  return dir;
}

/** A throwaway directory that is NOT a git repository — where a builder's copy would live. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ax-mutation-restore-scratch-'));
  tmpDirs.push(dir);
  return dir;
}

function read(dir, file = TARGET) {
  return readFileSync(join(dir, file), 'utf8');
}

function porcelain(dir) {
  return git(dir, 'status', '--porcelain').trim();
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------
// Behaviour.
// ---------------------------------------------------------------------------------

describe.each(SHELLS)('mutation-restore protocol under %s', (shell) => {
  it('precondition passes on a committed-clean path', () => {
    const dir = makeRepo();

    const r = runBlock(shell, PRECONDITION, {
      cwd: dir,
      file: TARGET,
      mark: PRECONDITION_MARK,
    });

    expect(r.out).toMatch(/committed-clean/);
    expect(r.status).toBe(0);
  });

  it('precondition refuses a path carrying uncommitted work, and names BOTH roles', () => {
    // Incident (3) from the owner's chair and incident (2) from the reviewer's: a file that
    // already carries work nobody has committed. Every restore from here is lossy.
    const dir = makeRepo();
    const dirty = `${V1}// a 25-line comment someone is still writing\n`;
    writeFileSync(join(dir, TARGET), dirty);

    const r = runBlock(shell, PRECONDITION, {
      cwd: dir,
      file: TARGET,
      mark: PRECONDITION_MARK,
    });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/REFUSE/);
    // Both roles named, and told DIFFERENT things — "commit first" is the fix for one and
    // forbidden for the other, so a refusal that addresses only the owner ships half the bug.
    expect(r.out).toMatch(/owner of this worktree: commit/i);
    expect(r.out).toMatch(/subagent in someone else's worktree: do NOT commit/i);
    // Fail-CLOSED: the block changed nothing on its way out.
    expect(read(dir)).toBe(dirty);
  });

  it('restore puts back exactly the mutation and leaves the path clean', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, TARGET), MUTANT);

    const r = runBlock(shell, RESTORE, { cwd: dir, file: TARGET, mark: RESTORE_MARK });

    expect(r.status).toBe(0);
    expect(read(dir)).toBe(V1);
    expect(porcelain(dir)).toBe('');
  });

  it('restore keeps a commit that landed during the window — a file copy reverts it', () => {
    // Incident (1), reproduced. The agent takes a copy of v1, mutates, and while its suite
    // runs a sibling in the same worktree commits a fix (v2) to the same file. The agent's
    // mutant is then re-applied ON TOP of v2, which is what makes this test stand on its
    // own: the restore has to both REMOVE the mutant and KEEP the sibling's commit. (An
    // earlier version wrote the mutant and overwrote it with v2 on the next line, so the
    // mutant was never in the tree when the block ran — it leaned entirely on the control.)
    const dir = makeRepo();
    writeFileSync(join(dir, TARGET), V2);
    git(dir, 'add', TARGET);
    git(dir, 'commit', '-q', '-m', 'sibling fix');
    const mutantOnTop = V2.replace('answer = 42', 'answer = 43');
    writeFileSync(join(dir, TARGET), mutantOnTop);

    const r = runBlock(shell, RESTORE, { cwd: dir, file: TARGET, mark: RESTORE_MARK });

    expect(r.status).toBe(0);
    expect(read(dir)).toBe(V2);
    expect(read(dir)).toContain('SIBLING-FIX');
    expect(porcelain(dir)).toBe('');

    // DEMONSTRATION, not a control, and labelled so after it stopped being load-bearing:
    // the same fixture restored the way incident (1) restored it puts back the stale v1 —
    // the mutant is gone, which LOOKS right, and the sibling's committed fix is gone with
    // it, silently, exit status 0. It touches nothing from SKILL.md, so it cannot fail for
    // any change under review; it is kept because the assertions above say what the block
    // DOES and this says what the alternative would have done. Measured: deleting the
    // block's `git checkout -- "$P"` reddens the assertions above on both shells, so they
    // no longer lean on it.
    const control = makeRepo();
    const controlCopy = join(scratch(), 'backup.copy');
    writeFileSync(controlCopy, read(control));
    writeFileSync(join(control, TARGET), V2);
    git(control, 'add', TARGET);
    git(control, 'commit', '-q', '-m', 'sibling fix');
    writeFileSync(join(control, TARGET), mutantOnTop);
    const cp = spawnSync(shell, ['-c', `cp "${controlCopy}" "${TARGET}"`], {
      cwd: control,
      encoding: 'utf8',
    });
    expect(cp.status).toBe(0);
    expect(read(control)).not.toContain('SIBLING-FIX');
  });

  it('restore brings back a DELETED file — "remove it and watch it go red" is a legal mutant', () => {
    // The guard above is `[ -d "$F" ]`, deliberately not `[ -f "$F" ]`: deleting the file
    // the guard covers is one of the commonest mutants on this board, and an existence
    // check would refuse it. Nothing asserted that the rest of the block survives a path
    // that is tracked but absent from disk, so this walks it: `ls-files` answers from the
    // index (tracked), `status --porcelain` reports ` D` (dirty, so not "already clean"),
    // and `checkout --` recreates the file.
    const dir = makeRepo();
    rmSync(join(dir, TARGET));

    const r = runBlock(shell, RESTORE, { cwd: dir, file: TARGET, mark: RESTORE_MARK });

    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^ok:/m);
    expect(read(dir)).toBe(V1);
    expect(porcelain(dir)).toBe('');
  });

  it('restore refuses a mutant that was COMMITTED — checkout would be a no-op reporting success', () => {
    // `git commit -am wip` after a red run is an ordinary habit. Do it here and
    // `git checkout --` has nothing to undo, `git status --porcelain` is empty, and without
    // the already-clean gate the block prints `ok: restored, working tree clean` over a
    // mutant that is now on the branch and headed for the PR.
    const dir = makeRepo();
    writeFileSync(join(dir, TARGET), MUTANT);
    git(dir, 'commit', '-q', '-am', 'wip');

    const r = runBlock(shell, RESTORE, { cwd: dir, file: TARGET, mark: RESTORE_MARK });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/already clean/);
    expect(r.out).toMatch(/COMMITTED it/);
    expect(r.out).not.toMatch(/^ok:/m);
    // And it does not pretend: the mutant is still exactly where the agent left it.
    expect(read(dir)).toBe(MUTANT);
  });

  it('restore refuses when the mutant was staged — checkout restores from the INDEX', () => {
    // `git checkout -- <path>` restores from the index, not from HEAD. Stage the mutant
    // (an `git add -A` between mutating and restoring is all it takes) and the restore
    // brings it straight back with exit status 0, looking successful. The post-restore
    // check is the only thing that notices.
    const dir = makeRepo();
    writeFileSync(join(dir, TARGET), MUTANT);
    git(dir, 'add', TARGET);

    const r = runBlock(shell, RESTORE, { cwd: dir, file: TARGET, mark: RESTORE_MARK });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/still dirty after restore/);
    // And it says so rather than quietly leaving the mutant behind as "restored".
    expect(read(dir)).toBe(MUTANT);
  });

  it.each([
    ['precondition', () => PRECONDITION, PRECONDITION_MARK],
    ['restore', () => RESTORE, RESTORE_MARK],
  ])('%s refuses an EMPTY $F rather than addressing the whole worktree', (_name, block, mark) => {
    // A pathspec of `""` — and, worse, `:(literal)` of `""` — matches EVERY tracked file.
    // Measured on git 2.52.0: `ls-files --error-unmatch -- ":(literal)"` exits 0 and lists
    // the lot, `status --porcelain` reports them all, and `checkout --` reverts them all and
    // exits 0. That is incident (2) — a subagent silently reverting work that is not its
    // own — performed by the protocol block itself, printing `ok`. `$F` goes empty whenever
    // an agent parameterises the block (`F="$TARGET"`, `F=$(…)` returning nothing) or drops
    // the `F=` line while pasting, which is the exact shape this section is about.
    const dir = makeRepo();
    const BYSTANDER = 'bystander.js';
    writeFileSync(join(dir, BYSTANDER), V1);
    git(dir, 'add', BYSTANDER);
    git(dir, 'commit', '-q', '-m', 'bystander');
    // Somebody else's uncommitted work, sitting in the same tree.
    const theirs = `${V1}// work that belongs to someone else\n`;
    writeFileSync(join(dir, BYSTANDER), theirs);
    writeFileSync(join(dir, TARGET), MUTANT);

    const r = runBlock(shell, block(), { cwd: dir, file: '', mark });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/is empty/);
    expect(r.out).not.toMatch(/^ok:/m);
    // Nothing was touched — neither their work nor the mutant.
    expect(read(dir, BYSTANDER)).toBe(theirs);
    expect(read(dir)).toBe(MUTANT);
  });

  it.each([
    ['precondition', () => PRECONDITION, PRECONDITION_MARK],
    ['restore', () => RESTORE, RESTORE_MARK],
  ])('%s refuses a DIRECTORY — literal magic drops wildcards, not the subtree', (_name, block, mark) => {
    // `:(literal)` disables pattern matching, NOT directory-prefix matching. Measured:
    // `ls-files --error-unmatch -- ":(literal)sub"` exits 0 and prints `sub/nested.js`, so a
    // directory sails the tracked gate and `checkout --` reverts the whole subtree.
    const dir = makeRepo();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.js'), V1);
    git(dir, 'add', 'sub');
    git(dir, 'commit', '-q', '-m', 'subtree');
    const theirs = `${V1}// someone else's work under sub/\n`;
    writeFileSync(join(dir, 'sub', 'nested.js'), theirs);

    const r = runBlock(shell, block(), { cwd: dir, file: 'sub', mark });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/more than one tracked path/);
    expect(r.out).not.toMatch(/^ok:/m);
    expect(read(dir, join('sub', 'nested.js'))).toBe(theirs);
  });

  it.each([
    ['precondition', () => PRECONDITION, PRECONDITION_MARK],
    ['restore', () => RESTORE, RESTORE_MARK],
  ])('%s refuses a DELETED directory — the filesystem test cannot see it', (_name, block, mark) => {
    // The reason the scope gate asks GIT rather than the filesystem. A `[ -d "$F" ]` test
    // is FALSE for a directory that has been removed from disk — and "delete the whole
    // module and watch the canary go red" is an ordinary mutant here, blessed explicitly by
    // the deleted-FILE case below. To git the path is still a directory: `ls-files` answers
    // `sub/nested.js` from the index, `status` reports ` D`, and `checkout --` recreates the
    // entire subtree, wiping a bystander's uncommitted work with exit 0 and an `ok` line.
    // Measured on git 2.52.0 — same signature as the empty-`$F` Critical, narrower reach.
    const dir = makeRepo();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.js'), V1);
    writeFileSync(join(dir, 'sub', 'other.js'), V1);
    git(dir, 'add', 'sub');
    git(dir, 'commit', '-q', '-m', 'subtree');
    const theirs = `${V1}// someone else's uncommitted work under sub/\n`;
    writeFileSync(join(dir, 'sub', 'nested.js'), theirs);
    rmSync(join(dir, 'sub', 'other.js'));

    const r = runBlock(shell, block(), { cwd: dir, file: 'sub', mark });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/more than one tracked path/);
    expect(r.out).not.toMatch(/^ok:/m);
    expect(read(dir, join('sub', 'nested.js'))).toBe(theirs);
  });

  it('restore addresses the named file literally — a `[`-bracketed name is not a pattern', () => {
    // The behavioural half of `:(literal)`, which until now only a text check asserted.
    // Without it, `git checkout -- "we[i]rd.js"` is a character class matching `weird.js`:
    // the sibling gets reverted and the real mutant survives, exit status 0.
    const dir = makeRepo();
    const ODD = 'we[i]rd.js';
    const SIBLING = 'weird.js';
    writeFileSync(join(dir, ODD), V1);
    writeFileSync(join(dir, SIBLING), V1);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'odd names');
    writeFileSync(join(dir, ODD), MUTANT);
    const siblingWork = `${V1}// the sibling's own uncommitted work\n`;
    writeFileSync(join(dir, SIBLING), siblingWork);

    const r = runBlock(shell, RESTORE, { cwd: dir, file: ODD, mark: RESTORE_MARK });

    expect(r.status).toBe(0);
    expect(read(dir, ODD)).toBe(V1);
    // The sibling the pattern would have matched is untouched.
    expect(read(dir, SIBLING)).toBe(siblingWork);
  });

  it('precondition reads the named file literally — a sibling\'s cleanliness is not yours', () => {
    // The PRECONDITION half of the same property, and it fails in the other direction: with
    // a bare `$F`, `git status --porcelain "we[i]rd.js"` is a character class that matches
    // the CLEAN `weird.js`, prints nothing, and the block announces `ok: committed-clean`
    // over a file that is dirty. Fail-OPEN, in the block whose claim is that it fails
    // closed — and until this test existed, only a text scan stood between the doc and it.
    const dir = makeRepo();
    const ODD = 'we[i]rd.js';
    const SIBLING = 'weird.js';
    writeFileSync(join(dir, ODD), V1);
    writeFileSync(join(dir, SIBLING), V1);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'odd names');
    // Only the odd-named file is dirty; the sibling the glob would match is clean.
    writeFileSync(join(dir, ODD), `${V1}// uncommitted\n`);

    const r = runBlock(shell, PRECONDITION, {
      cwd: dir,
      file: ODD,
      mark: PRECONDITION_MARK,
    });

    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/carries uncommitted work/);
    expect(r.out).not.toMatch(/committed-clean/);
  });

  it.each([
    ['precondition', () => PRECONDITION, PRECONDITION_MARK],
    ['restore', () => RESTORE, RESTORE_MARK],
  ])('%s refuses a path git does not track', (_name, block, mark) => {
    // `git status --porcelain -- <unknown path>` prints NOTHING and errors, which is
    // indistinguishable from "clean" — so without an explicit tracked check an
    // UNSUBSTITUTED `F="<the file you are about to mutate>"` sails straight through and the
    // agent proceeds to mutate on a guarantee nothing actually checked. Found by mutating
    // this branch's own block; fail-closed in both directions.
    const dir = makeRepo();
    writeFileSync(join(dir, 'never-added.js'), MUTANT);

    for (const file of ['never-added.js', '<the file you are about to mutate>']) {
      const r = runBlock(shell, block(), { cwd: dir, file, mark });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/not a tracked file/);
    }
  });
});

// ---------------------------------------------------------------------------------
// Structure of the blocks themselves.
// ---------------------------------------------------------------------------------

describe('the blocks in yolo-ship Phase 4', () => {
  it('are each present exactly once, and carry their marker', () => {
    expect(bashBlocks(yoloText).filter((b) => b.includes(PRECONDITION_MARK))).toHaveLength(1);
    expect(bashBlocks(yoloText).filter((b) => b.includes(RESTORE_MARK))).toHaveLength(1);
  });

  it('each bind the target exactly once', () => {
    // BOTH blocks bind it. An agent's Bash calls do not share shell state, and the restore
    // runs a red test-run later — i.e. always a new shell — so a restore block that leaned
    // on the precondition's `$F` would run with it unset. (It failed closed when that
    // happened, but named the wrong cause.) Split from the pathspec check below so a red
    // names one cause: a single loop asserting both died on the first and reported it.
    for (const block of [PRECONDITION, RESTORE]) {
      expect(block.split('\n').filter((l) => /^F=/.test(l))).toHaveLength(1);
    }
  });

  it('each address the target as a literal pathspec, never as a bare $F', () => {
    for (const block of [PRECONDITION, RESTORE]) {
      expect(block.split('\n').filter((l) => /^P=":\(literal\)\$F"$/.test(l))).toHaveLength(1);
    }
    // No git INVOCATION may mention `$F` at all — deliberately stronger than "no `-- "$F"`".
    // A filename containing [ * or ? is a PATTERN to git, so a bare `$F` could check, or
    // restore, a sibling file instead. Measured: the `--`-keyed version of this check
    // missed `git status --porcelain "$F"` — no separator, and the pathspec is still bare —
    // and that mutant survived the ENTIRE suite while making the precondition announce
    // `ok: committed-clean` over a dirty file. Comparisons against `$F` live on non-git
    // lines (`[ "$ONE" != "$F" ]`), so this costs nothing.
    //
    // `echo` lines are excluded here and checked separately below, because a refusal
    // message legitimately says both `$F` (naming the file for the reader) and the word
    // "git" (explaining what git did). They get the narrower rule that matters for them.
    for (const l of [...logicalLines(PRECONDITION), ...logicalLines(RESTORE)]) {
      if (/^echo\b/.test(l) || !/\bgit\b/.test(l)) continue;
      expect(l).not.toMatch(/\$\{?F\b/);
    }
  });

  it('hand the reader no runnable git command with a bare $F in it', () => {
    // The other direction of the same hazard, and it is not hypothetical: the precondition's
    // success line used to end `— git checkout -- $F restores it exactly`, bare and
    // unquoted. An agent that reads an `ok:`/`REFUSE:` line naming a command runs that
    // command, and `git checkout -- we[i]rd.js` reverts the SIBLING. A message may name a
    // command, but it must spell the path as a placeholder, never as `$F`.
    for (const l of [...logicalLines(PRECONDITION), ...logicalLines(RESTORE)]) {
      if (!/^echo\b/.test(l)) continue;
      if (!/\bgit\s+(checkout|restore|status|ls-files)\b/.test(l)) continue;
      expect(l).not.toMatch(/\$\{?F\b|\\\$\{?F\b/);
    }
  });

  it('restore with git, never with a file copy', () => {
    expect(logicalLines(RESTORE).some((l) => /^git checkout -- "\$P"$/.test(l))).toBe(true);
    for (const l of [...logicalLines(PRECONDITION), ...logicalLines(RESTORE)]) {
      expect(l).not.toMatch(/(^|[;&|(]\s*)(cp|rsync|install|mv)\s/);
    }
  });

  it('pipe no git invocation', () => {
    // A pipe launders git's exit status. Narrowly: this check forbids ONE laundering shape.
    // `[ -n "$(git … )" ]` launders the status just as thoroughly, and both blocks use it —
    // which is exactly why each one first establishes the path is tracked with an
    // status-checked `git ls-files`, rather than trusting an empty string to mean "clean".
    // Every git line is scanned, not just the first: a check that inspects one occurrence
    // is a check on that occurrence, not on the property.
    for (const l of [...logicalLines(PRECONDITION), ...logicalLines(RESTORE)]) {
      if (!/\bgit\b/.test(l)) continue;
      expect(l).not.toMatch(/\|/);
    }
  });

  it('match every REFUSE one-for-one with an `exit 1` — COUNTED, not paired', () => {
    // `some(/^exit 1$/)` would be satisfied by a block that kept one refusal and softened
    // the rest — measured: dropping only the dirty-branch `exit 1` left `some()` true, so
    // the structure check passed and the mutant had to be widened to fit it. Counting binds
    // the gate to the message: 4 REFUSE branches in the precondition, 5 in the restore.
    //
    // HONEST LIMIT, in the name rather than the fine print, and re-derived rather than
    // asserted: this is count-equality plus a per-block floor, not pairing.
    //   - Softening one refusal to a warning while adding a stray `exit 1` elsewhere keeps
    //     the counts level and passes. Nothing here sees that.
    //   - Deleting a whole `if` also keeps them level — that one is CORRECT (its REFUSE and
    //     its exit go together, see M9); the behavioural tests are what catch it.
    //   - `echo "REFUSE: …" && exit 1` keeps `refusals` (the line still starts `echo
    //     "REFUSE`) and drops `exits` -> caught by the EQUALITY, not the floor.
    //   - Collapsing a whole `if` onto one line drops both by one -> caught by the floor
    //     only because the floor is per-block and exact. It was a single shared `>= 4`
    //     before, which pinned the precondition and left the restore's fifth refusal free.
    const FLOORS = new Map([
      [PRECONDITION, 4],
      [RESTORE, 5],
    ]);
    for (const [block, floor] of FLOORS) {
      const lines = logicalLines(block);
      const refusals = lines.filter((l) => /^echo "REFUSE/.test(l)).length;
      const exits = lines.filter((l) => /^exit 1$/.test(l)).length;
      expect(refusals).toBeGreaterThanOrEqual(floor);
      expect(exits).toBe(refusals);
      expect(lines.some((l) => l.includes('git status --porcelain'))).toBe(true);
    }
  });

  it('logicalLines keeps a command a comment tried to swallow', () => {
    // The TASK-454 fail-open, pinned one layer down: join-then-filter returns NEITHER line
    // here, so the piped git below would be invisible to every structural check above,
    // while both shells happily run it.
    const swallow = ['# a note \\', 'N=$(git status --porcelain | cat)'].join('\n');
    expect(logicalLines(swallow)).toEqual(['N=$(git status --porcelain | cat)']);
  });
});

// ---------------------------------------------------------------------------------
// The dispatch prompt. TEXT checks, weaker than everything above, and labelled so.
// ---------------------------------------------------------------------------------

/** The body of a `## ` section, up to the next `## ` heading or EOF. */
function sectionBody(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `## ${heading}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The blockquote inside a section, `> ` stripped — the literal text a builder receives. */
function blockquote(body) {
  return body
    .split('\n')
    .filter((l) => l === '>' || l.startsWith('> '))
    .map((l) => l.slice(2))
    .join('\n');
}

/** Top-level `- ` bullets, each carrying its own indented continuation lines. */
function bullets(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) out.push(line);
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += `\n${line}`;
  }
  return out;
}

describe('the code-lane dispatch prompt (text check — weaker on purpose)', () => {
  // Weaker because there is nothing runnable here to execute: what the prompt must carry is
  // a pointer and the per-role rule, and prose is the only surface that has ever carried
  // those. It is pinned anyway because the rule reached builders for two days ONLY as an
  // orchestrator habit — a habit lives in whoever is driving and disappears the first time
  // a dispatch is generated by someone who does not remember it.
  const section = sectionBody(templatesText, 'Code-lane dispatch prompt');
  const promptBullets = bullets(blockquote(section)).filter((b) => /mutation testing/i.test(b));

  it('carries a mutation-restore bullet inside the builder-facing blockquote', () => {
    expect(promptBullets).toHaveLength(1);
  });

  it('names the commit-first rule, the someone-else case and the file-copy hazard in ONE bullet', () => {
    const [b] = promptBullets;
    expect(b).toBeDefined();
    // All three in the SAME bullet: split across unrelated bullets they read as three
    // separate suggestions rather than one rule with two roles.
    expect(b).toMatch(/commit before you mutate/i);
    expect(b).toMatch(/git checkout -- /);
    expect(b).toMatch(/someone\s+ELSE'S worktree/i);
    expect(b).toMatch(/never from a file\s+copy/i);
    // The pointer to the runnable blocks, which are the part that is actually enforced.
    expect(b).toMatch(/yolo-ship Phase 4/);
  });

  it('keeps the rule in the prompt, not in the orchestrator-facing prose above it', () => {
    // NOT COVERAGE OF THIS CHANGE — it passes either way. Measured: `git show
    // origin/main:…/templates.md | grep -i mutation` matches nothing, so this negative
    // assertion is byte-identically green against the unfixed file. It is a tripwire for a
    // drift nobody has made yet: guidance addressed to the orchestrator ("remember to tell
    // builders…") would reproduce the exact defect this card fixes, because a habit lives
    // in whoever is driving. The two assertions above it ARE red against `origin/main`.
    const prose = section
      .split('\n')
      .filter((l) => !(l === '>' || l.startsWith('> ')))
      .join('\n');
    expect(prose).not.toMatch(/ax-mutation-restore|mutation testing/i);
  });
});
