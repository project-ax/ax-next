import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO, 'scripts/hooks/guard-ds-writes.mjs');
const LINT = path.join(REPO, 'scripts/hooks/lint-ui-file.mjs');
const { locateInWorktree } = await import(path.join(REPO, 'scripts/hooks/worktree-root.mjs'));

function run(script, stdin) {
  return spawnSync('node', [script], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    cwd: REPO,
  });
}
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path } });

const cleanup = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});
function fakeRoot({ gitFile = false, marker = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ax-hook-')));
  cleanup.push(root);
  if (gitFile) writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');
  else mkdirSync(path.join(root, '.git'));
  if (marker) writeFileSync(path.join(root, '.ax-ds-task'), '');
  return root;
}

describe('guard-ds-writes', () => {
  it('blocks packages/ui without marker', () => {
    const root = fakeRoot();
    const r = run(GUARD, edit(path.join(root, 'packages/ui/a.ts')));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('(ds) card');
  });
  it('blocks packages/eslint-plugin-ui without marker', () => {
    const root = fakeRoot();
    expect(run(GUARD, edit(path.join(root, 'packages/eslint-plugin-ui/a.js'))).status).toBe(2);
  });
  it('allows packages/ui with marker', () => {
    const root = fakeRoot({ marker: true });
    expect(run(GUARD, edit(path.join(root, 'packages/ui/a.ts'))).status).toBe(0);
  });
  it('prefix lookalike allowed', () => {
    const root = fakeRoot();
    expect(run(GUARD, edit(path.join(root, 'packages/uix/a.ts'))).status).toBe(0);
  });
  it('dotdot resolved', () => {
    const root = fakeRoot();
    const r = run(GUARD, edit(path.join(root, 'packages/channel-web/../ui/a.ts')));
    expect(r.status).toBe(2);
  });
  it('worktree root via .git file', () => {
    const root = fakeRoot({ gitFile: true, marker: true });
    expect(run(GUARD, edit(path.join(root, 'packages/ui/a.ts'))).status).toBe(0);
    const root2 = fakeRoot({ gitFile: true });
    expect(run(GUARD, edit(path.join(root2, 'packages/ui/a.ts'))).status).toBe(2);
  });
  it('fails open on malformed input', () => {
    expect(run(GUARD, 'not json').status).toBe(0);
    expect(run(GUARD, '{}').status).toBe(0);
    expect(run(GUARD, '').status).toBe(0);
  });
});

describe('lint-ui-file', () => {
  const tmpFile = path.join(REPO, `packages/channel-web/src/components/__HookTmp-${process.pid}-${Date.now()}.tsx`);
  afterEach(() => rmSync(tmpFile, { force: true }));

  it('reports a new arbitrary value', () => {
    writeFileSync(tmpFile, 'export const A = () => <div className="p-[3px]" />;\n');
    const r = run(LINT, edit(tmpFile));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ax-ui/no-arbitrary-values');
  }, 60_000);
  it('reports className and raw elements (R15: both rules are on)', () => {
    writeFileSync(tmpFile, 'export const A = () => <div className="flex gap-2" />;\n');
    const r = run(LINT, edit(tmpFile));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ax-ui/no-classname');
    expect(r.stderr).toContain('ax-ui/no-raw-elements');
  }, 60_000);
  it('passes a clean file', () => {
    writeFileSync(tmpFile, 'export const A = () => null;\n');
    expect(run(LINT, edit(tmpFile)).status).toBe(0);
  }, 60_000);
  it('ignores frozen violations', () => {
    const f = path.join(REPO, 'packages/channel-web/src/components/Toast.tsx');
    expect(run(LINT, edit(f)).status).toBe(0);
  }, 60_000);
  it('ignores non-channel-web files', () => {
    expect(run(LINT, edit(path.join(REPO, 'README.md'))).status).toBe(0);
  }, 60_000);
  it('fails open on malformed input', () => {
    expect(run(LINT, 'garbage').status).toBe(0);
    expect(run(LINT, '{"tool_input":{}}').status).toBe(0);
  }, 60_000);
  it('fails open when eslint cannot be spawned', () => {
    const r = spawnSync(process.execPath, [LINT], {
      input: JSON.stringify(edit(path.join(REPO, 'packages/channel-web/src/components/Toast.tsx'))),
      encoding: 'utf8',
      cwd: REPO,
      env: { PATH: '' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  }, 60_000);
});

describe('lint hook: worktree of the edited file', () => {
  // A linked worktree nested inside a "main" checkout, the shape auto-ship
  // builders use: <main>/.claude/worktrees/agent-x with a `.git` FILE.
  function nestedWorktree() {
    const main = realpathSync(mkdtempSync(path.join(tmpdir(), 'ax-main-')));
    cleanup.push(main);
    mkdirSync(path.join(main, '.git'));
    const wt = path.join(main, '.claude/worktrees/agent-x');
    mkdirSync(path.join(wt, 'packages/channel-web/src/components'), { recursive: true });
    writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
    const file = path.join(wt, 'packages/channel-web/src/components/X.tsx');
    writeFileSync(file, 'export const X = () => <div style={{ padding: 3 }} />;\n');
    return { main, wt, file };
  }

  it('root and rel path come from the edited file, not the hook script', () => {
    const { wt, file } = nestedWorktree();
    expect(locateInWorktree(file)).toEqual({
      root: wt,
      resolved: file,
      rel: 'packages/channel-web/src/components/X.tsx',
    });
    expect(locateInWorktree(path.join(wt, 'packages/../packages/channel-web/src/components/X.tsx')).rel).toBe(
      'packages/channel-web/src/components/X.tsx',
    );
  });

  it('fails open when that worktree has no eslint installed', () => {
    const { file } = nestedWorktree();
    const r = run(LINT, edit(file));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  }, 60_000);

  it("fails open when that worktree's eslint dies, and it ran there (not in the hook's checkout)", () => {
    // Without the ran-in-the-worktree check this passed vacuously on the
    // original hook, which resolved the file against ITS OWN checkout, saw a
    // path outside it, and exited 0 before ever spawning eslint.
    const { wt, file } = nestedWorktree();
    const bin = path.join(wt, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'eslint'), '#!/bin/sh\npwd > "$(pwd)/eslint-ran-here"\nexit 1\n', { mode: 0o755 });
    const r = run(LINT, edit(file));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(readFileSync(path.join(wt, 'eslint-ran-here'), 'utf8').trim()).toBe(wt);
  }, 60_000);

  it('lints a file in another worktree than the hook copy lives in', () => {
    // Simulate $CLAUDE_PROJECT_DIR being a different checkout: run a COPY of
    // the hook from a temp dir against a new violating file in this repo.
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'ax-hookcopy-')));
    cleanup.push(elsewhere);
    mkdirSync(path.join(elsewhere, 'scripts/hooks'), { recursive: true });
    for (const f of ['lint-ui-file.mjs', 'worktree-root.mjs']) {
      copyFileSync(path.join(REPO, 'scripts/hooks', f), path.join(elsewhere, 'scripts/hooks', f));
    }
    const file = path.join(
      REPO,
      `packages/channel-web/src/components/__HookWt-${process.pid}-${Date.now()}.tsx`,
    );
    cleanup.push(file);
    writeFileSync(file, 'export const A = () => <p style={{ margin: 0 }} />;\n');
    const r = spawnSync('node', [path.join(elsewhere, 'scripts/hooks/lint-ui-file.mjs')], {
      input: JSON.stringify(edit(file)),
      encoding: 'utf8',
      cwd: elsewhere,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ax-ui/no-style-prop');
  }, 60_000);
});

describe('lint hook: says how many violations are new', () => {
  // A self-contained worktree with its OWN minimal eslint config and
  // suppressions file (node_modules borrowed from this repo), so the counts
  // are under the test's control and the real eslint-suppressions.json is
  // never touched.
  function worktreeWithSuppressions(suppressions) {
    const wt = realpathSync(mkdtempSync(path.join(tmpdir(), 'ax-wt-')));
    cleanup.push(wt);
    writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere\n');
    writeFileSync(path.join(wt, 'package.json'), '{"name":"wt","private":true,"type":"module"}\n');
    symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'), 'dir');
    writeFileSync(
      path.join(wt, 'eslint.config.mjs'),
      [
        "import tseslint from 'typescript-eslint';",
        "import axUi from '@project-ax/eslint-plugin-ui';",
        'export default [{',
        "  files: ['packages/channel-web/src/**/*.tsx'],",
        '  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },',
        "  plugins: { 'ax-ui': axUi },",
        "  rules: { 'ax-ui/no-arbitrary-values': 'error', 'ax-ui/no-style-prop': 'error' },",
        '}];',
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(wt, 'eslint-suppressions.json'), JSON.stringify(suppressions, null, 2));
    mkdirSync(path.join(wt, 'packages/channel-web/src/components'), { recursive: true });
    return wt;
  }
  const REL = 'packages/channel-web/src/components/Frozen.tsx';

  it('names frozen vs current counts per rule for a file with suppressions', () => {
    const wt = worktreeWithSuppressions({ [REL]: { 'ax-ui/no-arbitrary-values': { count: 1 } } });
    const file = path.join(wt, REL);
    writeFileSync(
      file,
      // no-arbitrary-values reports once per class string, so three strings = 3.
      'export const A = () => (\n' +
        '  <>\n' +
        '    <div className="p-[1px]" />\n' +
        '    <div className="m-[2px]" />\n' +
        '    <div className="gap-[3px]" style={{ margin: 0 }} />\n' +
        '  </>\n' +
        ');\n',
    );
    const r = run(LINT, edit(file));
    expect(r.status).toBe(2);
    const lines = r.stderr.split('\n');
    expect(lines[0]).toBe(
      'ax-ui/no-arbitrary-values: 1 frozen in eslint-suppressions.json, file now has 3 — remove the 2 you added.',
    );
    // No frozen entry for no-style-prop in this file: no summary line for it.
    expect(r.stderr).not.toMatch(/no-style-prop: \d+ frozen/);
    expect(r.stderr).toContain(`${REL}:5 ax-ui/no-style-prop`);
    expect(r.stderr).toContain(`${REL}:3 ax-ui/no-arbitrary-values`);
  }, 60_000);

  it('a file without suppressions gets no summary line', () => {
    const wt = worktreeWithSuppressions({});
    const file = path.join(wt, REL);
    writeFileSync(file, 'export const A = () => <div className="p-[1px]" />;\n');
    const r = run(LINT, edit(file));
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('frozen in eslint-suppressions.json');
    expect(r.stderr).toContain(`${REL}:1 ax-ui/no-arbitrary-values`);
  }, 60_000);

  it('stays quiet while the file is within its frozen count', () => {
    const wt = worktreeWithSuppressions({ [REL]: { 'ax-ui/no-arbitrary-values': { count: 2 } } });
    const file = path.join(wt, REL);
    writeFileSync(file, 'export const A = () => <><div className="p-[1px]" /><p className="m-[2px]" /></>;\n');
    const r = run(LINT, edit(file));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  }, 60_000);
});
