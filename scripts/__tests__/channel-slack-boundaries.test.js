// Guard: two names belong to @ax/channel-slack (and auth), and nobody else
// may spell them (TASK-1093; design docs/plans/2026-11-09-channel-slack-design.md §6).
//
// RULE 1 — `auth:find-user-by-email` is the caller allowlist TASK-1092 asked
// for. The hook answers "which AX user owns this verified email?", so a
// caller can learn whether an address has an account. Only auth-better (which
// registers it) and channel-slack (which maps a Slack sender to their user) may
// name it. ipc-core's dependencies test keeps the hook off the runner's direct
// IPC actions, but `tool:execute:<name>` dispatches into host tool plugins and
// those can call ANY hook. Nothing at runtime stops that, so this scan does.
//
// RULE 2 — `slack:` strings. channel-slack keeps its four per-install secrets
// in the credentials vault under `slack:<installId>:<name>`, and its DM
// conversations under externalKey `slack:<installId>:…`. The vault doesn't
// restrict which plugin reads a ref, so "only channel-slack reads its secrets"
// can only be held by keeping every other package from building such a name.
// (The vault's own `credentials:get({ …, scope: 'global' })` option, added for
// channel-slack in PR A, is generic vault vocabulary and is NOT matched here:
// the rule keys on the `slack:` prefix, never on `scope`.)
//
// WHY IT LIVES HERE AND NOT IN A PACKAGE. CI's PR `test` job runs only the
// packages a PR changes plus their dependents. A package that starts calling
// the hook doesn't depend on channel-slack, so a channel-slack test would never
// run on the PR that breaks the rule. `pnpm test:scripts` runs on EVERY PR
// (the slot-vocabulary guard's lesson, TASK-518). An ESLint
// `no-restricted-syntax` block was the other option; in flat config it would
// REPLACE other blocks' options for the same rule instead of adding to them.
//
// WHAT IT READS. Every file `git ls-files` tracks under packages/ and presets/
// with a JS/TS extension, TESTS INCLUDED (a test that plants a `slack:` row in
// the vault is how a second reader starts). Each file is parsed with the
// TypeScript compiler. A file the parser reports errors for is an OFFENDER,
// not a skip: a file we couldn't read is a file we didn't check.
//
// WHAT IT MATCHES. Rule 1: a string literal or a no-substitution template
// whose text is exactly the hook name. Rule 2: a string literal, a
// no-substitution template, or a template HEAD whose text starts with
// `slack:`. Comments never count.
//
// WHAT IT CANNOT SEE. It's a repo scan, not a runtime check:
//   - a name built at runtime (`'auth:find-user-' + 'by-email'`,
//     `'slack' + ':' + id`, `` `${ns}:${id}` ``), or read from config;
//   - files that aren't JS/TS (JSON, YAML, Markdown, SQL) — they're filtered
//     out of the walk, not parsed;
//   - code outside packages/ and presets/, and untracked files;
//   - a plugin that calls `credentials:get` with a ref it received at runtime.
// The PR security note states this residual: any host plugin can still call
// the hook or read a vault ref at runtime.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = ['packages', 'presets'];

const FIND_USER_HOOK = 'auth:find-user-by-email';
const SLACK_PREFIX = 'slack:';

const RULES = {
  'find-user-by-email': {
    dirs: ['packages/auth-better/', 'packages/channel-slack/'],
    // Each file needs a one-line reason. Adding one is a reviewed decision.
    files: new Map([
      ['presets/memory/src/__tests__/canary.test.ts', "the canary's auth stub registers it so channel-slack boots"],
      ['presets/k8s/src/__tests__/channel-slack-composition.test.ts', 'stubs auth to map fake Slack senders to users'],
      ['presets/k8s/src/__tests__/preset.test.ts', "pins channel-slack's manifest `calls`"],
    ]),
  },
  'slack-prefix': {
    dirs: ['packages/channel-slack/'],
    files: new Map([
      ['presets/k8s/src/__tests__/channel-slack-composition.test.ts', "checks Disconnect removed the install's vault refs"],
    ]),
  },
};

const SCRIPT_KIND = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
]);

function extensionOf(path) {
  const m = /\.[^./]+$/.exec(path);
  return m === null ? '' : m[0];
}

