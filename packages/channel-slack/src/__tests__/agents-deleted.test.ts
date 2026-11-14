import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENTS_DELETED_KEY, subscribeAgentsDeleted } from '../agents-deleted.js';
import { createChannelStore, type ChannelStore } from '../channel-store.js';
import { runMigrations, type ChannelSlackDatabase } from '../migrations.js';

/*
  `@ax/agents` fires `agents:deleted { agentId, ownerId, ownerType }` AFTER the
  agent row is gone, each subscriber bounded at 150 s
  (AGENTS_DELETED_SUBSCRIBER_TIMEOUT_MS). A channel binding has no foreign key
  to the agents table (no plugin references another's rows), so this
  subscriber is the only thing that removes a deleted agent's channels.
  Without it each channel stays "taken" by an agent that no longer exists, and
  a connect refuses it until someone runs `/ax disconnect` there.

  It removes the agent's thread rows too (TASK-1094, the memory switch's
  map), in the same transaction as its bindings: nothing else ever deletes
  them, because they must outlive a disconnect.

  A real bus and a real Postgres. The store's own contract is
  channel-store.test.ts.
*/

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<ChannelSlackDatabase>;
let channels: ChannelStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = new Kysely<ChannelSlackDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(db);
  channels = createChannelStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE channel_slack_v1_channels, channel_slack_v1_threads`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

const INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const OTHER_INSTALL = 'Zm9vYmFyYmF6cXV4cXV1eA';
const SUPPORT = 'C07SUPPORT1';
const SALES = 'C07SALES002';
const GENERAL = 'C07GENERAL3';
const AGENT = 'agt_support';
const OTHER_AGENT = 'agt_sales';

/** The real fire bounds each subscriber like this (@ax/agents' AGENTS_DELETED_SUBSCRIBER_TIMEOUT_MS). */
const SUBSCRIBER_TIMEOUT_MS = 150_000;

/** Text a failing delete's message carries, which no log line may repeat. */
const FAILURE_CANARY = 'failure-text-canary-4f2a';

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function captureLogger(o: { throwOn?: LogLine['level'] } = {}): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const rec =
    (level: LogLine['level']) =>
    (msg: string, bindings?: Record<string, unknown>): void => {
      lines.push({ level, msg, bindings });
      if (o.throwOn === level) throw new Error('the logger broke');
    };
  const logger: Logger = {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child: () => logger,
  };
  return { logger, lines };
}

async function bind(installId: string, channelId: string, agentId: string): Promise<void> {
  const outcome = await channels.upsert({
    installId,
    channelId,
    agentId,
    connectedByUserId: 'usr_ada',
    channelName: 'support',
  });
  expect(outcome).toBe('connected');
}

/**
 * A thread of `channelId` on `installId`, in conversation `conversationId`, for
 * `agentId`, as an earlier turn left it. Written straight to the table: a
 * thread row outlives its binding, and some of these have none.
 */
async function thread(conversationId: string, installId: string, channelId: string, agentId: string): Promise<void> {
  await sql`
    INSERT INTO channel_slack_v1_threads (conversation_id, install_id, channel_id, agent_id, not_remembered)
    VALUES (${conversationId}, ${installId}, ${channelId}, ${agentId}, true)
  `.execute(db);
}

async function countFor(agentId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM channel_slack_v1_channels WHERE agent_id = ${agentId}
  `.execute(db);
  return r.rows[0]!.n;
}

async function threadsFor(agentId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM channel_slack_v1_threads WHERE agent_id = ${agentId}
  `.execute(db);
  return r.rows[0]!.n;
}

async function total(): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT (SELECT count(*) FROM channel_slack_v1_channels)::int + (SELECT count(*) FROM channel_slack_v1_threads)::int AS n
  `.execute(db);
  return r.rows[0]!.n;
}

/** Fire `agents:deleted` the way `agents:delete` does, on a ctx whose log lines we keep. */
function fireDeleted(bus: HookBus, payload: unknown, ctxLogger: Logger) {
  const ctx = makeAgentContext({ sessionId: 'agents-delete', agentId: 'agt_web', userId: 'usr_ada', logger: ctxLogger });
  return bus.fire('agents:deleted', ctx, payload, { subscriberTimeoutMs: SUBSCRIBER_TIMEOUT_MS });
}

const deleted = (agentId: string) => ({ agentId, ownerId: 'team_support', ownerType: 'team' });

/**
 * Run `fn` with a BEFORE DELETE row trigger on `table` (the bindings, unless
 * told otherwise) whose plpgsql body is `body`, then drop it whatever happens.
 */
