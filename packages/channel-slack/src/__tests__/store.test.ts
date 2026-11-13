import { createHash, randomBytes } from 'node:crypto';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, type ChannelSlackDatabase } from '../migrations.js';
import { createInstallStore, type InstallRow, type InstallStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<ChannelSlackDatabase>;
let store: InstallStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  // Room for the concurrent consumes below to each hold their own connection.
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });
  db = new Kysely<ChannelSlackDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(db);
  store = createInstallStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE channel_slack_v1_installs`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

// Shaped like the real thing: an installId is 16 random bytes in base64url.
const newInstallId = (): string => randomBytes(16).toString('base64url');
const stateHash = (state: string): string => createHash('sha256').update(state).digest('hex');

const PENDING = {
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  connectedByUserId: 'usr_admin1',
} as const;

const TEAM = {
  teamId: 'T07ABCDEF12',
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
} as const;

async function pending(installId = newInstallId()): Promise<string> {
  await store.insertPending({ installId, ...PENDING });
  return installId;
}

async function rawRow(installId: string) {
  return db
    .selectFrom('channel_slack_v1_installs')
    .selectAll()
    .where('install_id', '=', installId)
    .executeTakeFirst();
}

describe('runMigrations', () => {
  it('runMigrations twice is a no-op', async () => {
    const installId = await pending();
    await runMigrations(db);
    await runMigrations(db);
    expect((await store.get(installId))?.installId).toBe(installId);

    const indexes = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'channel_slack_v1_installs'
    `.execute(db);
    const stateIndexes = indexes.rows.filter((r) => r.indexdef.includes('(oauth_state_hash)'));
    expect(stateIndexes).toHaveLength(1);
    expect(stateIndexes[0]!.indexdef).toMatch(/^CREATE UNIQUE INDEX/);
    expect(stateIndexes[0]!.indexdef).toMatch(/WHERE \(oauth_state_hash IS NOT NULL\)/);
  });

  it('two installs can never hold the same state hash', async () => {
    const a = await pending();
    const b = await pending();
    const hash = stateHash('one-state');
    const expiresAt = new Date('2026-11-13T12:10:00Z');
    await store.setOAuthState(a, { stateHash: hash, userId: 'usr_admin1', expiresAt });
    await expect(
      store.setOAuthState(b, { stateHash: hash, userId: 'usr_admin1', expiresAt }),
    ).rejects.toThrow();
  });
});

