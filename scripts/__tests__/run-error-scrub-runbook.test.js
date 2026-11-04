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
// its context (the default context on our machines is prod); the Cloud SQL
// backup command comes before the psql line that writes; and after that line,
// the runbook calls the write done only at `COMMIT`.
//
// That last one is the non-obvious one. The script prints
// `run-history rows rewritten:` BEFORE its second UPDATE and its COMMIT. If
// anything after that line fails, psql stops and the database rolls the whole
// transaction back, but the line is already in the log. So it proves nothing.
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
  'run-history rows rewritten:',
  'routines rewritten:',
  'Dry run: nothing was changed.',
];

/** 4g: from its heading to the next horizontal rule. */
function section() {
  const start = gke.indexOf(HEADING);
  expect(start, `deploy/GKE.md has no "${HEADING}"`).toBeGreaterThan(-1);
  const end = gke.indexOf('\n---\n', start);
  expect(end, 'no --- line after 4g').toBeGreaterThan(start);
  return gke.slice(start, end);
}

/** A line that runs psql with the flag that writes. */
const writes = (line) => line.includes('psql') && line.includes('-v apply=1');

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

  it('names its context on every kubectl line and backs up before it writes', () => {
    const lines = section().split('\n');
    const kubectl = lines.filter((l) => l.trim().startsWith('kubectl '));
    expect(kubectl.length, 'no kubectl lines, so this check would pass on nothing').toBeGreaterThan(0);
    expect(kubectl.filter((l) => !l.includes('--context "$KCTX"'))).toEqual([]);

    // The backup is the only undo. Prose may mention the flag earlier; only a
    // line that runs psql with it counts. Only the backup command itself counts
    // as the backup, so a sentence that names it can't stand in for it.
    const backup = lines.findIndex((l) => l.trim().startsWith('gcloud sql backups create'));
    const write = lines.findIndex(writes);
    expect(backup, 'no `gcloud sql backups create` command').toBeGreaterThan(-1);
    expect(write, 'no psql line with -v apply=1').toBeGreaterThan(-1);
    expect(backup, 'the backup must come before the psql line that writes').toBeLessThan(write);
  });

  it('calls the rewrite done only when its log reaches COMMIT', () => {
    // psql prints `COMMIT` only because the script's write branch ends in one.
    const branch = script.indexOf('\\if :apply');
    expect(branch, 'the script has no `\\if :apply` branch').toBeGreaterThan(-1);
    expect(script.slice(branch, script.indexOf('\\else', branch))).toMatch(/^COMMIT;$/m);

    const lines = section().split('\n');
    const write = lines.findIndex(writes);
    expect(write, 'no psql line with -v apply=1').toBeGreaterThan(-1);
    const after = lines.slice(write + 1).join('\n');
    expect(after, 'after the write, 4g must name COMMIT as the sign it worked').toContain('COMMIT');
    expect(after, 'and the line just before it').toContain('routines rewritten:');
  });
});
