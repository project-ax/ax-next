// Guard: delete_user.sh deletes a user's personal agents THROUGH THE HOST before it
// deletes a single row, and fails closed.
//
// WHY THIS EXISTS (TASK-994). The script used to delete `agents_v1_agents` rows with
// raw SQL. That skips `agents:deleted`, so no plugin cleaned up after the agents
// (chats, sessions, routines, files, facts). Worse, its routines statements named
// columns the routines schema had since renamed, and everything ran in one
// ON_ERROR_STOP transaction — so in practice it deleted nothing at all, and nobody
// noticed. Now it mints a short login session for the user, has the host delete each
// agent with the product's own `DELETE /admin/agents/:id` (see
// delete-user-agents.test.js for the in-pod half), and only then removes the rest.
//
// These tests run the REAL script against a stub `kubectl` that records every call
// (argv + stdin) and answers from STUB_* variables. Anything it does not recognise
// fails loudly (exit 99), so a new cluster call cannot slip past unseen. What they pin:
//   - the agents go through the host, before the transaction, and the transaction no
//     longer deletes agents rows;
//   - a host refusal, or a personal agent still there afterwards, stops the script
//     before any row is deleted — and the session it minted is removed either way;
//   - the email and user id reach psql only as variables (`-v name=value`), never as
//     SQL text, so a quote in an email cannot change a query;
//   - every kubectl call is pinned to the kind context;
//   - every table and column its SQL names exists in the migrations (the check that
//     would have caught the renamed routines columns).
//
// Nothing here can reach a cluster: the stub comes first on PATH and KUBECONFIG
// points at a file that does not exist.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'delete_user.sh');
const HELPER = join(REPO_ROOT, 'scripts', 'delete-user-agents.mjs');
const KIND_CONTEXT = 'kind-ax-next-dev';
const UID = 'usr_0123abcd';

// macOS ships bash 3.2 as /bin/bash and Homebrew's bash usually comes first on PATH,
// so run the suite under both when they differ: the script promises to work on both.
const SHELLS = [
  ...new Set(
    ['bash', '/bin/bash']
      .map((b) => {
        const r = spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf-8' });
        return r.status === 0 ? realpathSync(r.stdout.trim()) : null;
      })
      .filter(Boolean),
  ),
];

// The stub is node behind a two-line sh wrapper: node so it can log argv and stdin as
// JSON without shell-quoting games, `.cjs` so no package.json can flip it to ESM.
const STUB_JS = String.raw`
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const stdin = argv.includes('-i') ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, stdin }) + '\n');
const env = process.env;
const ids = (v) => (v || '').split(/\s+/).filter(Boolean);
const done = (out = '', code = 0) => {
  process.stdout.write(out);
  process.exit(code);
};
const inPod = argv.slice(argv.indexOf('--') + 1);

if (argv.includes('get') && argv.includes('secret')) done(Buffer.from('pw').toString('base64'));

if (inPod.includes('psql')) {
  if (/^BEGIN;/m.test(stdin)) done(env.STUB_TX_FAILS ? '' : 'BEGIN\nCOMMIT\n', env.STUB_TX_FAILS ? 3 : 0);
  if (/FROM auth_better_v1_users WHERE email/.test(stdin)) {
    done(env.STUB_UID ? env.STUB_UID + '|' + (env.STUB_ROLE || 'user') + '\n' : '');
  }
  if (/SELECT COUNT\(\*\) FROM agents_v1_agents/i.test(stdin)) done((env.STUB_REMAINING || '0') + '\n');
  if (/SELECT agent_id FROM agents_v1_agents/.test(stdin)) done(ids(env.STUB_AGENTS).join('\n'));
  if (/INSERT INTO auth_better_v1_sessions/.test(stdin)) done();
  if (/DELETE FROM auth_better_v1_sessions WHERE id = /.test(stdin)) done();
}

if (argv.includes('deploy/ax-next-host')) {
  const [, ...agentIds] = stdin.split('\n');
  const fail = new Set(ids(env.STUB_FAIL_IDS));
  let out = '';
  for (const id of agentIds.filter(Boolean)) {
    if (fail.has(id)) {
      process.stdout.write(out);
      process.stderr.write('failed ' + id + ' 401 {"error":"unauthenticated"}\n');
      process.exit(1);
    }
    out += 'deleted ' + id + '\n';
  }
  done(out);
}

process.stderr.write('UNHANDLED kubectl ' + argv.join(' ') + '\n');
process.exit(99);
`;

