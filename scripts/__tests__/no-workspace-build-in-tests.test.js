// Guard: no test may run a WORKSPACE BUILD unconditionally under CI.
//
// Why this exists. `packages/cli/src/__tests__/e2e.test.ts` used to call
// `pnpm --filter '@ax/cli...' build` from `beforeAll` — 71 of 76 workspace
// projects, including channel-web's `vite build` (rollup + minify, the heaviest
// step in the repo). That ran INSIDE a vitest worker while pnpm was
// concurrently running other packages' suites and several testcontainer
// Postgres containers, on a 4-vCPU/16 GB `ubuntu-latest` runner.
//
// The result was a long-running CI flake with a deceptive signature: a worker
// gets OOM-killed, so the job fails with `Worker exited unexpectedly` /
// `Timeout terminating forks worker`, **zero failing assertions**, and the file
// it blames migrates between runs. It reddened `main` (on a docs-only commit)
// and three unrelated PRs before anyone traced it, because nothing about the
// symptom points at the cause. The repeat offender was
// `credentials-wiring.test.ts` — a SIBLING file of the build-spawning one, i.e.
// a concurrent fork of the very vitest instance detonating the build.
//
// CI already builds: the workflow runs `pnpm typecheck` (= `tsc --build` across
// every project reference) before the test step. A test that rebuilds is doing
// the pipeline's job, badly, at peak memory.
//
// This guard is a TRIPWIRE, not a proof: it flags a test that spawns a package
// manager with `build` and never mentions `process.env.CI`. That is deliberately
// crude — the point is that reintroducing this pattern has to be a conscious
// act with a comment attached, rather than something that silently reds CI
// again three months from now.
//
// Lives in scripts/__tests__/, which CI's `pnpm test:scripts` runs
// UNCONDITIONALLY (it is not gated on affected packages).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = ['packages', 'presets'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-web', '.git', '.worktrees']);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Every test file under the workspace roots. */
function testFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (TEST_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Does this source spawn a package manager with a `build` argument?
 *
 * Matches the argv-array shape the repo uses (`spawnSync('pnpm', [..., 'build'])`)
 * as well as a shell string, without trying to parse JavaScript — a false
 * positive here costs one comment, a false negative costs another month of
 * mystery CI reds.
 */
function spawnsAWorkspaceBuild(src) {
  // Comments are stripped FIRST. Without this the guard fired on
  // `test-harness/src/__tests__/mcp-server-stub.test.ts`, which spawns `node`
  // and merely MENTIONS `pnpm --filter @ax/test-harness build` in a hint
  // comment — a false positive that would have taught the next person to
  // distrust this guard, which is how tripwires die.
  const code = stripComments(src);
  const spawns = /\b(spawnSync|spawn|execSync|execFileSync|execFile)\s*\(/.test(code);
  if (!spawns) return false;
  const mentionsPm = /['"`](pnpm|npm|yarn)['"`]|\bpnpm /.test(code);
  if (!mentionsPm) return false;
  return /['"`]build['"`]|\bpnpm[^\n'"`]*\bbuild\b/.test(code);
}

/**
 * Remove `//` and block comments. Deliberately naive — it does not understand
 * `//` inside a string literal or a regex. For a tripwire that is the right
 * trade: the failure mode of over-stripping is a missed flag on a bizarre line,
 * and the failure mode of NOT stripping is the false positive above.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('no test runs a workspace build under CI', () => {
  const files = ROOTS.flatMap((r) => testFiles(join(REPO_ROOT, r)));

  it('finds test files to scan (the scan itself must not be vacuous)', () => {
    // Without this, a broken walk would make every assertion below trivially
    // true — the exact "assertion that cannot fail" this repo keeps getting
    // bitten by.
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((f) => f.endsWith(join('cli', 'src', '__tests__', 'e2e.test.ts'))),
    ).toBe(true);
  });

  it('never spawns a package-manager build without a CI guard', () => {
    const offenders = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (!spawnsAWorkspaceBuild(src)) continue;
      // The escape hatch: acknowledge CI explicitly. `e2e.test.ts` skips the
      // build when `process.env.CI` is set, which is what makes it legal here.
      if (/process\.env\.CI\b/.test(src)) continue;
      offenders.push(relative(REPO_ROOT, file));
    }

    expect(
      offenders,
      'These tests spawn a workspace build with no CI guard. Under CI the ' +
        'pipeline has already built (`pnpm typecheck`), and rebuilding from ' +
        'inside a vitest worker OOM-kills sibling forks — surfacing as ' +
        '"Worker exited unexpectedly" with zero failing assertions, blaming a ' +
        'different file each run. Skip the build when process.env.CI is set.',
    ).toEqual([]);
  });
});

/** Sanity: the matcher recognises the exact shape that caused the incident. */
describe('spawnsAWorkspaceBuild matcher', () => {
  it('matches the argv-array form that caused the flake', () => {
    expect(
      spawnsAWorkspaceBuild(
        `const r = spawnSync('pnpm', ['--filter', '@ax/cli...', 'build'], {});`,
      ),
    ).toBe(true);
  });

  it('matches a shell-string form', () => {
    expect(spawnsAWorkspaceBuild(`execSync('pnpm -r build');`)).toBe(true);
  });

  it('does not match an ordinary spawn', () => {
    expect(spawnsAWorkspaceBuild(`spawnSync('node', [entry, 'hi'], {});`)).toBe(
      false,
    );
  });

  it('does not match prose merely mentioning build', () => {
    expect(spawnsAWorkspaceBuild(`// we build the thing here\nconst x = 1;`)).toBe(
      false,
    );
  });

  // The exact false positive this guard produced on its first run.
  it('does not match a spawn of node whose COMMENT mentions a pnpm build', () => {
    const src = [
      "// hasn't been built — run `pnpm --filter @ax/test-harness build`.",
      "const child = spawn(process.execPath, [stubPath], {});",
    ].join('\n');
    expect(spawnsAWorkspaceBuild(src)).toBe(false);
  });

  it('still matches when the build spawn sits next to an unrelated comment', () => {
    const src = [
      '/* some block comment about pnpm */',
      "spawnSync('pnpm', ['--filter', '@ax/cli...', 'build'], {});",
    ].join('\n');
    expect(spawnsAWorkspaceBuild(src)).toBe(true);
  });
});
