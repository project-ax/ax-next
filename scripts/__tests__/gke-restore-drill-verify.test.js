// Guard: the restore drill's verifier tells the truth about a restored copy.
//
// WHY THIS EXISTS. `deploy/gke/restore-drill-verify.sh` is the part of the
// restore drill that decides PASS or FAIL. A drill whose verifier says PASS over
// a broken copy is worse than no drill: it is a backup nobody has restored, wearing
// a certificate. So this runs the REAL script (under `sh`, which is dash on the
// CI runner and on the agent image) against REAL git repositories and a REAL
// sqlite file, then breaks each in the ways a bad restore breaks them, and
// asserts the verdict flips.
//
// Nothing here talks to GCP or Kubernetes. The cluster half of the drill is
// covered by gke-backups.test.js with stub `gcloud`/`kubectl`.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFY = join(repoRoot, 'deploy/gke/restore-drill-verify.sh');

// Hermetic git: no user config, fixed identity.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'drill',
  GIT_AUTHOR_EMAIL: 'drill@example.invalid',
  GIT_COMMITTER_NAME: 'drill',
  GIT_COMMITTER_EMAIL: 'drill@example.invalid',
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' });
}

let root;
let ws;
let facts;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drill-verify-'));
  ws = join(root, 'workspace');
  facts = join(root, 'facts');
  mkdirSync(ws);
  mkdirSync(facts);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A bare repo with one commit, named the way the local workspace backend names them. */
function makeRepo(name) {
  const work = join(root, `work-${name}`);
  mkdirSync(work);
  git(['init', '-q', '-b', 'main'], work);
  writeFileSync(join(work, 'hello.txt'), `hello from ${name}\n`);
  git(['add', '.'], work);
  git(['commit', '-q', '-m', `first commit for ${name}`], work);
  git(['clone', '-q', '--bare', work, join(ws, name)], root);
  return join(ws, name);
}

