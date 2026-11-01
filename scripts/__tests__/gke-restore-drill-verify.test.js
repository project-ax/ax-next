// Guard: the restore drill's verifier tells the truth about a restored copy.
//
// WHY THIS EXISTS. `deploy/gke/restore-drill-verify.sh` is the part of the
// restore drill that decides PASS or FAIL. A drill whose verifier says PASS over
// a broken copy is worse than no drill: it is a backup nobody has restored, wearing
// a certificate. So this runs the REAL script (under `sh`, which is dash on the
// CI runner and on the agent image) against a REAL content-addressed blob tree
// (the host PVC's `blobs/`, the only live data on it since TASK-996) and a REAL
// sqlite file, then breaks each in the ways a bad restore breaks them, and
// asserts the verdict flips.
//
// Nothing here talks to GCP or Kubernetes. The cluster half of the drill is
// covered by gke-backups.test.js with stub `gcloud`/`kubectl`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
  symlinkSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFY = join(repoRoot, 'deploy/gke/restore-drill-verify.sh');

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

/** Store `content` the way @ax/blob-store-fs does: blobs/<aa>/<bb>/<sha256>. */
function makeBlob(content, { ageSeconds = 0 } = {}) {
  const sha = createHash('sha256').update(content).digest('hex');
  const dir = join(ws, 'blobs', sha.slice(0, 2), sha.slice(2, 4));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, sha);
  writeFileSync(file, content);
  if (ageSeconds > 0) {
    const t = Date.now() / 1000 - ageSeconds;
    utimesSync(file, t, t);
  }
  return { sha, file };
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
    makeBlob('first attachment');
    makeBlob('second attachment');
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain('2 blobs found (hashing the newest 2)');
    expect(r.out.match(/hash matches/g)).toHaveLength(2);
    expect(r.out).toContain('facts.db integrity_check = ok');
    expect(r.out).toContain('memory_facts: 3 rows');
    expect(r.out.trim().split('\n').at(-1)).toBe('DRILL-RESULT: PASS');
    expect(r.status).toBe(0);
  });

  it('FAILS when the workspace disk has no blobs/ directory', () => {
    // The store creates its root at boot, so a running fs deployment's disk
    // always has one. A disk without it is the wrong disk or a bad copy.
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain('FAIL: no blobs/ directory');
    expect(r.out).toContain('DRILL-RESULT: FAIL');
    expect(r.status).toBe(1);
  });

  it('warns, but passes, when blobs/ exists and is empty', () => {
    mkdirSync(join(ws, 'blobs'));
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain('blobs/ holds no stored files');
    expect(r.status).toBe(0);
  });

  it('FAILS when a blob\'s bytes no longer match its name, and names it', () => {
    const good = makeBlob('good bytes');
    const bad = makeBlob('bytes that will be torn');
    writeFileSync(bad.file, 'torn');
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain(`FAIL: ${bad.sha.slice(0, 12)} content does not match its name`);
    expect(r.out).toContain(`${good.sha.slice(0, 12)} hash matches`);
    expect(r.out).toContain('DRILL-RESULT: FAIL');
    expect(r.status).toBe(1);
  });

  it('FAILS on a symlink where a blob should be, without following it', () => {
    const real = makeBlob('real');
    const sha = createHash('sha256').update('pointed-at').digest('hex');
    const dir = join(ws, 'blobs', sha.slice(0, 2), sha.slice(2, 4));
    mkdirSync(dir, { recursive: true });
    symlinkSync(real.file, join(dir, sha));
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain(`FAIL: ${sha} is not a regular file`);
    expect(r.status).toBe(1);
  });

  it('FAILS when blobs/ itself is a symlink, without hashing what it points at', () => {
    // Pointed off the restored disk, a followed link would "verify" some other tree.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(ws, 'blobs'));
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain('FAIL: blobs is a symlink');
    expect(r.out).not.toContain('blobs found');
    expect(r.status).toBe(1);
  });

  it('FAILS on a symlinked shard directory instead of skipping it', () => {
    const torn = createHash('sha256').update('real bytes').digest('hex');
    const hidden = join(root, 'hidden', torn.slice(2, 4));
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, torn), 'torn');
    mkdirSync(join(ws, 'blobs'));
    symlinkSync(join(root, 'hidden'), join(ws, 'blobs', torn.slice(0, 2)));
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain(`FAIL: ${torn.slice(0, 2)} is a symlink, not a shard directory`);
    expect(r.status).toBe(1);
  });

  it('names an unreadable blob in a FAIL line and keeps hashing the rest', () => {
    if (process.getuid?.() === 0) return; // root reads mode-000 files anyway
    const locked = makeBlob('locked bytes');
    const fine = makeBlob('fine bytes', { ageSeconds: 100 });
    chmodSync(locked.file, 0o000);
    makeFactsDb();
    try {
      const r = verify();
      expect(r.out).toContain(`FAIL: ${locked.sha.slice(0, 12)} cannot be read: EACCES`);
      expect(r.out).toContain(`${fine.sha.slice(0, 12)} hash matches`);
      expect(r.out).not.toMatch(/\n\s+at /); // no stack trace
      expect(r.status).toBe(1);
    } finally {
      chmodSync(locked.file, 0o644);
    }
  });

  it.each(['0', '00', 'abc', '-5', ''])('refuses MAX_BLOBS=%j instead of hashing nothing', (v) => {
    const b = makeBlob('bytes');
    writeFileSync(b.file, 'torn');
    makeFactsDb();
    const r = verify({ MAX_BLOBS: v });
    if (v === '') {
      // Unset-equivalent: the default applies and the torn blob is caught.
      expect(r.out).toContain('content does not match its name');
    } else {
      expect(r.out).toContain('MAX_BLOBS must be a positive integer');
    }
    expect(r.status).toBe(1);
  });

  it('FAILS on a blob filed under the wrong shard', () => {
    const { sha, file } = makeBlob('misfiled');
    const wrong = join(ws, 'blobs', sha.slice(0, 2) === '00' ? '01' : '00', '00');
    mkdirSync(wrong, { recursive: true });
    writeFileSync(join(wrong, sha), readFileSync(file));
    rmSync(file);
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain(`FAIL: ${sha} is filed under the wrong shard`);
    expect(r.status).toBe(1);
  });

  it('ignores what the store itself ignores: .retired/, temp files, stray names', () => {
    makeBlob('live');
    const { sha } = makeBlob('retired one');
    // Move one into the retired tree, the way `retire` does.
    const retired = join(ws, 'blobs', '.retired', sha.slice(0, 2), sha.slice(2, 4));
    mkdirSync(retired, { recursive: true });
    writeFileSync(join(retired, sha), 'not even the right bytes');
    rmSync(join(ws, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha));
    const live = makeBlob('another');
    writeFileSync(`${live.file}.tmp.123.abc`, 'half written');
    mkdirSync(join(ws, 'blobs', 'lost+found'));
    makeFactsDb();
    const r = verify();
    expect(r.out).toContain('2 blobs found');
    expect(r.out).not.toContain('FAIL');
    expect(r.status).toBe(0);
  });

  it('reports old ws-*.git repos without checking them, and never runs git', () => {
    // Since TASK-995 nothing reads the old git workspace repos. They are
    // agent-written and untrusted, so the verifier must not hand them to git
    // at all: a PATH stub records any git call.
    mkdirSync(join(ws, 'ws-aaa.git'));
    mkdirSync(join(ws, 'ws-bbb.git'));
    makeBlob('blob');
    makeFactsDb();
    const bin = join(root, 'gitbin');
    mkdirSync(bin);
    const calls = join(root, 'git-calls.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexit 1\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const r = verify({ PATH: `${bin}:${process.env.PATH}` });
    expect(r.out).toContain('warn: 2 old git workspace repos (ws-*.git, repo.git) still on the disk');
    expect(r.out).toContain('Reset after the agent-files cutover');
    expect(existsSync(calls), 'the verifier ran git').toBe(false);
    expect(r.status).toBe(0);
  });

  it('hashes only MAX_BLOBS blobs, newest first, but still counts them all', () => {
    makeBlob('old', { ageSeconds: 3000 });
    makeBlob('older', { ageSeconds: 6000 });
    const newest = makeBlob('newest');
    makeFactsDb();
    const r = verify({ MAX_BLOBS: '1' });
    expect(r.out).toContain('3 blobs found (hashing the newest 1)');
    expect(r.out.match(/hash matches/g)).toHaveLength(1);
    expect(r.out).toContain(`${newest.sha.slice(0, 12)} hash matches`);
    expect(r.status).toBe(0);
  });

  it('FAILS when facts.db is missing', () => {
    makeBlob('blob');
    const r = verify();
    expect(r.out).toContain('facts.db not found');
    expect(r.status).toBe(1);
  });

  it('FAILS when facts.db is corrupt', () => {
    makeBlob('blob');
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
    makeBlob('blob');
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
    makeBlob('blob');
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
    makeBlob('blob');
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
