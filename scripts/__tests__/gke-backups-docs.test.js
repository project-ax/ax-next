// Guard: the backup runbook, the script and the overlay say the same thing.
//
// WHY THIS EXISTS. A backup runbook that has drifted from the script it
// describes is worse than none: the retention it promises is not the retention
// that runs, or the command it tells you to type in an emergency has a flag that
// was renamed last month. The script (`deploy/gke/backups.sh`) is the single
// source of truth for the numbers; `deploy/GKE.md` quotes them; the overlay
// `gke-values.yaml` points at both. This checks the quotes against the source,
// every flag the docs use against the flags the script accepts, and every
// internal link the runbook makes to this section.
//
// It also holds the two things a stub-driven test cannot: `shellcheck` over the
// shell we ship (the script writes to production, so it gets the linter), and
// "no deployment's project id in a public file".

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf-8');

const SCRIPT_PATH = 'deploy/gke/backups.sh';
const VERIFY_PATH = 'deploy/gke/restore-drill-verify.sh';
const script = read(SCRIPT_PATH);
const gke = read('deploy/GKE.md');
const overlay = read('deploy/charts/ax-next/gke-values.yaml');

function constant(name) {
  const m = new RegExp(`^${name}=("?)([^"\\n#]+)\\1`, 'm').exec(script);
  if (m === null) throw new Error(`${name} not found in ${SCRIPT_PATH}`);
  return m[2].trim();
}

