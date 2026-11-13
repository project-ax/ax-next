import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { runAuthBetterMigration, type AuthBetterDatabase } from '../migrations.js';

// TASK-1116. The way back for a sign-in the identity gate refuses as `email_mismatch` (deploy/GKE.md,
// "4i. Change an account's email (sign-in recovery)"): change one account's email, in one
// transaction, showing the account before and after. Run as the operator runs it: the real file,
// through the container's own psql, dry run first, then `-v apply=1`.

const SCRIPT_URL = new URL('../../sql/change-account-email.sql', import.meta.url);
const SCRIPT = existsSync(SCRIPT_URL) ? readFileSync(SCRIPT_URL, 'utf8') : '';
/** Every secret column gets a value with this in it. None may reach the output. */
const SECRET = 'SECRET';
const TABLES = ['auth_better_v1_users', 'auth_better_v1_accounts', 'auth_better_v1_sessions'] as const;

let container: StartedPostgreSqlContainer;
let db: Kysely<AuthBetterDatabase>;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }) });
  await runAuthBetterMigration(db);
}, 60_000);
afterAll(async () => {
  await db?.destroy();
  if (container) await stopPostgresContainer(container);
}, 60_000);

/** Bob signed in with Google as bob@ before his address changed; an admin stored in mixed case; a third account. */
beforeEach(async () => {
  for (const t of [...TABLES].reverse()) await sql`DELETE FROM ${sql.table(t)}`.execute(db);
  const users: Array<[string, string, boolean, 'admin' | 'user']> = [
    ['u-bob', 'bob@canopyworks.com', true, 'user'],
    ['u-owner', 'Owner@CanopyWorks.com', false, 'admin'],
    ['u-carol', 'carol@canopyworks.com', true, 'user'],
  ];
  for (const [id, email, verified, role] of users) {
    await sql`INSERT INTO auth_better_v1_users (id, email, email_verified, name, role, created_at, updated_at)
      VALUES (${id}, ${email}, ${verified}, ${`Name of ${id}`}, ${role}, now() - interval '1 day', now() - interval '1 day')`.execute(db);
  }
  await sql`INSERT INTO auth_better_v1_accounts (id, user_id, account_id, provider_id, access_token, refresh_token, id_token, scope)
    VALUES ('a-bob', 'u-bob', 'g-bob', 'google', ${`${SECRET}-access`}, ${`${SECRET}-refresh`}, ${`${SECRET}-idtoken`}, 'openid,email,profile'),
           ('a-carol', 'u-carol', 'g-carol', 'google', null, null, null, 'openid,email,profile')`.execute(db);
  await sql`INSERT INTO auth_better_v1_sessions (id, user_id, token, expires_at, ip_address, user_agent)
    VALUES ('s-bob', 'u-bob', ${`${SECRET}-session`}, now() + interval '1 day', ${`${SECRET}-ip`}, ${`${SECRET}-ua`})`.execute(db);
});

/** Runs the real script with the container's own psql, as the runbook's pod does. `vars` become `-v name=value`. */
async function run(vars: Record<string, string>) {
  await container.copyContentToContainer([{ content: SCRIPT, target: '/tmp/change.sql' }]);
  const flags = Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]);
  return container.exec(['psql', '-X', '-v', 'ON_ERROR_STOP=1', ...flags, '-U', container.getUsername(),
    '-d', container.getDatabase(), '-f', '/tmp/change.sql']);
}

/** Every row of the tables the script can see, so a test can say "nothing else changed". */
async function snapshot(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    out[t] = (await sql`SELECT * FROM ${sql.table(t)} ORDER BY id`.execute(db)).rows;
  }
  return JSON.stringify(out);
}

async function emailOf(id: string): Promise<string | undefined> {
  const r = await sql<{ email: string }>`SELECT email FROM auth_better_v1_users WHERE id = ${id}`.execute(db);
  return r.rows[0]?.email;
}

