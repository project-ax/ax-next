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
// Severities in the channel-web block of eslint.config.mjs. The ratchet reads
// these (not the script) to decide whether a rule was switched on.
const SEV2 = { 'ax-ui/no-style-prop': 'error', 'ax-ui/no-arbitrary-values': 'error' };
const SEV4 = { ...SEV2, 'ax-ui/no-classname': 'error', 'ax-ui/no-raw-elements': 'error' };

function configText(rules, decoy = '') {
  const lines = Object.entries(rules).map(([rule, sev]) =>
    typeof sev === 'string' ? `      '${rule}': '${sev}',` : `      '${rule}': ${sev.raw},`,
  );
  return (
    `${decoy}export default [{\n  files: ['packages/other/**'],\n  rules: { 'no-undef': 'off' },\n}, {\n` +
    `  files: ['packages/channel-web/src/**/*.tsx'],\n  rules: {\n${lines.join('\n')}\n  },\n}];\n`
  );
}

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
 * Commit `base` then `head` (each `{ suppressions?: object|null, script?: string, rules?: {rule: severity}, configText?: string, decoy?: string, message?: string, files?: string[] }`)
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
    writeFileSync(join(repo, 'eslint.config.mjs'), state.configText ?? configText(state.rules ?? SEV2, state.decoy));
    if (state.suppressions === null || state.suppressions === undefined) {
      rmSync(join(repo, 'eslint-suppressions.json'), { force: true });
    } else {
      writeFileSync(join(repo, 'eslint-suppressions.json'), supp(state.suppressions));
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--allow-empty', '-m', state.message ?? msg);
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

  it('a rule switched on in this range (base off, head error) may carry a total', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: { ...SEV4, 'ax-ui/no-classname': 'off' } },
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 40 } },
        script: ON4,
        rules: SEV4,
      },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ax-ui/no-classname switched on');
  });

  it('a rule absent from the base config counts as off', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: SEV2 },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 40 } }, script: ON4, rules: SEV4 },
    );
    expect(run(repo, [baseSha]).status).toBe(0);
  });

  it('a rise on a rule already error at the base fails (the two-PR bypass: dropped from the script, then re-added higher)', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: SEV4 },
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 40 } },
        script: ON4,
        rules: SEV4,
      },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-classname: total went up — base 0, head 40');
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

  it('warn at the base is not off: a rise fails', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: { ...SEV4, 'ax-ui/no-classname': 'warn' } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4 } }, script: ON4, rules: SEV4 },
    );
    expect(run(repo, [baseSha]).status).toBe(1);
  });

  it('a rule that is off at HEAD may not rise', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: SEV2 },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': 'off' } },
    );
    expect(run(repo, [baseSha]).status).toBe(1);
  });

  it('quoted rule ids in the script parse (switch-on still recognised)', () => {
    const quoted = `${ON2} --suppress-rule "ax-ui/no-classname" --suppress-rule 'ax-ui/no-raw-elements'`;
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: SEV2 },
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4, 'ax-ui/no-raw-elements': 3 } },
        script: quoted,
        rules: SEV4,
      },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ax-ui/no-raw-elements switched on');
  });

  it('a switched-on rule missing from lint:ui:suppress fails', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: SEV2 },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4 } }, script: ON2, rules: SEV4 },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-classname');
    expect(r.out).toContain('lint:ui:suppress');
  });

  it('an unparseable severity at HEAD fails closed, naming the rule', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: SEV2 },
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4 } },
        script: ON4,
        rules: { ...SEV2, 'ax-ui/no-classname': { raw: 'sev' } },
      },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-classname');
    expect(r.out).toContain('severity');
  });

  it('a decoy comment before the block cannot make the base read off (two-PR bypass)', () => {
    const { repo, baseSha } = repoWith(
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } },
        script: ON4,
        rules: SEV4,
        decoy: "// 'ax-ui/no-classname': 'off',\n/* 'ax-ui/no-classname': 'off' */\n",
      },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 40 } }, script: ON4, rules: SEV4 },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-classname: total went up');
  });

  it('a decoy comment before the block cannot make HEAD read error', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': 'off' } },
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 40 } },
        script: ON4,
        rules: { ...SEV4, 'ax-ui/no-classname': 'off' },
        decoy: "// 'ax-ui/no-classname': 'error',\n",
      },
    );
    expect(run(repo, [baseSha]).status).toBe(1);
  });

  it('a rule in another config block does not count as the channel-web severity', () => {
    const other = "export default [{ files: ['x/**'], rules: { 'ax-ui/no-classname': 'error' } }, {\n  files: ['packages/channel-web/src/**/*.tsx'],\n  rules: { 'ax-ui/no-style-prop': 'error' },\n}];\n";
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON4, configText: other },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4 } }, script: ON4, rules: SEV4 },
    );
    // base: absent from the channel-web block -> off -> legit switch-on
    expect(run(repo, [baseSha]).status).toBe(0);
  });

  it('downgrading a rule with frozen entries (error -> off) fails', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-classname': 4 } }, script: ON4, rules: SEV4 },
      { suppressions: {}, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': 'off' } },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-classname');
    expect(r.out).toContain('design-system decision');
    expect(r.out).toContain('scripts/ui-suppressions-ratchet.mjs in a reviewed PR');
    expect(r.out).not.toContain('UI-Ratchet-Override');
  });

  it('removing a rule with frozen entries from the block fails; warn too', () => {
    const noClass = { ...SEV4 };
    delete noClass['ax-ui/no-classname'];
    for (const rules of [noClass, { ...SEV4, 'ax-ui/no-classname': 'warn' }]) {
      const { repo, baseSha } = repoWith(
        { suppressions: { [A]: { 'ax-ui/no-classname': 4 } }, script: ON4, rules: SEV4 },
        { suppressions: {}, script: ON4, rules },
      );
      expect(run(repo, [baseSha]).status).toBe(1);
    }
  });

  it('a UI-Ratchet-Override trailer no longer waives anything', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-classname': 4 } }, script: ON4, rules: SEV4 },
      {
        suppressions: {},
        script: ON4,
        rules: { ...SEV4, 'ax-ui/no-classname': 'off' },
        message: 'drop no-classname\n\nUI-Ratchet-Override: owner approved, see DS-12',
      },
    );
    expect(run(repo, [baseSha]).status).toBe(1);
  });

  it('a rule id twice in the channel-web block reads unreadable (ESLint applies the last one)', () => {
    const dup = (first, last) =>
      "export default [{\n  files: ['packages/channel-web/src/**/*.tsx'],\n  rules: {\n" +
      `    'ax-ui/no-style-prop': 'error',\n    'ax-ui/no-classname': '${first}',\n    'ax-ui/no-classname': '${last}',\n  },\n}];\n`;
    // HEAD side: first says error, last says off.
    let t = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': 'off' } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 9 } }, script: ON4, configText: dup('error', 'off') },
    );
    let r = run(t.repo, [t.baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('cannot be read');
    // base side: first says off, last says error.
    t = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON4, configText: dup('off', 'error') },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 9 } }, script: ON4, rules: SEV4 },
    );
    r = run(t.repo, [t.baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('cannot be read');
  });

  it('two config blocks matching the channel-web glob read unreadable', () => {
    const two =
      "export default [{\n  files: ['packages/channel-web/src/**/*.tsx'],\n  rules: { 'ax-ui/no-style-prop': 'error', 'ax-ui/no-classname': 'error' },\n}, {\n" +
      "  files: ['packages/channel-web/src/**/*.tsx'],\n  rules: { 'ax-ui/no-classname': 'off' },\n}];\n";
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': 'off' } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 9 } }, script: ON4, configText: two },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('cannot be read');
  });

  it('a downgrade with no frozen entries is fine (nothing to launder)', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON4, rules: SEV4 },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': 'off' } },
    );
    expect(run(repo, [baseSha]).status).toBe(0);
  });

  it('a switch-on with nonzero base entries fails', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-classname': 4 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': 'off' } },
      { suppressions: { [A]: { 'ax-ui/no-classname': 9 } }, script: ON4, rules: SEV4 },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-classname');
  });

  it('a present-but-unparseable severity at the base fails closed, naming the rule', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': { raw: 'sev' } } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 40 } }, script: ON4, rules: SEV4 },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-classname');
    expect(r.out).toContain('base');
    expect(r.out).toContain('severity');
  });

  it('array-form severity at HEAD reads its first element (switch-on with options)', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: SEV2 },
      {
        suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4, 'ax-ui/no-raw-elements': 3 } },
        script: ON4,
        rules: {
          ...SEV2,
          'ax-ui/no-classname': { raw: "['error', { intrinsicOnly: true }]" },
          'ax-ui/no-raw-elements': { raw: '[\n        "error",\n        { elements: [\'div\', \'span\'] },\n      ]' },
        },
      },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ax-ui/no-classname switched on');
    expect(r.out).toContain('ax-ui/no-raw-elements switched on');
  });

  it('array-form severity at the base reads its first element (error at base: a rise fails)', () => {
    const { repo, baseSha } = repoWith(
      {
        suppressions: { [A]: { 'ax-ui/no-classname': 4 } },
        script: ON4,
        rules: { ...SEV4, 'ax-ui/no-classname': { raw: "['error', { intrinsicOnly: true }]" } },
      },
      {
        suppressions: { [A]: { 'ax-ui/no-classname': 5 } },
        script: ON4,
        rules: { ...SEV4, 'ax-ui/no-classname': { raw: "['error', { intrinsicOnly: true }]" } },
      },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ax-ui/no-classname: total went up — base 4, head 5');
  });

  it('array-form off at the base, plain error at HEAD is a switch-on', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: { ...SEV4, 'ax-ui/no-classname': { raw: "['off', {}]" } } },
      { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4 } }, script: ON4, rules: SEV4 },
    );
    expect(run(repo, [baseSha]).status).toBe(0);
  });

  it('array-form error -> array-form warn with frozen entries is a downgrade', () => {
    const { repo, baseSha } = repoWith(
      { suppressions: { [A]: { 'ax-ui/no-classname': 4 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': { raw: "['error', {}]" } } },
      { suppressions: { [A]: { 'ax-ui/no-classname': 4 } }, script: ON4, rules: { ...SEV4, 'ax-ui/no-classname': { raw: '["warn", {}]' } } },
    );
    const r = run(repo, [baseSha]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("from 'error' to 'warn'");
  });

  it('an array whose first element is not a severity literal stays unreadable', () => {
    for (const raw of ['[sev, {}]', "[ 'fatal', {} ]", '[2, {}]', '[]']) {
      const { repo, baseSha } = repoWith(
        { suppressions: { [A]: { 'ax-ui/no-style-prop': 2 } }, script: ON2, rules: SEV2 },
        { suppressions: { [A]: { 'ax-ui/no-style-prop': 2, 'ax-ui/no-classname': 4 } }, script: ON4, rules: { ...SEV2, 'ax-ui/no-classname': { raw } } },
      );
      const r = run(repo, [baseSha]);
      expect(r.status, raw).toBe(1);
      expect(r.out, raw).toContain('cannot be read');
    }
  });

  it('fails closed on an unresolvable base or none at all', () => {
    const { repo } = repoWith({ suppressions: null }, { suppressions: null });
    expect(run(repo, ['no-such-ref']).status).toBe(2);
    expect(run(repo, []).status).toBe(2);
  });
});
