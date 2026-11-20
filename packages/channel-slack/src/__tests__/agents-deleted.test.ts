import { randomBytes } from 'node:crypto';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENTS_DELETED_KEY, subscribeAgentsDeleted } from '../agents-deleted.js';
import { createBots, type Bots } from '../bots.js';
import { createChannelStore, type ChannelStore } from '../channel-store.js';
import { runMigrations, type ChannelSlackDatabase } from '../migrations.js';
import { createMutex, type Mutex } from '../mutex.js';
import { SECRET_NAMES, configTokenRef, createSecretStore, secretRef } from '../secrets.js';
import { SlackApiError } from '../slack-api.js';
import { createInstallStore, type InstallStore } from '../store.js';
import {
  APP,
  BOT_TOKEN,
  CLIENT_SECRET,
  GRANT,
  MINTED_ACCESS,
  NOW_MS,
  SIGNING_SECRET,
  fakeSlack,
  mintedRefresh,
} from './fake-slack-config.js';
import {
  BOT_PREFIX,
  CONFIG_ACCESS_PREFIX,
  CONFIG_REFRESH_PREFIX,
  fakeBotToken,
  fakeConfigRefreshToken,
} from './fake-slack-tokens.js';
import { busVault } from './fake-vault.js';

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

  And the agent's own Slack bot (TASK-1167), pending or live: its Slack app
  deleted with an access token minted from its approver's own configuration
  token, its row, its secrets and, once nothing else names the approver,
  their token. Without it the bot would stay live in Slack, for an agent that
  no longer exists, and keep its approver's token alive.

  A real bus and a real Postgres. The bot tests add the real install store,
  the real secret store over a fake vault on the bus (fake-vault.ts), and a
  fake Slack that retires a rotated refresh token at once
  (fake-slack-config.ts). The stores' own contracts are channel-store.test.ts
  and store.test.ts.
*/

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<ChannelSlackDatabase>;
let channels: ChannelStore;
let installs: InstallStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = new Kysely<ChannelSlackDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(db);
  channels = createChannelStore(db);
  installs = createInstallStore(db);
}, 120_000);

/** No binding, thread, install or leftover app: what every test, and each case of a table-driven one, starts from. */
async function clearTables(): Promise<void> {
  await sql`
    TRUNCATE channel_slack_v1_channels, channel_slack_v1_threads, channel_slack_v1_installs, channel_slack_v1_leftover_apps
  `.execute(db);
}

beforeEach(clearTables);

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
    INSERT INTO channel_slack_v1_threads (conversation_id, install_id, channel_id, agent_id, not_remembered, external)
    VALUES (${conversationId}, ${installId}, ${channelId}, ${agentId}, true, false)
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
  table:
    | 'channel_slack_v1_channels'
    | 'channel_slack_v1_threads'
    | 'channel_slack_v1_installs' = 'channel_slack_v1_channels',
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

/** For the tests about bindings and threads alone: an agent with no bot of its own. */
const NO_BOT: Pick<Bots, 'removeForAgent'> = { removeForAgent: async () => {} };

