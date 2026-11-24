// Tests for scripts/ui-suppressions-ratchet.mjs — frozen `ax-ui/*` lint
// violations in eslint-suppressions.json may only go down.
//
// Each case builds a throwaway git repo: a base commit, then a HEAD commit,
// and runs the real script against the base. Failing cases also assert the
// rule / path named in the message, so a script that failed for some other
// reason would not satisfy them; the passing cases keep an always-exit-1
// script from passing the suite.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui-suppressions-ratchet.mjs');

const trash = [];
afterAll(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const A = 'packages/channel-web/src/A.tsx';
const B = 'packages/channel-web/src/B.tsx';
const ON2 = '--suppress-rule ax-ui/no-style-prop --suppress-rule ax-ui/no-arbitrary-values';
const ON4 = `${ON2} --suppress-rule ax-ui/no-classname --suppress-rule ax-ui/no-raw-elements`;

function supp(entries) {
  // entries: { file: { rule: count } }
  const out = {};
  for (const [file, rules] of Object.entries(entries)) {
    out[file] = {};
    for (const [rule, count] of Object.entries(rules)) out[file][rule] = { count };
  }
  return JSON.stringify(out, null, 2);
}

/**
 * Commit `base` then `head` (each `{ suppressions?: object|null, script?: string, files?: string[] }`)
 * and return { repo, baseSha }.
 */
function repoWith(base, head) {
  const repo = mkdtempSync(join(tmpdir(), 'ui-ratchet-'));
  trash.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const commit = (state, msg) => {
    for (const f of state.files ?? [A, B]) {
      mkdirSync(join(repo, dirname(f)), { recursive: true });
      writeFileSync(join(repo, f), `// ${f}\n`);
    }
    for (const f of state.remove ?? []) rmSync(join(repo, f), { force: true });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { 'lint:ui:suppress': `eslint src ${state.script ?? ON2}` } }),
    );
    if (state.suppressions === null || state.suppressions === undefined) {
      rmSync(join(repo, 'eslint-suppressions.json'), { force: true });
    } else {
      writeFileSync(join(repo, 'eslint-suppressions.json'), supp(state.suppressions));
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--allow-empty', '-m', msg);
  };
  commit(base, 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  commit(head, 'head');
  return { repo, baseSha };
}

function run(repo, args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, BASE_SHA: '', ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('ui-suppressions-ratchet', () => {
  it('a raised total fails, naming the rule and both totals', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 3 } } },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-style-prop');
    expect(r.out).toContain('base 2, head 3');
  });

  it('a lowered total passes', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 1 } } },
    );
    expect(run(repo, [baseSha]).status).toBe(0);
  });

  it('equal totals pass, even when code moved between files', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 1 }, [B]: { 'ax-ui/no-style-prop': 1 } } },
    );
    expect(run(repo, [baseSha]).status).toBe(0);
  });

  it('a key naming a path missing at HEAD fails', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, remove: [A], files: [B] },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`names ${A}, which does not exist at HEAD`);
  });

  it('a base without the file passes', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: null },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 5 } } },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('nothing to ratchet against');
  });

  it('reads the base from $BASE_SHA when no argument is given', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 3 } } },
    );
    expect(run(repo, [], { BASE_SHA: baseSha }).status).toBe(1);
  });

  it('a rule switched on in this range (added to lint:ui:suppress) may carry a total', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2 },
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 40 } },
        script: ON4,
      },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ax-ui/no-classname switched on');
  });

  it('a rule already on at the base may not come back after being fully pruned', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2 },
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-arbitrary-values': 1 } },
        script: ON2,
      },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-arbitrary-values: total went up — base 0, head 1');
  });

  it('fails closed on an unresolvable base or none at all', () => {
    const { repo } = repoWith({ suppressions: null }, { suppressions: null });
    expect(run(repo, ['no-such-ref']).status).toBe(2);
    expect(run(repo, []).status).toBe(2);
  });
});