/** Tracked JS/TS sources under ROOTS (tests included), repo-relative. Throws if git does. */
function trackedSources() {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => SCRIPT_KIND.has(extensionOf(p)));
}

/**
 * Every mention in `text`, allowlist NOT applied: `{ rule, line }` per hit, or
 * `{ rule: 'unreadable', line, reason }` when the file can't be parsed.
 */
function findMentions(fileName, text) {
  const kind = SCRIPT_KIND.get(extensionOf(fileName));
  if (kind === undefined) return [{ rule: 'unreadable', line: 0, reason: `no parser for ${fileName}` }];
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  // `parseDiagnostics` is not in the public typings. If a TypeScript upgrade
  // renames it, we can't tell a clean parse from a broken one — so refuse.
  const diagnostics = sourceFile.parseDiagnostics;
  if (!Array.isArray(diagnostics)) {
    return [{ rule: 'unreadable', line: 0, reason: 'this TypeScript no longer exposes parseDiagnostics' }];
  }
  if (diagnostics.length > 0) {
    const d = diagnostics[0];
    const { line } = sourceFile.getLineAndCharacterOfPosition(d.start ?? 0);
    return [{ rule: 'unreadable', line: line + 1, reason: ts.flattenDiagnosticMessageText(d.messageText, ' ') }];
  }
  const hits = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text === FIND_USER_HOOK) hits.push({ rule: 'find-user-by-email', line: lineOf(node) });
      if (node.text.startsWith(SLACK_PREFIX)) hits.push({ rule: 'slack-prefix', line: lineOf(node) });
    } else if (ts.isTemplateHead(node)) {
      if (node.text.startsWith(SLACK_PREFIX)) hits.push({ rule: 'slack-prefix', line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

function allowed(rule, file) {
  const r = RULES[rule];
  return r.dirs.some((d) => file.startsWith(d)) || r.files.has(file);
}

/** One line per offending mention in `file`; [] when the file is clean. */
function offendersIn(file, text) {
  return findMentions(file, text)
    .filter((h) => h.rule === 'unreadable' || !allowed(h.rule, file))
    .map((h) =>
      h.rule === 'unreadable'
        ? `${file} — unreadable at line ${h.line}: ${h.reason}`
        : `${file}:${h.line} — ${h.rule}`,
    );
}

describe('only auth-better and channel-slack name auth:find-user-by-email or slack: refs', () => {
  const files = trackedSources();

  it('no other tracked source names them', () => {
    const offenders = files.flatMap((f) => offendersIn(f, readFileSync(join(REPO_ROOT, f), 'utf8')));
    expect(
      offenders,
      'auth:find-user-by-email has a caller allowlist and slack: refs belong to channel-slack — see this file\'s header',
    ).toEqual([]);
  });

  it('actually reads the tree it claims to read, tests included', () => {
    // A walk that found nothing would pass the case above for the wrong
    // reason. No exact count: the population grows with every PR.
    expect(files.length).toBeGreaterThan(1000);
    expect(files.some((f) => f.split('/').includes('__tests__'))).toBe(true);
    expect(files).toContain('packages/channel-slack/src/secrets.ts');
    expect(files.some((f) => f.startsWith('presets/'))).toBe(true);
  });

  it('sees the real owners — the detector works on real code, not only on the fixtures', () => {
    // Positive control: channel-slack IS the legitimate home of both names.
    // If these go quiet, the scan above is vacuous.
    const read = (f) => findMentions(f, readFileSync(join(REPO_ROOT, f), 'utf8')).map((h) => h.rule);
    expect(read('packages/channel-slack/src/secrets.ts')).toContain('slack-prefix');
    expect(read('packages/channel-slack/src/plugin.ts')).toContain('find-user-by-email');
    expect(read('presets/memory/src/__tests__/canary.test.ts')).toContain('find-user-by-email');
  });
});

// Hostile synthetic inputs: [expected, label, path, source]. `offender` = must
// be reported, `clean` = must pass. The row count is pinned so a deleted row
// is a visible diff rather than a quieter guard.
const CASES = [
  // --- rule 1 ---
  ['offender', 'a bus.call in another package', 'packages/agents/src/x.ts', "await bus.call('auth:find-user-by-email', ctx, { email });"],
  ['clean', 'the same call in channel-slack', 'packages/channel-slack/src/x.ts', "await bus.call('auth:find-user-by-email', ctx, { email });"],
  ['clean', 'the same call in auth-better', 'packages/auth-better/src/x.ts', "bus.registerService('auth:find-user-by-email', 'auth', impl);"],
  ['offender', 'a no-substitution template', 'packages/agents/src/x.ts', 'const h = `auth:find-user-by-email`;'],
  ['offender', 'a test file in another package (tests are scanned)', 'packages/agents/src/__tests__/x.test.ts', "bus.registerService('auth:find-user-by-email', 'stub', f);"],
  ['offender', 'a preset file that is not on the list', 'presets/k8s/src/__tests__/acceptance.test.ts', "registers: ['auth:find-user-by-email']"],
  ['clean', 'an allowlisted preset test', 'presets/memory/src/__tests__/canary.test.ts', "bus.registerService('auth:find-user-by-email', name, async () => null);"],
  ['clean', 'a comment naming the hook', 'packages/agents/src/x.ts', "// auth:find-user-by-email is channel-slack's\n/* 'auth:find-user-by-email' */\nexport {};"],
  ['clean', 'the name inside a longer string', 'packages/agents/src/x.ts', "const s = 'never call auth:find-user-by-email';"],
  ['clean', 'a sibling auth hook', 'packages/agents/src/x.ts', "await bus.call('auth:get-user', ctx, { userId });"],
  // --- rule 2 ---
  ['offender', 'a template head building a secret ref', 'packages/memory/src/y.ts', 'const ref = `slack:${id}:bot-token`;'],
  ['offender', 'a plain string ref', 'packages/credentials/src/__tests__/y.test.ts', "await bus.call('credentials:get', ctx, { ref: 'slack:abc:signing-secret', userId });"],
  ['offender', 'a JSX attribute', 'packages/channel-web/src/y.tsx', 'export const F = () => <input name="slack:token" />;'],
  ['offender', 'an allowlisted rule-1 file still may not build a ref', 'presets/memory/src/__tests__/canary.test.ts', "const r = 'slack:x:bot-token';"],
  ['clean', 'channel-slack builds its own refs', 'packages/channel-slack/src/secrets.ts', 'return `slack:${installId}:${name}`;'],
  ['clean', 'the composition test', 'presets/k8s/src/__tests__/channel-slack-composition.test.ts', 'const ref = `slack:${installId}:bot-token`;'],
  ['clean', "the vault's scope: 'global' read (PR A)", 'packages/credentials/src/y.ts', "await bus.call('credentials:get', ctx, { ref, userId, scope: 'global' });"],
  ['clean', "the conversation origin 'slack' (no colon)", 'packages/conversations/src/y.ts', "const ORIGINS = ['web', 'routine', 'slack'] as const;"],
  ['clean', 'slack: later in a string or template', 'packages/routines/src/y.ts', "const a = 'x slack:'; const b = `${p}slack:${q}`;"],
  ['clean', 'slack: only in comments', 'packages/memory/src/y.ts', '// slack:<id>:bot-token\nexport {};'],
  // --- fail closed ---
  ['offender', 'a parse error', 'packages/agents/src/x.ts', "const x = ['a', 'b'"],
  ['offender', 'an extension there is no parser for', 'packages/agents/src/x.vue', '<script>export {}</script>'],
];

describe('the detector, against hostile synthetic sources', () => {
  it('carries every row', () => {
    expect(CASES).toHaveLength(22);
  });

  it.each(CASES)('%s — %s', (expected, _label, path, source) => {
    const offenders = offendersIn(path, source);
    if (expected === 'clean') expect(offenders).toEqual([]);
    else expect(offenders.length).toBeGreaterThan(0);
  });

  it('names the rule and the line', () => {
    expect(offendersIn('packages/memory/src/y.ts', "export {};\nconst r = `slack:${id}:bot-token`;")).toEqual([
      'packages/memory/src/y.ts:2 — slack-prefix',
    ]);
    expect(offendersIn('packages/agents/src/x.ts', "bus.call('auth:find-user-by-email', c, {});")).toEqual([
      'packages/agents/src/x.ts:1 — find-user-by-email',
    ]);
  });
});
