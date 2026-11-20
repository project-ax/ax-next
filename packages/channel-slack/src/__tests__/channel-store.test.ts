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
  await sql`
    TRUNCATE channel_slack_v1_channels, channel_slack_v1_threads, channel_slack_v1_installs,
      channel_slack_v1_memory_switches
  `.execute(db);
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

/**
 * The names Mel's label shows, as the router hands them over with a member's
 * turn (format.ts `senderLabelNames`): her display name, then her Slack id.
 */
const MEL = ['Mel', 'U07MEL00001'];

/**
 * A member's #support thread of the support agent, remembered, its turns
 * Mel's, unless told otherwise.
 */
const supportThread = (o: Partial<ChannelThread> = {}): ChannelThread => ({
  installId: INSTALL,
  channelId: SUPPORT,
  agentId: AGENT,
  notRemembered: false,
  external: false,
  speakerNames: MEL,
  ...o,
});

/** The thread outsiders' turns run in: no names, ever (memory never learns from it). */
const outsiderThread = (o: Partial<ChannelThread> = {}): ChannelThread =>
  supportThread({ external: true, speakerNames: [], ...o });

type ThreadIds = Omit<ChannelThread, 'notRemembered' | 'external' | 'speakerNames'>;
/**
 * Whose turn: a member's (the default), labelled with `speakerNames` (Mel's
 * by default), or an outsider's, run as `runAs` (Ada, who connects #support,
 * by default).
 */
type Turn = { mode?: 'attended' | 'external'; runAs?: string; speakerNames?: readonly string[] };

/**
 * A turn starting in `conversationId`: a member's, in #support of the support
 * agent, unless told otherwise; the switch as it is.
 */