let binDir;
let sandbox;
let logFile;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'delete-user-bin-'));
  writeFileSync(join(binDir, 'kubectl-stub.cjs'), STUB_JS);
  writeFileSync(
    join(binDir, 'kubectl'),
    `#!/bin/sh\nexec '${process.execPath}' '${join(binDir, 'kubectl-stub.cjs')}' "$@"\n`,
  );
  chmodSync(join(binDir, 'kubectl'), 0o755);
});
afterAll(() => rmSync(binDir, { recursive: true, force: true }));

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'delete-user-'));
  logFile = join(sandbox, 'calls.jsonl');
  writeFileSync(logFile, '');
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

function run(shell, args, env = {}) {
  const r = spawnSync(shell, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: sandbox,
      KUBECONFIG: join(sandbox, 'no-such-kubeconfig'),
      STUB_LOG: logFile,
      STUB_UID: UID,
      ...env,
    },
  });
  const calls = readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

// ── reading the recorded calls ──────────────────────────────────────────────────────
const isSql = (c) => c.argv.includes('psql');
const isTx = (c) => isSql(c) && /^BEGIN;/m.test(c.stdin);
const isHost = (c) => c.argv.includes('deploy/ax-next-host');
const isMint = (c) => isSql(c) && /INSERT INTO auth_better_v1_sessions/.test(c.stdin);
const isDrop = (c) => isSql(c) && !isTx(c) && /DELETE FROM auth_better_v1_sessions WHERE id = /.test(c.stdin);
const isRecount = (c) => isSql(c) && /SELECT COUNT\(\*\) FROM agents_v1_agents/i.test(c.stdin);
const indexOf = (r, pred) => r.calls.findIndex(pred);
const only = (r, pred) => {
  const hits = r.calls.filter(pred);
  expect(hits).toHaveLength(1);
  return hits[0];
};

/** psql variables a call passed, as `{ name: value }`. */
function psqlVars(call) {
  const vars = {};
  call.argv.forEach((a, i) => {
    if (call.argv[i - 1] === '-v') {
      const eq = a.indexOf('=');
      vars[a.slice(0, eq)] = a.slice(eq + 1);
    }
  });
  return vars;
}