describe('install rows', () => {
  it('insertPending then get/current round-trips', async () => {
    expect(await store.current()).toBeNull();
    const installId = await pending();

    const row = await store.get(installId);
    const expected: Omit<InstallRow, 'createdAt'> = {
      installId,
      status: 'pending',
      ...PENDING,
      teamId: null,
      teamName: null,
      botUserId: null,
      installedAt: null,
    };
    expect(row).toMatchObject(expected);
    expect(row?.createdAt).toBeInstanceOf(Date);
    // The row is the install, never its OAuth state.
    expect(Object.keys(row!).sort()).toEqual(
      [...Object.keys(expected), 'createdAt'].sort(),
    );
    expect(await store.current()).toEqual(row);
    expect(await store.get(newInstallId())).toBeNull();
  });

  it('current is the oldest install, whatever its status', async () => {
    const first = await pending();
    await sql`UPDATE channel_slack_v1_installs SET created_at = now() - interval '1 hour'
              WHERE install_id = ${first}`.execute(db);
    await pending();
    expect((await store.current())?.installId).toBe(first);
  });

  it('a duplicate installId is refused', async () => {
    const installId = await pending();
    await expect(pending(installId)).rejects.toThrow();
  });

  it('keeps who connected an install as an id, never a copy of their name (auth owns names)', async () => {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'channel_slack_v1_installs'
    `.execute(db);
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain('connected_by_user_id');
    expect(names.filter((n) => n.startsWith('connected_by_'))).toEqual(['connected_by_user_id']);
  });

  it('activate sets team, bot user, installedAt and status active', async () => {
    const installId = await pending();
    const installedAt = new Date('2026-11-13T12:00:00.000Z');
    await store.activate(installId, { ...TEAM, installedAt });

    const row = await store.get(installId);
    expect(row).toMatchObject({
      installId,
      status: 'active',
      ...TEAM,
      installedAt,
      ...PENDING,
    });
  });

  it('activate cleans a team name with a U+202E in it', async () => {
    const installId = await pending();
    await store.activate(installId, {
      ...TEAM,
      teamName: 'Acme‮fdp.exe ⁦Corp\u0007',
      installedAt: new Date(),
    });
    expect((await store.get(installId))?.teamName).toBe('Acme fdp.exe Corp');

    const longId = await pending();
    await store.activate(longId, {
      ...TEAM,
      // An emoji straddling the cut is dropped whole, never half kept.
      teamName: `${'a'.repeat(119)}\u{1F600}tail`,
      installedAt: new Date(),
    });
    const clamped = (await store.get(longId))!.teamName!;
    expect(clamped).toBe('a'.repeat(119));
  });

  it('activate refuses an install that is missing or not pending', async () => {
    await expect(
      store.activate(newInstallId(), { ...TEAM, installedAt: new Date() }),
    ).rejects.toThrow();

    const installId = await pending();
    await store.activate(installId, { ...TEAM, installedAt: new Date() });
    await expect(
      store.activate(installId, { ...TEAM, teamId: 'T07OTHERTM9', installedAt: new Date() }),
    ).rejects.toThrow();
    expect((await store.get(installId))?.teamId).toBe(TEAM.teamId);
  });

  it('remove and removeAll delete rows', async () => {
    const a = await pending();
    const b = await pending();
    const c = await pending();
    await store.remove(a);
    expect(await store.get(a)).toBeNull();
    expect(await store.get(b)).not.toBeNull();

    await store.removeAll();
    expect(await store.get(b)).toBeNull();
    expect(await store.get(c)).toBeNull();
    expect(await store.current()).toBeNull();
  });
});

describe('OAuth state', () => {
  const expiresAt = new Date('2026-11-13T12:10:00.000Z');

  it('peek does not consume', async () => {
    const installId = await pending();
    const hash = stateHash('peek-state');
    await store.setOAuthState(installId, { stateHash: hash, userId: 'usr_admin1', expiresAt });

    const want = { installId, userId: 'usr_admin1', expiresAt };
    expect(await store.peekOAuthState(hash)).toEqual(want);
    expect(await store.peekOAuthState(hash)).toEqual(want);
    expect(await store.consumeOAuthState(hash)).toEqual(want);
    expect(await store.peekOAuthState(stateHash('never-minted'))).toBeNull();
  });

  it('consumeOAuthState is single-use', async () => {
    const installId = await pending();
    const hash = stateHash('single-use');
    await store.setOAuthState(installId, { stateHash: hash, userId: 'usr_admin1', expiresAt });

    expect(await store.consumeOAuthState(hash)).toEqual({
      installId,
      userId: 'usr_admin1',
      expiresAt,
    });
    expect(await store.consumeOAuthState(hash)).toBeNull();
    expect(await store.peekOAuthState(hash)).toBeNull();
    // Consuming clears the state and nothing else.
    const row = await rawRow(installId);
    expect(row).toMatchObject({
      status: 'pending',
      oauth_state_hash: null,
      oauth_state_user_id: null,
      oauth_state_expires_at: null,
    });
  });

  it('two concurrent consumes: exactly one wins', async () => {
    for (let round = 0; round < 5; round += 1) {
      const installId = await pending();
      const hash = stateHash(`race-${round}`);
      await store.setOAuthState(installId, { stateHash: hash, userId: 'usr_admin1', expiresAt });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.consumeOAuthState(hash)),
      );
      expect(results.filter((r) => r !== null)).toEqual([
        { installId, userId: 'usr_admin1', expiresAt },
      ]);
    }
  });

  it('setOAuthState replaces the previous state, so the old one stops matching', async () => {
    const installId = await pending();
    const old = stateHash('old-state');
    const fresh = stateHash('fresh-state');
    await store.setOAuthState(installId, { stateHash: old, userId: 'usr_admin1', expiresAt });
    await store.setOAuthState(installId, { stateHash: fresh, userId: 'usr_admin2', expiresAt });

    expect(await store.consumeOAuthState(old)).toBeNull();
    expect(await store.consumeOAuthState(fresh)).toEqual({
      installId,
      userId: 'usr_admin2',
      expiresAt,
    });
  });

  it('setOAuthState refuses an install that is missing or not pending', async () => {
    const state = { stateHash: stateHash('x'), userId: 'usr_admin1', expiresAt };
    await expect(store.setOAuthState(newInstallId(), state)).rejects.toThrow();

    const installId = await pending();
    await store.activate(installId, { ...TEAM, installedAt: new Date() });
    await expect(store.setOAuthState(installId, state)).rejects.toThrow();
    expect(await store.peekOAuthState(state.stateHash)).toBeNull();
  });

  it('the state is stored only as the hash the caller passes', async () => {
    const installId = await pending();
    const hash = stateHash('raw-state-value');
    await store.setOAuthState(installId, { stateHash: hash, userId: 'usr_admin1', expiresAt });
    const row = await rawRow(installId);
    expect(row?.oauth_state_hash).toBe(hash);
    expect(JSON.stringify(row)).not.toContain('raw-state-value');
  });
});
