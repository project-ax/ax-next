import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { runAuthBetterMigration, type AuthBetterDatabase } from '../migrations.js';

// TASK-1116. The read-only sign-up audit (deploy/GKE.md, "4h. Audit accounts after TASK-1116"),
// run as the operator runs it: the real file, through the container's own psql, against a
// migrated database seeded with one account per thing it looks for.

const AUDIT = readFileSync(new URL('../../sql/audit-sign-ups.sql', import.meta.url), 'utf8');
const TAKEN_OVER = 'LINKED AFTER PASSWORD - treat as taken over';
const PASSWORD_ONLY = 'password only';
const PASSWORD_LATER = 'password added after a provider sign-in - ask a developer';
const CONFIRM = 'confirm with the person';
const CAPITALS = 'capital letters - lowercase it (4i)';
const NOT_ASCII = 'not plain ASCII - cannot sign in (4i)';
/** Every secret column gets a value with this in it. None may reach the output. */
const SECRET = 'SECRET';
const TABLES = ['auth_better_v1_users', 'auth_better_v1_accounts', 'auth_better_v1_sessions',
  'auth_better_v1_verifications', 'auth_providers'] as const;

type Account = { provider: 'credential' | 'google' | 'github'; at: number; scope?: string | null };
type Seed = {
  email: string; verified: boolean; role?: 'admin' | 'user'; accounts: Account[];
  session?: 'live' | 'expired'; sections: number[];
};

/** `at` is minutes after the base time. Google rows made by the redirect flow have a scope. */
const SEEDS: Seed[] = [
  { email: 'alice@canopyworks.com', verified: true, accounts: [{ provider: 'google', at: 0 }], sections: [] },
  // Signs in through its Google link, but better-auth's lowercase lookup by email never finds it.
  { email: 'Bob@CanopyWorks.COM', verified: true, accounts: [{ provider: 'google', at: 0 }], sections: [6] },
  { email: 'guest@gmail.example', verified: true, accounts: [{ provider: 'google', at: 0 }], session: 'expired', sections: [1] },
  { email: 'eng@eng.canopyworks.com', verified: true, accounts: [{ provider: 'google', at: 0 }], sections: [1] },
  { email: 'pwonly@canopyworks.com', verified: false, accounts: [{ provider: 'credential', at: 0 }], sections: [2, 3] },
  { email: 'taken@canopyworks.com', verified: true,
    accounts: [{ provider: 'credential', at: 0 }, { provider: 'google', at: 1 }], sections: [2] },
  // A password set after a real sign-in is not the pre-takeover shape, but nothing in ax sets one either.
  { email: 'later@canopyworks.com', verified: true,
    accounts: [{ provider: 'google', at: 0 }, { provider: 'credential', at: 1 }], sections: [2] },
  { email: 'mallory@evil.example', verified: false, accounts: [{ provider: 'credential', at: 0 }], session: 'live', sections: [1, 2, 3] },
  { email: 'admin@canopyworks.com', verified: false, role: 'admin', accounts: [], sections: [] },
  // A setup admin the wizard saved as typed: its first sign-in would make a new member instead.
  { email: 'Owner@CanopyWorks.com', verified: false, role: 'admin', accounts: [], sections: [6] },
  // The sign-in gate refuses an address beyond plain ASCII, so this one can't sign in at all.
  { email: 'jos\u00e9@canopyworks.com', verified: true, accounts: [{ provider: 'google', at: 0 }], sections: [6] },
  { email: 'promoted@canopyworks.com', verified: false, role: 'admin', accounts: [{ provider: 'credential', at: 0 }], sections: [2, 3] },
  // A Google account made by POST /auth/sign-in/social with an idToken: better-auth stores no scope.
  { email: 'idtok@canopyworks.com', verified: true, accounts: [{ provider: 'google', at: 0, scope: null }], sections: [4] },
  // Any GitHub sign-in, or a second provider on one account: the old `trustedProviders` let one link
  // in on an email the provider hadn't verified, and nothing on file tells those links apart.
  { email: 'gh@canopyworks.com', verified: true, accounts: [{ provider: 'github', at: 0, scope: null }], sections: [5] },
  { email: 'both@canopyworks.com', verified: true,
    accounts: [{ provider: 'google', at: 0 }, { provider: 'github', at: 1 }], sections: [5] },
  // No GitHub at all: two sign-ins from one provider are 2+ provider sign-ins all the same.
  { email: 'twogoogle@canopyworks.com', verified: true,
    accounts: [{ provider: 'google', at: 0 }, { provider: 'google', at: 1 }], sections: [5] },
  // The R2 shape (sign-up-gate.test.ts): the setup admin, still unverified, with a GitHub row a
  // pre-fix link left behind.
  { email: 'gh-admin@canopyworks.com', verified: false, role: 'admin',
    accounts: [{ provider: 'github', at: 0 }], sections: [3, 5] },
];