describe("agents:deleted removes the deleted agent's channel bindings and thread rows", () => {
  it("removes the agent's bindings and threads on every install, keeps other agents', and logs the counts alone", async () => {
    const bus = new HookBus();
    const plugin = captureLogger();
    const ctxLog = captureLogger();
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, plugin.logger);
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
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, plugin.logger);
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
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, plugin.logger);
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
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, plugin.logger);
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
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, plugin.logger);
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
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, plugin.logger);
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
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, plugin.logger);
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
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, plugin.logger);
    await bind(INSTALL, SUPPORT, AGENT);

    const fired = await fireDeleted(bus, deleted(AGENT), ctxLog.logger);
    expect(fired.rejected).toBe(false);

    expect(await countFor(AGENT)).toBe(0);
    expect(plugin.lines.map((l) => l.msg)).toEqual(['slack_agent_channels_removed']);
    expect(subscriberFailures(ctxLog.lines)).toEqual([]);
  });

  it('subscribes under AGENTS_DELETED_KEY, so the plugin can take it off the bus by that name', async () => {
    const bus = new HookBus();
    subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, captureLogger().logger);
    await bind(INSTALL, SUPPORT, AGENT);

    expect(bus.unsubscribe('agents:deleted', AGENTS_DELETED_KEY)).toBe(1);
    await fireDeleted(bus, deleted(AGENT), captureLogger().logger);
    expect(await countFor(AGENT)).toBe(1);
  });

  it('the function it returns unsubscribes: a later delete leaves the bindings alone', async () => {
    const bus = new HookBus();
    const off = subscribeAgentsDeleted(bus, { channels, bots: NO_BOT }, captureLogger().logger);
    await bind(INSTALL, SUPPORT, AGENT);

    off();
    await fireDeleted(bus, deleted(AGENT), captureLogger().logger);
    expect(await countFor(AGENT)).toBe(1);
    expect(bus.unsubscribe('agents:deleted', AGENTS_DELETED_KEY)).toBe(0);
  });
});

// ── The agent's own Slack bot (TASK-1167) ──────────────────────────────────

/** Ada connected the shared app (Admin › Slack), with her own configuration token. */
const ADA = 'usr_ada';
/**
 * Grace, a team admin of the agent's team, asked for the agent's own bot and
 * approved it, so her configuration token made its app: the row names her
 * both ways.
 */
const GRACE = 'usr_grace';
const BOT_INSTALL = 'R3JhY2VzQm90SW5zdGFsbA';
const BOT_APP = 'A07BOTAPP001';
const BOT_NAME = 'support-helper';
/** Grace's bot for another team agent. */
const SALES_BOT_INSTALL = 'U2FsZXNCb3RJbnN0YWxsMQ';
const SALES_BOT_APP = 'A07BOTAPP002';
/** Each person's own configuration token (TASK-1175), as their last use of it left it. */
const ADA_STORED = fakeConfigRefreshToken('ADASTOREDSECRET');
const GRACE_STORED = fakeConfigRefreshToken('GRACESTOREDSECRET');
/** A bot's own three secrets, unlike the shared app's. */
const BOT_BOT_TOKEN = fakeBotToken('SUPPORTBOTSECRET');
const BOT_SIGNING_SECRET = 'BOTSIGNINGSECRET0a1b2c3d4e5f';
const BOT_CLIENT_SECRET = 'BOTCLIENTSECRET9f8e7d6c5b4a';

/**
 * The subscriber with the real bot domain behind it: bots.ts on the real
 * install store, the real secret store over a fake vault on the bus, and a
 * fake Slack. A test may hand in the store or the lock, to watch or break
 * them, and a log level that throws.
 */
function botWorld(o: { installs?: InstallStore; lock?: Mutex; throwOn?: LogLine['level'] } = {}) {
  /** Every vault and Slack call, in order. */
  const trail: string[] = [];
  const bus = new HookBus();
  const { vault, vaultCalls, vaultFailures } = busVault(bus, trail);
  const slack = fakeSlack(trail);
  const plugin = captureLogger(o.throwOn !== undefined ? { throwOn: o.throwOn } : {});
  const bots = createBots({
    bus,
    installs: o.installs ?? installs,
    secrets: createSecretStore(bus, { logger: plugin.logger }),
    api: slack.api,
    lock: o.lock ?? createMutex(),
    publicOrigin: 'https://ax.example',
    logger: plugin.logger,
    now: () => NOW_MS,
    randomBytes: (n) => randomBytes(n),
  });
  subscribeAgentsDeleted(bus, { channels, bots }, plugin.logger);
  return { bus, vault, vaultCalls, vaultFailures, slack, trail, lines: plugin.lines };
}

type BotWorld = ReturnType<typeof botWorld>;

