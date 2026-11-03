// Tests for scripts/memory-append-check.sh — the guard that keeps
// `.claude/memory/` an append-only, per-task-shard store instead of five files
// every concurrent branch edits (TASK-415).
//
// Runs under vitest as a plain assertion harness (mirrors
// `memory-write-target.test.js`), spawning the real shell script against
// throwaway git repos in os.tmpdir().
//
// Contract under test:
//   R1  any DELETED line under `.claude/memory/` fails — not "my rows
//       survived". The real incident it answers: a branch's resolution passed
//       its own row-presence check while a whole-file blank-line normalization
//       had silently collapsed four pre-existing double-blank runs elsewhere
//       in decisions.md. Nothing of that branch's was lost, so a row-presence
//       check reported success — and the churn manufactured the next agent's
//       conflict.
//   R2  touching a ROOT `.claude/memory/<name>.md` archive fails; shards pass.
//   —   a `Memory-Rewrite:` commit trailer waives both, for deliberate hygiene.
//   —   an unresolvable base ref exits 2. Fail CLOSED: a check that could not
//       run is not a check that passed.
//
// VACUITY NOTE, because the two halves are weak in opposite directions. A
// script that always exited 1 would pass every failure case here and fail
// `a shard-only branch passes`; a script that always exited 0 would pass the
// clean cases and fail all the rest. Each failing case additionally asserts
// the specific rule text (`R1` / `R2`) and the offending path, so a script
// that failed for some *other* reason would not satisfy them either.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'memory-append-check.sh');

