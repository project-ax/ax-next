// Guard: the per-task SHARD layout for `.claude/memory/` is what removes the
// append-collision, and `merge=union` is NOT a substitute for it.
//
// WHY THIS FILE EXISTS (TASK-415). `.claude/memory/decisions.md`,
// `patterns.md` and `mistakes.md` were append-only logs that every concurrent
// auto-ship branch appended to, so they collided on essentially every branch.
// Measured across one day: eight branches hit an append-collision, and two hit
// a SECOND one while merely waiting in the merge queue behind another
// session's stack. In every case NO production file conflicted — the shape was
// always "both sides appended at EOF". Each collision cost a rebase, a
// force-push and a fresh ~10-minute CI run, on files no product code reads.
//
// Two fixes were on the table. `merge=union` is the cheap one, and it is the
// one that looks right: "both sides appended at EOF" is exactly the case the
// built-in union driver is documented to handle, and it needs no config in any
// clone. It was REFUTED by measurement, and `union merge SILENTLY DROPS lines`
// below is that refutation, kept executable so nobody re-proposes it from the
// same plausible reasoning. Union is a LINE-wise driver: git's diff matches
// whatever the two appended blocks happen to share at their edges as ordinary
// context, and emits it once. Measured against the real decisions.md — 3189
// lines the day this was written, and growing daily, which is rather the point
// of it being the serialization point — all four shapes tried lost lines: from
// one (a shared leading blank) up to two (a shared closing line, which left a
// multi-line row ending in a colon with the next `##` heading welded to it).
// EVERY ONE of them reported a `git diff --numstat` deletions column of 0.
//
// Calibrating that, because the frequency matters and overstating it would be
// the same sin: the shared LEADING blank is lost in every case and that one is
// cosmetic (CommonMark still reads `##` after a paragraph line as a heading).
// Content loss needs a shared TRAILING line, and in the real decisions.md that
// is rare — measured, entries almost never end on a line another entry also
// ends on (only `---`, twice). The lines that ARE mass-duplicated are interior
// and therefore safe: `| Date | Decision | Rationale | Alternatives |` appears
// 203 times and `|---|---|---|---|` 185, and every one of them sits between
// unique lines rather than at a block edge.
//
// So union's corruption is low-frequency, not routine. It is still
// disqualifying, and the reason is the deletions column rather than the line
// count. That column is the sharpest check we have that no row was silently
// dropped, and union defeats it: the loss happens *during the merge*, so
// relative to the base nothing was ever deleted. Given two options costing
// about the same to adopt — one `.gitattributes` line versus one helper and a
// rule — the tiebreak is that only one of them has a silent-loss mode at all.
// A rare silent corruption in the log we use to reconstruct why we did things
// is worse than a frequent visible one.
//
// Shards have no such failure mode because there is no merge at all: two
// branches write two different paths, git takes both, and there is nothing for
// `rerere` to record or to replay against a different `main` either.
//
// HOW TO READ THE CASES. `shards do not collide` on its own would be weak —
// of course two unrelated files merge. Its control is `the monolith DOES
// collide`, run on the same fixture with the same two appends: that one proves
// the clean result comes from the layout and not from the test being gentle.
// If you ever make the monolith case stop conflicting, this whole file has
// gone vacuous.
//
// WHEN THIS GOES RED: do not relax the assertions. A red `monolith` case means
// the collision this card removed has stopped reproducing (find out why before
// touching anything). A red `union` case means git's union driver changed
// behaviour, and the refutation above needs re-measuring before anyone acts on
// it.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const trash = [];