async function withDeleteTrigger(
  body: string,
  fn: () => Promise<void>,
  table: 'channel_slack_v1_channels' | 'channel_slack_v1_threads' = 'channel_slack_v1_channels',
): Promise<void> {
  await sql
    .raw(
      `CREATE FUNCTION channel_slack_test_bindings_on_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
         BEGIN ${body} END
       $fn$;
       CREATE TRIGGER channel_slack_test_bindings_on_delete BEFORE DELETE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION channel_slack_test_bindings_on_delete();`,
    )
    .execute(db);
  try {
    await fn();
  } finally {
    await sql
      .raw(
        `DROP TRIGGER IF EXISTS channel_slack_test_bindings_on_delete ON ${table};
         DROP FUNCTION IF EXISTS channel_slack_test_bindings_on_delete();`,
      )
      .execute(db);
  }
}

const subscriberFailures = (lines: LogLine[]): LogLine[] => lines.filter((l) => l.msg === 'hook_subscriber_failed');

describe("agents:deleted removes the deleted agent's channel bindings and thread rows", () => {
  it("removes the agent's bindings and threads on every install, keeps other agents', and logs the counts alone", async () => {
    const bus = new HookBus();
    const plugin = captureLogger();
    const ctxLog = captureLogger();
    subscribeAgentsDeleted(bus, channels, plugin.logger);
    await bind(INSTALL, SUPPORT, AGENT);
    await bind(INSTALL, SALES, AGENT);
    await bind(OTHER_INSTALL, SUPPORT, AGENT);
    await bind(INSTALL, GENERAL, OTHER_AGENT);
    await thread('conv_1', INSTALL, SUPPORT, AGENT);
    await thread('conv_2', OTHER_INSTALL, SUPPORT, AGENT);
    await thread('conv_3', INSTALL, GENERAL, OTHER_AGENT);

    const fired = await fireDeleted(bus, deleted(AGENT), ctxLog.logger);
    expect(fired.rejected).toBe(false);

    expect(await countFor(AGENT)).toBe(0);
    expect(await threadsFor(AGENT)).toBe(0);
    expect(await channels.listAll(INSTALL)).toEqual([{ channelId: GENERAL, agentId: OTHER_AGENT }]);
    expect(await threadsFor(OTHER_AGENT)).toBe(1);
    expect(plugin.lines).toEqual([
      { level: 'info', msg: 'slack_agent_channels_removed', bindings: { channels: 3, threads: 2 } },
    ]);
    expect(subscriberFailures(ctxLog.lines)).toEqual([]);
  });

  it('an agent whose channels were disconnected before it was deleted still loses its thread rows', async () => {
    const bus = new HookBus();
    const plugin = captureLogger();
    subscribeAgentsDeleted(bus, channels, plugin.logger);
    await thread('conv_1', INSTALL, SUPPORT, AGENT);

    const fired = await fireDeleted(bus, deleted(AGENT), captureLogger().logger);
    expect(fired.rejected).toBe(false);

    expect(await threadsFor(AGENT)).toBe(0);
    expect(plugin.lines).toEqual([
      { level: 'info', msg: 'slack_agent_channels_removed', bindings: { channels: 0, threads: 1 } },
    ]);
  });

  it('an agent with no channels removes nothing and logs nothing', async () => {
    const bus = new HookBus();
    const plugin = captureLogger();
    subscribeAgentsDeleted(bus, channels, plugin.logger);
    await bind(INSTALL, GENERAL, OTHER_AGENT);

    const fired = await fireDeleted(bus, deleted(AGENT), captureLogger().logger);
    expect(fired.rejected).toBe(false);

    expect(await countFor(OTHER_AGENT)).toBe(1);
    expect(plugin.lines).toEqual([]);
  });

  it('a payload without a usable agent id is ignored: nothing removed, nothing logged, nothing thrown', async () => {
    const bus = new HookBus();
    const plugin = captureLogger();
    const ctxLog = captureLogger();
    subscribeAgentsDeleted(bus, channels, plugin.logger);
    // Rows a careless read of `agentId` would match: an empty id, and the
    // text a number turns into on the way to Postgres.
    await bind(INSTALL, SUPPORT, '');
    await bind(INSTALL, SALES, '42');
    await thread('conv_1', INSTALL, SUPPORT, '');
    await thread('conv_2', INSTALL, SALES, '42');

    for (const payload of [undefined, null, {}, { agentId: '' }, { agentId: 42 }, 'agt_support']) {
      const fired = await fireDeleted(bus, payload, ctxLog.logger);
      expect(fired.rejected, JSON.stringify(payload)).toBe(false);
    }

    expect(await total()).toBe(4);
    expect(plugin.lines).toEqual([]);
    expect(subscriberFailures(ctxLog.lines)).toEqual([]);
  });

  it('a delete that fails is logged by its code alone, keeps the bindings and threads, and never fails the agent delete', async () => {
    const bus = new HookBus();
    const plugin = captureLogger();
    const ctxLog = captureLogger();
    subscribeAgentsDeleted(bus, channels, plugin.logger);
    await bind(INSTALL, SUPPORT, AGENT);
    await thread('conv_1', INSTALL, SUPPORT, AGENT);

    await withDeleteTrigger(`RAISE EXCEPTION 'refused in test: ${FAILURE_CANARY}'; RETURN OLD;`, async () => {
      const fired = await fireDeleted(bus, deleted(AGENT), ctxLog.logger);
      expect(fired.rejected).toBe(false);
    });

    expect(await countFor(AGENT)).toBe(1);
    // The bindings' delete failed first, so the threads' never ran. (The
    // other order, a threads' delete that fails after the bindings' went, is
    // the next test: that one is what the transaction is for.)
    expect(await threadsFor(AGENT)).toBe(1);
    // plpgsql's RAISE EXCEPTION: Postgres's code, never its message.
    expect(plugin.lines).toEqual([
      { level: 'warn', msg: 'slack_agent_cleanup_failed', bindings: { code: 'P0001' } },
    ]);
    expect(JSON.stringify(plugin.lines)).not.toContain(FAILURE_CANARY);
    expect(subscriberFailures(ctxLog.lines)).toEqual([]);
  });

  it("a thread delete that fails keeps the bindings too: both go, or neither does", async () => {
    const bus = new HookBus();
    const plugin = captureLogger();
    subscribeAgentsDeleted(bus, channels, plugin.logger);
    await bind(INSTALL, SUPPORT, AGENT);
    await thread('conv_1', INSTALL, SUPPORT, AGENT);

    await withDeleteTrigger(
      `RAISE EXCEPTION 'refused in test'; RETURN OLD;`,
      async () => {
        const fired = await fireDeleted(bus, deleted(AGENT), captureLogger().logger);
        expect(fired.rejected).toBe(false);
      },
      'channel_slack_v1_threads',
    );

    expect(await countFor(AGENT)).toBe(1);
    expect(await threadsFor(AGENT)).toBe(1);
    expect(plugin.lines).toEqual([
      { level: 'warn', msg: 'slack_agent_cleanup_failed', bindings: { code: 'P0001' } },
    ]);
  });

  it('a logger that throws while reporting the failure still never fails the agent delete', async () => {
    const bus = new HookBus();
    const plugin = captureLogger({ throwOn: 'warn' });
    const ctxLog = captureLogger();
    subscribeAgentsDeleted(bus, channels, plugin.logger);
    await bind(INSTALL, SUPPORT, AGENT);

    await withDeleteTrigger(`RAISE EXCEPTION 'refused in test'; RETURN OLD;`, async () => {
      const fired = await fireDeleted(bus, deleted(AGENT), ctxLog.logger);
      expect(fired.rejected).toBe(false);
    });

    expect(plugin.lines.map((l) => l.msg)).toEqual(['slack_agent_cleanup_failed']);
    expect(subscriberFailures(ctxLog.lines)).toEqual([]);
  });

  it('a logger that throws on the success line neither fails the delete nor reports it as failed', async () => {
    const bus = new HookBus();
    const plugin = captureLogger({ throwOn: 'info' });
    const ctxLog = captureLogger();
    subscribeAgentsDeleted(bus, channels, plugin.logger);
    await bind(INSTALL, SUPPORT, AGENT);

    const fired = await fireDeleted(bus, deleted(AGENT), ctxLog.logger);
    expect(fired.rejected).toBe(false);

    expect(await countFor(AGENT)).toBe(0);
    expect(plugin.lines.map((l) => l.msg)).toEqual(['slack_agent_channels_removed']);
    expect(subscriberFailures(ctxLog.lines)).toEqual([]);
  });

  it('subscribes under AGENTS_DELETED_KEY, so the plugin can take it off the bus by that name', async () => {
    const bus = new HookBus();
    subscribeAgentsDeleted(bus, channels, captureLogger().logger);
    await bind(INSTALL, SUPPORT, AGENT);

    expect(bus.unsubscribe('agents:deleted', AGENTS_DELETED_KEY)).toBe(1);
    await fireDeleted(bus, deleted(AGENT), captureLogger().logger);
    expect(await countFor(AGENT)).toBe(1);
  });

  it('the function it returns unsubscribes: a later delete leaves the bindings alone', async () => {
    const bus = new HookBus();
    const off = subscribeAgentsDeleted(bus, channels, captureLogger().logger);
    await bind(INSTALL, SUPPORT, AGENT);

    off();
    await fireDeleted(bus, deleted(AGENT), captureLogger().logger);
    expect(await countFor(AGENT)).toBe(1);
    expect(bus.unsubscribe('agents:deleted', AGENTS_DELETED_KEY)).toBe(0);
  });
});