/** What seedShared stores: the shared app's three secrets, and its person's own token. */
function sharedVault(person = ADA, token = ADA_STORED): Map<string, string> {
  return new Map([
    [secretRef(INSTALL, 'bot-token'), BOT_TOKEN],
    [secretRef(INSTALL, 'signing-secret'), SIGNING_SECRET],
    [secretRef(INSTALL, 'client-secret'), CLIENT_SECRET],
    [configTokenRef(person), token],
  ]);
}

/** The shared app, live, connected by `person` with their own token, and its secrets. */
async function seedShared(w: BotWorld, person = ADA, token = ADA_STORED): Promise<void> {
  await installs.insertPending({
    installId: INSTALL,
    appId: APP.appId,
    clientId: APP.clientId,
    botName: 'canopy-works',
    connectedByUserId: person,
  });
  await installs.activate(INSTALL, {
    teamId: GRANT.teamId,
    teamName: GRANT.teamName,
    botUserId: GRANT.botUserId,
    installedAt: new Date(NOW_MS),
  });
  for (const [ref, value] of sharedVault(person, token)) w.vault.set(ref, value);
}

/** A live bot's three secrets, as seedBot stores them. */
function botSecrets(installId: string): Array<[string, string]> {
  return [
    [secretRef(installId, 'client-secret'), BOT_CLIENT_SECRET],
    [secretRef(installId, 'signing-secret'), BOT_SIGNING_SECRET],
    [secretRef(installId, 'bot-token'), BOT_BOT_TOKEN],
  ];
}

/**
 * A team agent's own bot, Grace's: pending, with the client and signing
 * secrets its request stored, or (`live`, the default) after her Allow, with
 * its bot token too. Her own token is each test's to store.
 */
async function seedBot(
  w: BotWorld,
  o: { installId?: string; appId?: string; agentId?: string; botName?: string; live?: boolean } = {},
): Promise<void> {
  const installId = o.installId ?? BOT_INSTALL;
  await installs.insertPendingBot({
    installId,
    appId: o.appId ?? BOT_APP,
    clientId: '7512345678901.7522222222222',
    botName: o.botName ?? BOT_NAME,
    connectedByUserId: GRACE,
    agentId: o.agentId ?? AGENT,
    requestedByUserId: GRACE,
  });
  const [clientSecret, signingSecret, botToken] = botSecrets(installId);
  w.vault.set(...clientSecret!);
  w.vault.set(...signingSecret!);
  if (o.live === false) return;
  await installs.activate(installId, {
    teamId: GRANT.teamId,
    teamName: GRANT.teamName,
    botUserId: 'U07HELPERBOT',
    installedAt: new Date(NOW_MS),
  });
  w.vault.set(...botToken!);
}

/** The bot's app on the leftover list: it may still be on Slack, and only Grace's token can delete it. */
const leftOver = () => [
  { installId: BOT_INSTALL, appId: BOT_APP, botName: BOT_NAME, leftAt: expect.any(Date), connectedByUserId: GRACE },
];

const removed = (appDeleted: boolean): LogLine => ({
  level: 'info',
  msg: 'slack_agent_bot_removed',
  bindings: { installId: BOT_INSTALL, appDeleted },
});

/**
 * Code-only: no line carries a token or a secret, a person's or the agent's
 * id, a Slack id other than the install's, a name, or a failure's own text.
 */
function expectCodeOnly(lines: LogLine[]): void {
  const all = JSON.stringify(lines);
  for (const text of [
    BOT_PREFIX,
    CONFIG_ACCESS_PREFIX,
    CONFIG_REFRESH_PREFIX,
    BOT_SIGNING_SECRET,
    BOT_CLIENT_SECRET,
    SIGNING_SECRET,
    CLIENT_SECRET,
    ADA,
    GRACE,
    AGENT,
    BOT_APP,
    APP.appId,
    GRANT.teamId,
    BOT_NAME,
    FAILURE_CANARY,
  ]) {
    expect(all, text).not.toContain(text);
  }
}

