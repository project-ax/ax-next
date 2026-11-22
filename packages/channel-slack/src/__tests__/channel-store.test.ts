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
  over; and remove acts only on the binding of the agent the caller named,
  so a route that checked rights on agent A can't touch agent B's.

  The thread map (TASK-1094) is what the capture veto stands on. Nothing
  marks a thread not remembered any more (TASK-1203: a private channel is
  remembered like any other), but a thread marked before (a turn while its
  channel was private, TASK-1188, or switched off, TASK-1202) stays marked
  for good, and its row outlives the binding and the install, so the
  capture veto (capture-veto.ts) keeps refusing it after Slack is
  disconnected. Only a deleted agent takes its rows away.
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

/** Whether a binding's stored notice claim is exactly `stamp` (a claimNotice answer), compared by the database at full precision. */
async function noticeStampIs(installId: string, channelId: string, stamp: string): Promise<boolean> {
  const r = await sql<{ same: boolean | null }>`
    SELECT notice_posted_at = ${stamp}::timestamptz AS same FROM channel_slack_v1_channels
     WHERE install_id = ${installId} AND channel_id = ${channelId}
  `.execute(db);
  return r.rows[0]?.same === true;
}

/** Pin a binding's age, so "oldest first" never hangs on the clock's resolution. */
async function setCreatedAt(installId: string, channelId: string, at: Date): Promise<void> {
  await sql`
    UPDATE channel_slack_v1_channels SET created_at = ${at}
     WHERE install_id = ${installId} AND channel_id = ${channelId}
  `.execute(db);
}

/** Every binding on an install, whichever agent, read straight from the table, by channel. */
async function bindingsOn(installId: string): Promise<Array<{ channelId: string; agentId: string }>> {
  const r = await sql<{ channel_id: string; agent_id: string }>`
    SELECT channel_id, agent_id FROM channel_slack_v1_channels
     WHERE install_id = ${installId} ORDER BY channel_id
  `.execute(db);
  return r.rows.map((row) => ({ channelId: row.channel_id, agentId: row.agent_id }));
}

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
 * agent, unless told otherwise. It says nothing about the channel's privacy:
 * nothing reads it (TASK-1203).
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

/**
 * A member's thread a turn marked not remembered before TASK-1203 (its
 * channel was private then, TASK-1188, or switched off, TASK-1202), in
 * #support of the support agent unless told otherwise, with Mel's names.
 * Nothing writes one any more, so it is written by SQL, as the database
 * holds one from then.
 */