afterAll(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Run git without throwing, so a deliberately-conflicting rebase is observable. */
function tryGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Paths git reports as unmerged (`UU` etc.) right now. */
function conflictedPaths(cwd) {
  const out = git(cwd, 'diff', '--name-only', '--diff-filter=U');
  return out ? out.split('\n') : [];
}

/**
 * A repo whose `.claude/memory/decisions.md` is shaped like the real one:
 * paragraph-length entries, not single lines.
 */
function makeRepo({ unionDriver = false, rerere = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memshard-'));
  trash.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'rerere.enabled', rerere ? 'true' : 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');

  mkdirSync(join(dir, '.claude', 'memory'), { recursive: true });
  writeFileSync(
    join(dir, '.claude', 'memory', 'decisions.md'),
    [
      '# Decisions',
      '',
      'Architectural / process decisions. Never deleted — strikethrough if reversed.',
      '',
      '## 2026-09-01 — BASE-1 an entry that was already here',
      '',
      '- `2026-09-01` (BASE-1) — **A row with real length to it.** It runs onto a second',
      '  line and then a third, because that is what these entries actually look like.',
      '',
    ].join('\n'),
  );
  if (unionDriver) {
    writeFileSync(join(dir, '.gitattributes'), '.claude/memory/*.md merge=union\n');
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/**
 * The text a task appends. Deliberately ends on an IDENTICAL closing line,
 * which is the MAXIMAL case: the shape that made union lose the most (two
 * lines rather than one).
 *
 * Being straight about how artificial that is, since the whole file exists to
 * argue against an overstated claim. Real entries do close with an
 * `*Alternatives:* …` clause, but as the tail of a paragraph rather than a
 * standalone line, so two real entries almost never share their last line
 * byte-for-byte. The refutation does not rest on this case: a reviewer
 * reproducing it independently, with two entries closing DIFFERENTLY, still
 * measured 4 lines appended and 3 surviving with numstat deletions at 0. One
 * lost line that the deletions column cannot see is already disqualifying.
 * This fixture just makes the mechanism impossible to miss.
 */
function entryFor(taskId) {
  return [
    '',
    `## 2026-09-19 — ${taskId} the decision ${taskId} made`,
    '',
    `- \`2026-09-19\` (${taskId}) — **${taskId} chose the thing.** The reasoning for`,
    `  ${taskId} runs onto a second line, and onto a third, before it closes with`,
    '  *Alternatives:* none that survived contact.',
    '',
  ].join('\n');
}

function appendToMonolith(dir, taskId) {
  const file = join(dir, '.claude', 'memory', 'decisions.md');
  writeFileSync(file, readFileSync(file, 'utf8') + entryFor(taskId));
  git(dir, 'commit', '-qam', `${taskId} memory`);
}

function addShard(dir, taskId) {
  const shardDir = join(dir, '.claude', 'memory', 'decisions');
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(join(shardDir, `2026-09-19-${taskId}.md`), entryFor(taskId).trimStart());
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `${taskId} memory`);
}

/**
 * Put two branches in the collision situation and rebase one onto the other,
 * exactly as an auto-ship builder does when `main` moves under it.
 * `write` is whichever of the two append strategies is under test.
 */
function twoConcurrentBranches(repo, write) {
  const { dir, base } = repo;
  git(dir, 'checkout', '-q', '-b', 'branch-b', base);
  write(dir, 'TASK-BBB');

  git(dir, 'checkout', '-q', '-b', 'branch-a', base);
  write(dir, 'TASK-AAA');

  // `--no-rerere-autoupdate`: `rerere.enabled=false` is not enough on a host
  // whose shared `.git` already holds an `rr-cache` — that was measured on
  // this repo, where a replayed resolution came back staged `M` instead of
  // `UU` and looked like "no conflict".
  const rebase = tryGit(dir, 'rebase', '--no-rerere-autoupdate', 'branch-b');
  return { dir, rebase, conflicts: conflictedPaths(dir) };
}

describe('.claude/memory shard layout vs. the monolith', () => {
  let monolith;
  let shards;

  beforeEach(() => {
    monolith = null;
    shards = null;
  });

  it('the monolith DOES collide — this is the control, and the thing being fixed', () => {
    monolith = twoConcurrentBranches(makeRepo(), appendToMonolith);

    expect(monolith.rebase.status, 'rebase of two EOF appends to one file').not.toBe(0);
    expect(monolith.conflicts).toEqual(['.claude/memory/decisions.md']);
  });

  it('shards do not collide — two branches, two files, zero manual resolution', () => {
    shards = twoConcurrentBranches(makeRepo(), addShard);
    const { dir, rebase, conflicts } = shards;

    expect(rebase.status, `rebase failed: ${rebase.stderr}`).toBe(0);
    expect(conflicts).toEqual([]);

    // Both branches' rows are present, byte-for-byte as each wrote them.
    for (const taskId of ['TASK-AAA', 'TASK-BBB']) {
      const shard = readFileSync(
        join(dir, '.claude', 'memory', 'decisions', `2026-09-19-${taskId}.md`),
        'utf8',
      );
      expect(shard).toBe(entryFor(taskId).trimStart());
    }

    // And the archive nobody appended to is untouched.
    expect(git(dir, 'diff', '--name-only', 'branch-b', 'HEAD')).toBe(
      '.claude/memory/decisions/2026-09-19-TASK-AAA.md',
    );
  });

  it('union merge SILENTLY DROPS lines — and the deletions column cannot see it', () => {
    const repo = makeRepo({ unionDriver: true });
    const { dir, base } = repo;

    git(dir, 'checkout', '-q', '-b', 'branch-b', base);
    appendToMonolith(dir, 'TASK-BBB');
    git(dir, 'checkout', '-q', '-b', 'branch-a', base);
    appendToMonolith(dir, 'TASK-AAA');

    const addedByA = Number(
      git(dir, 'diff', '--numstat', base, 'HEAD', '--', '.claude/memory/').split('\t')[0],
    );

    const rebase = tryGit(dir, 'rebase', '--no-rerere-autoupdate', 'branch-b');

    // Half one: union really does suppress the conflict. That is the whole
    // appeal, and it is genuine.
    expect(rebase.status, `rebase failed: ${rebase.stderr}`).toBe(0);
    expect(conflictedPaths(dir)).toEqual([]);

    // Half two: it paid for that with A's own content.
    const [addedAfter, deletedAfter] = git(
      dir,
      'diff',
      '--numstat',
      'branch-b',
      'HEAD',
      '--',
      '.claude/memory/',
    )
      .split('\t')
      .map(Number);

    expect(addedAfter).toBeLessThan(addedByA);
    // …and this is why union is disqualified rather than merely imperfect: the
    // sharpest check available reports a clean bill of health on the loss.
    expect(deletedAfter).toBe(0);

    // Concretely: the shared closing line was emitted ONCE and ended up
    // attached to whichever entry git ordered last, so the other entry now
    // stops mid-thought on `…before it closes with`. Which of the two loses it
    // is git's business, not ours — the claim is that one of them does.
    const merged = readFileSync(join(dir, '.claude', 'memory', 'decisions.md'), 'utf8');
    expect(
      merged.split('\n').filter((l) => l.includes('*Alternatives:*')),
      'two entries each wrote a closing line; union emitted one',
    ).toHaveLength(1);
    const intact = ['TASK-AAA', 'TASK-BBB'].filter((t) => merged.includes(entryFor(t).trimStart()));
    expect(intact, 'exactly one entry survives verbatim — the other was truncated').toHaveLength(1);
  });

  it('rerere has nothing to replay against shards, even with an rr-cache present', () => {
    // The second hazard on the card: with `rerere.enabled=false` but an
    // `rr-cache` directory in the shared `.git`, a recorded resolution was
    // replayed against DIFFERENT `main` content and staged as `M` rather than
    // left `UU` — an invisible resolution. The shard layout dissolves it
    // rather than mitigating it: rerere only ever acts on a conflict, and
    // there is no longer one to act on.
    const repo = makeRepo({ rerere: true });
    mkdirSync(join(repo.dir, '.git', 'rr-cache'), { recursive: true });

    const { dir, rebase, conflicts } = twoConcurrentBranches(repo, addShard);

    expect(rebase.status, `rebase failed: ${rebase.stderr}`).toBe(0);
    expect(conflicts).toEqual([]);
    // Nothing staged behind our back either — `M` is the shape an invisible
    // rerere replay takes, and a clean tree is the only way to rule it out.
    expect(git(dir, 'status', '--porcelain')).toBe('');
    for (const taskId of ['TASK-AAA', 'TASK-BBB']) {
      expect(
        readFileSync(
          join(dir, '.claude', 'memory', 'decisions', `2026-09-19-${taskId}.md`),
          'utf8',
        ),
      ).toBe(entryFor(taskId).trimStart());
    }
  });
});
