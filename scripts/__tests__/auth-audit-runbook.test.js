// Guard: the sign-up audit runbook (deploy/GKE.md, 4h) runs the script it names, and only
// against the cluster it names.
//
// WHY THIS EXISTS (TASK-1116). 4h walks a person through reading every account in production
// that the open sign-up may have let in. The script
// (`packages/auth-better/sql/audit-sign-ups.sql`, pinned by its own psql test in
// @ax/auth-better) is read-only, but the commands around it are kubectl against prod, and the
// default kubectl context on our machines IS prod. So every kubectl line names its context.
//
// What it checks: 4h sits after 4g's closing rule (4g's own guard reads everything from its
// heading to the first `---` as 4g); every kubectl line names `--context "$KCTX"`; every script
// path 4h loads is a file git tracks; the psql line passes `-v domain=`; the section headers and
// count names it explains are ones the script really prints; it has no ```text sample block
// (4g's guard counts `CREATE FUNCTION` lines in those) and no write flag.
//
// Plain file reads plus one `git ls-files`: no network, no Docker, no build.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_PATH = 'packages/auth-better/sql/audit-sign-ups.sql';
const HEADING = '### 4h. Audit accounts after TASK-1116 (sign-up gate)';
const PREVIOUS = '### 4g. Scrub old run errors';

const gke = readFileSync(join(repoRoot, 'deploy/GKE.md'), 'utf-8');
const script = existsSync(join(repoRoot, SCRIPT_PATH)) ? readFileSync(join(repoRoot, SCRIPT_PATH), 'utf-8') : '';

/** 4h: from its heading to the next horizontal rule. */
function section() {
  const start = gke.indexOf(HEADING);
  expect(start, `deploy/GKE.md has no "${HEADING}"`).toBeGreaterThan(-1);
  const end = gke.indexOf('\n---\n', start);
  expect(end, 'no --- line after 4h').toBeGreaterThan(start);
  return gke.slice(start, end);
}

/** The lines inside ``` fences that aren't `#` comments: what a reader pastes. */
function commands(text) {
  let fenced = false;
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced && t !== '' && !t.startsWith('#')) out.push(t);
  }
  return out;
}

/** True when git tracks `rel` (relative to the repo root). */
function tracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('the sign-up audit runbook (GKE.md 4h)', () => {
  it("sits after 4g's closing rule and before Step 5", () => {
    const g = gke.indexOf(PREVIOUS);
    const h = gke.indexOf(HEADING);
    const step5 = gke.indexOf('\n## Step 5');
    expect(g, 'no 4g heading').toBeGreaterThan(-1);
    expect(h, 'no 4h heading').toBeGreaterThan(-1);
    expect(gke.indexOf('\n---\n', g), "4h must come after 4g's closing ---").toBeLessThan(h);
    expect(h).toBeLessThan(step5);
    expect(gke.indexOf('\n---\n', h), '4h must end with its own --- before Step 5').toBeLessThan(step5);
  });

  it('names its context on every kubectl line, and never switches the default', () => {
    const text = section();
    // A kubectl command starts its line, or continues the one above after `||`. (A trailing
    // `# kubectl config get-contexts` comment is a hint, not a command.)
    const run = commands(text).filter((l) => /^(?:\|\|\s*)?kubectl /.test(l));
    expect(run.length, 'no kubectl commands, so this check would pass on nothing').toBeGreaterThan(0);
    const count = (l, re) => (l.match(re) ?? []).length;
    expect(run.filter((l) => count(l, /\bkubectl /g) !== count(l, /\bkubectl --context "\$KCTX"/g))).toEqual([]);
    expect(run.filter((l) => /use-context|set-context/.test(l))).toEqual([]);
    expect(text, 'KCTX is not set in 4h').toMatch(/^KCTX=/m);
    // The kind recipe pins kind by name; prod's is set by the reader, never left to the default.
    expect(text).toMatch(/^KCTX=kind-ax-next-dev\b/m);
  });

  it('loads a script git tracks, and passes it the domain', () => {
    const text = section();
    const run = commands(text);
    const fromFile = run.filter((l) => l.includes('--from-file=audit.sql='));
    expect(fromFile.length, 'no `--from-file=audit.sql=` command').toBeGreaterThan(0);
    const paths = new Set();
    for (const l of fromFile) paths.add(l.match(/--from-file=audit\.sql=(\S+)/)[1]);
    for (const l of run) for (const m of l.matchAll(/<\s*(\S+\.sql)\b/g)) paths.add(m[1]);
    expect([...paths]).toEqual([SCRIPT_PATH]);
    expect(tracked(SCRIPT_PATH), `${SCRIPT_PATH} is not tracked by git`).toBe(true);

    // psql as a command: at the start of a line (the pod's args) or after kubectl's `--` (kind).
    const psql = run.filter((l) => /^psql |-- psql /.test(l));
    expect(psql.length, 'no psql command').toBeGreaterThan(0);
    for (const l of psql) {
      expect(l).toContain('-v ON_ERROR_STOP=1');
      expect(l).toMatch(/-v domain=\S/);
      expect(l).not.toMatch(/-v apply|-c /);
    }
  });

  it('explains the sections and counts the script prints', () => {
    const text = section();
    const headers = script.split('\n').filter((l) => l.startsWith("\\echo '== ")).map((l) => l.slice(7, -1));
    expect(headers.length, 'the script prints no section headers').toBeGreaterThan(0);
    for (const h of headers) expect(text, `4h does not quote "${h}"`).toContain(h);
    for (const name of ['outside_domain', 'with_password', 'taken_over', 'unverified', 'id_token_sign_in', 'to_confirm']) {
      expect(script, `the script does not count ${name}`).toMatch(new RegExp(`\\bAS ${name}\\b`));
      expect(text, `4h does not explain ${name}`).toContain(name);
    }
    for (const verdict of ['LINKED AFTER PASSWORD - treat as taken over', 'password only',
      'password added after a provider sign-in - ask a developer', 'confirm with the person']) {
      expect(script).toContain(`'${verdict}'`);
      expect(text).toContain(verdict);
    }
  });

  it('has no sample-output block', () => {
    expect(section()).not.toMatch(/^\s*```text\s*$/m);
  });
});
