// Guard: the run-error scrub runbook (deploy/GKE.md, 4g) quotes the script it runs.
//
// WHY THIS EXISTS (TASK-1036). 4g walks a person through rewriting old error
// text in production run history by hand: back up, dry run, write the counts
// down, rewrite, check. The script decides what that prints
// (`packages/routines/sql/scrub-leaked-run-errors.sql`, pinned by its own psql
// test in @ax/routines). The runbook tells the reader which lines to look for.
// If the two drift, someone compares a dry run against a line it no longer
// prints, on the one day they are changing prod data by hand.
//
// What it checks: the script the runbook loads exists; every output line the
// runbook quotes is one the script really `\echo`es; every kubectl line names
// its context (the default context on our machines is prod), and the project
// is set once in 4g and always quoted; before the dry run, the release is
// checked for commits that change what a failed run says; the backup is checked
// against the database the app uses, and comes before the command that writes;
// and after that command, the runbook calls the write done only when its log
// ends with `COMMIT`.
//
// A "command" is a line inside a ``` fence that isn't a shell comment. Prose
// names the flag that writes ("its psql line adds `-v apply=1`") before the
// command that uses it, so a check that took the first line with both would
// test a sentence.
//
// The COMMIT rule is the non-obvious one. The script prints both `rewritten:`
// lines BEFORE its COMMIT. If the commit doesn't go through, psql stops and the
// database rolls the whole transaction back, but the lines are already in the
// log. So they prove nothing.
//
// Plain file reads at module top level, no hooks, no subprocesses: it runs in
// `pnpm test:scripts` with no network, no Docker and no build.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_PATH = 'packages/routines/sql/scrub-leaked-run-errors.sql';
const HEADING = '### 4g. Scrub old run errors';

const gke = readFileSync(join(repoRoot, 'deploy/GKE.md'), 'utf-8');
// Read only when present, so a missing script fails the first test by name
// instead of failing this whole file at import.
const scriptExists = existsSync(join(repoRoot, SCRIPT_PATH));
const script = scriptExists ? readFileSync(join(repoRoot, SCRIPT_PATH), 'utf-8') : '';

/** What the script prints, and what the runbook tells the reader to look for. */
const OUTPUT_LABELS = [
  'run-history rows with old error text:',
  'routines with old error text:',
  'old rows that look like a host sentence:',
  'run-history rows rewritten:',
  'routines rewritten:',
  'Dry run: nothing was changed.',
  'Stopped: some rows look like a sentence this script does not know.',
];

/** Step 2: the commits to the routines code since the script's keep-list last changed. */
const KEEP_LIST_CHECK = `git log --oneline "$(git log -1 --format=%H -- ${SCRIPT_PATH})"..HEAD -- packages/routines/src`;

/** 4g: from its heading to the next horizontal rule. */
function section() {
  const start = gke.indexOf(HEADING);
  expect(start, `deploy/GKE.md has no "${HEADING}"`).toBeGreaterThan(-1);
  const end = gke.indexOf('\n---\n', start);
  expect(end, 'no --- line after 4g').toBeGreaterThan(start);
  return gke.slice(start, end);
}

/** Each line of `text`, and whether it is a command: inside a ``` fence and not a `#` comment. */
function lines(text) {
  let fenced = false;
  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      fenced = !fenced;
      return { line, command: false };
    }
    return { line, command: fenced && !trimmed.startsWith('#') };
  });
}

/** The index of the first command whose trimmed text passes `test`, or -1. */
const firstCommand = (ls, test) => ls.findIndex((l) => l.command && test(l.line.trim()));

/** A line that runs psql with the flag that writes. */
const writes = (l) => l.includes('psql') && l.includes('-v apply=1');

