#!/usr/bin/env node
// ui-suppressions-ratchet.mjs — frozen UI-lint violations may only go DOWN.
//
// `eslint-suppressions.json` (ESLint bulk suppressions) freezes channel-web's
// pre-existing `ax-ui/*` violations so the rules can be errors for new code.
// ESLint alone does not keep that one-way:
//
//   - `pnpm lint:ui:suppress` happily RAISES a count, and lint passes after.
//   - ESLint only checks suppressions for files it lints, so an entry for a
//     deleted or renamed file is slack nobody ever trips over.
//
// This compares the per-rule TOTALS at HEAD against the merge-base with a base
// ref, and fails if any rule's total went up. Totals, not per-file counts, so
// moving code between files is legal. It also fails if any key names a path
// that does not exist at HEAD (delete that entry by hand).
//
// Switching a rule on is the one legitimate way for a total to rise: the PR
// that ships a rule's replacements flips it from 'off' (or absent) to 'error'
// in the channel-web block of eslint.config.mjs, adds it to the root
// package.json `lint:ui:suppress` script, and regenerates the file. So a rule's
// total may rise only if its severity in that block is 'off' (or the rule is
// absent) at the base and 'error' at HEAD, and the rule is in the HEAD script.
// The base must hold no entries for it. A rule already on at the base may not
// grow, even if its entries had all been fixed and pruned. (Keying on the script
// instead would let a rule be dropped from it in one PR and re-added at a higher
// count in the next.)
//
// Severities are read from the channel-web config block only, comments
// stripped, so a decoy line elsewhere can't fake one. A severity that is present
// but unreadable fails closed. A rule that has frozen entries may not go from
// 'error' to anything else (that would launder the entries: off + prune, then
// back on higher) unless a commit in the range carries `UI-Ratchet-Override:`.
//
// Usage:
//   node scripts/ui-suppressions-ratchet.mjs <base-ref>
//   BASE_SHA=<sha> node scripts/ui-suppressions-ratchet.mjs
//
// Exit codes:
//   0  totals held or went down (or the base has no suppressions file)
//   1  a rule's total went up, or a key names a missing path (all printed)
//   2  usage error, or the base could not be resolved (fail CLOSED)
import { spawnSync } from 'node:child_process';

const FILE = 'eslint-suppressions.json';
const TAG = 'ui-suppressions-ratchet';

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function die(msg) {
  process.stderr.write(`${TAG}: ${msg}\n`);
  process.exit(2);
}

/** File contents at `ref`, or null when the path does not exist there. */
function show(ref, file) {
  if (!git(['cat-file', '-e', `${ref}:${file}`]).ok) return null;
  const r = git(['show', `${ref}:${file}`]);
  if (!r.ok) die(`could not read ${file} at ${ref}: ${r.err.trim()}`);
  return r.out;
}

function parseSuppressions(text, where) {
  if (text === null) return {};
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch (e) {
    die(`${FILE} at ${where} is not valid JSON: ${e.message}`);
  }
}

function totals(suppressions) {
  const out = new Map();
  for (const rules of Object.values(suppressions)) {
    for (const [rule, entry] of Object.entries(rules ?? {})) {
      const n = Number(entry?.count ?? 0);
      out.set(rule, (out.get(rule) ?? 0) + (Number.isFinite(n) ? n : 0));
    }
  }
  return out;
}

