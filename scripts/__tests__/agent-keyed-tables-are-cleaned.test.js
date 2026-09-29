// Guard: every table that stores rows keyed on an agent (or on a conversation or
// session that belongs to one) is cleaned when the agent is deleted — or is on the
// list below, with a reason, because it is kept on purpose.
//
// TASK-718. The prod walk deleted one agent and found rows left in seven tables
// (conversations, events, transcripts, artifacts, sessions, inbox, session owners),
// because deleting an agent only ever cleaned up what someone remembered to wire
// (credentials, the Filestore directory, routines). There is no foreign key from
// any of these tables to the agents table, on purpose (invariants 2 and 4: a plugin
// owns its own rows), so the database does not notice a missing cleanup and neither
// does a review of the plugin that adds the table. This does.
//
// WHY IT LIVES HERE AND NOT IN ONE PLUGIN'S TESTS. A guard for "no plugin, anywhere,
// adds an agent-keyed table without a cleanup" has to read everywhere, and CI's PR
// `test` job only runs the packages a PR changes. `pnpm test:scripts` runs on EVERY
// PR, so the PR that adds the table is the one that goes red.
//
// WHAT IT CHECKS. For every non-test source file under packages/*/src it finds each
// `CREATE TABLE` (plus `ALTER TABLE ... ADD COLUMN`) and collects the columns. A
// table with an `agent_id`, `agent_key`, `conversation_id` or `session_id` column is
// "agent-scoped" and must EITHER
//   - be deleted from (`deleteFrom('<table>')` or `DELETE FROM <table>`) in a
//     non-migration source file of the SAME package, AND that package must react to
//     `agents:deleted` or `conversations:purged` somewhere in its source; OR
//   - be listed in KEPT_ON_PURPOSE with the reason, and a card if the reason is
//     "not done yet".
//
// WHAT IT CANNOT SEE — a heuristic, not a proof. It does not run the code:
//   - A delete that exists but is keyed on the wrong thing, or is never reached,
//     passes. The per-plugin tests (`agents-deleted.test.ts` in each package) fire
//     the real event and count rows; this guard only makes sure a table cannot be
//     added and forgotten.
//   - State that is not a table: key-value entries, git repositories, object-store
//     blobs, files on a volume. Those are listed under NOT_TABLES below so the gap
//     is written down where the next person will look for it.
//   - A table created some way other than a `CREATE TABLE` in a .ts file.
//   - A table that ties rows to an agent through a GENERIC owner column
//     (`owner_id` plus `owner_type = 'agent'`, the shape the credentials store
//     uses) rather than one of the four scoping columns. Credentials are purged by
//     `credentials:purge-by-owner` from `deleteAgent` itself; the next table of
//     that shape has to be added to SCOPING_COLUMNS or found by review.
//   - A cleanup that cannot be re-run. The subscribers are idempotent, but
//     attachments hears about a conversation once, from the purge that deletes it,
//     so a lost `conversations:purged` is not healed by firing `agents:deleted`
//     again. Whatever such a failure leaves is unreadable, not exposed.
//
// THE ALLOWLIST IS PART OF THE TEST. Adding a table to KEPT_ON_PURPOSE is a
// decision that a person's data outlives the agent that produced it. Say why, in a
// sentence a reviewer can disagree with.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PACKAGES = join(ROOT, 'packages');

/** Columns that tie a row to an agent, directly or through its conversations/sessions. */
const SCOPING_COLUMNS = ['agent_id', 'agent_key', 'conversation_id', 'session_id'];

/** Hooks a package may use to hear that an agent, or its conversations, are gone. */
const CLEANUP_TRIGGERS = [/['"`]agents:deleted['"`]/, /['"`]conversations:purged['"`]/];

/**
 * Agent-scoped tables that deliberately survive the agent. Every entry is a
 * product or safety decision, not a to-do; a to-do belongs on the board.
 */
const KEPT_ON_PURPOSE = {
  routines_v1_fires:
    'Routine fire history (when it ran, status). TASK-680 kept it on purpose: it has no foreign key to the ' +
    'definitions and is preserved when a routine is de-materialized. Whether it should go with the agent is a ' +
    'retention question of its own; a follow-up card asks it.',
  attachments_v1_temps:
    'Pre-commit uploads. They carry a user id and no conversation or agent, expire on a TTL and are swept by ' +
    "the plugin's own janitor, so they cannot outlive the agent by more than the TTL.",
};

/**
 * Agent-scoped state that is not a table, so this guard cannot see it. Written
 * down so the gap has an address. Each has a follow-up card.
 */
