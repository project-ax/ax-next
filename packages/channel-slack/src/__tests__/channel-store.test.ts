import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createChannelStore, type ChannelBinding, type ChannelStore } from '../channel-store.js';
import { runMigrations, type ChannelSlackDatabase } from '../migrations.js';

/*
  The binding decides whose identity a channel's outsiders run as (the
  connector's), so the rules below are the security-relevant ones: one agent
  per channel, decided atomically; a second agent can never take a channel
  over; and remove/setRemember act only on the binding of the agent the caller
  named, so a route that checked rights on agent A can't touch agent B's.
*/

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<ChannelSlackDatabase>;
let channels: ChannelStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  // Room for the racing upserts below to each hold their own connection.
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });
  db = new Kysely<ChannelSlackDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(db);
  channels = createChannelStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE channel_slack_v1_channels`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

// Shaped like the real thing: an installId is 16 random bytes in base64url.
const INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const OTHER_INSTALL = 'Zm9vYmFyYmF6cXV4cXV1eA';
const SUPPORT = 'C07SUPPORT1';
const SALES = 'C07SALES002';
const GENERAL = 'C07GENERAL3';
const AGENT = 'agt_support';
const OTHER_AGENT = 'agt_sales';
const ADA = 'usr_ada';
const BOB = 'usr_bob';

const NUL = String.fromCharCode(0x00);
const RLO = String.fromCharCode(0x202e); // right-to-left override

type Connect = Parameters<ChannelStore['upsert']>[0];

/** A binding as a connect writes it: Ada connects #support to the support agent, unless told otherwise. */
function connect(o: Partial<Connect> = {}): ReturnType<ChannelStore['upsert']> {
  return channels.upsert({
    installId: INSTALL,
    channelId: SUPPORT,
    agentId: AGENT,
    connectedByUserId: ADA,
    channelName: 'support',
    ...o,
  });
}

/** Every column of one row, `updated_at` included, as the database holds it. */
async function rawRow(installId: string, channelId: string) {
  const r = await sql<Record<string, unknown>>`
    SELECT * FROM channel_slack_v1_channels
     WHERE install_id = ${installId} AND channel_id = ${channelId}
  `.execute(db);
  return r.rows[0];
}

/** Pin a binding's age, so "oldest first" never hangs on the clock's resolution. */
async function setCreatedAt(installId: string, channelId: string, at: Date): Promise<void> {
  await sql`
    UPDATE channel_slack_v1_channels SET created_at = ${at}
     WHERE install_id = ${installId} AND channel_id = ${channelId}
  `.execute(db);
}

const byChannel = (a: { channelId: string }, b: { channelId: string }): number =>
  a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0;

describe('runMigrations', () => {
  it('a second run keeps every binding (additive and idempotent)', async () => {
    await connect();
    await runMigrations(db);
    await runMigrations(db);
    expect((await channels.get(INSTALL, SUPPORT))?.agentId).toBe(AGENT);
  });
});

describe('upsert: one agent per channel', () => {
  it('a new channel is connected and reads back with remember on', async () => {
    expect(await channels.get(INSTALL, SUPPORT)).toBeNull();
    expect(await connect()).toBe('connected');

    const want: Omit<ChannelBinding, 'createdAt'> = {
      installId: INSTALL,
      channelId: SUPPORT,
      agentId: AGENT,
      connectedByUserId: ADA,
      channelName: 'support',
      remember: true,
    };
    expect(await channels.get(INSTALL, SUPPORT)).toEqual({ ...want, createdAt: expect.any(Date) });
    // A binding is keyed by install AND channel.
    expect(await channels.get(OTHER_INSTALL, SUPPORT)).toBeNull();
    expect(await channels.get(INSTALL, SALES)).toBeNull();
  });

  it('the same agent again is a reconnect: the connector and name change, remember and createdAt stay', async () => {
    await connect();
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);
    const before = (await channels.get(INSTALL, SUPPORT))!;

    expect(await connect({ connectedByUserId: BOB, channelName: 'help-desk' })).toBe('reconnected');
    expect(await channels.get(INSTALL, SUPPORT)).toEqual({
      ...before,
      connectedByUserId: BOB,
      channelName: 'help-desk',
      remember: false,
    });
  });

  it('another agent is told the channel is taken, and the row is left exactly as it was', async () => {
    await connect();
    const before = await rawRow(INSTALL, SUPPORT);

    expect(await connect({ agentId: OTHER_AGENT, connectedByUserId: BOB, channelName: 'hijacked' })).toBe(
      'taken',
    );
    expect(await rawRow(INSTALL, SUPPORT)).toEqual(before);
  });

  it('two agents race one channel: exactly one connects, the other is told it is taken', async () => {
    for (let round = 0; round < 10; round += 1) {
      const channelId = `C07RACE${round}`;
      const results = await Promise.all([
        connect({ channelId, agentId: AGENT }),
        connect({ channelId, agentId: OTHER_AGENT, connectedByUserId: BOB }),
      ]);
      expect([...results].sort()).toEqual(['connected', 'taken']);
      const winner = results[0] === 'connected' ? AGENT : OTHER_AGENT;
      expect((await channels.get(INSTALL, channelId))?.agentId).toBe(winner);
    }
  });

  it('eight agents race one channel: one binding, seven told it is taken, none thrown', async () => {
    for (let round = 0; round < 5; round += 1) {
      const channelId = `C07CROWD${round}`;
      const agents = Array.from({ length: 8 }, (_, i) => `agt_racer_${i}`);
      const results = await Promise.all(agents.map((agentId) => connect({ channelId, agentId })));
      expect(results.filter((r) => r === 'connected')).toHaveLength(1);
      expect(results.filter((r) => r === 'taken')).toHaveLength(7);
      expect((await channels.get(INSTALL, channelId))?.agentId).toBe(agents[results.indexOf('connected')]);
    }
  });

  it('the same agent racing itself: one connects, the other reconnects, neither is taken', async () => {
    const results = await Promise.all([connect(), connect({ connectedByUserId: BOB })]);
    expect([...results].sort()).toEqual(['connected', 'reconnected']);
  });

  it('stores the name cleaned: a NUL, a bidi override and brackets never reach the row', async () => {
    expect(await connect({ channelName: `sup${NUL}port${RLO}[x](y)` })).toBe('connected');
    expect((await channels.get(INSTALL, SUPPORT))?.channelName).toBe('sup port x y');
  });
});

describe('remove and setRemember act only on the named agent', () => {
  it('remove: another agent, install or channel removes nothing; the bound agent removes only its row', async () => {
    await connect();
    await connect({ channelId: SALES });
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT });

    expect(await channels.remove(INSTALL, SUPPORT, OTHER_AGENT)).toBe(false);
    expect(await channels.remove(OTHER_INSTALL, SUPPORT, AGENT)).toBe(false);
    expect(await channels.remove(INSTALL, 'C07NOWHERE1', AGENT)).toBe(false);
    expect((await channels.get(INSTALL, SUPPORT))?.agentId).toBe(AGENT);

    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
    expect(await channels.get(INSTALL, SUPPORT)).toBeNull();
    expect([...(await channels.listAll(INSTALL))].sort(byChannel)).toEqual([
      { channelId: GENERAL, agentId: OTHER_AGENT },
      { channelId: SALES, agentId: AGENT },
    ]);
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(false);
  });

  it('setRemember: another agent, install or channel changes nothing; the bound agent flips it both ways', async () => {
    await connect();
    await connect({ channelId: SALES });

    expect(await channels.setRemember(INSTALL, SUPPORT, OTHER_AGENT, false)).toBe(false);
    expect(await channels.setRemember(OTHER_INSTALL, SUPPORT, AGENT, false)).toBe(false);
    expect(await channels.setRemember(INSTALL, 'C07NOWHERE1', AGENT, false)).toBe(false);
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(true);

    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(false);
    // The agent's other channel keeps its own switch.
    expect((await channels.get(INSTALL, SALES))?.remember).toBe(true);
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, true)).toBe(true);
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(true);
  });
});

describe('lists', () => {
  const OLDER = new Date('2026-11-13T09:00:00.000Z');
  const NEWER = new Date('2026-11-13T10:00:00.000Z');

  it("listForAgent: this agent's channels on this install, oldest first, a reconnect keeping its place", async () => {
    // Sales is connected first but made the newer of the two, so "oldest
    // first" disagrees with both insertion order and channel-id order; the
    // reconnect of support makes it the most recently updated, so it also
    // disagrees with updated_at order.
    await connect({ channelId: SALES, channelName: 'sales' });
    await connect({ channelId: SUPPORT, channelName: 'support' });
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT, channelName: 'general' });
    await connect({ installId: OTHER_INSTALL, channelId: 'C07ELSEWHR1', channelName: 'elsewhere' });
    await setCreatedAt(INSTALL, SUPPORT, OLDER);
    await setCreatedAt(INSTALL, SALES, NEWER);
    expect(await connect({ channelId: SUPPORT, connectedByUserId: BOB, channelName: 'support' })).toBe(
      'reconnected',
    );

    const want: ChannelBinding[] = [
      {
        installId: INSTALL,
        channelId: SUPPORT,
        agentId: AGENT,
        connectedByUserId: BOB,
        channelName: 'support',
        remember: true,
        createdAt: OLDER,
      },
      {
        installId: INSTALL,
        channelId: SALES,
        agentId: AGENT,
        connectedByUserId: ADA,
        channelName: 'sales',
        remember: true,
        createdAt: NEWER,
      },
    ];
    expect(await channels.listForAgent(INSTALL, AGENT)).toEqual(want);
    expect(await channels.listForAgent(INSTALL, 'agt_nobody')).toEqual([]);
    expect(await channels.listForAgent(OTHER_INSTALL, OTHER_AGENT)).toEqual([]);
  });

  it('listAll: every binding on this install, whichever agent, and none from another install', async () => {
    await connect({ channelId: SUPPORT });
    await connect({ channelId: SALES });
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT });
    await connect({ installId: OTHER_INSTALL, channelId: 'C07ELSEWHR1' });

    expect([...(await channels.listAll(INSTALL))].sort(byChannel)).toEqual([
      { channelId: GENERAL, agentId: OTHER_AGENT },
      { channelId: SALES, agentId: AGENT },
      { channelId: SUPPORT, agentId: AGENT },
    ]);
    expect(await channels.listAll('AAAAAAAAAAAAAAAAAAAAAA')).toEqual([]);
  });
});

describe('removeForAgent', () => {
  it("removes the agent's bindings on every install and counts them; other agents keep theirs", async () => {
    await connect({ channelId: SUPPORT });
    await connect({ channelId: SALES });
    await connect({ installId: OTHER_INSTALL, channelId: SUPPORT });
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT });

    expect(await channels.removeForAgent(AGENT)).toBe(3);
    expect(await channels.listAll(INSTALL)).toEqual([{ channelId: GENERAL, agentId: OTHER_AGENT }]);
    expect(await channels.listAll(OTHER_INSTALL)).toEqual([]);
    // Nothing left: safe to run again, and an agent with no channels is not an error.
    expect(await channels.removeForAgent(AGENT)).toBe(0);
    expect(await channels.removeForAgent('agt_never_bound')).toBe(0);
  });
});
