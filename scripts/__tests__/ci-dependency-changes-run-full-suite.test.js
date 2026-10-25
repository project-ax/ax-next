// Guard: a PR that changes dependency resolution runs the FULL package suite in
// CI, and every other PR keeps the affected-packages selection.
//
// Why this exists (TASK-943). The PR test step in .github/workflows/ci.yml picks
// packages with pnpm's `...[$BASE_SHA]` filter. pnpm maps each changed file to
// the workspace project that contains it, and `pnpm-lock.yaml`, `patches/`,
// `pnpm-workspace.yaml` and the root `package.json` all live in the workspace
// ROOT, which the step excludes with `!{.}`. So a PR that touched only those
// selected nothing. #1029 (TASK-938) patched zod for every package, and CI
// printed "No affected workspace packages — package tests skipped". The full
// suite first ran on main, after the merge. The same holds for the other
// repo-wide inputs the step now lists: `.npmrc`, `.pnpmfile.cjs`,
// `tsconfig.base.json` and ci.yml itself.
//
// Why it RUNS the step instead of grepping it (TASK-392's lesson): a text scan
// for `pnpm-lock` passes against a script that mentions the file and branches on
// nothing. So this slices the step's `run: |` block out of ci.yml and runs it
// the way the runner does. A `run:` with no `shell:` gets `bash -e {0}` on
// Linux: errexit, no pipefail. Each case gets a throwaway git repo and a stub
// `pnpm` first on PATH that logs its argv and runs nothing. zsh plays no part
// here: this is a workflow step, not a skill block the Bash tool runs.
//
// Both directions are pinned. A step that ALWAYS ran the full suite would pass
// every dependency case, so the package, nested-manifest, docs-only and
// sandbox-protocol cases assert that it did not.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const STEP_NAME = 'Test (affected packages + dependents)';

/**
 * The `run: |` block of the step called `name`, dedented the way YAML reads a
 * literal block (the indent of its first non-blank line). Raw text, because no
 * YAML parser resolves from scripts/: only the root devDependencies are linked
 * there. Returns null when the step or its block can't be found, and the first
 * test turns that into a named failure.
 */
function stepRunScript(yaml, name) {
  const lines = yaml.split('\n');
  const indentOf = (line) => line.length - line.trimStart().length;
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (at === -1) return null;
  const stepIndent = indentOf(lines[at]);
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (indentOf(line) <= stepIndent) return null; // reached the next step
    if (!/^\s*run:\s*\|[-+]?\s*$/.test(line)) continue;
    const keyIndent = indentOf(line);
    const body = [];
    let blockIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (b.trim() === '') {
        body.push('');
        continue;
      }
      if (indentOf(b) <= keyIndent) break;
      blockIndent ??= indentOf(b);
      body.push(b.slice(blockIndent));
    }
    return `${body.join('\n').trimEnd()}\n`;
  }
  return null;
}

// Throwaway repos must not pick up the developer's git config (signing, hooks,
// default branch), so global and system config are switched off. Git's
// location variables are dropped too: run from a git hook or `rebase -x`, an
// inherited GIT_DIR would point every `add -A` and `commit` here at the REAL
// repository.
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];
const inherited = { ...process.env };
for (const name of GIT_LOCATION_VARS) delete inherited[name];
const GIT_ENV = {
  ...inherited,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

// Everything this file creates lives under one temp dir, removed by one
// retrying rmSync: `force` alone doesn't retry ENOTEMPTY, which a late
// `git gc --auto` can cause.
const ROOT = mkdtempSync(join(tmpdir(), 'ci-select-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

// Stand-in for pnpm. It logs one line per call, with each argument followed by
// \037 (the ASCII unit separator). It answers `list` with $STUB_AFFECTED, which
// plays the part of whatever pnpm's affected filter would have selected, and
// any `run test` exits with $STUB_TEST_STATUS. (No `${…}` in here: inside a
// template literal, even a String.raw one, that interpolates.)
const STUB = String.raw`#!/bin/sh
for a in "$@"; do printf '%s\037' "$a"; done >> "$PNPM_LOG"
printf '\n' >> "$PNPM_LOG"
prev=
for a in "$@"; do
  if [ "$a" = list ]; then
    if [ -n "$STUB_AFFECTED" ]; then printf '%s\n' "$STUB_AFFECTED"; fi
    exit 0
  fi
  if [ "$prev" = run ] && [ "$a" = test ]; then exit "$STUB_TEST_STATUS"; fi
  prev=$a
done
exit 0
`;

const WORKFLOW = readFileSync(CI_WORKFLOW, 'utf8');
const SCRIPT = stepRunScript(WORKFLOW, STEP_NAME);

/**
 * The lines of the step called `name`, from its `- name:` line up to the next
 * line at or left of its indent. Used to check the step's own keys (`shell:`),
 * which the run-block slice above never sees.
 */
function stepLines(yaml, name) {
  const lines = yaml.split('\n');
  const indentOf = (line) => line.length - line.trimStart().length;
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (at === -1) return null;
  const stepIndent = indentOf(lines[at]);
  const out = [lines[at]];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && indentOf(lines[i]) <= stepIndent) break;
    out.push(lines[i]);
  }
  return out;
}
const BIN = join(ROOT, 'bin');
mkdirSync(BIN);
writeFileSync(join(BIN, 'pnpm'), STUB, { mode: 0o755 });
const SCRIPT_FILE = join(ROOT, 'step.sh');
// A missing step still runs every case, and each one fails loudly on exit 99.
writeFileSync(SCRIPT_FILE, SCRIPT ?? 'exit 99\n');

const rootManifest = (over = {}) =>
  `${JSON.stringify(
    {
      name: 'fixture',
      private: true,
      packageManager: 'pnpm@10.33.2',
      scripts: { test: 'pnpm -r run test' },
      pnpm: { overrides: { 'left-pad@<1.3.0': '>=1.3.0' } },
      ...over,
    },
    null,
    2,
  )}\n`;

const BASE_TREE = {
  'package.json': rootManifest(),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'patches/left-pad@1.3.0.patch': '--- a/index.js\n+++ b/index.js\n',
  'packages/foo/package.json': '{ "name": "@ax/foo" }\n',
  'packages/foo/src/index.ts': 'export const foo = 1;\n',
  'packages/sandbox-protocol/src/index.ts': 'export const schema = 1;\n',
  'docs/notes.md': 'notes\n',
};

function put(dir, path, body) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
}

