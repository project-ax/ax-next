// Guard: eslint must ignore agent worktree copies of the repo.
//
// Why this exists (TASK-309). Agent dispatch in this repo is mandatorily
// worktree-isolated, so a linked worktree -- a FULL copy of the repo -- is
// almost always sitting under `.worktrees/`, `.claude/worktrees/`, or a stray
// `*/worktrees/` directory. `.gitignore:30-31` ignores those, but
// `eslint.config.mjs` did not, so `eslint .` walked every copy: it
// double-reported every real finding and resurrected long-deleted code. Three
// sessions in a row "fixed" this by sweeping worktrees, and the very next
// dispatch undid the sweep. Worse, `git worktree list` only knows about
// REGISTERED worktrees -- the file that actually reddened lint was an
// unregistered stray placeholder under `.claire/worktrees/`, which no sweep
// could ever have found.
//
// TWO globs are required, not one. Measured against ESLint's own
// `isPathIgnored`: `**/worktrees/**` does cross dot-segments (so it covers
// `.claude/worktrees/**` and `.claire/worktrees/**`), but it does NOT match
// `.worktrees/**` -- `.worktrees` is a DIFFERENT directory name, not a
// `worktrees` directory. `.gitignore` lists the two patterns separately for
// exactly this reason.
//
// The last assertion is the over-ignore guard, and it is the point of this
// test as much as the first three: it fails if someone later "simplifies" the
// globs into something that silently stops linting real source. Broadening an
// ignore is the kind of change that looks harmless in a diff and turns lint
// into a no-op.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally
// (same pattern as no-workspace-build-in-tests.test.js and
// no-raw-nul-bytes.test.js) -- no network, no build.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Resolved against the real eslint.config.mjs at the repo root -- not a
// fixture -- so the assertions below describe the config the developer's
// `pnpm lint` actually uses.
const eslint = new ESLint({ cwd: REPO_ROOT });

// Warm the flat-config load ONCE, off the per-test clock (TASK-331).
//
// `new ESLint(...)` above is lazy; the first `isPathIgnored` call is what
// actually resolves `eslint.config.mjs` and pulls in typescript-eslint and
// every plugin it references. That cost used to land inside whichever `it` ran
// first, which made this file's first test the slowest in the whole
// `pnpm test:scripts` suite by 2.7x -- ~1.1s idle, against what was then
// vitest's undeclared 5_000ms default. Measured under CPU oversubscription it
// scales the way any cold module graph does: 2_693ms at 2x, 3_959ms at 6x,
// 7_207ms at 11x, where it fails 6 runs in 10. The resulting summary line reads
// `Tests  1 failed | 152 passed (153)` -- a timeout is counted in the collected
// total, so it wears an assertion failure's costume and sent TASK-331 hunting a
// product race that did not exist.
//
// Warming it here leaves each assertion below measuring only a cached lookup
// (~1ms), so contention can make this file slow but can no longer make it
// WRONG. The 120_000 argument overrides the config's `hookTimeout`; it is
// deliberately far past any observed cold load, because a hook that is merely
// slow should report as slow and a hook that has genuinely hung should be the
// only thing this budget ever catches.
//
// The warmed path is deliberately NOT one of the paths asserted below, and the
// result is deliberately discarded. What is being warmed is the config
// resolution, which any path triggers; warming with a path under test would move
// that path's first real failure out of its named `it` and into this hook, where
// the reason for the run being red is harder to read.
beforeAll(async () => {
  await eslint.isPathIgnored(join(REPO_ROOT, 'eslint.config.mjs'));
}, 120_000);

const IGNORED = [
  // The default location `git worktree add` is pointed at here.
  '.worktrees/TASK-1/packages/core/src/index.ts',
  // Where agent dispatch actually puts its isolated worktrees.
  '.claude/worktrees/TASK-1/packages/core/src/index.ts',
  // A stray, unregistered copy -- the case that reddened lint for real.
  '.claire/worktrees/credentials-ux-redesign/packages/channel-web/src/x.tsx',
];

describe('eslint ignores worktree copies of the repo', () => {
  for (const relPath of IGNORED) {
    it(`ignores ${relPath}`, async () => {
      await expect(eslint.isPathIgnored(join(REPO_ROOT, relPath))).resolves.toBe(true);
    });
  }

  // Over-ignore guard. If this flips to `true`, the worktree globs have been
  // broadened into something that stops linting the real tree.
  it('still lints real source outside a worktree copy', async () => {
    await expect(
      eslint.isPathIgnored(join(REPO_ROOT, 'packages/core/src/index.ts')),
    ).resolves.toBe(false);
  });

  // The same guard at the boundary the two-glob design actually rests on:
  // `worktrees` must match as a path SEGMENT, never as a substring. This
  // file's own NAME contains the substring, so it is the canary for a glob
  // that drops the trailing `/**` -- `'**/*worktree*'` (measured) ignores
  // this very test, while every other assertion here stays green. Keeping
  // the `/**` is what confines the match to directory segments.
  it('matches worktrees as a path segment, not as a substring', async () => {
    await expect(
      eslint.isPathIgnored(
        join(REPO_ROOT, 'scripts/__tests__/eslint-ignores-worktrees.test.js'),
      ),
    ).resolves.toBe(false);
  });
});