describe('change-account-email.sql', () => {
  it('exists', () => {
    expect(SCRIPT, 'packages/auth-better/sql/change-account-email.sql is missing').not.toBe('');
  });

  it('prints its usage and runs nothing without both emails', async () => {
    for (const vars of [{}, { old_email: 'bob@canopyworks.com' }, { new_email: 'robert@canopyworks.com' }]) {
      const r = await run(vars);
      expect(r.exitCode, r.output).toBe(0);
      expect(r.stdout).toContain('Usage:');
      expect(r.stdout).not.toContain('BEGIN');
    }
  });

  it('dry run: shows the account before and after the change inside one transaction, then rolls it back', async () => {
    const before = await snapshot();
    const r = await run({ old_email: 'bob@canopyworks.com', new_email: 'robert@canopyworks.com' });
    expect(r.exitCode, r.output).toBe(0);
    const out = r.stdout;
    // In order: the transaction opens, the account as it is, the one-row update, the account after.
    const at = (text: string) => {
      const i = out.indexOf(text);
      expect(i, `"${text}" is not in the output`).toBeGreaterThan(-1);
      return i;
    };
    const begin = at('BEGIN');
    const now = at('== The account now');
    const update = at('UPDATE 1');
    const after = at('== The account after the change');
    const end = at('ROLLBACK');
    expect([begin, now, update, after, end]).toEqual([...[begin, now, update, after, end]].sort((a, b) => a - b));
    expect(out.slice(now, update)).toContain('bob@canopyworks.com');
    expect(out.slice(now, update)).toContain('u-bob');
    expect(out.slice(after, end)).toContain('robert@canopyworks.com');
    expect(out).toContain('Dry run: nothing was changed. Run again with -v apply=1 to change it.');
    expect(out).not.toContain('COMMIT');
    expect(await snapshot()).toBe(before);
  });

  it('apply: changes that one account, and nothing else', async () => {
    const r = await run({ old_email: 'bob@canopyworks.com', new_email: 'robert@canopyworks.com', apply: '1' });
    expect(r.exitCode, r.output).toBe(0);
    expect(r.stdout).toContain('UPDATE 1');
    expect(r.stdout.trimEnd().endsWith('COMMIT')).toBe(true);
    expect(await emailOf('u-bob')).toBe('robert@canopyworks.com');
    // Its sign-ins, sessions and every other account stay as they were.
    expect(await emailOf('u-carol')).toBe('carol@canopyworks.com');
    expect(await emailOf('u-owner')).toBe('Owner@CanopyWorks.com');
    const accounts = await sql`SELECT id, user_id FROM auth_better_v1_accounts ORDER BY id`.execute(db);
    expect(accounts.rows).toEqual([{ id: 'a-bob', user_id: 'u-bob' }, { id: 'a-carol', user_id: 'u-carol' }]);
    const sessions = await sql`SELECT id, user_id FROM auth_better_v1_sessions`.execute(db);
    expect(sessions.rows).toEqual([{ id: 's-bob', user_id: 'u-bob' }]);
    // Run twice, the second run finds no account with the old email.
    const again = await run({ old_email: 'bob@canopyworks.com', new_email: 'robert@canopyworks.com', apply: '1' });
    expect(again.exitCode).not.toBe(0);
  });

  it("matches the old email exactly as stored, so it can lowercase a setup admin's (audit section 6)", async () => {
    const r = await run({ old_email: 'Owner@CanopyWorks.com', new_email: 'owner@canopyworks.com', apply: '1' });
    expect(r.exitCode, r.output).toBe(0);
    expect(await emailOf('u-owner')).toBe('owner@canopyworks.com');
  });

  describe('stops before writing anything', () => {
    const cases: Array<{ name: string; vars: Record<string, string>; says: string }> = [
      {
        name: 'no account has exactly the old email',
        vars: { old_email: 'Bob@CanopyWorks.com', new_email: 'robert@canopyworks.com' },
        says: 'Stopped: no account has exactly that email.',
      },
      {
        name: 'the new email has a capital letter',
        vars: { old_email: 'bob@canopyworks.com', new_email: 'Robert@canopyworks.com' },
        says: 'Stopped: the new email must be all lowercase plain ASCII with one @.',
      },
      {
        name: 'the new email has a letter beyond plain ASCII',
        vars: { old_email: 'bob@canopyworks.com', new_email: 'josé@canopyworks.com' },
        says: 'Stopped: the new email must be all lowercase plain ASCII with one @.',
      },
      {
        name: 'the new email has a space',
        vars: { old_email: 'bob@canopyworks.com', new_email: 'robert @canopyworks.com' },
        says: 'Stopped: the new email must be all lowercase plain ASCII with one @.',
      },
      {
        name: 'the new email has two @',
        vars: { old_email: 'bob@canopyworks.com', new_email: 'robert@x@canopyworks.com' },
        says: 'Stopped: the new email must be all lowercase plain ASCII with one @.',
      },
      {
        name: 'the new email has no @',
        vars: { old_email: 'bob@canopyworks.com', new_email: 'robert' },
        says: 'Stopped: the new email must be all lowercase plain ASCII with one @.',
      },
      {
        name: 'another account already has the new email',
        vars: { old_email: 'bob@canopyworks.com', new_email: 'carol@canopyworks.com' },
        says: 'Stopped: another account already has that email.',
      },
      {
        name: 'another account has the new email in another case',
        vars: { old_email: 'bob@canopyworks.com', new_email: 'owner@canopyworks.com' },
        says: 'Stopped: another account already has that email.',
      },
    ];

    it.each(cases)('$name', async ({ vars, says }) => {
      const before = await snapshot();
      for (const mode of [{}, { apply: '1' }]) {
        const r = await run({ ...vars, ...mode });
        expect(r.exitCode, r.output).toBe(3);
        expect(r.output).toContain(says);
        expect(r.output).not.toContain('UPDATE 1');
        expect(r.output).not.toContain('COMMIT');
      }
      expect(await snapshot()).toBe(before);
    });
  });

  it('prints no secret', async () => {
    const r = await run({ old_email: 'bob@canopyworks.com', new_email: 'robert@canopyworks.com' });
    expect(r.exitCode, r.output).toBe(0);
    expect(r.output).not.toContain(SECRET);
  });
});
