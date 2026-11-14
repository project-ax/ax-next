import { makeAgentContext } from '@ax/core';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelCaptureVeto } from '../capture-veto.js';
import { createChannelStore, type ChannelBinding, type ChannelStore, type ChannelThread } from '../channel-store.js';
import { runMigrations, type ChannelSlackDatabase } from '../migrations.js';
import { createInstallStore, type InstallStore } from '../store.js';

/*
  The binding decides whose identity a channel's outsiders run as (the
  connector's), so the rules below are the security-relevant ones: one agent
  per channel, decided atomically; a second agent can never take a channel
  over; and remove/setRemember act only on the binding of the agent the caller
  named, so a route that checked rights on agent A can't touch agent B's.

  The thread map (TASK-1094) is what the memory switch stands on: a thread
  that had a turn while the switch was off stays not remembered for good, and
  its row outlives the binding and the install, so the capture veto
  (capture-veto.ts) keeps refusing it after Slack is disconnected. Only a
  deleted agent takes its rows away.
*/

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<ChannelSlackDatabase>;
let channels: ChannelStore;
let installs: InstallStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  // Room for the racing upserts below to each hold their own connection.
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });
  db = new Kysely<ChannelSlackDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(db);
  channels = createChannelStore(db);
  installs = createInstallStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE channel_slack_v1_channels, channel_slack_v1_threads, channel_slack_v1_installs`.execute(db);
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

// Conversation ids are the conversations plugin's, opaque here.
const CONV = 'conv_support_thread_1';
const OTHER_CONV = 'conv_support_thread_2';

/** A member's #support thread of the support agent, remembered, unless told otherwise. */
const supportThread = (o: Partial<ChannelThread> = {}): ChannelThread => ({
  installId: INSTALL,
  channelId: SUPPORT,
  agentId: AGENT,
  notRemembered: false,
  external: false,
  ...o,
});

type ThreadIds = Omit<ChannelThread, 'notRemembered' | 'external'>;
/** Whose turn: a member's (the default), or an outsider's, run as `runAs` (Ada, who connects #support, by default). */
type Turn = { mode?: 'attended' | 'external'; runAs?: string };

/**
 * A turn starting in `conversationId`: a member's, in #support of the support
 * agent, unless told otherwise; the switch as it is.
 */
function record(conversationId: string, o: Partial<ThreadIds> & Turn = {}): ReturnType<ChannelStore['recordThread']> {
  const { mode, runAs, ...ids } = o;
  return channels.recordThread({
    installId: INSTALL,
    channelId: SUPPORT,
    agentId: AGENT,
    ...ids,
    conversationId,
    ...(mode === 'external' ? { mode, runAs: runAs ?? ADA } : { mode: 'attended' as const }),
  });
}

/** A turn starting while its channel's switch is off; the switch is on again after. */
async function recordOff(conversationId: string, o: Partial<ThreadIds> & Turn = {}): Promise<void> {
  const ids = { installId: INSTALL, channelId: SUPPORT, agentId: AGENT, ...o };
  expect(await channels.setRemember(ids.installId, ids.channelId, ids.agentId, false)).toBe(true);
  expect(await record(conversationId, o)).toBe('recorded');
  expect(await channels.setRemember(ids.installId, ids.channelId, ids.agentId, true)).toBe(true);
}

/** What memory:pre-capture gets for a pass on `conversationId`, from the veto over the real store. */
function vetoFor(conversationId: string) {
  const ctx = makeAgentContext({ sessionId: 's', agentId: AGENT, userId: ADA, conversationId });
  return channelCaptureVeto(channels, ctx, { conversationId });
}

const REFUSED = { rejected: true, reason: 'channel-not-remembered' };
const OUTSIDER_THREAD = { rejected: true, reason: 'channel-external-turn' };

async function threadCount(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM channel_slack_v1_threads`.execute(db);
  return r.rows[0]!.n;
}