const trash = [];
afterAll(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function run(cwd, args = []) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

const ARCHIVE = [
  '# Decisions',
  '',
  'Architectural / process decisions.',
  '',
  '## 2026-09-01 — BASE-1 an entry that was already here',
  '',
  '- `2026-09-01` (BASE-1) — **A row with real length to it.** It runs onto a',
  '  second line, as these entries do.',
  '',
  '',
  '## 2026-09-02 — BASE-2 a second entry, after a double blank',
  '',
  '- `2026-09-02` (BASE-2) — **Another row.**',
  '',
].join('\n');

/**
 * A repo on `main` with a memory archive, plus a `work` branch to commit on.
 * The base ref every case measures against is `main`.
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'memcheck-'));
  trash.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, '.claude', 'memory'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'memory', 'decisions.md'), ARCHIVE);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-q', '-b', 'work');
  return dir;
}

function commit(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
}

function writeShard(dir, taskId, body = `- \`2026-09-19\` (${taskId}) — **A row.**\n`) {
  mkdirSync(join(dir, '.claude', 'memory', 'decisions'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'memory', 'decisions', `2026-09-19-${taskId}.md`), body);
}

const archivePath = (dir) => join(dir, '.claude', 'memory', 'decisions.md');

describe('memory-append-check.sh', () => {
  it('passes a shard-only branch with zero deletions', () => {
    const dir = makeRepo();
    writeShard(dir, 'TASK-415');
    commit(dir, 'TASK-415 memory');

    const r = run(dir, ['main']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/shard-only with zero deletions/);
  });

  it('passes when the branch changed nothing under .claude/memory/', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    commit(dir, 'unrelated');

    const r = run(dir, ['main']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/nothing under \.claude\/memory\/ changed/);
  });

  it('R2: fails a branch that appends to a root archive, even with zero deletions', () => {
    const dir = makeRepo();
    writeFileSync(archivePath(dir), `${ARCHIVE}\n## 2026-09-19 — TASK-415 a row\n`);
    commit(dir, 'TASK-415 memory');

    // Establish the premise: this really is a pure append. If it ever stops
    // being one, this case would be passing for the wrong reason.
    const [, deleted] = git(dir, 'diff', '--numstat', 'main', 'HEAD', '--', '.claude/memory/')
      .split('\t')
      .map(Number);
    expect(deleted, 'the fixture must be a PURE append for R2 to be what fails').toBe(0);

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/decisions\.md: root archive edited/);
    expect(r.stderr).toMatch(/R2/);
    expect(r.stderr).toMatch(/--shard/); // tells you what to do instead
  });

  it('R1: fails a branch that deletes a line from a root archive', () => {
    const dir = makeRepo();
    writeFileSync(
      archivePath(dir),
      ARCHIVE.split('\n')
        .filter((l) => !l.startsWith('- `2026-09-02`'))
        .join('\n'),
    );
    commit(dir, 'drop a row');

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/decisions\.md: \d+ line\(s\) DELETED/);
    expect(r.stderr).toMatch(/R1/);
  });

  it('R1: fails the real shape — rows added, blank runs collapsed elsewhere', () => {
    // This is the measured incident, reconstructed. The branch's own row is
    // added and intact; what fails is the unrelated whole-file normalization
    // that came with it. "My rows survived" would report success here.
    const dir = makeRepo();
    const normalized = `${ARCHIVE.replace(/\n\n\n/g, '\n\n')}\n## 2026-09-19 — TASK-415 a row\n`;
    writeFileSync(archivePath(dir), normalized);
    commit(dir, 'TASK-415 memory + tidy');

    expect(normalized, 'the fixture must really have added the row').toContain('TASK-415 a row');

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/R1/);
  });

  it('R1 applies to shards too — a branch may not delete another task shard', () => {
    // Shards remove the collision; they do not license deleting someone
    // else's file on the way past.
    const dir = makeRepo();
    writeShard(dir, 'TASK-100');
    commit(dir, 'TASK-100 memory');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'work');
    git(dir, 'checkout', '-q', '-b', 'work2');

    rmSync(join(dir, '.claude', 'memory', 'decisions', '2026-09-19-TASK-100.md'));
    writeShard(dir, 'TASK-415');
    commit(dir, 'TASK-415 memory');

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/2026-09-19-TASK-100\.md: \d+ line\(s\) DELETED/);
    // The shard it legitimately added is NOT reported.
    expect(r.stderr).not.toMatch(/TASK-415\.md/);
  });

  it('reports every violation, not just the first', () => {
    const dir = makeRepo();
    writeFileSync(archivePath(dir), ARCHIVE.replace('## 2026-09-02', '## 2026-09-03'));
    mkdirSync(join(dir, '.claude', 'memory', 'patterns'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'memory', 'patterns', '2026-09-19-TASK-415.md'), 'a\n');
    writeFileSync(join(dir, '.claude', 'memory', 'mistakes.md'), 'new root archive\n');
    commit(dir, 'several things at once');

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/decisions\.md/);
    expect(r.stderr).toMatch(/mistakes\.md/);
    expect(r.stderr).toMatch(/3 issue\(s\)/); // decisions: R1 + R2, mistakes: R2
  });

  it('a Memory-Rewrite trailer waives both rules and says so', () => {
    const dir = makeRepo();
    writeFileSync(archivePath(dir), ARCHIVE.replace('## 2026-09-02', '## 2026-09-03'));
    commit(dir, 'hygiene pass\n\nMemory-Rewrite: consolidating Q2 rows into ## Archived');

    const r = run(dir, ['main']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WAIVED by a commit trailer/);
    expect(r.stderr).toMatch(/consolidating Q2 rows/);
    // Still tells you what it waived, rather than going quiet.
    expect(r.stderr).toMatch(/R1|R2/);
  });

  it.each([
    [
      'documenting the mechanism in prose',
      'explain the guard\n\nThe escape hatch is a trailer:\nMemory-Rewrite: some reason\n\nThat is all it takes.\n',
    ],
    [
      'quoting it mid-body, indented',
      'notes\n\nSomeone wrote:\n  Memory-Rewrite: consolidating rows\n\nand it worked.\n',
    ],
  ])('prose cannot waive — %s', (_label, message) => {
    // The waiver is a TRAILER, and the distinction is load-bearing. A grep of
    // the whole commit body for `^Memory-Rewrite:` matches the string anywhere
    // in any message in the range, so a commit that merely quotes the line —
    // documenting it, reverting a waived commit, or arriving from another
    // branch — would waive real violations. Git's own trailer parser reads
    // only the trailer block.
    //
    // Honest about which case does the work: only the FIRST discriminates
    // against the old body-grep (measured — swapping the trailer parser back
    // reddens that one and not this pair). The indented case would have passed
    // either way, because `^Memory-Rewrite:` is line-anchored and the quote is
    // indented. It is kept as a correct assertion about indentation, not
    // claimed as proof of this fix.
    const dir = makeRepo();
    writeFileSync(archivePath(dir), ARCHIVE.replace('## 2026-09-02', '## 2026-09-03'));
    commit(dir, message);

    // Premise: the string really is present in the message, so a body grep
    // WOULD have matched. Without this the case could pass for the wrong reason.
    expect(git(dir, 'log', '--format=%B', '-1')).toMatch(/Memory-Rewrite:/);

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/WAIVED/);
  });

  it('a git too old to expand %(trailers:key=...) waives NOTHING, loudly', () => {
    // Direction matters here and nowhere else in this script. Git emits an
    // UNSUPPORTED pretty placeholder LITERALLY rather than failing, so on a
    // git too old to expand it the expansion is the format string itself — non-empty
    // for every commit, i.e. a waiver on everything. A waiver that silently
    // stops working is a nuisance; one that silently starts working deletes
    // the guard.
    //
    // Simulated with a `git` shim earlier on PATH that answers any
    // `%(trailers:` format with the literal placeholder and delegates
    // everything else to the real git — which is what an old git does.
    const dir = makeRepo();
    writeFileSync(archivePath(dir), ARCHIVE.replace('## 2026-09-02', '## 2026-09-03'));
    commit(dir, 'hygiene pass\n\nMemory-Rewrite: a genuine reason\n');

    // Control: with the real git, this commit DOES waive. Without this the
    // test could pass because the fixture never waived in the first place.
    expect(run(dir, ['main']).status, 'fixture must waive under a modern git').toBe(0);

    const shimDir = mkdtempSync(join(tmpdir(), 'oldgit-'));
    trash.push(shimDir);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in\n    *'%(trailers:'*) echo '%(trailers:key=Memory-Rewrite,valueonly)'; exit 0 ;;\n  esac\ndone\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );

    const r = spawnSync('bash', [SCRIPT, 'main'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot expand %\(trailers:key=\.\.\.\)/);
    expect(r.stderr).not.toMatch(/WAIVED/);
  });

  it('a real trailer still waives when it sits beside other trailers', () => {
    // The commits on this repo's branches carry Co-Authored-By and
    // Claude-Session trailers, so the waiver has to survive company.
    const dir = makeRepo();
    writeFileSync(archivePath(dir), ARCHIVE.replace('## 2026-09-02', '## 2026-09-03'));
    commit(
      dir,
      'hygiene pass\n\nMemory-Rewrite: folding Q2 shards into the archive\nCo-Authored-By: Someone <s@example.com>\n',
    );

    const r = run(dir, ['main']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WAIVED by a commit trailer/);
    expect(r.stderr).toMatch(/folding Q2 shards/);
  });

  it('the failure text does not hand an agent a paste-ready waiver line', () => {
    // A guard that prints the one line making CI green is coaching the
    // automated writers it exists to police. The shard command is the answer
    // it should be giving; the waiver is documented in CLAUDE.md for a human.
    const dir = makeRepo();
    writeFileSync(archivePath(dir), `${ARCHIVE}\n## 2026-09-19 — TASK-415 a row\n`);
    commit(dir, 'TASK-415 memory');

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--shard/); // the answer it SHOULD give
    // The rule is the strong one: the failure text does not NAME the trailer
    // at all. An earlier version asserted `/Memory-Rewrite:[ \t]*\S/`, which
    // a line-wrapped reintroduction (`Memory-Rewrite:` then the reason on the
    // next line) would have slipped straight past, since `[ \t]` does not
    // cross a newline. Not naming it is also simply easier to keep true.
    expect(r.stderr).not.toContain('Memory-Rewrite');
  });

  it('an empty or whitespace-only Memory-Rewrite trailer waives nothing', () => {
    const dir = makeRepo();
    writeFileSync(archivePath(dir), ARCHIVE.replace('## 2026-09-02', '## 2026-09-03'));
    commit(dir, 'hygiene pass\n\nMemory-Rewrite:   ');

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/WAIVED/);
  });

  it('fails a file under .claude/memory/ that git cannot line-diff', () => {
    // Zero-deletions is unprovable on a file git reports as binary, and an
    // unprovable claim is not a passing one.
    const dir = makeRepo();
    mkdirSync(join(dir, '.claude', 'memory', 'decisions'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'memory', 'decisions', '2026-09-19-TASK-415.md'),
      Buffer.from([0x68, 0x69, 0x00, 0x0a]),
    );
    commit(dir, 'TASK-415 memory');

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot line-diff/);
  });

  it('R2: still sees a root archive whose name git would QUOTE', () => {
    // Regression, and it bit while this script was being written. Without
    // `-z`, git quotes any path holding a space or a non-ASCII byte
    // (`".claude/memory/w\303\251ird note.md"`), and a quoted path no longer
    // starts with the prefix R2 strips — so precisely the odd filename you
    // would want flagged reads as a well-behaved shard. The `-z` fix then has
    // a second trap behind it: bash cannot hold a NUL in a variable, so
    // `$(git … -z)` loses the separators, `read -d ''` hits EOF, `read`
    // returns nonzero and the `while` body never runs. That reports a cheerful
    // `ok` on a diff nobody examined. Both mistakes are invisible except here.
    const dir = makeRepo();
    writeFileSync(join(dir, '.claude', 'memory', 'wéird note.md'), 'a root archive\n');
    commit(dir, 'add an oddly named archive');

    // Premise check: this really is a path git would quote without `-z`.
    expect(
      git(dir, 'diff', '--numstat', 'main', 'HEAD', '--', '.claude/memory/'),
    ).toMatch(/^1\t0\t"/);

    const r = run(dir, ['main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/root archive edited/);
    expect(r.stderr).toMatch(/wéird note\.md/);
  });

  it('sees the same violations when run from a subdirectory', () => {
    // Regression, measured on this branch. A bare `.claude/memory/` pathspec
    // is resolved relative to the CURRENT DIRECTORY, so `cd scripts && bash
    // ../scripts/memory-append-check.sh` matched nothing and reported
    // "nothing under .claude/memory/ changed — ok" on a branch that had
    // rewritten an archive. A guard that passes depending on where you stand
    // is worse than no guard: it is a green tick with no subject.
    const dir = makeRepo();
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'placeholder.txt'), 'x\n');
    writeFileSync(archivePath(dir), ARCHIVE.replace('## 2026-09-02', '## 2026-09-03'));
    commit(dir, 'rewrite an archive');

    const fromRoot = run(dir, ['main']);
    const fromSubdir = run(join(dir, 'scripts'), ['main']);

    expect(fromRoot.status).toBe(1);
    expect(fromSubdir.status, fromSubdir.stdout + fromSubdir.stderr).toBe(1);
    // Same verdict AND the same paths, which are repo-relative either way.
    expect(fromSubdir.stderr).toMatch(/\.claude\/memory\/decisions\.md/);
    expect(fromSubdir.stderr).toMatch(/R1/);
    expect(fromSubdir.stderr).toMatch(/R2/);
  });

  it('exits 2 on an unresolvable base ref — a check that did not run is not a pass', () => {
    const dir = makeRepo();
    writeShard(dir, 'TASK-415');
    commit(dir, 'TASK-415 memory');

    const r = run(dir, ['origin/nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot resolve base ref 'origin\/nope'/);
    expect(r.stderr).toMatch(/not treating that as a pass/i);
  });

  it('exits 2 outside a git repository, and 2 on too many arguments', () => {
    const outside = mkdtempSync(join(tmpdir(), 'memcheck-bare-'));
    trash.push(outside);
    // `git init` is deliberately NOT run here.
    const r = run(outside, ['main']);
    expect(r.status).toBe(2);

    const dir = makeRepo();
    expect(run(dir, ['main', 'extra']).status).toBe(2);
  });

  it('measures the merge base, not the tip, so an out-of-date branch still passes', () => {
    // A builder's branch is routinely several merges behind `main`. Those
    // other merges' memory shards must not be attributed to this branch.
    const dir = makeRepo();
    writeShard(dir, 'TASK-415');
    commit(dir, 'TASK-415 memory');
    const branchTip = git(dir, 'rev-parse', 'HEAD');

    git(dir, 'checkout', '-q', 'main');
    writeShard(dir, 'TASK-999');
    commit(dir, 'TASK-999 memory from somebody else');
    // main also rewrote an archive, which this branch must not be blamed for.
    writeFileSync(archivePath(dir), ARCHIVE.replace('## 2026-09-02', '## 2026-09-03'));
    commit(dir, 'somebody else rewrote the archive');

    git(dir, 'checkout', '-q', branchTip);
    const r = run(dir, ['main']);
    expect(r.status, r.stderr).toBe(0);
  });

  it('defaults its base ref to origin/main', () => {
    const dir = makeRepo();
    // No `origin` remote exists, so the default must be what fails to resolve.
    const r = run(dir, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot resolve base ref 'origin\/main'/);
  });

  it('is executable and is valid bash', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    expect(readFileSync(SCRIPT, 'utf8').startsWith('#!/usr/bin/env bash')).toBe(true);
  });
});