let repos = 0;

/**
 * Runs the step in a fresh repo whose PR commit applies `files` on top of
 * BASE_TREE. `affected` is what the stub prints for `list`, `base` overrides
 * BASE_SHA, and `testStatus` is the exit status of any `pnpm … run test`.
 * Returns the exit status, the output, and every pnpm call as an argv array.
 */
function runStep({ files, affected = '', base, testStatus = 0 }) {
  const repo = join(ROOT, `repo-${++repos}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [path, body] of Object.entries(BASE_TREE)) put(repo, path, body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'pr');
  for (const [path, body] of Object.entries(files)) put(repo, path, body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'pr');
  // Inside .git, so the log can never show up in the diff the step reads.
  const logFile = join(repo, '.git', 'pnpm-calls.log');
  const r = spawnSync('bash', ['-e', SCRIPT_FILE], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      BASH_ENV: '',
      PATH: `${BIN}:${process.env.PATH}`,
      BASE_SHA: base ?? baseSha,
      PNPM_LOG: logFile,
      STUB_AFFECTED: affected,
      STUB_TEST_STATUS: String(testStatus),
    },
  });
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const calls = log
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\x1f').slice(0, -1));
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls, baseSha };
}

const isFullSuite = (argv) =>
  (argv.includes('-r') || argv.includes('--recursive')) &&
  !argv.includes('--filter') &&
  argv.slice(-2).join(' ') === 'run test';
const isAffectedRun = (argv, base) =>
  argv.includes(`...[${base}]`) && argv.includes('!{.}') && argv.slice(-2).join(' ') === 'run test';

/** Exit 0, and the two repo-wide suites ran exactly once whichever branch was taken. */
function expectCleanRun(r) {
  const why = `${r.output}\npnpm calls: ${JSON.stringify(r.calls)}`;
  expect(r.status, why).toBe(0);
  expect(r.calls.filter((c) => c.join(' ') === 'test:eslint-rules'), why).toHaveLength(1);
  expect(r.calls.filter((c) => c.join(' ') === 'test:scripts'), why).toHaveLength(1);
}

function expectFullSuite(r) {
  expectCleanRun(r);
  const why = `pnpm calls: ${JSON.stringify(r.calls)}`;
  expect(r.calls.filter(isFullSuite), `expected one \`pnpm -r run test\`. ${why}`).toHaveLength(1);
  expect(r.calls.filter((c) => isAffectedRun(c, r.baseSha)), why).toHaveLength(0);
}

function expectAffectedOnly(r) {
  expectCleanRun(r);
  const why = `pnpm calls: ${JSON.stringify(r.calls)}`;
  expect(r.calls.filter((c) => isAffectedRun(c, r.baseSha)), why).toHaveLength(1);
  expect(r.calls.filter(isFullSuite), `ran the full suite. ${why}`).toHaveLength(0);
}