async function markedThread(conversationId: string, o: Partial<ThreadIds> = {}): Promise<void> {
  await sql`
    INSERT INTO channel_slack_v1_threads
      (conversation_id, install_id, channel_id, agent_id, not_remembered, external, speaker_names)
    VALUES
      (${conversationId}, ${o.installId ?? INSTALL}, ${o.channelId ?? SUPPORT}, ${o.agentId ?? AGENT}, true, false,
       ${MEL}::text[])
  `.execute(db);
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
  it('a second run keeps every binding and thread, names included (idempotent)', async () => {
    await connect();
    await connect({ channelId: SALES });
    await markedThread(CONV);
    await record(OTHER_CONV, { mode: 'external' });
    const support = await channels.get(INSTALL, SUPPORT);
    const sales = await channels.get(INSTALL, SALES);
    await runMigrations(db);
    await runMigrations(db);
    expect(await channels.get(INSTALL, SUPPORT)).toEqual(support);
    expect(await channels.get(INSTALL, SALES)).toEqual(sales);
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
    expect(await channels.getThread(OTHER_CONV)).toEqual(outsiderThread());
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

  // TASK-1202 (design §4c): a team agent's memory is shared with its team, so
  // a channel can no longer be switched to "not remembered". The boot drops
  // the switch's table and the bindings' `remember` column. Every binding
  // stays, with the rest of its row, and every thread row stays as it was: one
  // a turn marked while its channel was switched off is still refused, since
  // memory's cursor already skipped its turns.
  it("drops the memory switch's table and the bindings' remember column: every binding keeps the rest of its row, every thread row is left as it was, and a second run changes nothing (TASK-1202)", async () => {
    // The schema as TASK-1188 left it: the bindings with `remember`, and the switches kept apart from them.
    await sql`DROP TABLE channel_slack_v1_channels`.execute(db);
    await sql`
      CREATE TABLE channel_slack_v1_channels (
        install_id           TEXT NOT NULL,
        channel_id           TEXT NOT NULL,
        agent_id             TEXT NOT NULL,
        connected_by_user_id TEXT NOT NULL,
        channel_name         TEXT NOT NULL,
        remember             BOOLEAN NOT NULL DEFAULT true,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        is_private           BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (install_id, channel_id)
      )
    `.execute(db);
    await sql`DROP TABLE IF EXISTS channel_slack_v1_memory_switches`.execute(db);
    await sql`
      CREATE TABLE channel_slack_v1_memory_switches (
        agent_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        remember   BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (agent_id, channel_id)
      )
    `.execute(db);
    // #support switched off; #sales on, and private; another agent's #general off, on another install.
    await sql`
      INSERT INTO channel_slack_v1_channels
        (install_id, channel_id, agent_id, connected_by_user_id, channel_name, remember, is_private, created_at, updated_at)
      VALUES
        (${INSTALL}, ${SUPPORT}, ${AGENT}, ${ADA}, 'support', false, false, '2026-11-13T09:00:00Z', '2026-11-14T09:00:00Z'),
        (${INSTALL}, ${SALES}, ${AGENT}, ${ADA}, 'sales', true, true, '2026-11-13T10:00:00Z', '2026-11-14T10:00:00Z'),
        (${OTHER_INSTALL}, ${GENERAL}, ${OTHER_AGENT}, ${BOB}, 'general', false, false, '2026-11-13T11:00:00Z', '2026-11-14T11:00:00Z')
    `.execute(db);
    // The switches kept for them, and one for a channel no longer connected.
    await sql`
      INSERT INTO channel_slack_v1_memory_switches (agent_id, channel_id, remember)
      VALUES (${AGENT}, ${SUPPORT}, false), (${AGENT}, ${SALES}, true), (${OTHER_AGENT}, ${GENERAL}, false),
             (${AGENT}, 'C07GONE0004', false)
    `.execute(db);
    // A member's thread a turn marked while #support was switched off, and an outsiders' thread.
    await sql`
      INSERT INTO channel_slack_v1_threads
        (conversation_id, install_id, channel_id, agent_id, not_remembered, external, speaker_names)
      VALUES
        (${CONV}, ${INSTALL}, ${SUPPORT}, ${AGENT}, true, false, ${MEL}::text[]),
        (${OTHER_CONV}, ${INSTALL}, ${SUPPORT}, ${AGENT}, false, true, '{}')
    `.execute(db);
    // Every column of every binding but the two that go (`remember`, and `is_private`: TASK-1203, below).
    const bindingsBefore = (
      await sql<Record<string, unknown>>`
        SELECT install_id, channel_id, agent_id, connected_by_user_id, channel_name, created_at, updated_at
          FROM channel_slack_v1_channels ORDER BY install_id, channel_id
      `.execute(db)
    ).rows;
    const allThreads = async () =>
      (await sql<Record<string, unknown>>`SELECT * FROM channel_slack_v1_threads ORDER BY conversation_id`.execute(db)).rows;
    const threadsBefore = await allThreads();
    expect(bindingsBefore).toHaveLength(3);
    expect(threadsBefore).toHaveLength(2);

    for (let run = 1; run <= 2; run += 1) {
      await runMigrations(db);
      const table = await sql<{ t: string | null }>`
        SELECT to_regclass('channel_slack_v1_memory_switches')::text AS t
      `.execute(db);
      expect(table.rows[0]?.t, `run ${run}`).toBeNull();
      const columns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'channel_slack_v1_channels'
      `.execute(db);
      expect(columns.rows.map((c) => c.column_name), `run ${run}`).not.toContain('remember');
      expect(columns.rows.map((c) => c.column_name), `run ${run}`).not.toContain('is_private');
      // Every column of every binding: only `remember` and `is_private` went, nothing else moved, and the
      // memory notice's column came in open (TASK-1203: never told, so told at the channel's next turn).
      const bindingsAfter = await sql`SELECT * FROM channel_slack_v1_channels ORDER BY install_id, channel_id`.execute(db);
      expect(bindingsAfter.rows, `run ${run}`).toEqual(bindingsBefore.map((b) => ({ ...b, notice_posted_at: null })));
      expect(await allThreads(), `run ${run}`).toEqual(threadsBefore);
    }

    // The store reads each binding as it was, with no switch in it.
    expect(await channels.get(INSTALL, SUPPORT)).toEqual({
      installId: INSTALL,
      channelId: SUPPORT,
      agentId: AGENT,
      connectedByUserId: ADA,
      channelName: 'support',
      createdAt: new Date('2026-11-13T09:00:00Z'),
    });
    // #support was switched off: a member's new thread there is recorded remembered now, and memory
    // learns from it, hearing who speaks.
    expect(await record('conv_support_after_the_switch')).toBe('recorded');
    expect(await channels.getThread('conv_support_after_the_switch')).toEqual(supportThread());
    expect(await vetoFor('conv_support_after_the_switch')).toEqual(remembered('conv_support_after_the_switch'));
    // The thread the switch marked stays out, and the outsiders' thread too.
    expect(await vetoFor(CONV)).toEqual(REFUSED);
    expect(await vetoFor(OTHER_CONV)).toEqual(OUTSIDER_THREAD);
  });

  // TASK-1203 (design §4c): a private channel is remembered like any other,
  // so nothing reads a binding's privacy, and the boot drops the bindings'
  // `is_private`. Every binding stays, with the rest of its row, and every
  // thread row stays as it was: one a turn marked while its channel was
  // private is still refused, since memory's cursor already skipped its turns.
  it("drops the bindings' is_private column: every binding keeps the rest of its row, every thread row (not_remembered included) is left as it was, and a second run changes nothing (TASK-1203)", async () => {
    // The bindings as TASK-1202 left them: `is_private` still on, `remember` gone.
    await sql`DROP TABLE channel_slack_v1_channels`.execute(db);
    await sql`
      CREATE TABLE channel_slack_v1_channels (
        install_id           TEXT NOT NULL,
        channel_id           TEXT NOT NULL,
        agent_id             TEXT NOT NULL,
        connected_by_user_id TEXT NOT NULL,
        channel_name         TEXT NOT NULL,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        is_private           BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (install_id, channel_id)
      )
    `.execute(db);
    // #support private; #sales public; another agent's #general, private, on another install.
    await sql`
      INSERT INTO channel_slack_v1_channels
        (install_id, channel_id, agent_id, connected_by_user_id, channel_name, is_private, created_at, updated_at)
      VALUES
        (${INSTALL}, ${SUPPORT}, ${AGENT}, ${ADA}, 'support', true, '2026-11-13T09:00:00Z', '2026-11-14T09:00:00Z'),
        (${INSTALL}, ${SALES}, ${AGENT}, ${ADA}, 'sales', false, '2026-11-13T10:00:00Z', '2026-11-14T10:00:00Z'),
        (${OTHER_INSTALL}, ${GENERAL}, ${OTHER_AGENT}, ${BOB}, 'general', true, '2026-11-13T11:00:00Z', '2026-11-14T11:00:00Z')
    `.execute(db);
    // A member's thread a turn marked while #support was private, a member's #sales thread, remembered, and an
    // outsiders' thread.
    await markedThread(CONV);
    await sql`
      INSERT INTO channel_slack_v1_threads
        (conversation_id, install_id, channel_id, agent_id, not_remembered, external, speaker_names)
      VALUES
        ('conv_sales_thread', ${INSTALL}, ${SALES}, ${AGENT}, false, false, ${MEL}::text[]),
        (${OTHER_CONV}, ${INSTALL}, ${SUPPORT}, ${AGENT}, false, true, '{}')
    `.execute(db);
    // Every column of every binding but `is_private`, and every column of every thread row.
    const bindingsBefore = (
      await sql<Record<string, unknown>>`
        SELECT install_id, channel_id, agent_id, connected_by_user_id, channel_name, created_at, updated_at
          FROM channel_slack_v1_channels ORDER BY install_id, channel_id
      `.execute(db)
    ).rows;
    const allThreads = async () =>
      (await sql<Record<string, unknown>>`SELECT * FROM channel_slack_v1_threads ORDER BY conversation_id`.execute(db)).rows;
    const threadsBefore = await allThreads();
    expect(bindingsBefore).toHaveLength(3);
    expect(threadsBefore).toHaveLength(3);
    expect(threadsBefore.map((t) => [t['conversation_id'], t['not_remembered']])).toEqual([
      ['conv_sales_thread', false],
      [CONV, true],
      [OTHER_CONV, false],
    ]);

    for (let run = 1; run <= 2; run += 1) {
      await runMigrations(db);
      const columns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'channel_slack_v1_channels'
      `.execute(db);
      expect(columns.rows.map((c) => c.column_name), `run ${run}`).not.toContain('is_private');
      // Only `is_private` went: every other column of every binding is as it was, and the memory notice's
      // column came in open (never told, so told at the channel's next turn).
      const bindingsAfter = await sql`SELECT * FROM channel_slack_v1_channels ORDER BY install_id, channel_id`.execute(db);
      expect(bindingsAfter.rows, `run ${run}`).toEqual(bindingsBefore.map((b) => ({ ...b, notice_posted_at: null })));
      // Every thread row as it was: the mark included.
      expect(await allThreads(), `run ${run}`).toEqual(threadsBefore);
    }

    // The store reads each binding with no privacy in it.
    expect(await channels.get(INSTALL, SUPPORT)).toEqual({
      installId: INSTALL,
      channelId: SUPPORT,
      agentId: AGENT,
      connectedByUserId: ADA,
      channelName: 'support',
      createdAt: new Date('2026-11-13T09:00:00Z'),
    });
    // #support was private: a member's new thread there is recorded remembered, and memory learns from it,
    // hearing who speaks.
    expect(await record('conv_support_after_1203')).toBe('recorded');
    expect(await channels.getThread('conv_support_after_1203')).toEqual(supportThread());
    expect(await vetoFor('conv_support_after_1203')).toEqual(remembered('conv_support_after_1203'));
    // The thread marked while #support was private stays out, and the outsiders' thread too.
    expect(await vetoFor(CONV)).toEqual(REFUSED);
    expect(await vetoFor(OTHER_CONV)).toEqual(OUTSIDER_THREAD);
    expect(await vetoFor('conv_sales_thread')).toEqual(remembered('conv_sales_thread'));
  });

  // TASK-1203 (design §4c): a channel bound before the memory notice existed
  // was never told, so its binding's notice arrives open and the channel
  // hears it at its next turn; a later boot never reopens one already claimed.
  it('a binding from before TASK-1203 has its notice open after the migration, and a second run keeps a claim', async () => {
    // The bindings as TASK-1202 left them: no notice column, `is_private` still on.
    await sql`DROP TABLE channel_slack_v1_channels`.execute(db);
    await sql`
      CREATE TABLE channel_slack_v1_channels (
        install_id           TEXT NOT NULL,
        channel_id           TEXT NOT NULL,
        agent_id             TEXT NOT NULL,
        connected_by_user_id TEXT NOT NULL,
        channel_name         TEXT NOT NULL,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        is_private           BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (install_id, channel_id)
      )
    `.execute(db);
    await sql`
      INSERT INTO channel_slack_v1_channels (install_id, channel_id, agent_id, connected_by_user_id, channel_name)
      VALUES (${INSTALL}, ${SUPPORT}, ${AGENT}, ${ADA}, 'support')
    `.execute(db);

    await runMigrations(db);
    // Nullable, no default: a binding made now is untold too, until its channel's first turn claims it.
    const column = await sql<{ data_type: string; is_nullable: string; column_default: string | null }>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'channel_slack_v1_channels' AND column_name = 'notice_posted_at'
    `.execute(db);
    expect(column.rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null }]);
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toEqual(expect.any(String));

    await runMigrations(db);
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toBeNull();
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

  // TASK-1186. The shared app no longer serves channels (design §4b.1), so
  // every boot deletes its bindings.
  it("deletes the shared install's channel bindings at boot; a bot's bindings, a binding with no install row and every thread stay; a second run changes nothing (TASK-1186)", async () => {
    /** An install id with no row in the installs table. */
    const NO_INSTALL = 'bm8taW5zdGFsbC1yb3dfMQ';
    await sql`
      INSERT INTO channel_slack_v1_installs (install_id, status, app_id, client_id, bot_name, connected_by_user_id, kind)
      VALUES (${INSTALL}, 'active', 'A07QF9ZK2MN', '7512345678901.7511111111111', 'canopy', ${ADA}, 'shared')
    `.execute(db);
    await sql`
      INSERT INTO channel_slack_v1_installs
        (install_id, status, app_id, client_id, bot_name, connected_by_user_id, kind, agent_id, requested_by_user_id)
      VALUES (${OTHER_INSTALL}, 'active', 'A07BOT00001', '7512345678901.7522222222222', 'support-helper', ${BOB}, 'bot',
              ${AGENT}, ${BOB})
    `.execute(db);
    // On the shared app: #support and #sales.
    expect(await connect()).toBe('connected');
    expect(await connect({ channelId: SALES })).toBe('connected');
    // The agent's own bot's binding, and one whose install row is gone.
    expect(await connect({ installId: OTHER_INSTALL, channelId: GENERAL, connectedByUserId: BOB })).toBe('connected');
    expect(await connect({ installId: NO_INSTALL, channelId: GENERAL, agentId: OTHER_AGENT })).toBe('connected');
    // A member's thread in #sales, remembered.
    expect(await record(CONV, { channelId: SALES })).toBe('recorded');
    expect(await vetoFor(CONV)).toEqual(remembered(CONV));
    const botBinding = await rawRow(OTHER_INSTALL, GENERAL);
    const noInstallBinding = await rawRow(NO_INSTALL, GENERAL);
    expect(botBinding).toBeDefined();
    expect(noInstallBinding).toBeDefined();

    for (let run = 1; run <= 2; run += 1) {
      await runMigrations(db);
      expect(await channels.get(INSTALL, SUPPORT), `run ${run}`).toBeNull();
      expect(await channels.get(INSTALL, SALES), `run ${run}`).toBeNull();
      expect(await rawRow(OTHER_INSTALL, GENERAL), `run ${run}`).toEqual(botBinding);
      expect(await rawRow(NO_INSTALL, GENERAL), `run ${run}`).toEqual(noInstallBinding);
      expect(await channels.getThread(CONV), `run ${run}`).toEqual(supportThread({ channelId: SALES }));
    }
    // With its binding gone, the veto refuses the thread.
    expect(await vetoFor(CONV)).toEqual(REFUSED);
  });
});

describe('upsert: one agent per channel', () => {
  it('a new channel is connected and reads back', async () => {
    expect(await channels.get(INSTALL, SUPPORT)).toBeNull();
    expect(await connect()).toBe('connected');

    const want: Omit<ChannelBinding, 'createdAt'> = {
      installId: INSTALL,
      channelId: SUPPORT,
      agentId: AGENT,
      connectedByUserId: ADA,
      channelName: 'support',
    };
    expect(await channels.get(INSTALL, SUPPORT)).toEqual({ ...want, createdAt: expect.any(Date) });
    // A binding is keyed by install AND channel.
    expect(await channels.get(OTHER_INSTALL, SUPPORT)).toBeNull();
    expect(await channels.get(INSTALL, SALES)).toBeNull();
  });

  it('the same agent again is a reconnect: the connector and name change, createdAt stays', async () => {
    await connect();
    const before = (await channels.get(INSTALL, SUPPORT))!;

    expect(await connect({ connectedByUserId: BOB, channelName: 'help-desk' })).toBe('reconnected');
    expect(await channels.get(INSTALL, SUPPORT)).toEqual({
      ...before,
      connectedByUserId: BOB,
      channelName: 'help-desk',
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

describe('remove acts only on the named agent', () => {
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
    expect(await bindingsOn(INSTALL)).toEqual([
      { channelId: GENERAL, agentId: OTHER_AGENT },
      { channelId: SALES, agentId: AGENT },
    ]);
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(false);
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
        createdAt: OLDER,
      },
      {
        installId: INSTALL,
        channelId: SALES,
        agentId: AGENT,
        connectedByUserId: ADA,
        channelName: 'sales',
        createdAt: NEWER,
      },
    ];
    expect(await channels.listForAgent(INSTALL, AGENT)).toEqual(want);
    expect(await channels.listForAgent(INSTALL, 'agt_nobody')).toEqual([]);
    expect(await channels.listForAgent(OTHER_INSTALL, OTHER_AGENT)).toEqual([]);
  });
});

describe('removeForAgent', () => {
  it("removes the agent's bindings and thread rows on every install, counts each; other agents keep theirs", async () => {
    await connect({ channelId: SUPPORT });
    await connect({ channelId: SALES });
    await connect({ installId: OTHER_INSTALL, channelId: SUPPORT });
    await connect({ channelId: GENERAL, agentId: OTHER_AGENT });
    expect(await record(CONV)).toBe('recorded');
    await markedThread(OTHER_CONV, { installId: OTHER_INSTALL });
    expect(await record('conv_general_thread', { channelId: GENERAL, agentId: OTHER_AGENT })).toBe('recorded');

    expect(await channels.removeForAgent(AGENT)).toEqual({ channels: 3, threads: 2 });
    expect(await bindingsOn(INSTALL)).toEqual([{ channelId: GENERAL, agentId: OTHER_AGENT }]);
    expect(await bindingsOn(OTHER_INSTALL)).toEqual([]);
    expect(await channels.getThread(CONV)).toBeNull();
    expect(await channels.getThread(OTHER_CONV)).toBeNull();
    expect(await channels.getThread('conv_general_thread')).toEqual(supportThread({ channelId: GENERAL, agentId: OTHER_AGENT }));
    // Nothing left: safe to run again, and an agent with no channels is not an error.
    expect(await channels.removeForAgent(AGENT)).toEqual({ channels: 0, threads: 0 });
    expect(await channels.removeForAgent('agt_never_bound')).toEqual({ channels: 0, threads: 0 });
  });

  it('an agent whose channels were already disconnected still has its thread rows removed', async () => {
    await connect();
    await markedThread(CONV);
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);

    expect(await channels.removeForAgent(AGENT)).toEqual({ channels: 0, threads: 1 });
    expect(await threadCount()).toBe(0);
  });
});

describe('the thread map (TASK-1094)', () => {
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

  it('a binding removed or rebound between the read and the record: no-binding, and an earlier row is left as it was', async () => {
    await connect();
    await markedThread(CONV);
    expect(await channels.get(INSTALL, SUPPORT)).not.toBeNull();
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
    expect(await record(OTHER_CONV)).toBe('no-binding');
    expect(await record(CONV)).toBe('no-binding');

    expect(await connect({ agentId: OTHER_AGENT })).toBe('connected');
    expect(await record(OTHER_CONV)).toBe('no-binding');
    expect(await channels.getThread(OTHER_CONV)).toBeNull();
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: true }));
  });

  it("a conversation's thread is written once: a later record never moves it to another install, channel or agent", async () => {
    await connect();
    await connect({ installId: OTHER_INSTALL, channelId: SALES, agentId: OTHER_AGENT });
    expect(await record(CONV)).toBe('recorded');
    expect(await record(CONV, { installId: OTHER_INSTALL, channelId: SALES, agentId: OTHER_AGENT })).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(supportThread());
  });

  it('removing an install keeps its thread rows, so a thread marked before TASK-1203 stays refused after Slack is disconnected', async () => {
    for (const installId of [INSTALL, OTHER_INSTALL]) {
      await installs.insertPending({ installId, appId: 'A07QF9ZK2MN', clientId: '1.2', botName: 'canopy', connectedByUserId: ADA });
      await connect({ installId });
    }
    await markedThread(CONV);
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
    expect(await bindingsOn(OTHER_INSTALL)).toEqual([]);
    expect(await threadCount()).toBe(2);
    // A thread the channel had while it was remembered is refused too now: nothing is connected there.
    expect(await vetoFor(OTHER_CONV)).toEqual(REFUSED);
  });

  it('a disconnected channel keeps its threads; connected again, a remembered thread is remembered again and a marked one never', async () => {
    await connect();
    expect(await record(CONV)).toBe('recorded');
    await markedThread(OTHER_CONV);

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

  it("the veto over the real store: an outsider's thread is refused; a member's in a public channel is remembered", async () => {
    await connect();
    expect(await record(CONV, { mode: 'external' })).toBe('recorded');
    expect(await record(OTHER_CONV)).toBe('recorded');
    expect(await channels.getThread(OTHER_CONV)).toEqual(supportThread());
    expect(await vetoFor(CONV)).toEqual(OUTSIDER_THREAD);
    expect(await vetoFor(OTHER_CONV)).toEqual(remembered(OTHER_CONV));
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

// ── A private channel is remembered like any other (TASK-1203) ──────────────

/*
  TASK-1203 (design §4c): a team agent's memory is shared with its team, so
  a private channel's threads are remembered like any channel's. Nothing
  marks a thread not remembered any more, and nothing reads a binding's
  privacy. A thread marked before this card (a turn while its channel was
  private, TASK-1188, or switched off, TASK-1202) stays marked and refused:
  memory leaves its cursor where a refusal stopped it, so un-marking one
  would let its next pass read the turns said under the old promise.
*/
describe('a private channel is remembered like any other (TASK-1203)', () => {
  it('a new thread is recorded remembered (TASK-1203)', async () => {
    await connect();
    expect(await record(CONV)).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(supportThread({ notRemembered: false }));
    expect(await vetoFor(CONV)).toEqual(remembered(CONV));
    // An outsiders' thread is recorded unmarked too: its own flag keeps memory out (capture-veto.ts).
    expect(await record(OTHER_CONV, { mode: 'external' })).toBe('recorded');
    expect(await channels.getThread(OTHER_CONV)).toEqual(outsiderThread({ notRemembered: false }));
    expect(await vetoFor(OTHER_CONV)).toEqual(OUTSIDER_THREAD);
  });

  it('a thread marked before TASK-1203 stays marked when a new turn records it', async () => {
    await connect();
    await markedThread(CONV);
    // Mel's next turn there, under a new name: the record adds it, and never clears the mark.
    expect(await record(CONV, { speakerNames: ['Mel B', 'U07MEL00001'] })).toBe('recorded');
    expect(await channels.getThread(CONV)).toEqual(
      supportThread({ notRemembered: true, speakerNames: ['Mel', 'Mel B', 'U07MEL00001'] }),
    );
    expect(await vetoFor(CONV)).toEqual(REFUSED);
    // A new thread in the same channel is remembered.
    expect(await record(OTHER_CONV)).toBe('recorded');
    expect(await vetoFor(OTHER_CONV)).toEqual(remembered(OTHER_CONV));
  });
});

// ── A channel's memory notice, claimed once per binding (TASK-1203) ─────────

/*
  TASK-1203 (design §4c): a team bot tells each channel, once, that what it
  hears is shared with its team. The notice goes with a channel's first turn
  (router.ts), and a turn on any replica may be that first one, so the
  binding records it: claimed before the post, in one conditional UPDATE, so
  of any number of claims exactly one wins and only its replica posts. A post
  Slack refuses releases the claim (only that claim: by the stamp it
  answered), and the next turn tries again. A reconnect
  keeps the claim; a binding removed and made again is a new binding, told
  again.
*/
describe("a channel's memory notice: claimed once per binding (TASK-1203)", () => {
  it("claims a binding's notice once: the first claim wins, later ones don't (TASK-1203)", async () => {
    await connect();
    const before = await rawRow(INSTALL, SUPPORT);
    // Not told yet.
    expect(before?.['notice_posted_at']).toBeNull();

    const won = await channels.claimNotice(INSTALL, SUPPORT, AGENT);
    expect(won).toEqual(expect.any(String));
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toBeNull();
    // The claim stamps the notice and changes nothing else in the binding; the stamp it answers is the stored one, exactly.
    const after = await rawRow(INSTALL, SUPPORT);
    expect(after?.['notice_posted_at']).toBeInstanceOf(Date);
    expect(await noticeStampIs(INSTALL, SUPPORT, won!)).toBe(true);
    expect({ ...after, notice_posted_at: null }).toEqual(before);
  });

  it('two replicas claiming one binding at once: exactly one wins', async () => {
    await connect();
    // A second replica: its own pool and store, against the same database.
    const otherDb = new Kysely<ChannelSlackDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 }) }),
    });
    try {
      const replicas = [channels, createChannelStore(otherDb)];
      const won = await Promise.all(
        Array.from({ length: 8 }, (_, i) => replicas[i % 2]!.claimNotice(INSTALL, SUPPORT, AGENT)),
      );
      expect(won.filter((w) => w !== null)).toHaveLength(1);
    } finally {
      await otherDb.destroy();
    }
  });

  it('a reconnect keeps the claim; a binding removed and bound again claims again', async () => {
    await connect();
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toEqual(expect.any(String));
    // The same agent's bot binding it again, with a new connector and a renamed channel: still told.
    expect(await connect({ connectedByUserId: BOB, channelName: 'help-desk' })).toBe('reconnected');
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toBeNull();
    // Disconnected, then bound again: a new binding, so the channel is told again.
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
    expect(await connect()).toBe('connected');
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toEqual(expect.any(String));
  });

  it("release reopens the claim, and only for the binding's own install, channel and agent", async () => {
    await connect();
    const stamp = await channels.claimNotice(INSTALL, SUPPORT, AGENT);
    expect(stamp).toEqual(expect.any(String));
    // Another agent, install or channel releases nothing.
    await channels.releaseNotice(INSTALL, SUPPORT, OTHER_AGENT, stamp!);
    await channels.releaseNotice(OTHER_INSTALL, SUPPORT, AGENT, stamp!);
    await channels.releaseNotice(INSTALL, SALES, AGENT, stamp!);
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toBeNull();
    // The binding's own, by the stamp its claim answered: the next turn claims it again.
    await channels.releaseNotice(INSTALL, SUPPORT, AGENT, stamp!);
    expect((await rawRow(INSTALL, SUPPORT))?.['notice_posted_at']).toBeNull();
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toEqual(expect.any(String));
  });

  it("a release gives back only its own claim: a binding removed and made again keeps the new binding's claim (review F7)", async () => {
    // Turn 1 claims, and its post is slow to fail...
    await connect();
    const old = await channels.claimNotice(INSTALL, SUPPORT, AGENT);
    expect(old).toEqual(expect.any(String));
    // ...meanwhile an admin disconnects, the bot binds the channel again, and the new binding's first turn claims.
    expect(await channels.remove(INSTALL, SUPPORT, AGENT)).toBe(true);
    expect(await connect()).toBe('connected');
    const fresh = await channels.claimNotice(INSTALL, SUPPORT, AGENT);
    expect(fresh).toEqual(expect.any(String));
    expect(fresh).not.toBe(old);
    // Turn 1's post fails, and it releases with its own (old) stamp: the new claim stays.
    await channels.releaseNotice(INSTALL, SUPPORT, AGENT, old!);
    expect(await noticeStampIs(INSTALL, SUPPORT, fresh!)).toBe(true);
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toBeNull();
    // The new claim's own release still works, at whatever precision the database keeps.
    await channels.releaseNotice(INSTALL, SUPPORT, AGENT, fresh!);
    expect((await rawRow(INSTALL, SUPPORT))?.['notice_posted_at']).toBeNull();
  });

  it("another agent's binding, or no binding, claims nothing", async () => {
    await connect();
    expect(await channels.claimNotice(INSTALL, SUPPORT, OTHER_AGENT)).toBeNull();
    expect(await channels.claimNotice(OTHER_INSTALL, SUPPORT, AGENT)).toBeNull();
    expect(await channels.claimNotice(INSTALL, SALES, AGENT)).toBeNull();
    // None of them touched the binding: its own agent's first claim still wins.
    expect(await channels.claimNotice(INSTALL, SUPPORT, AGENT)).toEqual(expect.any(String));
  });
});