function makeFactsDb({ rows = 3 } = {}) {
  const db = new DatabaseSync(join(facts, 'facts.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE memory_facts (id INTEGER PRIMARY KEY, body TEXT)');
  const insert = db.prepare('INSERT INTO memory_facts (body) VALUES (?)');
  for (let i = 0; i < rows; i++) insert.run(`fact number ${i} `.repeat(40));
  db.close();
}

// `sh` is dash on the CI runner and bash-in-POSIX-mode on a Mac; the agent image
// runs dash. Run everything under dash too, when this machine has one, so a
// bashism that `sh` forgives on a laptop still fails here.
const HAS_DASH = spawnSync('dash', ['-c', 'true']).status === 0;
let shell = 'sh';

function verify(env = {}) {
  const r = spawnSync(shell, [VERIFY, ws, facts], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.each(['sh', ...(HAS_DASH ? ['dash'] : [])])('restore-drill-verify.sh under %s', (sh) => {
  beforeEach(() => {
    shell = sh;
  });

  it('passes a healthy restored copy and says what it looked at', () => {
    makeRepo('ws-aaa.git');
    makeRepo('ws-bbb.git');
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain('2 repositories found');
    expect(r.out).toContain('ws-aaa.git fsck clean');
    expect(r.out).toContain('ws-bbb.git fsck clean');
    expect(r.out).toContain('facts.db integrity_check = ok');
    expect(r.out).toContain('memory_facts: 3 rows');
    expect(r.out.trim().split('\n').at(-1)).toBe('DRILL-RESULT: PASS');
    expect(r.status).toBe(0);
  });

  it('accepts the single-repo layout older installs used', () => {
    makeRepo('repo.git');
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain('1 repositories found');
    expect(r.status).toBe(0);
  });

  it('FAILS when the workspace disk has no repositories at all', () => {
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain('no ws-*.git repositories found');
    expect(r.out).toContain('DRILL-RESULT: FAIL');
    expect(r.status).toBe(1);
  });

  it('FAILS when a repository is damaged, and names it', () => {
    const repo = makeRepo('ws-good.git');
    const bad = makeRepo('ws-bad.git');
    makeFactsDb();
    // Lose every loose object in the bad repo: what a half-restored disk looks like.
    for (const d of execFileSync('find', [join(bad, 'objects'), '-type', 'f', '-path', '*/objects/??/*'], {
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(Boolean)) {
      rmSync(d, { force: true });
    }
    const r = verify();
    expect(r.out).toContain('FAIL: ws-bad.git fsck failed');
    expect(r.out).toContain('ws-good.git fsck clean');
    expect(repo).toBeTruthy();
    expect(r.status).toBe(1);
  });

  it('FAILS when facts.db is missing', () => {
    makeRepo('ws-aaa.git');
    const r = verify();
    expect(r.out).toContain('facts.db not found');
    expect(r.status).toBe(1);
  });

  it('FAILS when facts.db is corrupt', () => {
    makeRepo('ws-aaa.git');
    makeFactsDb({ rows: 400 });
    // Scribble over the middle of the file (after the header, so it still looks
    // like sqlite): a torn write. Any of "cannot open", "integrity_check
    // failed" or "cannot read table" is the right verdict; the wrong one is PASS.
    const fd = openSync(join(facts, 'facts.db'), 'r+');
    writeSync(fd, Buffer.alloc(8192, 0xab), 0, 8192, 4096);
    closeSync(fd);
    const r = verify();
    expect(r.out).toMatch(/FAIL: .*(integrity_check|could not|malformed)/);
    expect(r.out).not.toContain('DRILL-RESULT: PASS');
    expect(r.status).toBe(1);
  });

  it('FAILS when facts.db opens and reads fine but integrity_check reports damage', () => {
    // A torn write does not always make the file unreadable; sometimes it opens,
    // every SELECT works, and only integrity_check notices (here: a row that
    // breaks a CHECK constraint, like the real table's `provenance IN (...)`).
    makeRepo('ws-aaa.git');
    const db = new DatabaseSync(join(facts, 'facts.db'));
    db.exec('CREATE TABLE memory_facts (id INTEGER PRIMARY KEY, n INTEGER CHECK (n > 0))');
    db.exec('INSERT INTO memory_facts (n) VALUES (1)');
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.exec('INSERT INTO memory_facts (n) VALUES (-5)');
    db.close();
    const r = verify();
    expect(r.out).toContain('FAIL: facts.db integrity_check:');
    expect(r.out).not.toContain('integrity_check = ok');
    expect(r.out).toContain('DRILL-RESULT: FAIL');
    expect(r.status).toBe(1);
  });

  it('warns, but passes, when facts.db is valid and empty', () => {
    makeRepo('ws-aaa.git');
    makeFactsDb({ rows: 0 });
    const r = verify();
    expect(r.out).toContain('every table is empty');
    expect(r.status).toBe(0);
  });

  it('opens a REAL facts.db, vector table and all, without loading the sqlite-vec extension', () => {
    // The production facts.db carries a sqlite-vec `vec0` virtual table and an
    // FTS5 one. The drill pod opens the file with plain node:sqlite, which does
    // not have vec0 registered. Build the file the way the memory plugin does
    // (same driver, same extension) and prove the verifier still reads it.
    makeRepo('ws-aaa.git');
    const req = createRequire(join(repoRoot, 'packages/memory-facts-sqlite/package.json'));
    const BetterSqlite3 = req('better-sqlite3');
    const sqliteVec = req('sqlite-vec');
    const db = new BetterSqlite3(join(facts, 'facts.db'), { allowExtension: true });
    db.pragma('journal_mode = WAL');
    sqliteVec.load(db);
    db.exec('CREATE TABLE memory_facts (id INTEGER PRIMARY KEY, body TEXT)');
    db.exec('CREATE VIRTUAL TABLE memory_facts_vec USING vec0(embedding float[4])');
    db.exec('CREATE VIRTUAL TABLE memory_facts_fts USING fts5(body)');
    db.exec("INSERT INTO memory_facts (body) VALUES ('likes tea')");
    db.close();

    const r = verify();
    expect(r.out).toContain('facts.db integrity_check = ok');
    expect(r.out).toContain('memory_facts: 1 rows');
    // Virtual tables are skipped when counting, not read (and not failed).
    expect(r.out).not.toContain('memory_facts_vec: ');
    expect(r.out).not.toContain('memory_facts_fts: ');
    expect(r.out).not.toContain('FAIL');
    expect(r.status).toBe(0);
  });

  it('checks only MAX_REPOS repositories but still counts them all', () => {
    for (const n of ['ws-1.git', 'ws-2.git', 'ws-3.git']) makeRepo(n);
    makeFactsDb();
    const r = verify({ MAX_REPOS: '1' });
    expect(r.out).toContain('3 repositories found (checking the newest 1)');
    expect(r.out.match(/fsck clean/g)).toHaveLength(1);
    expect(r.status).toBe(0);
  });

  it('refuses to run without its two arguments, and says FAIL rather than nothing', () => {
    const r = spawnSync(shell, [VERIFY], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('DRILL-RESULT: FAIL');
  });

  it('is plain POSIX sh: no bashisms for the image\'s dash', () => {
    const text = readFileSync(VERIFY, 'utf-8');
    expect(text.split('\n')[0]).toBe('#!/bin/sh');
    expect(text).not.toMatch(/\[\[|\bmapfile\b|\bdeclare\b|\bsource\s/);
  });
});