/** Rules named by `--suppress-rule` in the root `lint:ui:suppress` script at `ref`. */
function suppressScriptRules(ref) {
  const text = show(ref, 'package.json');
  if (text === null) return new Set();
  let script;
  try {
    script = JSON.parse(text)?.scripts?.['lint:ui:suppress'];
  } catch {
    return new Set();
  }
  if (typeof script !== 'string') return new Set();
  return new Set(
    [...script.matchAll(/--suppress-rule[=\s]+(\S+)/g)].map((m) => m[1].replace(/^(["'])(.*)\1$/, '$2')),
  );
}

/** `text` with // and /* *\/ comments blanked out; string literals are left alone. */
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * The config object whose `files` is the channel-web tsx glob, comments
 * stripped; null if there is none. Anchoring here keeps a decoy line elsewhere
 * in the file (or in a comment) from being read as the rule's severity.
 */
function channelWebBlock(text) {
  const code = stripComments(text);
  const re = /files:\s*\[\s*(['"])packages\/channel-web\/src\/\*\*\/\*\.tsx\1\s*\]/g;
  for (const m of code.matchAll(re)) {
    const open = code.lastIndexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) {
        const block = code.slice(open, i + 1);
        if (block.includes('ax-ui/')) return block;
        break;
      }
    }
  }
  return null;
}

/**
 * A rule's severity in the channel-web block of `eslint.config.mjs` at `ref`:
 * 'off' | 'warn' | 'error'; 'absent' when the rule id is not in the block (or
 * there is no block/file); 'unreadable' when the id is there but its value is
 * not a plain severity string (e.g. `['error', {...}]`).
 */
function severity(ref, rule) {
  const text = show(ref, 'eslint.config.mjs');
  const block = text === null ? null : channelWebBlock(text);
  if (block === null) return 'absent';
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(['"])${escaped}\\1\\s*:\\s*(['"])(off|warn|error)\\2\\s*[,}\\s]`).exec(block);
  if (m) return m[3];
  return new RegExp(`(['"])${escaped}\\1`).test(block) ? 'unreadable' : 'absent';
}

/** Reasons given by `UI-Ratchet-Override:` trailers on commits in base..HEAD. */
function overrides(base) {
  const r = git(['log', '--format=%(trailers:key=UI-Ratchet-Override,valueonly)', `${base}..HEAD`]);
  return r.ok ? r.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

const baseRef = process.argv[2] || process.env.BASE_SHA;
if (!baseRef) die('usage: ui-suppressions-ratchet.mjs <base-ref>  (or set BASE_SHA)');

const top = git(['rev-parse', '--show-toplevel']);
if (!top.ok) die('not inside a git repository');
process.chdir(top.out.trim());

if (!git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]).ok) {
  die(`cannot resolve base ref '${baseRef}' — a check that could not run is not a pass`);
}
const mb = git(['merge-base', baseRef, 'HEAD']);
if (!mb.ok || mb.out.trim() === '') die(`no merge-base between '${baseRef}' and HEAD`);
const base = mb.out.trim();

const headText = show('HEAD', FILE);
const head = parseSuppressions(headText, 'HEAD');
const problems = [];

// Stale keys: ESLint never looks at entries for files it doesn't lint.
const tracked = new Set(git(['ls-tree', '-r', '--name-only', 'HEAD']).out.split('\n'));
for (const file of Object.keys(head)) {
  if (!tracked.has(file)) {
    problems.push(
      `${FILE} names ${file}, which does not exist at HEAD. Delete that entry ` +
        `(code moved to another file keeps its count under the new path).`,
    );
  }
}

const baseText = show(base, FILE);
if (baseText === null) {
  process.stdout.write(`${TAG}: no ${FILE} at the base (${base.slice(0, 12)}); nothing to ratchet against.\n`);
} else {
  const before = totals(parseSuppressions(baseText, base));
  const after = totals(head);
  const scriptRules = suppressScriptRules('HEAD');

  const waivers = overrides(base);

  for (const rule of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(rule) ?? 0;
    const h = after.get(rule) ?? 0;
    const was = severity(base, rule);
    const now = severity('HEAD', rule);

    // Downgrade laundering: off + prune in one PR, back on at a higher count in
    // the next. A rule with frozen entries may not stop being an error.
    if (b > 0 && was === 'error' && now !== 'error') {
      if (waivers.length > 0) {
        process.stdout.write(
          `${TAG}: ${rule} downgraded to '${now}' with ${b} frozen, waived by UI-Ratchet-Override: ${waivers.join('; ')}\n`,
        );
      } else {
        problems.push(
          `${rule}: severity went from 'error' to '${now}' while ${b} violations are frozen. ` +
            `Switching a frozen rule off is a design-system decision: it needs the CODEOWNERS owner ` +
            `and a \`UI-Ratchet-Override: <reason>\` trailer on a commit in the range.`,
        );
      }
    }

    if (h <= b) continue;
    if (was === 'unreadable') {
      problems.push(
        `${rule}: total went up (base ${b}, head ${h}) and its severity at the base in ` +
          `eslint.config.mjs cannot be read (expected a literal 'off' | 'warn' | 'error'). Failing closed.`,
      );
      continue;
    }
    if (now === 'unreadable') {
      problems.push(
        `${rule}: total went up (base ${b}, head ${h}) and its severity in eslint.config.mjs at HEAD ` +
          `cannot be read (expected a literal 'off' | 'warn' | 'error'). Failing closed.`,
      );
      continue;
    }
    if ((was === 'off' || was === 'absent') && now === 'error' && b === 0) {
      if (scriptRules.has(rule)) {
        process.stdout.write(`${TAG}: ${rule} switched on in this range: frozen ${h} (base ${b}).\n`);
      } else {
        problems.push(
          `${rule}: switched on in this range but missing from the lint:ui:suppress script in package.json, ` +
            `so its frozen total (${h}) cannot be regenerated. Add --suppress-rule ${rule}.`,
        );
      }
      continue;
    }
    problems.push(
      `${rule}: total went up — base ${b}, head ${h}. Frozen violations may only go down; ` +
        `fix the new ones instead of re-running lint:ui:suppress.`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(problems.map((p) => `${TAG}: ${p}`).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write(`${TAG}: ok\n`);