let container: StartedPostgreSqlContainer;
let db: Kysely<AuthBetterDatabase>;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }) });
  await runAuthBetterMigration(db);
  await seed();
}, 60_000);
afterAll(async () => {
  await db?.destroy();
  if (container) await stopPostgresContainer(container);
}, 60_000);

async function seed(): Promise<void> {
  const base = sql`now() - interval '1 day'`;
  for (const [i, s] of SEEDS.entries()) {
    const id = `u${i}`;
    await sql`INSERT INTO auth_better_v1_users (id, email, email_verified, name, role, created_at, updated_at)
      VALUES (${id}, ${s.email}, ${s.verified}, ${'Name ' + i}, ${s.role ?? 'user'}, ${base}, ${base})`.execute(db);
    for (const [j, a] of s.accounts.entries()) {
      const scope = 'scope' in a ? a.scope : 'openid,email,profile';
      const at = sql`${base} + make_interval(mins => ${a.at})`;
      await sql`INSERT INTO auth_better_v1_accounts
        (id, user_id, account_id, provider_id, access_token, refresh_token, id_token, scope, password, created_at, updated_at)
        VALUES (${`${id}-a${j}`}, ${id}, ${a.provider === 'credential' ? id : `${a.provider}-${i}-${j}`}, ${a.provider},
          ${`${SECRET}-access-${i}`}, ${`${SECRET}-refresh-${i}`}, ${`${SECRET}-idtoken-${i}`}, ${scope},
          ${a.provider === 'credential' ? `${SECRET}-pwhash-${i}` : null}, ${at}, ${at})`.execute(db);
    }
    if (s.session) {
      const expires = s.session === 'live' ? sql`now() + interval '1 day'` : sql`now() - interval '1 hour'`;
      await sql`INSERT INTO auth_better_v1_sessions (id, user_id, token, expires_at, ip_address, user_agent)
        VALUES (${`${id}-s`}, ${id}, ${`${SECRET}-session-${i}`}, ${expires}, ${`${SECRET}-ip`}, ${`${SECRET}-ua`})`.execute(db);
    }
  }
  await sql`INSERT INTO auth_better_v1_verifications (id, identifier, value, expires_at)
    VALUES ('v1', 'pwonly@canopyworks.com', ${`${SECRET}-verification`}, now() + interval '1 hour')`.execute(db);
  await sql`INSERT INTO auth_providers (kind, client_id, client_secret_encrypted, allowed_domains, enabled) VALUES
    ('google', ${`${SECRET}-client-id`}, ${Buffer.from(`${SECRET}-client-secret`)}, 'canopyworks.com', true),
    ('github', ${`${SECRET}-client-id-gh`}, ${Buffer.from(`${SECRET}-client-secret-gh`)}, NULL, true)`.execute(db);
}

