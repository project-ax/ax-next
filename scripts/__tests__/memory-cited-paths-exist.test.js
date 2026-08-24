// Guard: every repo file path cited in `.claude/memory/*.md` must still exist.
//
// Why this exists. The agent-workspace epic's dominant defect is not code, it is
// prose that misleads the next reader -- including the prose that generates the
// next task card. Four sessions running, cards were filed FROM a stale memory
// line rather than from the code, and 19+ false comments were found and fixed in
// a single session. A moved file is the cheapest and most common form of that
// rot: `@ax/agent-runner-core` was extracted from `@ax/agent-claude-sdk-runner`
// in #395, and two memory rows kept pointing at the old package for months.
// Nothing in the repo noticed, because nothing reads prose.
//
// This guard is deliberately narrow, and the narrowness is the design. A first
// draft asserted that every *symbol* named in memory still exists too. Measured
// against the corpus, that check was worthless-to-harmful:
//
//   * 187 hook-shaped names (`skills:approved-caps-list`) -- 187 resolve. Zero
//     findings.
//   * 146 SCREAMING_SNAKE constants (`DISABLED_BUILTINS`) -- 146 resolve. Zero
//     findings.
//   * 73 `@ax/<pkg>` names -- 8 do not resolve, and SIX of those are correct
//     prose. `decisions.md` has an "Alternatives rejected" column, so it is
//     structurally full of deliberate references to things that do not exist:
//     "`@ax/database-sqlite` doesn't exist" is a true sentence that a
//     package-existence guard flags as rot.
//
// So a symbol guard here would have been vacuous at best and a false-positive
// generator at worst -- on an epic whose whole subject is false claims in
// memory, that is the last thing to add. Paths are the class that measured
// clean: 150 checkable citations, 5 flagged, and after the two gates below, 4
// flagged and all 4 genuinely rotten.
//
// THE TWO GATES, and why each is load-bearing rather than a convenience:
//
//   1. The containing directory must be TRACKED IN GIT. Memory prose cites three
//      kinds of path that look repo-relative and are not: build output
//      (`dist/main.js`, meaning the compiled file inside a container image),
//      dependency source (`node_modules/ai/src/ui/chat.ts`), and paths inside an
//      *agent's* memory tree, which collide with real repo directories
//      (`docs/entity/rome.md`, `system/map.md`). Requiring the parent directory
//      to be tracked removes all three without a hand-maintained allowlist --
//      `docs/plans/` is tracked so it is checked, `docs/entity/` is not a repo
//      directory at all so it is not.
//
//   2. Paths git DELIBERATELY IGNORES are skipped. `mistakes.md` correctly
//      describes `.claude/auto-ship-board.sh` as gitignored run state generated
//      from a heredoc in a skill doc. Its absence from a clean checkout is the
//      point of the sentence, not a defect in it.
//
//   Plus: any token containing `...` is an author's deliberate elision
//   (`presets/k8s/.../acceptance.test.ts`, `packages/.../foo.ts`), never a claim
//   that that literal path exists.
//
// A citation is satisfied by a TRACKED file, not merely a present one. Deleted
// packages leave stale `dist/` and `node_modules/` behind (`packages/auth-oidc/`
// is on disk right now and gone from git), and a citation those directories
// happen to satisfy is still rot.
//
// WHEN THIS GOES RED: fix the memory file, not this test. The path moved, was
// renamed, or was never committed -- find where it went and update the prose.
// If the citation is to something that legitimately does not exist (a rejected
// alternative, a doc that never landed), rewrite the sentence so it does not
// read as a live file reference. Do not add an allowlist: the moment this grows
// an exceptions list, the exceptions list becomes the next thing that rots.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally --
// no network, no build. Same pattern as the sibling guards in this directory.

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEMORY_DIR = join(REPO_ROOT, '.claude', 'memory');

/**
 * A path-shaped token: at least one slash, a dotted extension, and an optional
 * `:line` or `:line-line` suffix that is stripped before resolution. This guard
 * asserts the FILE exists; it says nothing about what is on the line, which is
 * why `.claude/memory/` prefers citing the file and not the line.
 */
const PATH_TOKEN = /^([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@-]+)+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?$/;

/** Every backticked span on a line, so a finding can name file:line. */
function citations(markdown) {
  const found = [];
  markdown.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      found.push({ line: i + 1, token: match[1].trim() });
    }
  });
  return found;
}

/** Every file git tracks, and every directory implied by one. */
function trackedPaths() {
  const files = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean);

  const dirs = new Set();
  for (const file of files) {
    const segments = file.split('/');
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'));
  }
  return { files: new Set(files), dirs };
}

/**
 * The subset of `paths` that git deliberately ignores. One batched call --
 * `check-ignore` exits 1 when nothing matches, which is not an error here.
 */