// NOT_TABLES (documentation only, nothing reads it):
//   - the agent's git workspace repository (no delete hook exists yet)
//   - blob bytes behind attachments (content-addressed and shared across users)
//   - key-value entries: the memory observer cursors, declined-grant markers
//   - the agent's memory files inside its git workspace

/** Directories never scanned. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', 'tests', 'coverage']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(full);
  }
  return out;
}

/**
 * Replace `${NAME}` with the string a `const NAME = 'table_name'` in the same
 * package gives it. The sqlite facts backend writes `CREATE TABLE ... ${TABLE}`;
 * without this the guard would not see that backend's table at all.
 */
export function resolveTableConstants(files) {
  const constants = new Map();
  for (const { text } of files) {
    for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([a-z][a-z0-9_]*)'/g)) {
      constants.set(m[1], m[2]);
    }
  }
  if (constants.size === 0) return files;
  return files.map((f) => ({
    ...f,
    text: f.text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => constants.get(name) ?? whole),
  }));
}

/** Every package's non-test source files, keyed by package directory name. */
function readPackageSources() {
  const byPackage = new Map();
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    byPackage.set(
      pkg,
      resolveTableConstants(
        walk(src).map((file) => ({
          file,
          rel: relative(ROOT, file).split(sep).join('/'),
          text: readFileSync(file, 'utf-8'),
        })),
      ),
    );
  }
  return byPackage;
}

/** Text between the `(` at `open` and its matching `)`. */
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** Top-level comma split (a `NUMERIC(10, 2)` or `CHECK (a, b)` does not split). */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim().length > 0) parts.push(cur);
  return parts;
}

const CONSTRAINT_WORDS = new Set([
  'PRIMARY',
  'UNIQUE',
  'CHECK',
  'FOREIGN',
  'CONSTRAINT',
  'EXCLUDE',
  'LIKE',
]);

