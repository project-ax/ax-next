import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO, 'scripts/hooks/guard-ds-writes.mjs');
const LINT = path.join(REPO, 'scripts/hooks/lint-ui-file.mjs');

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
  const tmpFile = path.join(REPO, 'packages/channel-web/src/components/__HookTmp.tsx');
  afterEach(() => rmSync(tmpFile, { force: true }));

  it('reports new div', () => {
    writeFileSync(tmpFile, 'export const A = () => <div />;\n');
    const r = run(LINT, edit(tmpFile));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ax-ui/no-raw-elements');
  });
  it('passes a clean file', () => {
    writeFileSync(tmpFile, 'export const A = () => null;\n');
    expect(run(LINT, edit(tmpFile)).status).toBe(0);
  });
  it('ignores frozen violations', () => {
    const f = path.join(REPO, 'packages/channel-web/src/components/Toast.tsx');
    expect(run(LINT, edit(f)).status).toBe(0);
  });
  it('ignores non-channel-web files', () => {
    expect(run(LINT, edit(path.join(REPO, 'README.md'))).status).toBe(0);
  });
  it('fails open on malformed input', () => {
    expect(run(LINT, 'garbage').status).toBe(0);
    expect(run(LINT, '{"tool_input":{}}').status).toBe(0);
  });
});