/** The runbook's backup section: from its heading to the next top-level heading. */
function backupSection() {
  const start = gke.indexOf('## Backups and disaster recovery (do not skip)');
  expect(start, 'the runbook section is missing').toBeGreaterThan(-1);
  const rest = gke.slice(start + 3);
  const end = rest.search(/\n## /);
  return gke.slice(start, end === -1 ? undefined : start + 3 + end);
}

/** GitHub-style heading slug. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

describe('the backup runbook quotes the script, not its memory of it', () => {
  it('states the schedule name, retention and start time the script really uses', () => {
    const section = backupSection();
    const name = constant('DEFAULT_SCHEDULE_NAME');
    const days = constant('DEFAULT_RETENTION_DAYS');
    const start = constant('DEFAULT_START_TIME');
    expect(section, 'schedule name').toContain(`\`${name}\``);
    expect(section, 'retention').toMatch(new RegExp(`keep ${days} days`));
    expect(section, 'retention in the table').toMatch(new RegExp(`kept ${days} days`));
    expect(section, 'start time').toContain(`${start} UTC`);
  });

  it('states the staleness threshold the status command really uses', () => {
    const m = /^STALE_AFTER="PT(\d+)H"/m.exec(script);
    expect(m, 'STALE_AFTER not in the form PT<n>H').not.toBeNull();
    expect(backupSection()).toContain(`${m[1]} hours`);
  });

  it('creates the database the way the runbook says it is protected (Step 1b)', () => {
    // The "14 kept" and "7 days" claims in the table are only true if a fresh
    // install creates the instance with these flags.
    const days = constant('DEFAULT_RETENTION_DAYS');
    expect(gke).toContain('--enable-point-in-time-recovery');
    expect(gke).toContain(`--retained-backups-count=${days}`);
    expect(backupSection()).toContain('automated backup (14 kept)');
  });

  it('only uses commands and flags the script accepts', () => {
    const parse = script.slice(script.indexOf('parse_args() {'), script.indexOf('validate_args() {'));
    const accepted = new Set(parse.match(/--[a-z][a-z-]*/g));
    expect(accepted.has('--dry-run')).toBe(true);
    expect(accepted.has('--snapshot-now')).toBe(true);
    expect(accepted.has('--workspace-snapshot')).toBe(true);

    const commands = new Set(['enable', 'status', 'drill', 'drill-cleanup']);
    const bad = [];
    for (const [file, text] of [
      ['deploy/GKE.md', gke],
      ['deploy/charts/ax-next/gke-values.yaml', overlay],
      ['deploy/gke/backups.sh (header)', script.split('\nset -euo pipefail')[0]],
    ]) {
      for (const line of text.split('\n')) {
        const m = /backups\.sh\s+(\S+)(.*)$/.exec(line);
        if (m === null) continue;
        const cmd = m[1].replace(/[`.,;:)]+$/, '');
        // Prose that names the file ("deploy/gke/backups.sh (a daily...") is not a command line.
        if (!/^[a-z-]+$/.test(cmd) || cmd === 'a' || cmd === 'and') continue;
        if (!commands.has(cmd)) bad.push(`${file}: unknown command "${cmd}" in: ${line.trim()}`);
        for (const f of m[2].match(/--[a-z][a-z-]*/g) ?? []) {
          if (!accepted.has(f)) bad.push(`${file}: "${cmd}" uses unknown flag ${f}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('documents every command the script has', () => {
    const section = backupSection();
    for (const cmd of ['enable', 'status', 'drill', 'drill-cleanup']) {
      expect(section, cmd).toContain(`backups.sh ${cmd}`);
    }
  });

  it('says plainly what is NOT covered and what a bad day costs', () => {
    const section = backupSection();
    for (const phrase of ['Filestore', 'crash-consistent', 'Worst-case data loss', 'Up to 24 hours', 'What is **not** covered']) {
      expect(section, phrase).toContain(phrase);
    }
    expect(section).toMatch(/drill log|Record every drill/i);
  });

  it('keeps the overlay honest: no "THERE IS NO BACKUP", and it points at the script', () => {
    expect(overlay).not.toMatch(/THERE IS NO BACKUP/i);
    expect(overlay).toContain('deploy/gke/backups.sh enable');
    expect(overlay).toContain('Backups and disaster recovery');
  });
});

describe('links into the runbook resolve', () => {
  it('every #anchor link in GKE.md points at a real heading', () => {
    const headings = new Set(
      [...gke.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1].replace(/`/g, ''))),
    );
    const broken = [...gke.matchAll(/\]\(#([^)]+)\)/g)]
      .map((m) => m[1])
      .filter((a) => !headings.has(a));
    expect(broken).toEqual([]);
  });

  it('the files the runbook links to exist and are executable in git', () => {
    for (const rel of ['deploy/gke/backups.sh', 'deploy/gke/restore-drill-verify.sh']) {
      expect(gke, rel).toContain(`(${rel.replace('deploy/', '')})`);
      const mode = execFileSync('git', ['ls-files', '-s', '--', rel], { cwd: repoRoot, encoding: 'utf-8' }).split(' ')[0];
      expect(mode, `${rel} must be committed executable (100755)`).toBe('100755');
    }
  });
});

describe('the shell we ship', () => {
  const haveShellcheck = spawnSync('shellcheck', ['--version']).status === 0;

  it('has shellcheck available where CI runs (so this guard cannot silently vanish)', () => {
    if (process.env.CI) expect(haveShellcheck, 'install shellcheck in ci.yml').toBe(true);
  });

  it.runIf(haveShellcheck)('passes shellcheck: backups.sh (bash), the verifier (POSIX sh), and the stubs', () => {
    const run = (args) => spawnSync('shellcheck', args, { cwd: repoRoot, encoding: 'utf-8' });
    const bash = run(['-x', SCRIPT_PATH, 'scripts/__tests__/fixtures/gke-backups/gcloud', 'scripts/__tests__/fixtures/gke-backups/kubectl']);
    expect(`${bash.stdout}${bash.stderr}`).toBe('');
    const sh = run(['--shell=sh', VERIFY_PATH]);
    expect(`${sh.stdout}${sh.stderr}`).toBe('');
  });

  it('names no project, cluster or disk of any real deployment', () => {
    // This repo is public. Everything deployment-specific is discovered at run
    // time. So a literal `projects/<id>/...` in these files must be a
    // placeholder or a variable, never a value. (An allowlist of shapes, not a
    // denylist of names: a denylist would publish the very strings it guards.)
    for (const rel of [SCRIPT_PATH, VERIFY_PATH]) {
      const text = read(rel);
      const literal = [...text.matchAll(/projects\/([A-Za-z0-9._:-]+)/g)]
        .map((m) => m[1])
        .filter((id) => !/^[<$]/.test(id) && id !== 'p');
      expect(literal, `${rel}: hard-coded project id`).toEqual([]);
      expect(text, `${rel}: gke_ context`).not.toMatch(/gke_[a-z0-9-]+_[a-z0-9-]+_/);
    }
  });
});