describe('runMigrations', () => {
  it('a second run keeps every binding and thread (additive and idempotent)', async () => {
    await connect();
    await recordOff(CONV);
    await record(OTHER_CONV, { mode: 'external' });
    await runMigrations(db);
    await runMigrations(db);
    expect((await channels.get(INSTALL, SUPPORT))?.agentId).toBe(AGENT);
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
    expect(await channels.getThread(OTHER_CONV)).toEqual(supportThread({ external: true }));
  });

  it("adds `external` to a thread table made before it, every row a member's (none exist in production)", async () => {
    // The table as Task 14 made it, with one row.
    await sql`DROP TABLE channel_slack_v1_threads`.execute(db);
    await sql`
      CREATE TABLE channel_slack_v1_threads (
        conversation_id TEXT PRIMARY KEY,
        install_id      TEXT NOT NULL,
        channel_id      TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        not_remembered  BOOLEAN NOT NULL DEFAULT false,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(db);
    await sql`
      INSERT INTO channel_slack_v1_threads (conversation_id, install_id, channel_id, agent_id, not_remembered)
      VALUES (${CONV}, ${INSTALL}, ${SUPPORT}, ${AGENT}, true)
    `.execute(db);

    await runMigrations(db);
    await runMigrations(db);

    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
    await connect();
    expect(await record(OTHER_CONV, { mode: 'external' })).toBe('recorded');
    expect(await channels.getThread(OTHER_CONV)).toEqual(supportThread({ external: true }));
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
  it("removes the agent's bindings and thread rows on every install, counts each; other agents keep theirs", async () => {
    await connect({ channelId: SUPPORT });
    await connect({ channelId: SALES });
    await connect({ installId: OTHER_INSTALL, channelId: SUPPORT });
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT });
    expect(await record(CONV)).toBe('recorded');
    await recordOff(OTHER_CONV, { installId: OTHER_INSTALL });
    expect(await record('conv_general_thread', { channelId: GENERAL, agentId: OTHER_AGENT })).toBe('recorded');

    expect(await channels.removeForAgent(AGENT)).toEqual({ channels: 3, threads: 2 });
    expect(await channels.listAll(INSTALL)).toEqual([{ channelId: GENERAL, agentId: OTHER_AGENT }]);
    expect(await channels.listAll(OTHER_INSTALL)).toEqual([]);
    expect(await channels.getThread(CONV)).toBeNull();
    expect(await channels.getThread(OTHER_CONV)).toBeNull();
    expect(await channels.getThread('conv_general_thread')).toEqual(supportThread({ channelId: GENERAL, agentId: OTHER_AGENT }));
    // Nothing left: safe to run again, and an agent with no channels is not an error.
    expect(await channels.removeForAgent(AGENT)).toEqual({ channels: 0, threads: 0 });
    expect(await channels.removeForAgent('agt_never_bound')).toEqual({ channels: 0, threads: 0 });
  });

  it('an agent whose channels were already disconnected still has its thread rows removed', async () => {
    await connect();
    await recordOff(CONV);
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);

    expect(await channels.removeForAgent(AGENT)).toEqual({ channels: 0, threads: 1 });
    expect(await threadCount()).toBe(0);
  });
});

describe('the thread map behind the memory switch (TASK-1094)', () => {
  it('a conversation it never recorded is unknown; a recorded one reads back, keyed by the conversation alone', async () => {
    await connect();
    expect(await channels.getThread(CONV)).toBeNull();
    expect(await record(CONV)).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(supportThread());
    expect(await channels.getThread(OTHER_CONV)).toBeNull();
  });

  it("no binding, or another agent's: no-binding, and nothing is written", async () => {
    expect(await record(CONV)).toBe('no-binding');
    await connect({ agentId: OTHER_AGENT });
    expect(await record(CONV)).toBe('no-binding');
    expect(await threadCount()).toBe(0);
  });

  it('the switch is read in the same statement as the write: turned off after the caller read it, the thread is recorded not remembered', async () => {
    await connect();
    // The router read the binding with the switch on...
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(true);
    // ...an admin turned it off before the turn was recorded...
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);
    // ...so the turn runs while it is off, and the thread says so.
    expect(await record(CONV)).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
  });

  it('a binding removed or rebound between the read and the record: no-binding, and an earlier row is left as it was', async () => {
    await connect();
    await recordOff(CONV);
    expect(await channels.get(INSTALL, SUPPORT)).not.toBeNull();
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
    expect(await record(OTHER_CONV)).toBe('no-binding');
    expect(await record(CONV)).toBe('no-binding');

    expect(await connect({ agentId: OTHER_AGENT })).toBe('connected');
    expect(await record(OTHER_CONV)).toBe('no-binding');
    expect(await channels.getThread(OTHER_CONV)).toBeNull();
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
  });

  it('two turns recorded at once in one conversation, one with the switch off and one on, in either order: not remembered', async () => {
    // #support is on, #sales is off, both the support agent's: the two
    // statements read different switches, and race on one conversation.
    await connect();
    await connect({ channelId: SALES });
    expect(await channels.setRemember(INSTALL, SALES, AGENT, false)).toBe(true);
    for (let i = 0; i < 16; i += 1) {
      const conversationId = `conv_race_${i}`;
      const on = () => record(conversationId);
      const off = () => record(conversationId, { channelId: SALES });
      const outcomes = await Promise.all(i % 2 === 0 ? [off(), on()] : [on(), off()]);
      expect(outcomes).toEqual(['recorded', 'recorded']);
      expect((await channels.getThread(conversationId))?.notRemembered, conversationId).toBe(true);
    }
  });

  it('not remembered is sticky: once a turn ran while the switch was off, a later clean turn never clears it', async () => {
    await connect();
    await recordOff(CONV);
    expect(await record(CONV)).toBe('recorded');
    expect((await channels.getThread(CONV))?.notRemembered).toBe(true);

    // A clean thread is tainted by the first turn that runs while the switch is off.
    expect(await record(OTHER_CONV)).toBe('recorded');
    expect((await channels.getThread(OTHER_CONV))?.notRemembered).toBe(false);
    await recordOff(OTHER_CONV);
    expect(await record(OTHER_CONV)).toBe('recorded');
    expect((await channels.getThread(OTHER_CONV))?.notRemembered).toBe(true);
    expect(await threadCount()).toBe(2);
  });

  it("a conversation's thread is written once: a later record changes only the taint", async () => {
    await connect();
    await connect({ installId: OTHER_INSTALL, channelId: SALES, agentId: OTHER_AGENT });
    expect(await record(CONV)).toBe('recorded');
    await recordOff(CONV, { installId: OTHER_INSTALL, channelId: SALES, agentId: OTHER_AGENT });
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
  });

  it('removing an install keeps its thread rows, so a thread tainted while the switch was off stays refused after Slack is disconnected', async () => {
    for (const installId of [INSTALL, OTHER_INSTALL]) {
      await installs.insertPending({ installId, appId: 'A07QF9ZK2MN', clientId: '1.2', botName: 'canopy', connectedByUserId: ADA });
      await connect({ installId });
    }
    await recordOff(CONV);
    expect(await record(OTHER_CONV, { installId: OTHER_INSTALL })).toBe('recorded');
    expect(await vetoFor(CONV)).toEqual(REFUSED);
    expect(await vetoFor(OTHER_CONV)).toBeUndefined();

    // Admin › Slack › Disconnect: the install and its bindings go, its threads stay.
    await installs.remove(INSTALL);
    expect(await channels.get(INSTALL, SUPPORT)).toBeNull();
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
    expect(await vetoFor(CONV)).toEqual(REFUSED);

    // A reset removes every install the same way.
    expect((await installs.removeAll()).map((r) => r.installId)).toEqual([OTHER_INSTALL]);
    expect(await channels.listAll(OTHER_INSTALL)).toEqual([]);
    expect(await threadCount()).toBe(2);
    // A thread the channel had while it was remembered is refused too now: nothing is connected there.
    expect(await vetoFor(OTHER_CONV)).toEqual(REFUSED);
  });

  it('a disconnected channel keeps its threads; connected again, a remembered thread is remembered again and a tainted one never', async () => {
    await connect();
    expect(await record(CONV)).toBe('recorded');
    await recordOff(OTHER_CONV);

    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
    expect(await threadCount()).toBe(2);
    expect(await vetoFor(CONV)).toEqual(REFUSED);
    expect(await vetoFor(OTHER_CONV)).toEqual(REFUSED);

    expect(await connect()).toBe('connected');
    expect(await vetoFor(CONV)).toBeUndefined();
    expect(await vetoFor(OTHER_CONV)).toEqual(REFUSED);
  });

  it("an outsider's turn records its thread external, a member's records theirs attended, and neither ever flips", async () => {
    await connect();
    expect(await record(CONV, { mode: 'external' })).toBe('recorded');
    expect(await record(OTHER_CONV)).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(supportThread({ external: true }));
    expect(await channels.getThread(OTHER_CONV)).toEqual(supportThread());

    // A conversation's key fixes its mode; if one were ever recorded both ways, it stays external.
    expect(await record(CONV)).toBe('recorded');
    expect((await channels.getThread(CONV))?.external).toBe(true);
    expect(await record(OTHER_CONV, { mode: 'external' })).toBe('recorded');
    expect((await channels.getThread(OTHER_CONV))?.external).toBe(true);
  });

  it("an outsider's turn is recorded only while the person it runs as still connects the channel; a member's whoever connected it", async () => {
    await connect();
    expect(await record(CONV, { mode: 'external', runAs: ADA })).toBe('recorded');

    // Bob connects #support again between Ada's outsider turn starting and its record.
    expect(await connect({ connectedByUserId: BOB })).toBe('reconnected');
    expect(await record(OTHER_CONV, { mode: 'external', runAs: ADA })).toBe('reconnected');
    expect(await channels.getThread(OTHER_CONV)).toBeNull();
    // A thread Ada's turns were recorded in is left exactly as it was.
    expect(await record(CONV, { mode: 'external', runAs: ADA })).toBe('reconnected');
    expect(await channels.getThread(CONV)).toEqual(supportThread({ external: true }));
    expect(await threadCount()).toBe(1);

    // Run as Bob, it records; a member's turn doesn't depend on who connected.
    expect(await record(OTHER_CONV, { mode: 'external', runAs: BOB })).toBe('recorded');
    expect(await record('conv_member_thread')).toBe('recorded');
    expect(await threadCount()).toBe(3);

    // No binding at all is still no-binding, for an outsider's turn too.
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
    expect(await record('conv_after_disconnect', { mode: 'external', runAs: BOB })).toBe('no-binding');
    expect(await record('conv_after_disconnect')).toBe('no-binding');
    expect(await threadCount()).toBe(3);
  });

  it("the veto over the real store: an outsider's thread is refused with the switch on; a member's is remembered", async () => {
    await connect();
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(true);
    expect(await record(CONV, { mode: 'external' })).toBe('recorded');
    expect(await record(OTHER_CONV)).toBe('recorded');
    expect(await vetoFor(CONV)).toEqual(OUTSIDER_THREAD);
    expect(await vetoFor(OTHER_CONV)).toBeUndefined();
  });

  it('the switch, read at capture time: off refuses every thread of the channel, on again lets the clean ones through', async () => {
    await connect();
    expect(await record(CONV)).toBe('recorded');
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);
    expect(await vetoFor(CONV)).toEqual(REFUSED);
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, true)).toBe(true);
    expect(await vetoFor(CONV)).toBeUndefined();
  });
});