describe('the run-error scrub runbook (GKE.md 4g) quotes its script', () => {
  it('names the script that exists and the flag that writes', () => {
    const text = section();
    expect(text).toContain(SCRIPT_PATH);
    expect(text).toContain('-v apply=1');
    expect(scriptExists, `${SCRIPT_PATH} does not exist`).toBe(true);
  });

  it('quotes the lines the script prints', () => {
    const text = section();
    for (const label of OUTPUT_LABELS) {
      // `\echo '<label>`: the script prints it, not just mentions it in a comment.
      expect(script, `the script does not print "${label}"`).toContain(`\\echo '${label}`);
      expect(text, `4g does not quote "${label}"`).toContain(label);
    }
  });

  it('names its context on every kubectl line, and sets and quotes its project', () => {
    const text = section();
    const trimmed = text.split('\n').map((l) => l.trim());
    // `|| kubectl …` continues the line above: it runs only when that one fails.
    const kubectl = trimmed.filter((l) => /^(?:\|\|\s*)?kubectl /.test(l));
    expect(kubectl.length, 'no kubectl lines, so this check would pass on nothing').toBeGreaterThan(0);
    const count = (l, re) => (l.match(re) ?? []).length;
    expect(kubectl.filter((l) => count(l, /\bkubectl /g) !== count(l, /kubectl --context "\$KCTX"/g))).toEqual([]);

    expect(text, 'PROJECT_ID is not set in 4g').toMatch(/^PROJECT_ID=/m);
    const gcloud = trimmed.filter((l) => l.startsWith('gcloud '));
    expect(gcloud.length, 'no gcloud lines, so this check would pass on nothing').toBeGreaterThan(0);
    expect(gcloud.filter((l) => !l.includes('--project="$PROJECT_ID"'))).toEqual([]);
    expect(text, 'an unquoted $PROJECT_ID').not.toMatch(/(?<!")\$PROJECT_ID/);
  });

  it('checks the release for changes to what a run says before the dry run', () => {
    const ls = lines(section());
    const check = firstCommand(ls, (l) => l === KEEP_LIST_CHECK);
    const dryRun = firstCommand(ls, (l) => l.includes('psql') && !l.includes('-v apply=1'));
    expect(check, `no command "${KEEP_LIST_CHECK}"`).toBeGreaterThan(-1);
    expect(dryRun, 'no dry-run psql command').toBeGreaterThan(-1);
    expect(check, 'the keep-list check must come before the dry run').toBeLessThan(dryRun);
  });

  it('backs up the database the app uses, before the command that writes', () => {
    const ls = lines(section());
    // The backup is the only undo. Only the backup command itself counts as the
    // backup, so a sentence that names it can't stand in for it.
    const backup = firstCommand(ls, (l) => l.startsWith('gcloud sql backups create'));
    const write = firstCommand(ls, writes);
    expect(backup, 'no `gcloud sql backups create` command').toBeGreaterThan(-1);
    expect(write, 'no psql command with -v apply=1').toBeGreaterThan(-1);
    expect(backup, 'the backup must come before the psql command that writes').toBeLessThan(write);

    // Before the backup: the instance's private IP, and the host the app's Secret points at.
    const instance = firstCommand(ls, (l) => l.startsWith('gcloud sql instances describe ax-next-db')
      && l.includes("--format='value(ipAddresses[0].ipAddress)'"));
    const secret = firstCommand(ls, (l) => l.startsWith('kubectl ') && l.includes('get secret ax-next-db') && l.includes("jsonpath='{.data.url}'"));
    expect(instance, 'no command printing the instance IP').toBeGreaterThan(-1);
    expect(secret, "no command printing the Secret's host").toBeGreaterThan(-1);
    expect(Math.max(instance, secret), 'compare them before the backup').toBeLessThan(backup);
    // The URL holds the password. `-n` with `p` prints only a host the pattern
    // found (never the line when it finds none), and the greedy `.*@` takes the
    // last @, so a password with an @ in it can't print a piece of itself.
    expect(ls[secret].line).toContain("| base64 -d | sed -nE 's#^.*@([^:/?]+).*$#\\1#p'");
  });

  it('calls the rewrite done only when its log ends with COMMIT', () => {
    // psql prints `COMMIT` only because the script's write branch ends in one.
    const branch = script.indexOf('\\if :apply');
    expect(branch, 'the script has no `\\if :apply` branch').toBeGreaterThan(-1);
    expect(script.slice(branch, script.indexOf('\\else', branch))).toMatch(/^COMMIT;$/m);

    const ls = lines(section());
    const write = firstCommand(ls, writes);
    expect(write, 'no psql command with -v apply=1').toBeGreaterThan(-1);
    const after = ls.slice(write + 1).map((l) => l.line).join('\n');
    expect(after, 'after the write, 4g must say the log has to end with COMMIT').toMatch(/ends with `COMMIT`/);
    expect(after, 'and name the line just before it').toContain('routines rewritten:');
  });
});

describe('lines()', () => {
  it('counts only fenced lines that are not comments as commands, so prose naming the flag is skipped', () => {
    const ls = lines([
      'its psql line adds `-v apply=1`',
      '```bash',
      '# psql -v apply=1 in a comment',
      'psql -X -v apply=1 -f /sql/scrub.sql',
      '```',
      'and psql -v apply=1 in prose again',
    ].join('\n'));
    expect(ls.map((l) => l.command)).toEqual([false, false, false, true, false, false]);
    expect(firstCommand(ls, writes)).toBe(3);
  });
});