/** Runs `file` (the real audit by default) with the container's own psql, as the runbook's pod does. */
async function runAudit(flags: string[], file = AUDIT, after: string[] = []) {
  await container.copyContentToContainer([{ content: file, target: '/tmp/audit.sql' }]);
  return container.exec(['psql', '-X', '-v', 'ON_ERROR_STOP=1', ...flags, '-U', container.getUsername(),
    '-d', container.getDatabase(), '-f', '/tmp/audit.sql', ...after]);
}

async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(t)}`.execute(db);
    out[t] = Number(r.rows[0]!.n);
  }
  return out;
}

/** Section number → its text, split on the `== N.` headers the script echoes. */
function sections(out: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const part of out.split(/^== /m).slice(1)) map.set(Number(part.slice(0, part.indexOf('.'))), part);
  return map;
}

/** The aligned-format table row of `section` that names `email`, split into trimmed cells. */
function row(section: string, email: string): string[] {
  const line = section.split('\n').find((l) => l.split('|').some((c) => c.trim() === email));
  expect(line, `no row for ${email}`).toBeDefined();
  return line!.split('|').map((c) => c.trim());
}

/** The header cells of a section's table. */
const header = (section: string) => section.split('\n')[1]!.split('|').map((c) => c.trim());

/** The counts row of section 7, by column name. */
function counts(section: string): Record<string, number> {
  const lines = section.split('\n');
  const names = lines[1]!.split('|').map((c) => c.trim());
  const values = lines[3]!.split('|').map((c) => Number(c.trim()));
  return Object.fromEntries(names.map((n, i) => [n, values[i]!]));
}

describe('audit-sign-ups.sql', () => {
  it('lists each account in exactly the sections it belongs to, prints no secret, and changes nothing', async () => {
    const before = await rowCounts();
    const r = await runAudit(['-v', 'domain=canopyworks.com']);
    expect(r.exitCode, r.output).toBe(0);
    const out = r.stdout;
    const s = sections(out);
    expect([...s.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    for (const seedRow of SEEDS) {
      const found = [1, 2, 3, 4, 5, 6].filter((n) => s.get(n)!.split('|').some((c) => c.trim() === seedRow.email));
      expect(found, seedRow.email).toEqual(seedRow.sections);
    }

    const userColumns = ['id', 'email', 'role', 'email_verified', 'created_at', 'sign_in_methods', 'live_sessions'];
    expect(header(s.get(1)!)).toEqual(userColumns);
    expect(header(s.get(2)!)).toEqual([...userColumns, 'password_set', 'first_provider_link', 'verdict']);
    expect(header(s.get(3)!)).toEqual(userColumns);
    expect(header(s.get(4)!)).toEqual([...userColumns, 'id_token_link']);
    expect(header(s.get(5)!)).toEqual([...userColumns, 'methods_added', 'verdict']);
    expect(header(s.get(6)!)).toEqual([...userColumns, 'verdict']);

    // Section 0: the providers and their lists, `(any domain)` for none.
    expect(row(s.get(0)!, 'google')).toEqual(['google', 't', 'canopyworks.com']);
    expect(row(s.get(0)!, 'github')).toEqual(['github', 't', '(any domain)']);

    // live_sessions counts only unexpired sessions.
    expect(row(s.get(1)!, 'guest@gmail.example').at(-1)).toBe('0');
    expect(row(s.get(1)!, 'mallory@evil.example').at(-1)).toBe('1');
    expect(row(s.get(1)!, 'mallory@evil.example')[5]).toBe('credential');

    // The pre-takeover signature: a password first, then the provider link.
    expect(row(s.get(2)!, 'taken@canopyworks.com').at(-1)).toBe(TAKEN_OVER);
    expect(row(s.get(2)!, 'taken@canopyworks.com')[5]).toBe('credential,google');
    for (const email of ['pwonly@canopyworks.com', 'mallory@evil.example', 'promoted@canopyworks.com']) {
      expect(row(s.get(2)!, email).at(-1), email).toBe(PASSWORD_ONLY);
    }
    expect(row(s.get(2)!, 'later@canopyworks.com').at(-1)).toBe(PASSWORD_LATER);

    // Each sign-in method with when it was added, oldest first, to ask the person about.
    const both = row(s.get(5)!, 'both@canopyworks.com');
    expect(both[5]).toBe('google,github');
    expect(both.at(-2)).toMatch(/^google \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}(:\d{2})?, github \d{4}-\d{2}-\d{2} /);
    expect(both.at(-1)).toBe(CONFIRM);
    expect(row(s.get(5)!, 'gh@canopyworks.com').at(-1)).toBe(CONFIRM);
    expect(row(s.get(5)!, 'twogoogle@canopyworks.com')[5]).toBe('google,google');
    expect(row(s.get(5)!, 'gh-admin@canopyworks.com')[5]).toBe('github');

    // What each email needs: capitals can just be lowercased; anything beyond ASCII can't sign in.
    expect(row(s.get(6)!, 'Bob@CanopyWorks.COM').at(-1)).toBe(CAPITALS);
    expect(row(s.get(6)!, 'Owner@CanopyWorks.com').at(-1)).toBe(CAPITALS);
    expect(row(s.get(6)!, 'Owner@CanopyWorks.com')[5]).toBe('(none)');
    expect(row(s.get(6)!, 'jos\u00e9@canopyworks.com').at(-1)).toBe(NOT_ASCII);

    expect(counts(s.get(7)!)).toEqual({
      outside_domain: 3, with_password: 5, taken_over: 1, unverified: 4, id_token_sign_in: 1, to_confirm: 4,
      email_to_fix: 3,
    });

    // No secret column's value, and no secret column's name.
    expect(out).not.toContain(SECRET);
    expect(r.output).not.toContain(SECRET);
    for (const n of s.keys()) {
      expect(header(s.get(n)!).filter((c) => /^(password|token|access_token|refresh_token|id_token|client_id|client_secret\w*|value|ip_address|user_agent)$/.test(c)), `section ${n}`).toEqual([]);
    }

    expect(await rowCounts()).toEqual(before);
  });

  it('takes a comma-separated domain list, ignoring case and spaces', async () => {
    const r = await runAudit(['-v', 'domain= CanopyWorks.com , eng.canopyworks.com ']);
    expect(r.exitCode, r.output).toBe(0);
    const s = sections(r.stdout);
    expect(s.get(1)).not.toContain('eng@eng.canopyworks.com');
    expect(s.get(1)).not.toContain('Bob@CanopyWorks.COM');
    expect(counts(s.get(7)!).outside_domain).toBe(2);
  });

  it('prints its usage and runs nothing without -v domain', async () => {
    const r = await runAudit([]);
    expect(r.exitCode, r.output).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).not.toContain('== 0.');
  });

  it('refuses a write inside its transaction', async () => {
    const before = await rowCounts();
    const spliced = AUDIT.replace(/^ROLLBACK;$/m,
      "INSERT INTO auth_better_v1_users (id, email) VALUES ('w1', 'write@evil.example');\nROLLBACK;");
    expect(spliced).not.toBe(AUDIT);
    const r = await runAudit(['-v', 'domain=canopyworks.com'], spliced);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('cannot execute INSERT in a read-only transaction');
    expect(await rowCounts()).toEqual(before);
  });

  it('leaves the rest of its session read-only too', async () => {
    const before = await rowCounts();
    const r = await runAudit(['-v', 'domain=canopyworks.com'], AUDIT,
      ['-c', "DELETE FROM auth_better_v1_accounts WHERE provider_id = 'credential'"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('== 7. Counts');
    expect(r.output).toContain('cannot execute DELETE in a read-only transaction');
    expect(await rowCounts()).toEqual(before);
  });
});