/** `{ table -> Set(columns) }` for every CREATE TABLE / ALTER TABLE in the text. */
export function tablesIn(text) {
  const tables = new Map();
  const cols = (name) => {
    if (!tables.has(name)) tables.set(name, new Set());
    return tables.get(name);
  };
  // Strip SQL and JS line comments so a column named in a comment is not a column.
  const clean = text.replace(/--[^\n]*/g, '').replace(/^\s*\/\/[^\n]*/gm, '');

  const create = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z0-9_]+)\s*\(/gi;
  for (let m = create.exec(clean); m !== null; m = create.exec(clean)) {
    const body = balanced(clean, m.index + m[0].length - 1);
    for (const part of splitTopLevel(body)) {
      const first = part.trim().split(/\s+/)[0]?.replace(/["`]/g, '');
      if (first === undefined || first.length === 0) continue;
      if (CONSTRAINT_WORDS.has(first.toUpperCase())) continue;
      cols(m[1]).add(first.toLowerCase());
    }
  }

  const alter = /ALTER TABLE\s+([a-z0-9_]+)([\s\S]*?)(?=`|;)/gi;
  for (let m = alter.exec(clean); m !== null; m = alter.exec(clean)) {
    const add = /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z0-9_]+)/gi;
    for (let a = add.exec(m[2]); a !== null; a = add.exec(m[2])) cols(m[1]).add(a[1].toLowerCase());
  }
  return tables;
}

function scan() {
  const byPackage = readPackageSources();
  /** table -> { pkg, columns:Set } for every agent-scoped table. */
  const scoped = new Map();
  for (const [pkg, files] of byPackage) {
    for (const { text } of files) {
      if (!/CREATE TABLE|ALTER TABLE/i.test(text)) continue;
      for (const [table, columns] of tablesIn(text)) {
        const hit = SCOPING_COLUMNS.filter((c) => columns.has(c));
        if (hit.length === 0) continue;
        const prev = scoped.get(table);
        const merged = new Set([...(prev?.columns ?? []), ...hit]);
        scoped.set(table, { pkg, columns: merged });
      }
    }
  }
  return { byPackage, scoped };
}

/** Does this package delete rows from `table` outside its migration/schema files? */
export function deletesFrom(files, table) {
  const kysely = new RegExp(`deleteFrom\\(\\s*['"\`]${table}(?:\\s+as\\s+\\w+)?['"\`]`);
  // A raw DELETE counts only where it is EXECUTED: inside a `sql\`...\`` tag or
  // handed to `prepare(` / `exec(` / `query(`. The bare words "DELETE FROM <table>"
  // also turn up in error messages (@ax/session-postgres names its inbox delete in
  // a corruption message), and a guard that counts prose passes with the real
  // delete removed -- a mutant proved it.
  const raw = new RegExp(
    `(?:\\bsql|\\.prepare\\(|\\.exec\\(|\\.query\\()\\s*\`[^\`]*?DELETE\\s+FROM\\s+${table}\\b`,
    'i',
  );
  // `const table = 'decisions_v1_decisions'; ... db.deleteFrom(table)`: the store
  // names its table once and passes the name around.
  const named = new RegExp(`\\bconst\\s+(\\w+)(?::\\s*[\\w.]+)?\\s*=\\s*['"\`]${table}['"\`]`, 'g');
  return files.some(({ rel, text }) => {
    if (/(^|\/)(migrations?|schema)\.[a-z]+$/.test(rel)) return false;
    const code = stripComments(text);
    if (kysely.test(code) || raw.test(code)) return true;
    for (const m of code.matchAll(named)) {
      if (new RegExp(`deleteFrom\\(\\s*${m[1]}\\s*\\)`).test(code)) return true;
    }
    return false;
  });
}

/** Drop block comments and `//` line comments (not the `//` of a URL). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Does this package react to the agent, or its conversations, going away? */
export function reactsToDeletion(files) {
  return files.some(({ text }) => CLEANUP_TRIGGERS.some((t) => t.test(text)));
}

describe('agent-scoped tables are cleaned when their agent is deleted (TASK-718)', () => {
  const { byPackage, scoped } = scan();

  it('finds the tables this guard exists for (a scan that finds nothing proves nothing)', () => {
    // The seven tables the prod walk found rows in, plus the ones TASK-680 and
    // credentials already cleaned. If the scan stops seeing these, the parser
    // broke, and every other case below would pass vacuously.
    for (const table of [
      'conversations_v1_conversations',
      'conversations_v1_events',
      'conversations_v1_transcripts',
      'attachments_v1_artifacts',
      'attachments_v1_files',
      'session_postgres_v1_sessions',
      'session_postgres_v1_inbox',
      'session_postgres_v2_session_agent',
      'routines_v1_definitions',
      'skills_v1_authored',
      // Both facts backends create a table of this name; the sqlite one through a
      // `${TABLE}` constant, which is why resolveTableConstants exists.
      'memory_facts_v1',
    ]) {
      expect([...scoped.keys()], `scan no longer sees ${table}`).toContain(table);
    }
  });

  it('sees the table of BOTH memory-facts backends (postgres literal, sqlite ${TABLE} constant)', () => {
    const owners = [];
    for (const [pkg, files] of byPackage) {
      if (!pkg.startsWith('memory-facts-')) continue;
      if (files.some(({ text }) => tablesIn(text).has('memory_facts_v1'))) owners.push(pkg);
    }
    expect(owners.sort()).toEqual(['memory-facts-postgres', 'memory-facts-sqlite']);
  });

  it('every agent-scoped table has a cleanup, or is kept on purpose with a reason', () => {
    const problems = [];
    for (const [table, { pkg, columns }] of [...scoped].sort()) {
      if (Object.hasOwn(KEPT_ON_PURPOSE, table)) continue;
      const files = byPackage.get(pkg) ?? [];
      const deletes = deletesFrom(files, table);
      const reacts = reactsToDeletion(files);
      if (deletes && reacts) continue;
      const missing = [
        deletes ? null : `no deleteFrom('${table}') outside migrations`,
        reacts ? null : "no reaction to 'agents:deleted' or 'conversations:purged'",
      ].filter(Boolean);
      problems.push(
        `${table} (packages/${pkg}, keyed on ${[...columns].join(', ')}): ${missing.join('; ')}`,
      );
    }
    expect(
      problems,
      [
        'These tables hold rows tied to an agent but nothing deletes them when the agent is deleted.',
        "Subscribe to 'agents:deleted' (or, for a table keyed only on a conversation id, to",
        "'conversations:purged') in the owning plugin and delete the rows -- see @ax/routines,",
        '@ax/conversations and @ax/attachments -- or add the table to KEPT_ON_PURPOSE with the reason.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('KEPT_ON_PURPOSE names only tables that exist, and gives a real reason', () => {
    for (const [table, reason] of Object.entries(KEPT_ON_PURPOSE)) {
      // A stale entry would silently exempt a future table that reuses the name.
      const known = [...byPackage.values()].some((files) =>
        files.some(({ text }) => tablesIn(text).has(table)),
      );
      expect(known, `${table} is on KEPT_ON_PURPOSE but no source creates it`).toBe(true);
      expect(reason.length, `${table}: give a reason a reviewer can disagree with`).toBeGreaterThan(40);
    }
  });

  // The parser, on small inputs, so a regression in it is not first noticed as a
  // mysteriously green scan.
  describe('the table parser', () => {
    it('reads columns from CREATE TABLE and skips constraints', () => {
      const t = tablesIn(`
        CREATE TABLE IF NOT EXISTS demo_v1 (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          amount NUMERIC(10, 2),
          PRIMARY KEY (id, agent_id),
          UNIQUE (agent_id, amount)
        )`);
      expect([...t.get('demo_v1')].sort()).toEqual(['agent_id', 'amount', 'id']);
    });

    it('reads columns added by ALTER TABLE ... ADD COLUMN', () => {
      const t = tablesIn(`
        ALTER TABLE demo_v1
          ADD COLUMN IF NOT EXISTS conversation_id TEXT,
          ADD COLUMN IF NOT EXISTS other TEXT
      \``);
      expect([...t.get('demo_v1')].sort()).toEqual(['conversation_id', 'other']);
    });

    it('resolves a ${CONST} table name from a const in the same package', () => {
      const [f] = resolveTableConstants([
        { rel: 'p/a.ts', text: "export const TABLE = 'facts_v1';" },
        { rel: 'p/b.ts', text: 'CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT, agent_key TEXT)' },
      ]).slice(1);
      expect([...tablesIn(f.text).get('facts_v1')].sort()).toEqual(['agent_key', 'id']);
    });

    it('ignores a column named in a comment', () => {
      const t = tablesIn(`
        CREATE TABLE demo_v1 (
          id TEXT, -- agent_id would be wrong here
          note TEXT
        )`);
      expect([...t.get('demo_v1')].sort()).toEqual(['id', 'note']);
    });
  });

  describe('the cleanup detectors', () => {
    const file = (rel, text) => ({ rel, text });
    it('finds a Kysely delete and a raw DELETE, but not one inside the migration file', () => {
      expect(deletesFrom([file('p/store.ts', "db.deleteFrom('t_v1').where(...)")], 't_v1')).toBe(true);
      expect(deletesFrom([file('p/store.ts', 'await sql`DELETE FROM t_v1 WHERE x`')], 't_v1')).toBe(true);
      expect(deletesFrom([file('p/migrations.ts', "deleteFrom('t_v1')")], 't_v1')).toBe(false);
      expect(deletesFrom([file('p/store.ts', "db.deleteFrom('t_v1_other')")], 't_v1')).toBe(false);
      // Prose that merely NAMES the statement is not a cleanup (the session-postgres
      // inbox carries such a message), and neither is a delete that is commented out.
      expect(
        deletesFrom([file('p/inbox.ts', 'throw new Error(`corrupt row (DELETE FROM t_v1 WHERE id = 1).`)')], 't_v1'),
      ).toBe(false);
      expect(deletesFrom([file('p/store.ts', "// db.deleteFrom('t_v1').execute()")], 't_v1')).toBe(false);
      expect(deletesFrom([file('p/store.ts', "/* db.deleteFrom('t_v1') */")], 't_v1')).toBe(false);
      // The executed raw forms: a better-sqlite3 prepare, and a pg query string.
      expect(deletesFrom([file('p/purge.ts', 'db.prepare(`DELETE FROM t_v1 WHERE k = ?`).run(k)')], 't_v1')).toBe(true);
      expect(deletesFrom([file('p/purge.ts', 'await c.query(`DELETE FROM t_v1 WHERE k = $1`, [k])')], 't_v1')).toBe(true);
      // The table named once in a const, the way @ax/decisions does it...
      expect(
        deletesFrom([file('p/store.ts', "const table = 't_v1';\nawait db.deleteFrom(table).execute();")], 't_v1'),
      ).toBe(true);
      // ...but a const that names the table and is never deleted from is not a cleanup.
      expect(
        deletesFrom([file('p/store.ts', "const table = 't_v1';\nawait db.selectFrom(table)")], 't_v1'),
      ).toBe(false);
    });

    it('sees a reaction to either trigger hook, and nothing else', () => {
      expect(reactsToDeletion([file('p/plugin.ts', "subscribes: ['agents:deleted']")])).toBe(true);
      expect(reactsToDeletion([file('p/plugin.ts', "subscribes: ['conversations:purged']")])).toBe(true);
      expect(reactsToDeletion([file('p/plugin.ts', "subscribes: ['chat:turn-end']")])).toBe(false);
      // Quote style is not the point.
      expect(reactsToDeletion([file('p/plugin.ts', 'subscribes: ["agents:deleted"]')])).toBe(true);
      expect(reactsToDeletion([file('p/plugin.ts', 'bus.subscribe(`agents:deleted`, X, h)')])).toBe(true);
    });
  });
});