describe.each(SHELLS)('delete_user.sh under %s', (shell) => {
  it('deletes each personal agent through the host before any row is removed', () => {
    const r = run(shell, ['someone@example.com'], { STUB_AGENTS: 'agt_a agt_b' });
    expect(r.status, r.out).toBe(0);

    const host = only(r, isHost);
    const [token, ...ids] = host.stdin.split('\n');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(ids).toEqual(['agt_a', 'agt_b', '']);
    // The in-pod helper, run as the helper's own tests run it.
    expect(host.argv.slice(host.argv.indexOf('--') + 1)).toEqual([
      'node',
      '--input-type=module',
      '-e',
      readFileSync(HELPER, 'utf8').replace(/\n+$/, ''),
    ]);
    expect(host.argv.join(' ')).toContain('-n ax-next exec -i deploy/ax-next-host -c host --');

    // The host gets the very session the script minted for this user...
    const mint = only(r, isMint);
    expect(mint.stdin).toContain(`\\set token '${token}'`);
    expect(psqlVars(mint)).toMatchObject({ uid: UID });
    expect(mint.stdin).toMatch(/INTERVAL '10 minutes'/);
    // ...which is gone again once the host is done, before the transaction.
    const drop = only(r, isDrop);
    expect(psqlVars(drop).sid).toBe(psqlVars(mint).sid);

    const tx = only(r, isTx);
    expect(indexOf(r, isMint)).toBeLessThan(indexOf(r, isHost));
    expect(indexOf(r, isHost)).toBeLessThan(indexOf(r, isDrop));
    expect(indexOf(r, isDrop)).toBeLessThan(indexOf(r, isRecount));
    expect(indexOf(r, isRecount)).toBeLessThan(indexOf(r, isTx));
    expect(tx.stdin).not.toMatch(/DELETE\s+FROM\s+agents_v1_agents/i);
    expect(tx.argv).toContain('ON_ERROR_STOP=1');
    // Auth rows go last: the user row is the final delete before COMMIT.
    const deletes = tx.stdin.match(/DELETE FROM \w+/g);
    expect(deletes.at(-1)).toBe('DELETE FROM auth_better_v1_users');
    expect(tx.stdin.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('stops before any SQL when the host refuses an agent, and removes the session it minted', () => {
    const r = run(shell, ['someone@example.com'], {
      STUB_AGENTS: 'agt_a agt_b',
      STUB_FAIL_IDS: 'agt_b',
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('failed agt_b 401');
    expect(r.calls.filter(isTx)).toEqual([]);
    expect(r.calls.filter(isRecount)).toEqual([]);
    const drop = only(r, isDrop);
    expect(psqlVars(drop).sid).toBe(psqlVars(only(r, isMint)).sid);
    expect(indexOf(r, isDrop)).toBeGreaterThan(indexOf(r, isHost));
  });

  it('skips the host when the user owns no personal agents', () => {
    const r = run(shell, ['someone@example.com'], { STUB_AGENTS: '' });
    expect(r.status, r.out).toBe(0);
    expect(r.calls.filter(isHost)).toEqual([]);
    expect(r.calls.filter(isMint)).toEqual([]);
    expect(r.calls.filter(isDrop)).toEqual([]);
    only(r, isTx);
  });

  it('refuses to delete rows while personal agents remain', () => {
    const r = run(shell, ['someone@example.com'], { STUB_AGENTS: 'agt_a', STUB_REMAINING: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/still/);
    expect(r.calls.filter(isTx)).toEqual([]);
    only(r, isDrop);
  });

  it('stops when no user has that email', () => {
    const r = run(shell, ['nobody@example.com'], { STUB_UID: '' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('no user with email nobody@example.com');
    expect(r.calls.filter((c) => isTx(c) || isMint(c) || isHost(c))).toEqual([]);
  });

  it('prints usage and touches nothing without exactly one email', () => {
    for (const args of [[], [''], ['a@example.com', 'b@example.com']]) {
      const r = run(shell, args);
      expect(r.status).toBe(2);
      expect(r.out).toMatch(/usage: bash delete_user\.sh <email>/);
      expect(r.calls).toEqual([]);
    }
  });

  it('never splices the email into SQL', () => {
    const email = "o'brien+x@example.com";
    const r = run(shell, [email], { STUB_AGENTS: 'agt_a' });
    expect(r.status, r.out).toBe(0);
    const carrying = [];
    for (const c of r.calls) {
      expect(c.stdin).not.toContain(email);
      c.argv.forEach((a, i) => {
        if (a.includes(email)) carrying.push([c.argv[i - 1], a]);
      });
    }
    expect(carrying).toEqual([['-v', `email=${email}`]]);
  });

  it('never splices the user id into SQL either', () => {
    const r = run(shell, ['someone@example.com'], { STUB_AGENTS: 'agt_a' });
    expect(r.status, r.out).toBe(0);
    for (const c of r.calls.filter(isSql)) expect(c.stdin).not.toContain(UID);
    for (const c of [r.calls.find(isMint), r.calls.find(isRecount), r.calls.find(isTx)]) {
      expect(psqlVars(c).uid).toBe(UID);
      expect(c.stdin).toContain(":'uid'");
    }
  });

  it('pins every kubectl call to kind', () => {
    const r = run(shell, ['someone@example.com'], { STUB_AGENTS: 'agt_a' });
    expect(r.status, r.out).toBe(0);
    expect(r.calls.length).toBeGreaterThan(5);
    for (const c of r.calls) {
      const i = c.argv.indexOf('--context');
      expect(i, c.argv.join(' ')).toBeGreaterThanOrEqual(0);
      expect(c.argv[i + 1]).toBe(KIND_CONTEXT);
    }
  });

  it('exits non-zero when the transaction fails', () => {
    const r = run(shell, ['someone@example.com'], { STUB_AGENTS: '', STUB_TX_FAILS: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).not.toMatch(/>> done/);
  });
});

// ── the schema check: every table and column the script's SQL names exists ──────────

/** `{ table -> Set(columns) }` from every CREATE TABLE / ALTER TABLE ADD COLUMN under packages/*\/src. */
function migrationSchema() {
  const schema = new Map();
  const cols = (t) => schema.get(t) ?? schema.set(t, new Set()).get(t);
  for (const pkg of readdirSync(join(REPO_ROOT, 'packages'))) {
    let files;
    try {
      files = readdirSync(join(REPO_ROOT, 'packages', pkg, 'src')).filter((f) => /migration.*\.ts$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const text = readFileSync(join(REPO_ROOT, 'packages', pkg, 'src', f), 'utf-8').replace(/--[^\n]*/g, '');
      for (const m of text.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(/gi)) {
        // The column list: up to the matching close paren, split on top-level commas.
        let depth = 0;
        let part = '';
        for (const ch of text.slice(m.index + m[0].length - 1)) {
          if (ch === '(' && depth++ === 0) continue;
          if (ch === ')' && --depth === 0) break;
          if (ch === ',' && depth === 1) {
            cols(m[1]).add(part.trim().split(/\s+/)[0].toLowerCase());
            part = '';
          } else part += ch;
        }
        cols(m[1]).add(part.trim().split(/\s+/)[0].toLowerCase());
      }
      for (const m of text.matchAll(/ALTER TABLE\s+(\w+)([^`;]*)/gi)) {
        for (const a of m[2].matchAll(/ADD COLUMN(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)) cols(m[1]).add(a[1].toLowerCase());
      }
    }
  }
  return schema;
}

/**
 * Names in `sql` that are not a column of any table its statement reads or writes.
 * The script's convention makes this readable: SQL words are UPPER case, every
 * lower-case word is a table or column, and values are psql variables (:'x') or
 * quoted literals. Per statement, every lower-case word must be one of the
 * statement's tables or a column of at least one of them.
 */
function unknownNames(sql, schema) {
  const bad = [];
  const text = sql.replace(/--[^\n]*/g, '').replace(/^\\.*$/gm, '');
  for (const stmt of text.split(';')) {
    const s = stmt.replace(/:?'[^']*'/g, ' ');
    const tables = [...s.matchAll(/\b(?:FROM|INTO)\s+(\w+)/g)].map((m) => m[1]);
    for (const t of tables) if (!schema.has(t)) bad.push(`table ${t}`);
    for (const [w] of s.matchAll(/\b[a-z][a-z0-9_]*\b/g)) {
      if (tables.includes(w)) continue;
      if (!tables.some((t) => schema.get(t)?.has(w))) bad.push(`${w} (${tables.join(', ')})`);
    }
  }
  return bad;
}

describe('delete_user.sh SQL matches the schema', () => {
  it('names only tables and columns the migrations create', () => {
    const r = run(SHELLS[0], ['someone@example.com'], { STUB_AGENTS: 'agt_a' });
    expect(r.status, r.out).toBe(0);
    const sql = r.calls.filter(isSql).map((c) => c.stdin).join('\n');
    expect(sql).toMatch(/^BEGIN;/m); // the transaction is in what we check
    expect(unknownNames(sql, migrationSchema())).toEqual([]);
  });

  it('self-test: flags the renamed routines columns the old script used', () => {
    // Verbatim from the pre-TASK-994 script. The routines schema calls these
    // `owner_user_id` and `routine_id`, so this statement failed and, inside one
    // ON_ERROR_STOP transaction, took every other delete down with it.
    const old = `
      DELETE FROM routines_v1_fires WHERE conversation_id IN (SELECT conversation_id FROM conversations_v1_conversations WHERE user_id='u1')
         OR (agent_id, path) IN (SELECT agent_id, path FROM routines_v1_definitions WHERE author_user_id='u1');
      DELETE FROM routines_v1_definitions       WHERE author_user_id='u1';`;
    const bad = unknownNames(old, migrationSchema());
    expect(bad).toEqual(expect.arrayContaining([expect.stringMatching(/^path /), expect.stringMatching(/^author_user_id /)]));
  });

  it('self-test: flags an unknown table, and accepts a known statement', () => {
    const schema = migrationSchema();
    expect(unknownNames("DELETE FROM agents_v9_nope WHERE owner_id = :'uid';", schema)).toContain('table agents_v9_nope');
    expect(unknownNames("DELETE FROM agents_v1_agents WHERE owner_id = :'uid';", schema)).toEqual([]);
  });
});