describe('the PR test step runs the full suite when dependency resolution changes', () => {
  it('finds the PR test step and its run block in ci.yml', () => {
    expect(SCRIPT, `no "${STEP_NAME}" step with a \`run: |\` block in ci.yml`).not.toBeNull();
    // Over-guard: the slice holds the whole block, not just its head.
    expect(SCRIPT).toContain('BASE_SHA');
    expect(SCRIPT).toContain('pnpm test:scripts');
  });

  it.each([
    ['the lockfile', { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# bumped\n" }],
    ['a patch under patches/', { 'patches/left-pad@1.3.0.patch': '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n' }],
    ['pnpm-workspace.yaml', { 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'presets/*'\n" }],
    [
      'the root package.json pnpm block',
      { 'package.json': rootManifest({ pnpm: { overrides: { 'left-pad@<1.3.1': '>=1.3.1' } } }) },
    ],
    ['the root package.json packageManager', { 'package.json': rootManifest({ packageManager: 'pnpm@10.34.0' }) }],
    ['.npmrc', { '.npmrc': 'node-linker=hoisted\n' }],
    ['.pnpmfile.cjs', { '.pnpmfile.cjs': 'module.exports = { hooks: {} };\n' }],
    ['tsconfig.base.json', { 'tsconfig.base.json': '{ "compilerOptions": { "target": "es2023" } }\n' }],
    ['the CI workflow', { '.github/workflows/ci.yml': 'name: CI\n' }],
  ])('a PR that changes only %s runs the full suite', (_, files) => {
    expectFullSuite(runStep({ files }));
  });

  it('the step runs on the default shell, which is what the rules above assume', () => {
    // The block is written for GitHub's default `bash -e` (no pipefail), and
    // the affected-path probe is still a pipe: under pipefail a pnpm error or
    // a SIGPIPE there reads as "no affected packages". Running the slice under
    // `bash -e` can't see a `shell:` key, so check for one here.
    const step = stepLines(WORKFLOW, STEP_NAME);
    expect(step, `no "${STEP_NAME}" step in ci.yml`).not.toBeNull();
    expect(step.filter((line) => /^\s*shell\s*:/.test(line))).toEqual([]);
    expect(WORKFLOW.split('\n').filter((line) => /^\s*defaults\s*:/.test(line))).toEqual([]);
  });

  it('an empty BASE_SHA runs the full suite, not nothing', () => {
    // `git diff --name-only ...HEAD` exits 0 with no output, so an empty base
    // would otherwise look like a PR that changed nothing.
    const r = runStep({ files: { 'docs/notes.md': 'more notes\n' }, base: '' });
    expectFullSuite(r);
  });

  it('a lockfile change next to a package change runs the full suite, not the affected set', () => {
    const r = runStep({
      files: {
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# bumped\n",
        'packages/foo/src/index.ts': 'export const foo = 2;\n',
      },
      affected: '/repo/packages/foo',
    });
    expectFullSuite(r);
  });

  it('a failing full suite fails the step', () => {
    // The full-suite branch must not swallow a red run: CI would then claim
    // coverage it never had, which is worse than the gap this closes.
    const r = runStep({ files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# bumped\n" }, testStatus: 1 });
    expect(r.status, r.output).not.toBe(0);
    expect(r.calls.filter(isFullSuite), JSON.stringify(r.calls)).toHaveLength(1);
  });

  it('a base the step cannot diff against runs the full suite, not nothing', () => {
    // A failed diff must not read as "nothing changed". The stub's `list` is
    // empty here, so a step that fails open would skip every package test.
    const r = runStep({ files: { 'docs/notes.md': 'more notes\n' }, base: 'f'.repeat(40) });
    expectFullSuite(r);
  });

  it('a package-only change still runs just the affected set', () => {
    const r = runStep({
      files: { 'packages/foo/src/index.ts': 'export const foo = 2;\n' },
      affected: '/repo/packages/foo',
    });
    expectAffectedOnly(r);
  });

  it("a package's own package.json is not the root manifest", () => {
    const r = runStep({
      files: { 'packages/foo/package.json': '{ "name": "@ax/foo", "version": "0.0.1" }\n' },
      affected: '/repo/packages/foo',
    });
    expectAffectedOnly(r);
  });

  it('a docs-only change runs no package tests', () => {
    const r = runStep({ files: { 'docs/notes.md': 'more notes\n' } });
    expectCleanRun(r);
    expect(r.calls.filter((c) => c.slice(-2).join(' ') === 'run test')).toHaveLength(0);
  });

  it('a sandbox-protocol change still adds @ax/agent-claude-sdk-runner (ARCH-11)', () => {
    const r = runStep({
      files: { 'packages/sandbox-protocol/src/index.ts': 'export const schema = 2;\n' },
      affected: '/repo/packages/sandbox-protocol',
    });
    expectAffectedOnly(r);
    const run = r.calls.find((c) => isAffectedRun(c, r.baseSha));
    expect(run.join(' ')).toContain('--filter @ax/agent-claude-sdk-runner');
  });

  it('a sandbox-protocol change on the full branch does not claim an extra filter', () => {
    // The full suite already includes the runner, so the ARCH-11 line would
    // only mislead whoever reads the log.
    const r = runStep({
      files: {
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# bumped\n",
        'packages/sandbox-protocol/src/index.ts': 'export const schema = 2;\n',
      },
      affected: '/repo/packages/sandbox-protocol',
    });
    expectFullSuite(r);
    expect(r.output).not.toContain('also running @ax/agent-claude-sdk-runner');
  });
});