describe("agents:deleted takes the deleted agent's own Slack bot with it (TASK-1167)", () => {
  it("deleting the agent deletes its bot's Slack app with an access token minted from the approver's own token, saved first", async () => {
    const w = botWorld();
    await seedShared(w);
    await seedBot(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const ctxLog = captureLogger();

    const fired = await fireDeleted(w.bus, deleted(AGENT), ctxLog.logger);
    expect(fired.rejected).toBe(false);

    // Grace's own token is read and rotated, and the refresh token Slack
    // minted with it is saved over it (the rotate retired the one it was
    // sent) before the access token minted alongside deletes the app.
    expect(w.trail).toEqual([
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      ...SECRET_NAMES.map((name) => `vault:delete ${name}`),
      'vault:delete config-refresh-token',
    ]);
    expect(w.vaultCalls).toEqual([
      { hook: 'credentials:get', ref: configTokenRef(GRACE) },
      { hook: 'credentials:set', ref: configTokenRef(GRACE) },
      ...SECRET_NAMES.map((name) => ({ hook: 'credentials:delete', ref: secretRef(BOT_INSTALL, name) })),
      // Last, her own token: nothing names her any more.
      { hook: 'credentials:delete', ref: configTokenRef(GRACE) },
    ]);
    expect(w.slack.calls).toEqual([
      { method: 'rotateConfigToken', args: [GRACE_STORED] },
      { method: 'deleteApp', args: [MINTED_ACCESS, BOT_APP] },
    ]);
    expect(await installs.get(BOT_INSTALL)).toBeNull();
    // Slack deleted it: nothing is left over.
    expect(await installs.leftoverApps()).toEqual([]);
    // The shared app, its secrets and Ada's token are as they were.
    expect(await installs.current()).toMatchObject({ installId: INSTALL, status: 'active', connectedByUserId: ADA });
    expect(w.vault).toEqual(sharedVault());
    expect(w.lines).toEqual([removed(true)]);
    expectCodeOnly(w.lines);
    expect(subscriberFailures(ctxLog.lines)).toEqual([]);
  });

  it("the approver's token stays when their shared install or another bot still names them", async () => {
    const cases: Array<[string, (w: BotWorld) => Promise<{ other: string; vault: Map<string, string> }>]> = [
      [
        'Grace connected the shared app too',
        async (w) => {
          await seedShared(w, GRACE, GRACE_STORED);
          // Her slot as the rotate left it: the successor it minted.
          return { other: INSTALL, vault: sharedVault(GRACE, mintedRefresh(1)) };
        },
      ],
      [
        'Grace has a bot for another agent too',
        async (w) => {
          await seedBot(w, { installId: SALES_BOT_INSTALL, appId: SALES_BOT_APP, agentId: OTHER_AGENT, botName: 'sales-helper' });
          return {
            other: SALES_BOT_INSTALL,
            vault: new Map([...botSecrets(SALES_BOT_INSTALL), [configTokenRef(GRACE), mintedRefresh(1)]]),
          };
        },
      ],
    ];
    for (const [name, seedOther] of cases) {
      await clearTables();
      const w = botWorld();
      await seedBot(w);
      const kept = await seedOther(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);

      expect((await fireDeleted(w.bus, deleted(AGENT), captureLogger().logger)).rejected, name).toBe(false);

      expect(w.slack.calls, name).toEqual([
        { method: 'rotateConfigToken', args: [GRACE_STORED] },
        { method: 'deleteApp', args: [MINTED_ACCESS, BOT_APP] },
      ]);
      // Only the agent's bot goes.
      expect((await installs.list()).map((r) => r.installId), name).toEqual([kept.other]);
      // Her token stays, as the successor the rotate minted: her other app needs it.
      expect(w.vault, name).toEqual(kept.vault);
      expect(
        w.vaultCalls.filter((c) => c.hook === 'credentials:delete').map((c) => c.ref),
        name,
      ).toEqual(SECRET_NAMES.map((n) => secretRef(BOT_INSTALL, n)));
      expect(w.lines, name).toEqual([removed(true)]);
    }
  });

  it('a dead approver token lists the app as left over naming the approver; row and per-install secrets gone; the token kept for the leftover', async () => {
    // [the stage and code logged, what Grace's slot holds]
    const cases: Array<[string, string, string | null]> = [
      // Revoked on Slack's page: Slack refuses it at the rotate.
      ['rotate', 'invalid_refresh_token', GRACE_STORED],
      // None stored for her at all.
      ['config-token', 'missing', null],
    ];
    for (const [stage, code, stored] of cases) {
      await clearTables();
      const w = botWorld();
      await seedBot(w);
      if (stored !== null) w.vault.set(configTokenRef(GRACE), stored);
      w.slack.on.rotateConfigToken = async () => {
        throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token');
      };

      expect((await fireDeleted(w.bus, deleted(AGENT), captureLogger().logger)).rejected, stage).toBe(false);

      // No access token, so Slack is never asked to delete the app.
      expect(w.slack.calls.map((c) => c.method), stage).toEqual(stored === null ? [] : ['rotateConfigToken']);
      expect(await installs.get(BOT_INSTALL), stage).toBeNull();
      expect(await installs.leftoverApps(), stage).toEqual(leftOver());
      // The bot's own secrets are gone. Her token stays for the leftover, as it was: nothing replaced it.
      expect(w.vault, stage).toEqual(stored === null ? new Map() : new Map([[configTokenRef(GRACE), stored]]));
      expect(w.lines, stage).toEqual([
        { level: 'warn', msg: 'slack_bot_failed', bindings: { installId: BOT_INSTALL, stage, code } },
        removed(false),
      ]);
    }
  });

  it('Slack refusing the delete lists the app as left over; app_not_found counts as deleted', async () => {
    // [Slack's answer to the delete, whether the app is gone, the vault after]
    const cases: Array<[string, boolean, Map<string, string>]> = [
      // Refused: listed, naming Grace, whose token stays for it as the successor saved before the delete.
      ['ratelimited', false, new Map([[configTokenRef(GRACE), mintedRefresh(1)]])],
      // Already deleted on Slack's side (say on api.slack.com/apps): what the removal wanted.
      ['app_not_found', true, new Map()],
    ];
    for (const [answer, appDeleted, vault] of cases) {
      await clearTables();
      const w = botWorld();
      await seedBot(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);
      w.slack.on.deleteApp = async () => {
        throw new SlackApiError('apps.manifest.delete', answer);
      };

      expect((await fireDeleted(w.bus, deleted(AGENT), captureLogger().logger)).rejected, answer).toBe(false);

      expect(w.slack.calls.map((c) => c.method), answer).toEqual(['rotateConfigToken', 'deleteApp']);
      expect(await installs.get(BOT_INSTALL), answer).toBeNull();
      expect(await installs.leftoverApps(), answer).toEqual(appDeleted ? [] : leftOver());
      expect(w.vault, answer).toEqual(vault);
      expect(w.lines, answer).toEqual(
        appDeleted
          ? [removed(true)]
          : [
              {
                level: 'warn',
                msg: 'slack_bot_failed',
                bindings: { installId: BOT_INSTALL, stage: 'delete-app', code: answer },
              },
              removed(false),
            ],
      );
    }
  });

  it('a pending bot is deleted the same way', async () => {
    const w = botWorld();
    // Grace asked for it, and hasn't clicked Allow in Slack yet.
    await seedBot(w, { live: false });
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);

    expect((await fireDeleted(w.bus, deleted(AGENT), captureLogger().logger)).rejected).toBe(false);

    expect(w.slack.calls).toEqual([
      { method: 'rotateConfigToken', args: [GRACE_STORED] },
      { method: 'deleteApp', args: [MINTED_ACCESS, BOT_APP] },
    ]);
    expect(await installs.get(BOT_INSTALL)).toBeNull();
    expect(await installs.leftoverApps()).toEqual([]);
    expect(w.vault).toEqual(new Map());
    expect(w.lines).toEqual([removed(true)]);
  });

  it('an agent with no bot costs no vault read and no Slack call', async () => {
    const w = botWorld();
    await seedShared(w);
    // Grace's bot is another agent's.
    await seedBot(w, { agentId: OTHER_AGENT });
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const before = new Map(w.vault);
    await bind(INSTALL, SUPPORT, AGENT);

    expect((await fireDeleted(w.bus, deleted(AGENT), captureLogger().logger)).rejected).toBe(false);

    expect(w.vaultCalls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect(await installs.botForAgent(OTHER_AGENT)).toMatchObject({ installId: BOT_INSTALL, status: 'active' });
    expect(await installs.current()).toMatchObject({ installId: INSTALL, status: 'active' });
    expect(w.vault).toEqual(before);
    // Its channel still goes, as it always did.
    expect(await countFor(AGENT)).toBe(0);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_agent_channels_removed', bindings: { channels: 1, threads: 0 } },
    ]);
  });

  it('the removal waits for the app lock and looks the bot up only once it holds it; the bindings and threads never wait', async () => {
    const lock = createMutex();
    let asked = 0;
    let lookups = 0;
    const w = botWorld({
      // The real lock, counting who asks for it.
      lock: {
        run(fn) {
          asked += 1;
          return lock.run(fn);
        },
      },
      installs: {
        ...installs,
        botForAgent(agentId) {
          lookups += 1;
          return installs.botForAgent(agentId);
        },
      },
    });
    await seedBot(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    await bind(BOT_INSTALL, SUPPORT, AGENT);
    await thread('conv_1', BOT_INSTALL, SUPPORT, AGENT);
    // Another step holds the lock: an admin's Connect, say, or a request still making this agent's bot.
    let release!: () => void;
    const held = lock.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const firing = fireDeleted(w.bus, deleted(AGENT), captureLogger().logger);
    await vi.waitFor(() => expect(asked).toBe(1));

    // It asked for the lock once the bindings and threads were gone, and waits for it.
    expect(await countFor(AGENT)).toBe(0);
    expect(await threadsFor(AGENT)).toBe(0);
    expect(lookups).toBe(0);
    expect(w.vaultCalls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect(await installs.get(BOT_INSTALL)).not.toBeNull();

    release();
    await held;
    expect((await firing).rejected).toBe(false);
    expect(lookups).toBe(1);
    expect(w.slack.calls.map((c) => c.method)).toEqual(['rotateConfigToken', 'deleteApp']);
    expect(await installs.get(BOT_INSTALL)).toBeNull();
  });

  it('a fault is logged code-only and never thrown, and no line carries a token or a person id', async () => {
    const lines: LogLine[] = [];

    // The row won't go, after Slack deleted the app: one error line, by the
    // install and the database's code. The row, its secrets and Grace's token
    // (the rotate's successor) all stay, so another delete event can finish.
    {
      const w = botWorld();
      await seedBot(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);
      const ctxLog = captureLogger();
      await withDeleteTrigger(
        `RAISE EXCEPTION 'refused in test: ${FAILURE_CANARY}'; RETURN OLD;`,
        async () => {
          expect((await fireDeleted(w.bus, deleted(AGENT), ctxLog.logger)).rejected).toBe(false);
        },
        'channel_slack_v1_installs',
      );
      expect(w.slack.calls.map((c) => c.method)).toEqual(['rotateConfigToken', 'deleteApp']);
      expect(await installs.get(BOT_INSTALL)).toMatchObject({ installId: BOT_INSTALL, status: 'active' });
      expect(await installs.leftoverApps()).toEqual([]);
      expect(w.vault).toEqual(new Map([...botSecrets(BOT_INSTALL), [configTokenRef(GRACE), mintedRefresh(1)]]));
      expect(w.lines).toEqual([
        {
          level: 'error',
          msg: 'slack_bot_failed',
          bindings: { installId: BOT_INSTALL, stage: 'agent-deleted', code: 'P0001' },
        },
      ]);
      expect(subscriberFailures(ctxLog.lines)).toEqual([]);
      lines.push(...w.lines, ...ctxLog.lines);
    }

    // The lookup fails, and so does the logger: nothing is known yet, so the
    // line names no install, and nothing else is touched.
    {
      await clearTables();
      const w = botWorld({
        throwOn: 'error',
        installs: {
          ...installs,
          botForAgent: async () => {
            throw Object.assign(new Error(`lookup refused: ${FAILURE_CANARY}`), { code: 'ECONNRESET' });
          },
        },
      });
      await seedBot(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);
      const ctxLog = captureLogger();
      expect((await fireDeleted(w.bus, deleted(AGENT), ctxLog.logger)).rejected).toBe(false);
      expect(w.vaultCalls).toEqual([]);
      expect(w.slack.calls).toEqual([]);
      expect(await installs.get(BOT_INSTALL)).not.toBeNull();
      expect(w.lines).toEqual([
        { level: 'error', msg: 'slack_bot_failed', bindings: { stage: 'agent-deleted', code: 'ECONNRESET' } },
      ]);
      expect(subscriberFailures(ctxLog.lines)).toEqual([]);
      lines.push(...w.lines, ...ctxLog.lines);
    }

    // The vault won't read Grace's token: the app can't be deleted, so it is
    // listed, and the rest goes as usual.
    {
      await clearTables();
      const w = botWorld();
      await seedBot(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);
      w.vaultFailures.set(
        `credentials:get ${configTokenRef(GRACE)}`,
        Object.assign(new Error(`vault down ${GRACE_STORED} ${FAILURE_CANARY}`), { code: 'ECONNREFUSED' }),
      );
      const ctxLog = captureLogger();
      expect((await fireDeleted(w.bus, deleted(AGENT), ctxLog.logger)).rejected).toBe(false);
      expect(w.slack.calls).toEqual([]);
      expect(await installs.get(BOT_INSTALL)).toBeNull();
      expect(await installs.leftoverApps()).toEqual(leftOver());
      expect(w.vault).toEqual(new Map([[configTokenRef(GRACE), GRACE_STORED]]));
      expect(w.lines).toEqual([
        {
          level: 'error',
          msg: 'slack_bot_failed',
          bindings: { installId: BOT_INSTALL, stage: 'config-token', code: 'ECONNREFUSED' },
        },
        removed(false),
      ]);
      expect(subscriberFailures(ctxLog.lines)).toEqual([]);
      lines.push(...w.lines, ...ctxLog.lines);
    }

    // A logger that throws on the success line: the bot still goes, and
    // nothing reports it as a failure.
    {
      await clearTables();
      const w = botWorld({ throwOn: 'info' });
      await seedBot(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);
      const ctxLog = captureLogger();
      expect((await fireDeleted(w.bus, deleted(AGENT), ctxLog.logger)).rejected).toBe(false);
      expect(await installs.get(BOT_INSTALL)).toBeNull();
      expect(w.vault).toEqual(new Map());
      expect(w.lines).toEqual([removed(true)]);
      expect(subscriberFailures(ctxLog.lines)).toEqual([]);
      lines.push(...w.lines, ...ctxLog.lines);
    }

    expectCodeOnly(lines);
  });

  it("the bot still goes when the agent's bindings and threads won't delete", async () => {
    const w = botWorld();
    await seedBot(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    await bind(INSTALL, SUPPORT, AGENT);

    await withDeleteTrigger(`RAISE EXCEPTION 'refused in test'; RETURN OLD;`, async () => {
      expect((await fireDeleted(w.bus, deleted(AGENT), captureLogger().logger)).rejected).toBe(false);
    });

    // The binding stays, and says so; the bot goes all the same.
    expect(await countFor(AGENT)).toBe(1);
    expect(w.slack.calls.map((c) => c.method)).toEqual(['rotateConfigToken', 'deleteApp']);
    expect(await installs.get(BOT_INSTALL)).toBeNull();
    expect(w.vault).toEqual(new Map());
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_agent_cleanup_failed', bindings: { code: 'P0001' } },
      removed(true),
    ]);
  });
});
