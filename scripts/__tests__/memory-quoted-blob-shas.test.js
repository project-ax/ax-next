// Guard: a blob sha quoted in `.claude/memory/` must still be that file's blob.
//
// WHY THIS EXISTS (TASK-415, and it exists because the same defect happened
// TWICE in one branch). Memory rows here record mutation-testing results —
// "mutant X reddens N tests" — and a mutant count is a measurement of ONE
// SPECIFIC VERSION of a file. To make that reproducible the row names the
// blob it measured. Then the script changed in a later commit, the row did
// not, and the sha pointed at nothing. A reviewer who re-ran the mutants — as
// this repo's culture tells everyone to — got different numbers and a sha
// matching no object. Round 1 caught it, it was fixed by re-measuring, and
// then a further commit made the freshly-written sha stale again.
//
// Prose cannot be trusted to track a file it merely mentions. This turns the
// convention into something that fails loudly: quote a blob sha and the sha
// is checked; change the file without re-measuring and the suite goes red in
// the same run that would have shipped the wrong number.
//
// THE CONVENTION. In any `.claude/memory/**/*.md`, write a measured-against
// reference as exactly:
//
//     `<repo-relative path>` blob `<sha>…`
//
// The sha may be abbreviated (7+ hex chars); a trailing ellipsis is optional
// and may be written `…` or `...`. The path must be a real tracked file.
//
// WHAT THIS DOES NOT COVER, stated plainly so nobody reads a green run as more
// than it is:
//
//   - It is an accident-catcher, not an adversarial control. Anything not in
//     the shape above is ordinary prose and is ignored, so rewording a row
//     stops it being checked — and the "at least one claim" floor below is
//     GLOBAL, so another row keeping the count above zero hides that. Closing
//     it properly needs either a near-miss detector (false positives on
//     ordinary prose) or a registry of must-check rows, which is the
//     allowlist rot `memory-cited-paths-exist.test.js` explicitly refuses.
//     Someone evading this guard could equally just delete the row.
//   - It only sees `.claude/memory/`. The same class of unguarded measurement
//     lives in ordinary code comments, where nothing checks it — a comment in
//     `packages/memory-strata/test/bench/corpora/internal.ts` picked up two
//     such numbers in the very commit that added this guard.
//
// WHEN THIS GOES RED: do NOT just edit the sha to match. The sha is a label on
// a MEASUREMENT. If the file changed, the measurement is stale too — re-run
// the mutants against the new blob and update both, or delete the claim. An
// updated sha beside a number nobody re-measured is the exact failure this
// guard exists to stop, wearing a green tick.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEMORY_DIR = join(REPO_ROOT, '.claude', 'memory');

/**
 * `path` + blob sha, e.g. ``  `scripts/x.sh` blob `a1b2c3d4…`  ``
 *
 * Both ellipsis spellings, because `…?` alone silently skipped a row written
 * with three ASCII dots — a false NEGATIVE, i.e. the one failure direction a
 * staleness guard must not have.
 */
const BLOB_CLAIM = /`([^`\n]+?)`\s+blob\s+`([0-9a-f]{7,40})(?:…|\.\.\.)?`/g;

/** Every memory `.md`: the root archives plus one level of per-task shards. */
function memoryMarkdownFiles() {
  if (!existsSync(MEMORY_DIR)) return [];
  const entries = readdirSync(MEMORY_DIR, { withFileTypes: true });
  return [
    ...entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name),
    ...entries
      .filter((e) => e.isDirectory())
      .flatMap((d) =>
        readdirSync(join(MEMORY_DIR, d.name), { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => join(d.name, e.name)),
      ),
  ];
}

const claims = memoryMarkdownFiles().flatMap((name) => {
  const text = readFileSync(join(MEMORY_DIR, name), 'utf8');
  return [...text.matchAll(BLOB_CLAIM)].map((m) => {
    const before = text.slice(0, m.index);
    return {
      file: name,
      line: before.split('\n').length,
      path: m[1],
      sha: m[2],
    };
  });
});

/** The blob sha of the file as it stands in the working tree. */
function blobOf(path) {
  return execFileSync('git', ['hash-object', '--', path], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

function isTracked(path) {
  return (
    execFileSync('git', ['ls-files', '--', path], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== ''
  );
}

describe('blob shas quoted in .claude/memory are current', () => {
  // Anti-vacuity. This whole file is a no-op if the regex stops matching —
  // a renamed convention, a reworded row, a backtick that became a quote —
  // and a no-op guard is indistinguishable from a passing one. The repo has
  // carried at least one such claim since TASK-415; if that stops being true,
  // this assertion is the thing that says so rather than the suite quietly
  // checking nothing.
  it('found at least one blob claim to check', () => {
    // Known limit, accepted deliberately: this floor is GLOBAL. It says the
    // convention is still in use somewhere, not that any particular row is
    // still checked. It also means that if the last blob claim in the repo is
    // ever legitimately retired, this goes red with nothing actually wrong —
    // at which point delete this file rather than inventing a row to satisfy
    // it. The guard exists to serve the claims, not the other way round.
    expect(
      claims.length,
      'blob claims in .claude/memory (pattern: `path` blob `sha…`)',
    ).toBeGreaterThan(0);
  });

  it('every quoted path is a tracked file', () => {
    const missing = claims
      .filter((c) => !isTracked(c.path))
      .map((c) => `  .claude/memory/${c.file}:${c.line}  claims a blob for \`${c.path}\``);

    expect(
      missing,
      'A memory row quotes a blob sha for a path git does not track.\n' +
        'Either the file moved (fix the path AND re-measure) or the backticked\n' +
        'text was never a path at all (reword it so it does not read as one).\n\n' +
        `${missing.join('\n')}\n`,
    ).toEqual([]);
  });

  it('every quoted blob sha matches the file as it stands now', () => {
    const stale = claims
      .filter((c) => isTracked(c.path))
      .filter((c) => !blobOf(c.path).startsWith(c.sha))
      .map(
        (c) =>
          `  .claude/memory/${c.file}:${c.line}  says \`${c.path}\` is blob \`${c.sha}…\`\n` +
          `    but it is now ${blobOf(c.path).slice(0, c.sha.length)}…`,
      );

    expect(
      stale,
      'A memory row quotes a blob sha that is no longer that file.\n\n' +
        'DO NOT just update the sha. The sha labels a MEASUREMENT (mutation counts,\n' +
        'usually). If the file changed, the measurement is stale too — re-run it\n' +
        'against the new blob and update both numbers and sha, or drop the claim.\n' +
        'A fresh sha beside a number nobody re-measured is precisely the failure\n' +
        'this guard exists to stop, wearing a green tick.\n\n' +
        `${stale.join('\n')}\n`,
    ).toEqual([]);
  });
});
