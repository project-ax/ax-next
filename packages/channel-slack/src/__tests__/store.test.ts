import { createHash, randomBytes } from 'node:crypto';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEFTOVER_APPS_MAX } from '../limits.js';
import { runMigrations, type ChannelSlackDatabase } from '../migrations.js';
import {
  createInstallStore,
  InstallStoreError,
  type InstallRow,
  type InstallStore,
} from '../store.js';

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
  await sql`TRUNCATE channel_slack_v1_installs, channel_slack_v1_channels, channel_slack_v1_leftover_apps`.execute(db);
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

/**
 * A team agent's own bot (TASK-1167). Grace asked for it and approved it, so
 * her configuration token made the app: she is both its requester and the
 * person on its row (`connectedByUserId`).
 */
const BOT = {
  appId: 'A07BOTAPP001',
  clientId: '7512345678901.7522222222222',
  botName: 'support-helper',
  connectedByUserId: 'usr_grace',
  agentId: 'agt_support',
  requestedByUserId: 'usr_grace',
} as const;

async function pending(installId = newInstallId()): Promise<string> {
  await store.insertPending({ installId, ...PENDING });
  return installId;
}

async function pendingBot(o: { agentId?: string; connectedByUserId?: string; requestedByUserId?: string } = {}): Promise<string> {
  const installId = newInstallId();
  await store.insertPendingBot({ installId, ...BOT, ...o });
  return installId;
}

/** What a failed statement's Postgres error code was (`undefined` when it didn't fail). */
async function pgCode(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (err: unknown) => (err as { code?: unknown }).code,
  );
}

async function rawRow(installId: string) {
  return db
    .selectFrom('channel_slack_v1_installs')
    .selectAll()
    .where('install_id', '=', installId)
    .executeTakeFirst();
}

/**
 * A channel connected to an agent on an install. Written raw: this file tests
 * the install store, and the bindings' own store has its own tests.
 */
async function bind(installId: string, channelId: string, agentId = 'agt_support'): Promise<void> {
  await sql`
    INSERT INTO channel_slack_v1_channels
      (install_id, channel_id, agent_id, connected_by_user_id, channel_name)
    VALUES (${installId}, ${channelId}, ${agentId}, 'usr_admin1', 'support')
  `.execute(db);
}

/** Every binding left, as `installId/channelId`, sorted. */
async function bindings(): Promise<string[]> {
  const r = await sql<{ install_id: string; channel_id: string }>`
    SELECT install_id, channel_id FROM channel_slack_v1_channels
  `.execute(db);
  return r.rows.map((row) => `${row.install_id}/${row.channel_id}`).sort();
}

/**
 * Run `fn` with a BEFORE DELETE row trigger on the installs table whose
 * plpgsql body is `body`, then drop it whatever happens. TRUNCATE (the
 * beforeEach cleanup) never fires it.
 */
async function withInstallDeleteTrigger(body: string, fn: () => Promise<void>): Promise<void> {
  await sql
    .raw(
      `CREATE FUNCTION channel_slack_store_test_on_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
         BEGIN ${body} END
       $fn$;
       CREATE TRIGGER channel_slack_store_test_on_delete BEFORE DELETE ON channel_slack_v1_installs
         FOR EACH ROW EXECUTE FUNCTION channel_slack_store_test_on_delete();`,
    )
    .execute(db);
  try {
    await fn();
  } finally {
    await sql
      .raw(
        `DROP TRIGGER IF EXISTS channel_slack_store_test_on_delete ON channel_slack_v1_installs;
         DROP FUNCTION IF EXISTS channel_slack_store_test_on_delete();`,
      )
      .execute(db);
  }
}