function gitIgnored(paths) {
  if (paths.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: REPO_ROOT,
      input: paths.join('\n'),
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch (err) {
    // Exit 1 means "none of these are ignored" and arrives with empty stdout.
    // Any other failure is a broken invocation and must not pass silently.
    if (err.status === 1) return new Set(String(err.stdout ?? '').split('\n').filter(Boolean));
    throw err;
  }
}

const memoryFiles = readdirSync(MEMORY_DIR).filter((name) => name.endsWith('.md'));
const tracked = trackedPaths();

/** Every path-shaped citation, before the gates, so the gates can be asserted. */
const allCitations = memoryFiles.flatMap((name) =>
  citations(readFileSync(join(MEMORY_DIR, name), 'utf8'))
    .map((c) => ({ ...c, file: name, path: PATH_TOKEN.exec(c.token)?.[1] }))
    .filter((c) => c.path),
);

const elided = allCitations.filter((c) => c.token.includes('...'));
const literal = allCitations.filter((c) => !c.token.includes('...'));
const inTrackedDir = literal.filter((c) =>
  tracked.dirs.has(c.path.slice(0, c.path.lastIndexOf('/'))),
);
const ignored = gitIgnored(inTrackedDir.map((c) => c.path));
const checkable = inTrackedDir.filter((c) => !ignored.has(c.path));

describe('.claude/memory citations point at files that exist', () => {
  // Anti-vacuity. Every gate above can only ever SHRINK the checked set, so a
  // parser that stops matching, a `git ls-files` that comes back empty, or a
  // `check-ignore` that starts matching everything would each turn this whole
  // file green while guarding nothing. Each input is proved non-trivial before
  // anything is asserted. Measured at the time of writing: 5 memory files, 408
  // path-shaped tokens, 150 checkable.
  it('parsed real data out of the memory files', () => {
    expect(memoryFiles.length, 'memory .md files').toBeGreaterThanOrEqual(5);
    expect(tracked.files.size, 'git-tracked files').toBeGreaterThan(1000);
    expect(allCitations.length, 'path-shaped citations').toBeGreaterThan(200);
    expect(checkable.length, 'citations surviving both gates').toBeGreaterThan(100);
  });

  it('every cited repo path is a tracked file', () => {
    const missing = checkable
      .filter((c) => !tracked.files.has(c.path))
      .map((c) => `  .claude/memory/${c.file}:${c.line}  cites \`${c.token}\``);

    expect(
      missing,
      'A memory file cites a repo path that no longer exists.\n' +
        'Fix the MEMORY FILE, not this test -- the file moved, was renamed, or was ' +
        'never committed. Find where it went and update the prose; a stale path is ' +
        'how a session files a task card against code that is not there.\n' +
        'If the citation is to something that legitimately does not exist (a rejected ' +
        'alternative, a design doc that never landed), rewrite the sentence so it does ' +
        'not read as a live file reference. Do NOT add an allowlist here.\n\n' +
        `${missing.join('\n')}\n`,
    ).toEqual([]);
  });

  // The gates carry the guard's precision, so they are asserted directly rather
  // than trusted. Without these, a gate could widen until it swallowed every
  // real finding and the assertion above would stay green.
  describe('the gates admit real claims and reject non-claims', () => {
    it('checks a path whose directory is tracked', () => {
      const dir = 'packages/core/src';
      expect(tracked.dirs.has(dir), `${dir} should be a tracked directory`).toBe(true);
      expect(tracked.files.has('packages/core/src/index.ts')).toBe(true);
      // The canary: a path in that same tracked directory that does not exist
      // must be something this guard WOULD flag. If this ever fails, the
      // detector has stopped detecting.
      expect(tracked.files.has('packages/core/src/definitely-not-a-real-file.ts')).toBe(false);
    });

    it('skips paths whose directory is not tracked', () => {
      // Build output, dependency source, and agent-memory-tree paths all look
      // repo-relative. None of them is a claim about a file in this repo.
      for (const dir of ['dist', 'node_modules/ai/src/ui', 'docs/entity']) {
        expect(tracked.dirs.has(dir), `${dir} must NOT be a tracked directory`).toBe(false);
      }
    });

    it('skips paths git deliberately ignores', () => {
      // mistakes.md cites `.claude/auto-ship-board.sh` precisely BECAUSE it is
      // generated, gitignored run state. Its absence is the point of the
      // sentence. If this stops being ignored, that citation becomes a finding.
      expect(gitIgnored(['.claude/auto-ship-board.sh'])).toContain(
        '.claude/auto-ship-board.sh',
      );
    });

    it('skips tokens the author elided with an ellipsis', () => {
      // e.g. `presets/k8s/.../acceptance.test.ts` -- shorthand, never a literal
      // path. Asserted non-empty so the elision branch cannot rot into a no-op
      // that silently starts flagging every abbreviated citation.
      expect(elided.length, 'ellipsis-elided citations').toBeGreaterThan(0);
      for (const c of elided) expect(c.token).toContain('...');
    });
  });
});