function record(conversationId: string, o: Partial<ThreadIds> & Turn = {}): ReturnType<ChannelStore['recordThread']> {
  const { mode, runAs, speakerNames, ...ids } = o;
  return channels.recordThread({
    installId: INSTALL,
    channelId: SUPPORT,
    agentId: AGENT,
    ...ids,
    conversationId,
    ...(mode === 'external'
      ? { mode, runAs: runAs ?? ADA }
      : { mode: 'attended' as const, speakerNames: speakerNames ?? MEL }),
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
/** Memory may learn from the conversation, and hears who is speaking in it (TASK-1146). */
const remembered = (conversationId: string, speakerNames: readonly string[] = MEL) => ({ conversationId, speakerNames });

async function threadCount(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM channel_slack_v1_threads`.execute(db);
  return r.rows[0]!.n;
}

describe('runMigrations', () => {
  it('a second run keeps every binding and thread, names included (additive and idempotent)', async () => {
    await connect();
    await recordOff(CONV);
    await record(OTHER_CONV, { mode: 'external' });
    // A switch kept for a channel that is no longer connected (TASK-1180): no binding to fill it from again.
    await connect({ channelId: SALES });
    expect(await channels.setRemember(INSTALL, SALES, AGENT, false)).toBe(true);
    expect(await channels.remove(INSTALL, SALES, AGENT)).toBe(true);
    await runMigrations(db);
    await runMigrations(db);
    expect((await channels.get(INSTALL, SUPPORT))?.agentId).toBe(AGENT);
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
    expect(await channels.getThread(OTHER_CONV)).toEqual(outsiderThread());
    expect(await channels.keptRemember(AGENT, SALES)).toBe(false);
  });

  it('adds speaker_names to a thread table made before it, every old row with none until its next member turn (TASK-1146)', async () => {
    // The table as TASK-1094 left it, `external` added on, with one member's row.
    await sql`DROP TABLE channel_slack_v1_threads`.execute(db);
    await sql`
      CREATE TABLE channel_slack_v1_threads (
        conversation_id TEXT PRIMARY KEY,
        install_id      TEXT NOT NULL,
        channel_id      TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        not_remembered  BOOLEAN NOT NULL DEFAULT false,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        external        BOOLEAN NOT NULL DEFAULT true
      )
    `.execute(db);
    await sql`
      INSERT INTO channel_slack_v1_threads (conversation_id, install_id, channel_id, agent_id, external)
      VALUES (${CONV}, ${INSTALL}, ${SUPPORT}, ${AGENT}, false)
    `.execute(db);

    await runMigrations(db);
    await runMigrations(db);

    expect(await channels.getThread(CONV)).toEqual(supportThread({ speakerNames: [] }));
    await connect();
    // No names to hand over: memory hears no opinion, as before TASK-1146.
    expect(await vetoFor(CONV)).toBeUndefined();
    // The member's next turn adds theirs.
    expect(await record(CONV)).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(supportThread());
    expect(await vetoFor(CONV)).toEqual(remembered(CONV));
  });

  it("adds `external` to a thread table made before it, every row an outsider's: fail closed (none exist in production)", async () => {
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

    // Nothing in the row says who spoke, so the veto treats it as outsiders' and refuses memory.
    expect(await channels.getThread(CONV)).toEqual(outsiderThread({ notRemembered: true }));
    await connect();
    expect(await record(OTHER_CONV, { mode: 'external' })).toBe('recorded');
    expect(await channels.getThread(OTHER_CONV)).toEqual(outsiderThread());
  });

  it("a thread row written without `external` is an outsider's: the column fails closed", async () => {
    await sql`
      INSERT INTO channel_slack_v1_threads (conversation_id, install_id, channel_id, agent_id)
      VALUES (${CONV}, ${INSTALL}, ${SUPPORT}, ${AGENT})
    `.execute(db);
    expect(await channels.getThread(CONV)).toEqual(outsiderThread());
    // recordThread names it every time, so a member's thread is still a member's.
    await connect();
    expect(await record(OTHER_CONV)).toBe('recorded');
    expect(await channels.getThread(OTHER_CONV)).toEqual(supportThread());
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

  // TASK-1179: a team agent's own bot binds a channel with the switch the team
  // already chose for it, in the same statement, so no turn ever reads it on.
  it('a new binding written with remember off reads back off', async () => {
    expect(await connect({ remember: false })).toBe('connected');
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(false);
  });

  it("a reconnect keeps the stored switch, whatever remember it's handed", async () => {
    await connect({ remember: false });
    expect(await connect({ connectedByUserId: BOB, remember: true })).toBe('reconnected');
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(false);
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

/*
  TASK-1180. The agent's memory switch for a channel is kept apart from its
  bindings, so a Disconnect (of the channel, of Slack in Admin › Slack, or a
  removed bot) never loses the team's OFF before the agent's own bot first
  answers there (router.ts reads it). setRemember writes it in the statement
  that flips the bindings, and flips every binding of that agent in that
  channel, on any install: a bot channel switched off stays off on the shared
  binding too, which the shared bot answers with again once the bot is gone.
*/
describe('the switch kept for the agent and channel (TASK-1180)', () => {
  /** A third install with a binding of #support, another agent's. */
  const THIRD_INSTALL = 'Y2hhbm5lbC1zbGFjay0wMw';

  it('setRemember keeps the switch apart from the binding: a Disconnect keeps it, keptRemember reads it', async () => {
    await connect();
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
    expect(await channels.get(INSTALL, SUPPORT)).toBeNull();
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBe(false);

    // Connected again: a connect keeps nothing (the live binding is read before the kept switch).
    expect(await connect()).toBe('connected');
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBe(false);
    // Flipped again, on: the switch kept is the one last set.
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, true)).toBe(true);
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBe(true);
  });

  it("keptRemember is null where nothing was set; another agent's switch is that agent's", async () => {
    expect(await channels.keptRemember(AGENT, SALES)).toBeNull();
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT });
    expect(await channels.setRemember(INSTALL, GENERAL, OTHER_AGENT, false)).toBe(true);
    expect(await channels.keptRemember(AGENT, GENERAL)).toBeNull();
    expect(await channels.keptRemember(OTHER_AGENT, GENERAL)).toBe(false);
  });

  it("a flip on one binding flips every binding of the same agent in the channel, on any install, and no other agent's or channel's", async () => {
    await connect();
    await connect({ installId: OTHER_INSTALL });
    await connect({ channelId: SALES });
    await connect({ installId: THIRD_INSTALL, agentId: OTHER_AGENT });

    expect(await channels.setRemember(OTHER_INSTALL, SUPPORT, AGENT, false)).toBe(true);
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(false);
    expect((await channels.get(OTHER_INSTALL, SUPPORT))?.remember).toBe(false);
    expect((await channels.get(INSTALL, SALES))?.remember).toBe(true);
    expect((await channels.get(THIRD_INSTALL, SUPPORT))?.remember).toBe(true);
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBe(false);
    expect(await channels.keptRemember(AGENT, SALES)).toBeNull();
    expect(await channels.keptRemember(OTHER_AGENT, SUPPORT)).toBeNull();

    // Back on, from the other binding: both of the agent's, and the kept switch.
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, true)).toBe(true);
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(true);
    expect((await channels.get(OTHER_INSTALL, SUPPORT))?.remember).toBe(true);
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBe(true);
  });

  it("a flip named on a binding that isn't the agent's writes nothing: no row moves and nothing is kept", async () => {
    await connect();
    const before = await rawRow(INSTALL, SUPPORT);

    // No binding on the install named, though the agent has one on another.
    expect(await channels.setRemember(OTHER_INSTALL, SUPPORT, AGENT, false)).toBe(false);
    // The install's binding of the channel is another agent's.
    expect(await channels.setRemember(INSTALL, SUPPORT, OTHER_AGENT, false)).toBe(false);

    expect(await rawRow(INSTALL, SUPPORT)).toEqual(before);
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBeNull();
    expect(await channels.keptRemember(OTHER_AGENT, SUPPORT)).toBeNull();
  });

  it("the kept switch outlives its install's removal (Admin › Slack's Disconnect, a bot's removal)", async () => {
    // The install row first, so its removal takes the row and its bindings in one statement (store.ts).
    await installs.insertPending({ installId: INSTALL, appId: 'A07QF9ZK2MN', clientId: '1.2', botName: 'canopy', connectedByUserId: ADA });
    await connect();
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);

    await installs.remove(INSTALL);
    expect(await channels.get(INSTALL, SUPPORT)).toBeNull();
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBe(false);
  });

  it("removeForAgent takes the agent's kept switches with its bindings and threads, and no other agent's", async () => {
    await connect();
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT });
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);
    expect(await channels.setRemember(INSTALL, GENERAL, OTHER_AGENT, false)).toBe(true);
    // Disconnected before the agent is deleted: its switch is still kept, and still goes with it.
    await connect({ channelId: SALES });
    expect(await channels.setRemember(INSTALL, SALES, AGENT, false)).toBe(true);
    expect(await channels.remove(INSTALL, SALES, AGENT)).toBe(true);

    // The answer counts bindings and threads, as before.
    expect(await channels.removeForAgent(AGENT)).toEqual({ channels: 1, threads: 0 });
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBeNull();
    expect(await channels.keptRemember(AGENT, SALES)).toBeNull();
    expect(await channels.keptRemember(OTHER_AGENT, GENERAL)).toBe(false);
  });

  it("runMigrations keeps a switch for every binding written before the table: off if any of the agent's bindings of the channel is, never over one already kept, and a second run changes nothing", async () => {
    // Bindings as phase 1 wrote them, before the table: their switches only on the bindings.
    await connect();
    await connect({ installId: OTHER_INSTALL });
    await sql`UPDATE channel_slack_v1_channels SET remember = false WHERE install_id = ${OTHER_INSTALL}`.execute(db);
    await connect({ channelId: SALES });
    // One already kept, off, while its binding is on (a fresh connect after a switch-off and a Disconnect).
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT });
    await sql`
      INSERT INTO channel_slack_v1_memory_switches (agent_id, channel_id, remember)
      VALUES (${OTHER_AGENT}, ${GENERAL}, false)
    `.execute(db);
    expect(await channels.keptRemember(AGENT, SUPPORT)).toBeNull();
    expect(await channels.keptRemember(AGENT, SALES)).toBeNull();

    for (let run = 1; run <= 2; run += 1) {
      await runMigrations(db);
      expect(await channels.keptRemember(AGENT, SUPPORT), `run ${run}`).toBe(false);
      expect(await channels.keptRemember(AGENT, SALES), `run ${run}`).toBe(true);
      expect(await channels.keptRemember(OTHER_AGENT, GENERAL), `run ${run}`).toBe(false);
    }
    // The bindings themselves are untouched.
    expect((await channels.get(INSTALL, SUPPORT))?.remember).toBe(true);
    expect((await channels.get(INSTALL, GENERAL))?.remember).toBe(true);
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

  it("a conversation's thread is written once: a later record never moves it to another install, channel or agent", async () => {
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
    expect(await vetoFor(OTHER_CONV)).toEqual(remembered(OTHER_CONV));

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
    expect(await vetoFor(CONV)).toEqual(remembered(CONV));
    expect(await vetoFor(OTHER_CONV)).toEqual(REFUSED);
  });

  it("an outsider's turn records its thread external, a member's records theirs attended, and neither ever flips", async () => {
    await connect();
    expect(await record(CONV, { mode: 'external' })).toBe('recorded');
    expect(await record(OTHER_CONV)).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(outsiderThread());
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
    expect(await channels.getThread(CONV)).toEqual(outsiderThread());
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
    expect(await vetoFor(OTHER_CONV)).toEqual(remembered(OTHER_CONV));
  });

  it('the switch, read at capture time: off refuses every thread of the channel, on again lets the clean ones through', async () => {
    await connect();
    expect(await record(CONV)).toBe('recorded');
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, false)).toBe(true);
    expect(await vetoFor(CONV)).toEqual(REFUSED);
    expect(await channels.setRemember(INSTALL, SUPPORT, AGENT, true)).toBe(true);
    expect(await vetoFor(CONV)).toEqual(remembered(CONV));
  });
});

describe("the speakers' names on a member's thread (TASK-1146)", () => {
  /*
    Memory must not file a statement made in a channel under the name of the
    person who made it. The names are the ones the member's sender label
    showed (format.ts `senderLabelNames`), recorded in the same statement as
    the thread, before the turn runs, and handed to memory by the veto. The
    idle observer can run long after the turn, over turns from before a
    rename, so the row keeps the union.
  */

  it('a member turn records its label names, and getThread returns them exactly as written', async () => {
    await connect();
    // Slack's text as the label showed it: quotes, a backslash, braces and a comma survive the array round trip.
    const names = ['Mel "the {boss}", \\o/', 'U07MEL00001'];
    expect(await record(CONV, { speakerNames: names })).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(supportThread({ speakerNames: names }));
    // A turn whose names repeat stores each once.
    expect(await record(OTHER_CONV, { speakerNames: ['U07MEL00001', 'U07MEL00001'] })).toBe('recorded');
    expect((await channels.getThread(OTHER_CONV))?.speakerNames).toEqual(['U07MEL00001']);
  });

  it('a second turn adds nothing it already has, and a rename adds the new name: both stay', async () => {
    await connect();
    expect(await record(CONV, { speakerNames: ['Mel', 'U1'] })).toBe('recorded');
    expect(await record(CONV, { speakerNames: ['Mel', 'U1'] })).toBe('recorded');
    expect((await channels.getThread(CONV))?.speakerNames).toEqual(['Mel', 'U1']);
    expect(await record(CONV, { speakerNames: ['Mel B', 'U1'] })).toBe('recorded');
    // Oldest first, by when each was last seen: `U1` came after `Mel B`.
    expect((await channels.getThread(CONV))?.speakerNames).toEqual(['Mel', 'Mel B', 'U1']);
  });

  it('keeps the 16 most recently seen names', async () => {
    await connect();
    for (let i = 0; i <= 16; i += 1) {
      expect(await record(CONV, { speakerNames: [`n${i}`, 'U1'] })).toBe('recorded');
    }
    // `n0` and `n1` were seen longest ago; the id, seen in every turn, stays.
    expect((await channels.getThread(CONV))?.speakerNames).toEqual([
      'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11', 'n12', 'n13', 'n14', 'n15', 'n16', 'U1',
    ]);
    // One turn with more than 16 names keeps its last 16 too.
    const many = Array.from({ length: 17 }, (_, i) => `m${i}`);
    expect(await record(OTHER_CONV, { speakerNames: many })).toBe('recorded');
    expect((await channels.getThread(OTHER_CONV))?.speakerNames).toEqual(many.slice(1));
  });

  it("an outsider's turn records no names, even when a caller hands it some", async () => {
    await connect();
    expect(await record(CONV, { mode: 'external' })).toBe('recorded');
    expect((await channels.getThread(CONV))?.speakerNames).toEqual([]);
    // The store's own rule, not just the type's: names on an outsider's turn are not stored.
    const outsider = {
      installId: INSTALL,
      channelId: SUPPORT,
      agentId: AGENT,
      conversationId: OTHER_CONV,
      mode: 'external',
      runAs: ADA,
      speakerNames: ['Bob Jones', 'U07BOBBY001'],
    } as unknown as Parameters<ChannelStore['recordThread']>[0];
    expect(await channels.recordThread(outsider)).toBe('recorded');
    expect((await channels.getThread(OTHER_CONV))?.speakerNames).toEqual([]);
  });

  it("two members' threads keep their own names, and memory hears each conversation's own", async () => {
    await connect();
    const team = ['Standup Team', 'U07TEAM0001'];
    expect(await record(CONV)).toBe('recorded');
    expect(await record(OTHER_CONV, { speakerNames: team })).toBe('recorded');
    expect((await channels.getThread(CONV))?.speakerNames).toEqual(MEL);
    expect((await channels.getThread(OTHER_CONV))?.speakerNames).toEqual(team);
    // A display name of work words ("Standup Team") drops facts only in its own member's conversation.
    expect(await vetoFor(CONV)).toEqual(remembered(CONV));
    expect(await vetoFor(OTHER_CONV)).toEqual(remembered(OTHER_CONV, team));
  });

  it("two member turns starting at once in one conversation keep both turns' names", async () => {
    await connect();
    for (let i = 0; i < 8; i += 1) {
      const conversationId = `conv_names_race_${i}`;
      const before = () => record(conversationId, { speakerNames: ['Mel', 'U1'] });
      const renamed = () => record(conversationId, { speakerNames: ['Mel B', 'U1'] });
      expect(await Promise.all(i % 2 === 0 ? [before(), renamed()] : [renamed(), before()])).toEqual(['recorded', 'recorded']);
      const names = (await channels.getThread(conversationId))?.speakerNames ?? [];
      expect([...names].sort(), conversationId).toEqual(['Mel', 'Mel B', 'U1']);
    }
  });
});