/** The same, as a BEFORE INSERT row trigger on the leftover apps table. */
async function withLeftoverInsertTrigger(body: string, fn: () => Promise<void>): Promise<void> {
  await sql
    .raw(
      `CREATE FUNCTION channel_slack_store_test_on_leftover() RETURNS trigger LANGUAGE plpgsql AS $fn$
         BEGIN ${body} END
       $fn$;
       CREATE TRIGGER channel_slack_store_test_on_leftover BEFORE INSERT ON channel_slack_v1_leftover_apps
         FOR EACH ROW EXECUTE FUNCTION channel_slack_store_test_on_leftover();`,
    )
    .execute(db);
  try {
    await fn();
  } finally {
    await sql
      .raw(
        `DROP TRIGGER IF EXISTS channel_slack_store_test_on_leftover ON channel_slack_v1_leftover_apps;
         DROP FUNCTION IF EXISTS channel_slack_store_test_on_leftover();`,
      )
      .execute(db);
  }
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

  it('adds config_token_added_at to an installs table from before it: backfilled from created_at, NOT NULL with a default, and a later run keeps a replaced value', async () => {
    const installId = await pending();
    await sql`UPDATE channel_slack_v1_installs SET created_at = '2026-11-01T00:00:00Z'
              WHERE install_id = ${installId}`.execute(db);
    // The table as it was before the column: no value and no default.
    await sql`ALTER TABLE channel_slack_v1_installs DROP COLUMN config_token_added_at`.execute(db);

    await runMigrations(db);
    // The day Connect added the token, never the day of the deploy that added the column.
    expect((await store.get(installId))?.configTokenAddedAt).toEqual(new Date('2026-11-01T00:00:00Z'));

    await store.activate(installId, { ...TEAM, installedAt: new Date('2026-11-01T00:05:00.000Z') });
    const replacedAt = new Date('2026-11-19T09:00:00.000Z');
    await store.setConfigTokenAddedAt(installId, replacedAt);
    await runMigrations(db);
    // The backfill fills only NULLs: a later boot never undoes a replace.
    expect((await store.get(installId))?.configTokenAddedAt).toEqual(replacedAt);

    const column = await sql<{ is_nullable: string; column_default: string | null }>`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'channel_slack_v1_installs' AND column_name = 'config_token_added_at'
    `.execute(db);
    expect(column.rows).toHaveLength(1);
    expect(column.rows[0]!.is_nullable).toBe('NO');
    expect(column.rows[0]!.column_default).toMatch(/now\(\)/);
  });

  it('adds connected_by_user_id to a leftover table from before it: an old row reads null, and a second run changes nothing', async () => {
    // The table as TASK-1132 made it: no person.
    await sql`DROP TABLE channel_slack_v1_leftover_apps`.execute(db);
    await sql`
      CREATE TABLE channel_slack_v1_leftover_apps (
        install_id             TEXT PRIMARY KEY,
        app_id                 TEXT NOT NULL,
        bot_name               TEXT NOT NULL,
        left_at                TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(db);
    const old = newInstallId();
    await sql`INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name, left_at)
              VALUES (${old}, ${PENDING.appId}, ${PENDING.botName}, '2026-11-18T12:00:00Z')`.execute(db);

    await runMigrations(db);
    // Whose token made it was never recorded, and the install row that knew is gone: it stays unknown.
    const oldApp = {
      installId: old,
      appId: PENDING.appId,
      botName: PENDING.botName,
      leftAt: new Date('2026-11-18T12:00:00Z'),
      connectedByUserId: null,
    };
    expect(await store.leftoverApps()).toEqual([oldApp]);

    const later = newInstallId();
    await store.rememberLeftoverApp({ installId: later, appId: 'A07NEWAPP001', botName: 'canopy', connectedByUserId: 'usr_ada' });
    await sql`UPDATE channel_slack_v1_leftover_apps SET left_at = '2026-11-19T12:00:00Z'
              WHERE install_id = ${later}`.execute(db);
    await runMigrations(db);
    // The second run neither backfills the old row nor touches the new one.
    expect(await store.leftoverApps()).toEqual([
      oldApp,
      {
        installId: later,
        appId: 'A07NEWAPP001',
        botName: 'canopy',
        leftAt: new Date('2026-11-19T12:00:00Z'),
        connectedByUserId: 'usr_ada',
      },
    ]);
  });

  it('a row from before TASK-1167 reads as shared, with null bot fields', async () => {
    // The table as it was before TASK-1167: none of the four columns, the
    // rule pairing them or the bot index.
    await sql`DROP INDEX IF EXISTS channel_slack_v1_installs_bot_agent`.execute(db);
    await sql`
      ALTER TABLE channel_slack_v1_installs
        DROP CONSTRAINT IF EXISTS channel_slack_v1_installs_kind_fields,
        DROP COLUMN IF EXISTS kind,
        DROP COLUMN IF EXISTS agent_id,
        DROP COLUMN IF EXISTS requested_by_user_id,
        DROP COLUMN IF EXISTS bot_handle
    `.execute(db);
    const old = newInstallId();
    await sql`
      INSERT INTO channel_slack_v1_installs (install_id, status, app_id, client_id, bot_name, connected_by_user_id)
      VALUES (${old}, 'active', ${PENDING.appId}, ${PENDING.clientId}, ${PENDING.botName}, 'usr_admin1')
    `.execute(db);

    await runMigrations(db);
    // And one written after, the way the CLI reset's test still writes it:
    // naming none of the new columns.
    const later = newInstallId();
    await sql`
      INSERT INTO channel_slack_v1_installs (install_id, status, app_id, client_id, bot_name, connected_by_user_id)
      VALUES (${later}, 'pending', ${PENDING.appId}, ${PENDING.clientId}, ${PENDING.botName}, 'usr_admin1')
    `.execute(db);

    for (const installId of [old, later]) {
      expect(await store.get(installId), installId).toMatchObject({
        installId,
        kind: 'shared',
        agentId: null,
        requestedByUserId: null,
        botHandle: null,
      });
    }
    expect(await store.listBots()).toEqual([]);
  });

  it('the database refuses a bot without its agent or requester, a shared row with an agent, and an unknown kind', async () => {
    const insert = (kind: string, agentId: string | null, requestedBy: string | null) =>
      sql`
        INSERT INTO channel_slack_v1_installs
          (install_id, status, app_id, client_id, bot_name, connected_by_user_id, kind, agent_id, requested_by_user_id)
        VALUES (${newInstallId()}, 'pending', ${BOT.appId}, ${BOT.clientId}, ${BOT.botName}, 'usr_grace',
                ${kind}, ${agentId}, ${requestedBy})
      `.execute(db);

    // check_violation, each one: a bot row that lost its agent can never read as anyone's.
    expect(await pgCode(insert('bot', null, 'usr_grace'))).toBe('23514');
    expect(await pgCode(insert('bot', 'agt_support', null))).toBe('23514');
    expect(await pgCode(insert('shared', 'agt_support', null))).toBe('23514');
    expect(await pgCode(insert('shared', null, 'usr_grace'))).toBe('23514');
    expect(await pgCode(insert('agent', 'agt_support', 'usr_grace'))).toBe('23514');
    expect(await pgCode(insert('Shared', null, null))).toBe('23514');
    expect(await store.list()).toEqual([]);

    // The same statement, with each kind's fields right, goes in.
    expect(await pgCode(insert('bot', 'agt_support', 'usr_grace'))).toBeUndefined();
    expect(await pgCode(insert('shared', null, null))).toBeUndefined();
    expect((await store.list()).map((r) => r.kind).sort()).toEqual(['bot', 'shared']);
  });

  it('the migrations run twice cleanly, and again after the installs table alone is dropped', async () => {
    const checks = async (): Promise<string[]> =>
      (
        await sql<{ conname: string }>`
          SELECT conname FROM pg_constraint
           WHERE conrelid = 'channel_slack_v1_installs'::regclass AND contype = 'c'
           ORDER BY conname
        `.execute(db)
      ).rows.map((r) => r.conname);
    const botIndexes = async (): Promise<string[]> =>
      (
        await sql<{ indexdef: string }>`
          SELECT indexdef FROM pg_indexes
           WHERE tablename = 'channel_slack_v1_installs' AND indexdef LIKE '%(agent_id)%'
        `.execute(db)
      ).rows.map((r) => r.indexdef);
    const expectRules = async (): Promise<void> => {
      // One of each, however many runs: never a second copy of a rule.
      expect(await checks()).toEqual(['channel_slack_v1_installs_kind_check', 'channel_slack_v1_installs_kind_fields']);
      const indexes = await botIndexes();
      expect(indexes).toHaveLength(1);
      expect(indexes[0]).toMatch(/^CREATE UNIQUE INDEX channel_slack_v1_installs_bot_agent /);
      expect(indexes[0]).toMatch(/WHERE \(kind = 'bot'::text\)/);
    };

    const bot = await pendingBot();
    await runMigrations(db);
    await runMigrations(db);
    expect((await store.get(bot))?.kind).toBe('bot');
    await expectRules();

    // The CLI reset's test drops this one table between its tests, and its
    // next boot migrates again.
    await sql`DROP TABLE channel_slack_v1_installs`.execute(db);
    await runMigrations(db);
    await expectRules();
    // And they hold: a bot needs its agent, and an agent gets one bot.
    const noAgent = sql`
      INSERT INTO channel_slack_v1_installs
        (install_id, status, app_id, client_id, bot_name, connected_by_user_id, kind, requested_by_user_id)
      VALUES (${newInstallId()}, 'pending', ${BOT.appId}, ${BOT.clientId}, ${BOT.botName}, 'usr_grace', 'bot', 'usr_grace')
    `.execute(db);
    expect(await pgCode(noAgent)).toBe('23514');
    await pendingBot();
    const second = await pendingBot().catch((e: unknown) => e);
    expect((second as InstallStoreError).code).toBe('bot-exists');
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
    const expected: Omit<InstallRow, 'createdAt' | 'configTokenAddedAt'> = {
      installId,
      status: 'pending',
      ...PENDING,
      teamId: null,
      teamName: null,
      botUserId: null,
      installedAt: null,
      // The shared app: no agent, no requester, no handle (TASK-1167).
      kind: 'shared',
      agentId: null,
      requestedByUserId: null,
      botHandle: null,
    };
    expect(row).toMatchObject(expected);
    expect(row?.createdAt).toBeInstanceOf(Date);
    // Connect adds the configuration token as it makes the row: one instant.
    expect(row?.configTokenAddedAt).toEqual(row?.createdAt);
    // The row is the install, never its OAuth state.
    expect(Object.keys(row!).sort()).toEqual(
      [...Object.keys(expected), 'createdAt', 'configTokenAddedAt'].sort(),
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

  it('current() never returns a bot', async () => {
    // A bot older than any shared install, and live: still not the shared app.
    const bot = await pendingBot();
    await store.activate(bot, { ...TEAM, installedAt: new Date('2026-11-20T09:00:00.000Z') });
    await sql`UPDATE channel_slack_v1_installs SET created_at = now() - interval '1 hour'
              WHERE install_id = ${bot}`.execute(db);
    await pendingBot({ agentId: 'agt_sales' });
    expect(await store.current()).toBeNull();

    const shared = await pending();
    expect(await store.current()).toEqual(await store.get(shared));
  });

  it('one bot per agent, pending or active', async () => {
    const first = await pendingBot();
    const pendingTwice = await store
      .insertPendingBot({ installId: newInstallId(), ...BOT, botName: 'support-again' })
      .catch((e: unknown) => e);
    expect(pendingTwice).toBeInstanceOf(InstallStoreError);
    expect((pendingTwice as InstallStoreError).code).toBe('bot-exists');

    await store.activate(first, { ...TEAM, installedAt: new Date('2026-11-20T09:00:00.000Z') });
    const activeTwice = await store
      .insertPendingBot({ installId: newInstallId(), ...BOT, connectedByUserId: 'usr_ada', requestedByUserId: 'usr_ada' })
      .catch((e: unknown) => e);
    expect(activeTwice).toBeInstanceOf(InstallStoreError);
    expect((activeTwice as InstallStoreError).code).toBe('bot-exists');

    // Another agent's bot is its own, and shared installs (no agent) never count.
    const sales = await pendingBot({ agentId: 'agt_sales' });
    await pending();
    await pending();
    expect((await store.listBots()).map((r) => r.installId).sort()).toEqual([first, sales].sort());

    // An install id already taken is refused the way insertPending refuses
    // one: it says nothing about the agent.
    const reused = await store
      .insertPendingBot({ installId: first, ...BOT, agentId: 'agt_billing' })
      .catch((e: unknown) => e);
    expect(reused).not.toBeInstanceOf(InstallStoreError);
    expect((reused as { code?: unknown }).code).toBe('23505');
    expect(await store.botForAgent('agt_billing')).toBeNull();
  });

  it('botForAgent and listBots see bots only, any status; listBots oldest first', async () => {
    await pending();
    expect(await store.listBots()).toEqual([]);
    expect(await store.botForAgent('agt_support')).toBeNull();

    const support = await pendingBot();
    const sales = await pendingBot({ agentId: 'agt_sales', connectedByUserId: 'usr_ada', requestedByUserId: 'usr_ada' });
    await store.activate(sales, { ...TEAM, installedAt: new Date('2026-11-20T09:05:00.000Z') });
    // Made support first, but sales is the older: the order can only come from created_at.
    await sql`UPDATE channel_slack_v1_installs SET created_at = '2026-11-20T10:00:00Z' WHERE install_id = ${support}`.execute(db);
    await sql`UPDATE channel_slack_v1_installs SET created_at = '2026-11-20T09:00:00Z' WHERE install_id = ${sales}`.execute(db);

    const supportRow = await store.botForAgent('agt_support');
    expect(supportRow).toEqual({
      installId: support,
      kind: 'bot',
      status: 'pending',
      appId: BOT.appId,
      clientId: BOT.clientId,
      botName: BOT.botName,
      agentId: 'agt_support',
      requestedByUserId: 'usr_grace',
      connectedByUserId: 'usr_grace',
      botHandle: null,
      teamId: null,
      teamName: null,
      botUserId: null,
      createdAt: new Date('2026-11-20T10:00:00Z'),
      configTokenAddedAt: expect.any(Date),
      installedAt: null,
    });
    expect(supportRow).toEqual(await store.get(support));
    expect(await store.botForAgent('agt_sales')).toEqual(await store.get(sales));
    expect((await store.botForAgent('agt_sales'))?.status).toBe('active');
    expect(await store.botForAgent('agt_billing')).toBeNull();
    expect(await store.listBots()).toEqual([await store.get(sales), await store.get(support)]);
  });

  it('setBotHandle writes only an active bot', async () => {
    const bot = await pendingBot();
    const notActive = async (installId: string): Promise<void> => {
      const err = await store.setBotHandle(installId, 'support-helper').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InstallStoreError);
      expect((err as InstallStoreError).code).toBe('install-not-active');
    };

    // Still pending: Slack has no bot user to name yet.
    await notActive(bot);
    expect((await store.get(bot))?.botHandle).toBeNull();
    // The shared app, live: it has no handle of its own here.
    const shared = await pending();
    await store.activate(shared, { ...TEAM, installedAt: new Date('2026-11-20T09:00:00.000Z') });
    await notActive(shared);
    expect((await rawRow(shared))?.bot_handle).toBeNull();
    await notActive(newInstallId());

    await store.activate(bot, { ...TEAM, installedAt: new Date('2026-11-20T09:05:00.000Z') });
    // Another live bot, so a write that lost its install_id filter would show.
    const other = await pendingBot({ agentId: 'agt_sales' });
    await store.activate(other, { ...TEAM, installedAt: new Date('2026-11-20T09:10:00.000Z') });
    const before = await store.get(bot);
    const otherBefore = await store.get(other);
    const sharedBefore = await store.get(shared);

    await store.setBotHandle(bot, 'support-helper');
    expect(await store.get(bot)).toEqual({ ...before, botHandle: 'support-helper' });
    expect(await store.get(other)).toEqual(otherBefore);
    expect(await store.get(shared)).toEqual(sharedBefore);
  });

  it('list returns every install, any status, newest config_token_added_at first, then by install id; [] when there are none', async () => {
    expect(await store.list()).toEqual([]);

    // Shaped like real ids, and in a known order: two installs whose tokens
    // were added at the same instant are listed by install id.
    const tieFirst = `A${newInstallId().slice(1)}`;
    const tieSecond = `B${newInstallId().slice(1)}`;
    const oldest = newInstallId();
    const newest = newInstallId();
    // Made in an order that is neither the listed one nor its reverse, so
    // the list's order can't come from created_at.
    await pending(tieSecond);
    await pending(oldest);
    await pending(tieFirst);
    await store.activate(tieFirst, { ...TEAM, installedAt: new Date('2026-11-10T12:05:00.000Z') });
    await pending(newest);
    await store.activate(newest, { ...TEAM, installedAt: new Date('2026-11-19T12:05:00.000Z') });
    const addedAt = async (installId: string, iso: string): Promise<void> => {
      await sql`UPDATE channel_slack_v1_installs SET config_token_added_at = ${new Date(iso)}
                WHERE install_id = ${installId}`.execute(db);
    };
    await addedAt(oldest, '2026-11-01T12:00:00.000Z');
    await addedAt(tieSecond, '2026-11-10T12:00:00.000Z');
    await addedAt(tieFirst, '2026-11-10T12:00:00.000Z');
    await addedAt(newest, '2026-11-19T12:00:00.000Z');

    // Whole rows, as get reads them.
    expect(await store.list()).toEqual([
      await store.get(newest),
      await store.get(tieFirst),
      await store.get(tieSecond),
      await store.get(oldest),
    ]);
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
      teamName: 'Acme\u202Efdp.exe \u2066Corp\u0007',
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

  it('setBotName renames an active install and changes nothing else, on no other install', async () => {
    const a = await pending();
    await store.activate(a, { ...TEAM, installedAt: new Date('2026-11-13T12:00:00.000Z') });
    const b = await pending();
    // Active too, so a rename that lost its install_id filter would also pass the active filter on b.
    await store.activate(b, { ...TEAM, teamId: 'T07OTHERTM9', installedAt: new Date('2026-11-13T13:00:00.000Z') });
    const snapshotA = await store.get(a);
    const snapshotB = await store.get(b);

    await store.setBotName(a, 'Ada Helper');

    expect(await store.get(a)).toEqual({ ...snapshotA, botName: 'Ada Helper' });
    expect(await store.get(b)).toEqual(snapshotB);
  });

  it('setBotName refuses an install that is missing or still pending, and changes nothing', async () => {
    const installId = await pending();
    const err = await store.setBotName(installId, 'Ada Helper').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallStoreError);
    expect((err as InstallStoreError).code).toBe('install-not-active');
    expect((await store.get(installId))?.botName).toBe(PENDING.botName);

    const missing = await store.setBotName(newInstallId(), 'Ada Helper').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(InstallStoreError);
    expect((missing as InstallStoreError).code).toBe('install-not-active');
  });

  it('setConfigTokenAddedAt changes when the token was added on an active install, and nothing else: not its person (TASK-1175), not its other columns, not another install, not its channel bindings', async () => {
    const a = await pending();
    await store.activate(a, { ...TEAM, installedAt: new Date('2026-11-13T12:00:00.000Z') });
    const b = await pending();
    // Active too, so an update that lost its install_id filter would also pass the active filter on b.
    await store.activate(b, { ...TEAM, teamId: 'T07OTHERTM9', installedAt: new Date('2026-11-13T13:00:00.000Z') });
    await bind(a, 'C07SUPPORT1');
    await bind(b, 'C07SALES002', 'agt_sales');
    const snapshotA = await store.get(a);
    const snapshotB = await store.get(b);
    // Whole rows: a binding's own connected_by_user_id is who its channel's outsiders run as.
    const allBindings = async () =>
      (await sql`SELECT * FROM channel_slack_v1_channels ORDER BY install_id, channel_id`.execute(db)).rows;
    const bindingsBefore = await allBindings();
    expect(bindingsBefore).toHaveLength(2);

    const addedAt = new Date('2026-11-19T09:00:00.000Z');
    await store.setConfigTokenAddedAt(a, addedAt);

    // createdAt included: it keeps meaning "row made", and keeps ordering current().
    // connectedByUserId stays as inserted: a Replace never moves an app to another person.
    expect(await store.get(a)).toEqual({ ...snapshotA, configTokenAddedAt: addedAt });
    expect(await store.get(b)).toEqual(snapshotB);
    expect(await allBindings()).toEqual(bindingsBefore);
  });

  it('setConfigTokenAddedAt refuses an install that is missing or still pending, and changes nothing', async () => {
    const installId = await pending();
    const before = await store.get(installId);
    const addedAt = new Date('2026-11-19T09:00:00.000Z');

    const err = await store.setConfigTokenAddedAt(installId, addedAt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallStoreError);
    expect((err as InstallStoreError).code).toBe('install-not-active');
    expect(await store.get(installId)).toEqual(before);

    const missing = await store.setConfigTokenAddedAt(newInstallId(), addedAt).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(InstallStoreError);
    expect((missing as InstallStoreError).code).toBe('install-not-active');
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

  it("removeAll returns exactly the installs its own delete removed: ids, app ids, teams and each one's person", async () => {
    const pendingId = newInstallId();
    await store.insertPending({ installId: pendingId, ...PENDING, connectedByUserId: 'usr_ada' });
    const activeId = newInstallId();
    await store.insertPending({ installId: activeId, ...PENDING, connectedByUserId: 'usr_grace' });
    await store.activate(activeId, { ...TEAM, installedAt: new Date() });

    const removed = await store.removeAll();
    expect(removed.sort((x, y) => x.installId.localeCompare(y.installId))).toEqual(
      [
        { installId: pendingId, appId: PENDING.appId, teamId: null, connectedByUserId: 'usr_ada', kind: 'shared' },
        { installId: activeId, appId: PENDING.appId, teamId: TEAM.teamId, connectedByUserId: 'usr_grace', kind: 'shared' },
      ].sort((x, y) => x.installId.localeCompare(y.installId)),
    );
    expect(await store.current()).toBeNull();
    // Nothing left: the next one removes, and says, nothing.
    expect(await store.removeAll()).toEqual([]);
  });

  it('removeAll removes bots too, returns their kind and approver, and takes their bindings', async () => {
    // A reset wipes every credential and every agent, so a bot row it left
    // would name a deleted agent and hold no secret.
    const shared = newInstallId();
    await store.insertPending({ installId: shared, ...PENDING, connectedByUserId: 'usr_ada' });
    await store.activate(shared, { ...TEAM, installedAt: new Date('2026-11-20T09:00:00.000Z') });
    const live = await pendingBot();
    await store.activate(live, { ...TEAM, installedAt: new Date('2026-11-20T09:05:00.000Z') });
    // Asked for by Hopper, approved by Ada: whose token made the app is Ada's.
    const waiting = await pendingBot({ agentId: 'agt_sales', connectedByUserId: 'usr_ada', requestedByUserId: 'usr_hopper' });
    await bind(shared, 'C07SUPPORT1');
    await bind(live, 'C07HELPDESK', 'agt_support');

    const removed = await store.removeAll();
    expect(removed.sort((x, y) => x.installId.localeCompare(y.installId))).toEqual(
      [
        { installId: shared, appId: PENDING.appId, teamId: TEAM.teamId, connectedByUserId: 'usr_ada', kind: 'shared' },
        { installId: live, appId: BOT.appId, teamId: TEAM.teamId, connectedByUserId: 'usr_grace', kind: 'bot' },
        { installId: waiting, appId: BOT.appId, teamId: null, connectedByUserId: 'usr_ada', kind: 'bot' },
      ].sort((x, y) => x.installId.localeCompare(y.installId)),
    );
    expect(await store.list()).toEqual([]);
    expect(await bindings()).toEqual([]);
  });
});

/*
  A binding names the person whose identity a channel's outsiders run as, so
  it must never outlive its install (a disconnected workspace still looking
  connected to an agent), and the install must never go while its bindings
  stay half-deleted. Both deletes are one statement: all or nothing.
*/
describe("an install's channel bindings go with it", () => {
  it("remove deletes the install's bindings, and no other install's", async () => {
    const a = await pending();
    const b = await pending();
    await bind(a, 'C07SUPPORT1');
    await bind(a, 'C07SALES002', 'agt_sales');
    await bind(b, 'C07SUPPORT1');

    await store.remove(a);
    expect(await store.get(a)).toBeNull();
    expect(await store.get(b)).not.toBeNull();
    expect(await bindings()).toEqual([`${b}/C07SUPPORT1`]);
  });

  it("removeAll deletes every removed install's bindings and still returns exactly the installs", async () => {
    const pendingId = await pending();
    const activeId = await pending();
    await store.activate(activeId, { ...TEAM, installedAt: new Date() });
    await bind(pendingId, 'C07SUPPORT1');
    await bind(activeId, 'C07SALES002');

    const removed = await store.removeAll();
    expect(removed.sort((x, y) => x.installId.localeCompare(y.installId))).toEqual(
      [
        { installId: pendingId, appId: PENDING.appId, teamId: null, connectedByUserId: PENDING.connectedByUserId, kind: 'shared' },
        { installId: activeId, appId: PENDING.appId, teamId: TEAM.teamId, connectedByUserId: PENDING.connectedByUserId, kind: 'shared' },
      ].sort((x, y) => x.installId.localeCompare(y.installId)),
    );
    expect(await bindings()).toEqual([]);
  });

  it('a failing install delete keeps the bindings: remove and removeAll delete nothing at all', async () => {
    const a = await pending();
    const b = await pending();
    await bind(a, 'C07SUPPORT1');
    await bind(b, 'C07SALES002');
    const before = await bindings();
    expect(before).toHaveLength(2);

    await withInstallDeleteTrigger(`RAISE EXCEPTION 'refused in test'; RETURN OLD;`, async () => {
      await expect(store.remove(a)).rejects.toThrow();
      await expect(store.removeAll()).rejects.toThrow();
    });

    expect(await store.get(a)).not.toBeNull();
    expect(await store.get(b)).not.toBeNull();
    expect(await bindings()).toEqual(before);
  });

  it("a delete that skips an install keeps that install's bindings, and takes the others'", async () => {
    const kept = await pending();
    const gone = await pending();
    await bind(kept, 'C07SUPPORT1');
    await bind(gone, 'C07SALES002');

    // A row trigger returning NULL skips that row's delete without an error,
    // as when what a read saw and what the delete removed differ.
    await withInstallDeleteTrigger(`IF OLD.install_id = '${kept}' THEN RETURN NULL; END IF; RETURN OLD;`, async () => {
      await store.remove(kept);
      expect(await store.get(kept)).not.toBeNull();
      expect(await bindings()).toEqual([`${kept}/C07SUPPORT1`, `${gone}/C07SALES002`].sort());

      expect((await store.removeAll()).map((r) => r.installId)).toEqual([gone]);
      expect(await bindings()).toEqual([`${kept}/C07SUPPORT1`]);
    });
  });
});

/*
  Disconnect deletes the install's Slack app with a token minted from the
  stored refresh token. When Slack won't (the token is dead or revoked, or
  Slack doesn't answer), the install still goes, and its app's id and name
  move to the leftover list in the statement that deletes it, so the next
  Connect can delete the app. The id is never in both tables, and a delete
  that doesn't happen remembers nothing.
*/
describe("an app Disconnect couldn't delete is remembered with the install's removal (TASK-1132)", () => {
  it('remove with appLeft moves the app id and name into the leftover list, and the bindings still go', async () => {
    const a = await pending();
    await bind(a, 'C07SUPPORT1');

    await store.remove(a, { appLeft: true });

    expect(await store.get(a)).toBeNull();
    expect(await bindings()).toEqual([]);
    expect(await store.leftoverApps()).toEqual([
      {
        installId: a,
        appId: PENDING.appId,
        botName: PENDING.botName,
        leftAt: expect.any(Date),
        connectedByUserId: PENDING.connectedByUserId,
      },
    ]);
  });

  it("remove with appLeft moves the install's person into the leftover row in the same statement", async () => {
    const a = newInstallId();
    await store.insertPending({ installId: a, ...PENDING, connectedByUserId: 'usr_ada' });
    const b = newInstallId();
    await store.insertPending({ installId: b, ...PENDING, connectedByUserId: 'usr_grace' });
    await store.activate(b, { ...TEAM, installedAt: new Date() });

    await store.remove(a, { appLeft: true });
    await store.remove(b, { appLeft: true });

    // Each row's own person, whatever its status: whose token made the app.
    const left = await store.leftoverApps();
    expect(left.find((l) => l.installId === a)?.connectedByUserId).toBe('usr_ada');
    expect(left.find((l) => l.installId === b)?.connectedByUserId).toBe('usr_grace');
    expect(left).toHaveLength(2);
  });

  it('remove without appLeft, or with appLeft false, remembers nothing', async () => {
    const a = await pending();
    const b = await pending();

    await store.remove(a);
    await store.remove(b, { appLeft: false });

    expect(await store.get(a)).toBeNull();
    expect(await store.get(b)).toBeNull();
    expect(await store.leftoverApps()).toEqual([]);
  });

  it('a failing or skipped install delete remembers nothing', async () => {
    const a = await pending();

    await withInstallDeleteTrigger(`RAISE EXCEPTION 'refused in test'; RETURN OLD;`, async () => {
      await expect(store.remove(a, { appLeft: true })).rejects.toThrow(/refused in test/);
    });
    expect(await store.get(a)).not.toBeNull();
    expect(await store.leftoverApps()).toEqual([]);

    // A row trigger returning NULL skips that row's delete without an error.
    await withInstallDeleteTrigger(`IF OLD.install_id = '${a}' THEN RETURN NULL; END IF; RETURN OLD;`, async () => {
      await expect(store.remove(a, { appLeft: true })).resolves.toBeUndefined();
    });
    expect(await store.get(a)).not.toBeNull();
    expect(await store.leftoverApps()).toEqual([]);

    // No such install: nothing deleted, so nothing remembered.
    await expect(store.remove(newInstallId(), { appLeft: true })).resolves.toBeUndefined();
    expect(await store.leftoverApps()).toEqual([]);
  });

  it('if remembering the app fails, the install and its bindings stay: one statement', async () => {
    const a = await pending();
    await bind(a, 'C07SUPPORT1');

    await withLeftoverInsertTrigger(`RAISE EXCEPTION 'refused in test'; RETURN NEW;`, async () => {
      await expect(store.remove(a, { appLeft: true })).rejects.toThrow(/refused in test/);
    });

    expect(await store.get(a)).not.toBeNull();
    expect(await bindings()).toEqual([`${a}/C07SUPPORT1`]);
    expect(await store.leftoverApps()).toEqual([]);
  });

  it('leftoverApps lists the oldest first, at most LEFTOVER_APPS_MAX; forgetLeftoverApp drops only the one named', async () => {
    const removed: string[] = [];
    for (let i = 0; i < LEFTOVER_APPS_MAX + 2; i += 1) {
      const installId = await pending();
      await store.remove(installId, { appLeft: true });
      removed.push(installId);
    }
    // One minute apart, the LAST one removed the oldest: the list's order can
    // only come from left_at, never from the random ids or the order the rows
    // were written in.
    const base = Date.parse('2026-11-18T12:00:00.000Z');
    for (const [i, installId] of removed.entries()) {
      const leftAt = new Date(base + (removed.length - 1 - i) * 60_000);
      await sql`UPDATE channel_slack_v1_leftover_apps SET left_at = ${leftAt}
                WHERE install_id = ${installId}`.execute(db);
    }
    const oldestFirst = [...removed].reverse();

    const listed = await store.leftoverApps();
    expect(listed).toHaveLength(LEFTOVER_APPS_MAX);
    expect(listed.map((l) => l.installId)).toEqual(oldestFirst.slice(0, LEFTOVER_APPS_MAX));
    expect(listed[0]).toEqual({
      installId: oldestFirst[0],
      appId: PENDING.appId,
      botName: PENDING.botName,
      leftAt: new Date(base),
      connectedByUserId: PENDING.connectedByUserId,
    });

    await store.forgetLeftoverApp(oldestFirst[0]!);
    expect((await store.leftoverApps()).map((l) => l.installId)).toEqual(
      oldestFirst.slice(1, LEFTOVER_APPS_MAX + 1),
    );

    // One that isn't there is not an error, and nothing else is forgotten.
    await expect(store.forgetLeftoverApp(newInstallId())).resolves.toBeUndefined();
    expect((await store.leftoverApps()).map((l) => l.installId)).toEqual(
      oldestFirst.slice(1, LEFTOVER_APPS_MAX + 1),
    );
  });

  it('the same install id remembered twice keeps the first, and its person (only tests reuse ids)', async () => {
    const a = await pending();
    await store.remove(a, { appLeft: true });
    await store.insertPending({ installId: a, ...PENDING, appId: 'A07OTHERAPP1', connectedByUserId: 'usr_admin2' });

    await expect(store.remove(a, { appLeft: true })).resolves.toBeUndefined();

    expect(await store.get(a)).toBeNull();
    expect(await store.leftoverApps()).toEqual([
      {
        installId: a,
        appId: PENDING.appId,
        botName: PENDING.botName,
        leftAt: expect.any(Date),
        connectedByUserId: PENDING.connectedByUserId,
      },
    ]);
  });

  it('removeAll leaves the leftover list alone', async () => {
    const left = await pending();
    await store.remove(left, { appLeft: true });
    const live = await pending();

    expect((await store.removeAll()).map((r) => r.installId)).toEqual([live]);
    expect((await store.leftoverApps()).map((l) => l.installId)).toEqual([left]);
  });
});

describe("an app Connect couldn't take back is remembered with no install row (TASK-1159)", () => {
  it('rememberLeftoverApp lists the app under the id Connect minted, with the person it was given, touches no install, and is forgotten like any other', async () => {
    const live = await pending();
    const id = newInstallId();

    await store.rememberLeftoverApp({ installId: id, appId: 'A07NEWAPP001', botName: 'canopy', connectedByUserId: 'usr_ada' });

    expect(await store.leftoverApps()).toEqual([
      { installId: id, appId: 'A07NEWAPP001', botName: 'canopy', leftAt: expect.any(Date), connectedByUserId: 'usr_ada' },
    ]);
    expect(await store.get(id)).toBeNull();
    expect((await store.current())?.installId).toBe(live);
    expect((await store.current())?.connectedByUserId).toBe(PENDING.connectedByUserId);

    await store.forgetLeftoverApp(id);
    expect(await store.leftoverApps()).toEqual([]);
  });

  it('rememberLeftoverApp keeps the person it was given; a second remember of the same id keeps the first app and its person', async () => {
    const id = newInstallId();
    await store.rememberLeftoverApp({ installId: id, appId: 'A07NEWAPP001', botName: 'canopy', connectedByUserId: 'usr_ada' });

    await expect(
      store.rememberLeftoverApp({ installId: id, appId: 'A07NEWAPP002', botName: 'other', connectedByUserId: 'usr_grace' }),
    ).resolves.toBeUndefined();

    expect(await store.leftoverApps()).toEqual([
      { installId: id, appId: 'A07NEWAPP001', botName: 'canopy', leftAt: expect.any(Date), connectedByUserId: 'usr_ada' },
    ]);
  });

  it('a failing insert rejects, so the caller can say so, and leaves nothing', async () => {
    await withLeftoverInsertTrigger(`RAISE EXCEPTION 'refused in test'; RETURN NEW;`, async () => {
      await expect(
        store.rememberLeftoverApp({
          installId: newInstallId(),
          appId: 'A07NEWAPP001',
          botName: 'canopy',
          connectedByUserId: 'usr_ada',
        }),
      ).rejects.toThrow(/refused in test/);
    });

    expect(await store.leftoverApps()).toEqual([]);
  });
});

/*
  One configuration token per person (TASK-1175): it is kept while any
  install or any leftover app still names the person whose token made it.
  A leftover from before TASK-1175 names no one, and a channel binding's
  person (whom its outsiders run as) holds no token.
*/
describe('whether anyone still names a person (TASK-1175)', () => {
  it('personHasApps: false with nothing stored, and a leftover that names no one never counts', async () => {
    expect(await store.personHasApps('usr_ada')).toBe(false);

    // Left before TASK-1175: no person.
    await sql`INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name)
              VALUES (${newInstallId()}, 'A07OLDAPP001', 'old')`.execute(db);
    expect(await store.personHasApps('usr_ada')).toBe(false);
  });

  it("personHasApps: true for a pending install's person, an active install's, and one named only by a leftover; false for anyone else", async () => {
    const p = newInstallId();
    await store.insertPending({ installId: p, ...PENDING, connectedByUserId: 'usr_pending' });
    const a = newInstallId();
    await store.insertPending({ installId: a, ...PENDING, connectedByUserId: 'usr_active' });
    await store.activate(a, { ...TEAM, installedAt: new Date() });
    await store.rememberLeftoverApp({ installId: newInstallId(), appId: 'A07NEWAPP001', botName: 'canopy', connectedByUserId: 'usr_left' });
    await sql`INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name)
              VALUES (${newInstallId()}, 'A07OLDAPP001', 'old')`.execute(db);
    // A binding names its connecting admin (bind's usr_admin1), but no token of theirs made an app.
    await bind(a, 'C07SUPPORT1');

    expect(await store.personHasApps('usr_pending')).toBe(true);
    expect(await store.personHasApps('usr_active')).toBe(true);
    expect(await store.personHasApps('usr_left')).toBe(true);
    expect(await store.personHasApps('usr_admin1')).toBe(false);
    expect(await store.personHasApps('usr_grace')).toBe(false);
  });

  it('personHasApps follows the rows: an install left on Slack keeps naming its person until the leftover is forgotten', async () => {
    const a = newInstallId();
    await store.insertPending({ installId: a, ...PENDING, connectedByUserId: 'usr_ada' });
    const b = newInstallId();
    await store.insertPending({ installId: b, ...PENDING, connectedByUserId: 'usr_grace' });

    await store.remove(a, { appLeft: true });
    expect(await store.personHasApps('usr_ada')).toBe(true);
    await store.remove(b);
    expect(await store.personHasApps('usr_grace')).toBe(false);

    await store.forgetLeftoverApp(a);
    expect(await store.personHasApps('usr_ada')).toBe(false);
  });

  it('personHasApps counts a pending bot and an active bot that name the person as approver, and stops once the bot is removed', async () => {
    // Grace only approved a bot (Hopper asked for it): no shared install and
    // no leftover names her.
    const bot = await pendingBot({ connectedByUserId: 'usr_grace', requestedByUserId: 'usr_hopper' });
    expect(await store.personHasApps('usr_grace')).toBe(true);
    // Asking for a bot holds no token: only the approver's made the app.
    expect(await store.personHasApps('usr_hopper')).toBe(false);

    await store.activate(bot, { ...TEAM, installedAt: new Date('2026-11-20T09:00:00.000Z') });
    expect(await store.personHasApps('usr_grace')).toBe(true);

    await store.remove(bot);
    expect(await store.personHasApps('usr_grace')).toBe(false);

    // A bot whose app Slack wouldn't delete: the leftover names her.
    const left = await pendingBot({ connectedByUserId: 'usr_grace' });
    await store.remove(left, { appLeft: true });
    expect(await store.leftoverApps()).toEqual([
      { installId: left, appId: BOT.appId, botName: BOT.botName, leftAt: expect.any(Date), connectedByUserId: 'usr_grace' },
    ]);
    expect(await store.personHasApps('usr_grace')).toBe(true);
  });
});

describe('OAuth state', () => {
  const expiresAt = new Date('2026-11-13T12:10:00.000Z');

  it('peek does not consume', async () => {
    const installId = await pending();
    const hash = stateHash('peek-state');
    await store.setOAuthState(installId, { stateHash: hash, userId: 'usr_admin1', expiresAt });

    const want = { installId, userId: 'usr_admin1', expiresAt };
    expect(await store.peekOAuthState(hash, 'shared')).toEqual(want);
    expect(await store.peekOAuthState(hash, 'shared')).toEqual(want);
    expect(await store.consumeOAuthState(hash, 'shared')).toEqual(want);
    expect(await store.peekOAuthState(stateHash('never-minted'), 'shared')).toBeNull();
  });

  it('consumeOAuthState is single-use', async () => {
    const installId = await pending();
    const hash = stateHash('single-use');
    await store.setOAuthState(installId, { stateHash: hash, userId: 'usr_admin1', expiresAt });

    expect(await store.consumeOAuthState(hash, 'shared')).toEqual({
      installId,
      userId: 'usr_admin1',
      expiresAt,
    });
    expect(await store.consumeOAuthState(hash, 'shared')).toBeNull();
    expect(await store.peekOAuthState(hash, 'shared')).toBeNull();
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
        Array.from({ length: 8 }, () => store.consumeOAuthState(hash, 'shared')),
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

    expect(await store.consumeOAuthState(old, 'shared')).toBeNull();
    expect(await store.consumeOAuthState(fresh, 'shared')).toEqual({
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
    expect(await store.peekOAuthState(state.stateHash, 'shared')).toBeNull();
  });

  it('the state is stored only as the hash the caller passes', async () => {
    const installId = await pending();
    const hash = stateHash('raw-state-value');
    await store.setOAuthState(installId, { stateHash: hash, userId: 'usr_admin1', expiresAt });
    const row = await rawRow(installId);
    expect(row?.oauth_state_hash).toBe(hash);
    expect(JSON.stringify(row)).not.toContain('raw-state-value');
  });

  /*
    Each Allow has its own callback (TASK-1167): the admin's finishes the
    shared app, the bot's a team agent's bot. A state reaches only its own
    kind's callback, so neither flow's finish step ever sees the other's.
  */
  it('a bot state is invisible to the shared peek and consume, and the reverse', async () => {
    const shared = await pending();
    const bot = await pendingBot();
    const sharedHash = stateHash('shared-state');
    const botHash = stateHash('bot-state');
    await store.setOAuthState(shared, { stateHash: sharedHash, userId: 'usr_admin1', expiresAt });
    await store.setOAuthState(bot, { stateHash: botHash, userId: 'usr_grace', expiresAt });

    expect(await store.peekOAuthState(botHash, 'shared')).toBeNull();
    expect(await store.consumeOAuthState(botHash, 'shared')).toBeNull();
    expect(await store.peekOAuthState(sharedHash, 'bot')).toBeNull();
    expect(await store.consumeOAuthState(sharedHash, 'bot')).toBeNull();
    // Neither was spent by the other kind's consume.
    expect((await rawRow(bot))?.oauth_state_hash).toBe(botHash);
    expect((await rawRow(shared))?.oauth_state_hash).toBe(sharedHash);

    // Each kind spends its own, exactly once.
    const botState = { installId: bot, userId: 'usr_grace', expiresAt };
    expect(await store.peekOAuthState(botHash, 'bot')).toEqual(botState);
    expect(await store.consumeOAuthState(botHash, 'bot')).toEqual(botState);
    expect(await store.consumeOAuthState(botHash, 'bot')).toBeNull();
    const sharedState = { installId: shared, userId: 'usr_admin1', expiresAt };
    expect(await store.peekOAuthState(sharedHash, 'shared')).toEqual(sharedState);
    expect(await store.consumeOAuthState(sharedHash, 'shared')).toEqual(sharedState);
    expect(await store.consumeOAuthState(sharedHash, 'shared')).toBeNull();
  });
});
