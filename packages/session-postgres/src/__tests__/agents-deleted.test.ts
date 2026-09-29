import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import type { Logger } from '@ax/core';
import {
  createSessionPostgresPlugin,
  type SessionClaimWorkInput,
  type SessionClaimWorkOutput,
  type SessionCreateInput,
  type SessionCreateOutput,
  type SessionQueueWorkInput,
  type SessionQueueWorkOutput,
  type SessionResolveTokenInput,
  type SessionResolveTokenOutput,
} from '../plugin.js';
import { runSessionMigration, type SessionDatabase } from '../migrations.js';
import { createSessionStore, type AgentConfig } from '../store.js';

// ---------------------------------------------------------------------------
// TASK-718: `agents:deleted` must take the agent's session data with it.
//
// Before this, @ax/session-postgres reacted to nothing, and `session:terminate`
// only sets a flag — so `session_postgres_v1_sessions` (which holds the
// session's bearer token), `_v1_inbox` and `_v2_session_agent` (a frozen
// agent-config snapshot) kept every row of a deleted agent forever, and a warm
// runner kept running against a deleted agent.
// ---------------------------------------------------------------------------

const AGENT_CONFIG: AgentConfig = {
  displayName: 'Test Agent',
  systemPromptAugment: 'be helpful',
  allowedTools: ['file.read'],
  mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk',
};

const AGENT_A = 'agent-A';
const AGENT_B = 'agent-B';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: Awaited<ReturnType<typeof createTestHarness>>[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()!.close({ onError: () => {} });
  }
  while (cleanups.length > 0) {
    await cleanups.pop()!().catch(() => {});
  }
  const cleanupClient = new pg.Client({ connectionString });
  await cleanupClient.connect();
  try {
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v2_session_agent');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_inbox');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_sessions');
    await cleanupClient.query('DROP FUNCTION IF EXISTS session_postgres_test_refuse_update()');
  } finally {
    await cleanupClient.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

interface LoggedRecord {
  level: string;
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function makeRecordingLogger() {
  const records: LoggedRecord[] = [];
  const make = (level: string) => (msg: string, bindings?: Record<string, unknown>) => {
    records.push({ level, msg, bindings });
  };
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: () => logger,
  };
  return { records, logger };
}

async function makeHarness() {
  const plugin = createSessionPostgresPlugin({ connectionString });
  const h = await createTestHarness({ plugins: [plugin] });
  harnesses.push(h);
  return { h, plugin };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>['h'];

async function createSession(
  h: Harness,
  sessionId: string,
  agentId: string,
): Promise<string> {
  const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    h.ctx(),
    {
      sessionId,
      workspaceRoot: '/tmp/ws',
      owner: { userId: 'u-1', agentId, agentConfig: AGENT_CONFIG },
    },
  );
  return token;
}

async function queueMessage(h: Harness, sessionId: string, content: string): Promise<void> {
  await h.bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
    'session:queue-work',
    h.ctx(),
    {
      sessionId,
      entry: { type: 'user-message', payload: { role: 'user', content }, reqId: `r-${content}` },
    },
  );
}

async function terminate(h: Harness, sessionId: string): Promise<void> {
  await h.bus.call('session:terminate', h.ctx(), { sessionId });
}

async function countIn(table: string, sessionIds: string[]): Promise<number> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE session_id = ANY($1)`,
      [sessionIds],
    );
    return r.rows[0].n as number;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Row counts for a set of session ids, straight from the tables. */
async function countRows(sessionIds: string[]): Promise<{
  sessions: number;
  inbox: number;
  agent: number;
}> {
  return {
    sessions: await countIn('session_postgres_v1_sessions', sessionIds),
    inbox: await countIn('session_postgres_v1_inbox', sessionIds),
    agent: await countIn('session_postgres_v2_session_agent', sessionIds),
  };
}

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end().catch(() => {});
  }
}

function spyOnTerminate(h: Harness): string[] {
  const seen: string[] = [];
  h.bus.subscribe<{ sessionId: string }>('session:terminate', 'spy', async (_ctx, payload) => {
    seen.push(payload.sessionId);
    return undefined;
  });
  return seen;
}

async function fireAgentDeleted(h: Harness, agentId: unknown, logger?: Logger): Promise<void> {
  await h.bus.fire(
    'agents:deleted',
    h.ctx(logger === undefined ? {} : { logger }),
    { agentId, ownerId: 'u-1', ownerType: 'user' },
  );
}

describe('@ax/session-postgres agents:deleted (TASK-718)', () => {
  it('subscribes to agents:deleted in its manifest', () => {
    const plugin = createSessionPostgresPlugin({
      connectionString: 'postgres://u:p@localhost:5432/db',
    });
    expect(plugin.manifest.subscribes).toContain('agents:deleted');
  });

  it("removes every row of the deleted agent's sessions and none of anyone else's", async () => {
    const { h } = await makeHarness();
    const terminated = spyOnTerminate(h);

    // Agent A: two live sessions, one already-terminated one — all with inbox rows.
    const tokenA1 = await createSession(h, 'sA-live-1', AGENT_A);
    await createSession(h, 'sA-live-2', AGENT_A);
    await createSession(h, 'sA-dead', AGENT_A);
    for (const s of ['sA-live-1', 'sA-live-2', 'sA-dead']) await queueMessage(h, s, `m-${s}`);
    await terminate(h, 'sA-dead');
    terminated.length = 0; // forget the setup terminate

    // Agent B (must be untouched) + an ownerless session (no v2 row, must be untouched).
    await createSession(h, 'sB-live', AGENT_B);
    await createSession(h, 'sB-dead', AGENT_B);
    await queueMessage(h, 'sB-live', 'm-b');
    await queueMessage(h, 'sB-dead', 'm-b2');
    await terminate(h, 'sB-dead');
    await h.bus.call<SessionCreateInput, SessionCreateOutput>('session:create', h.ctx(), {
      sessionId: 's-ownerless',
      workspaceRoot: '/tmp/ws',
    });
    terminated.length = 0;

    const aIds = ['sA-live-1', 'sA-live-2', 'sA-dead'];
    const otherIds = ['sB-live', 'sB-dead', 's-ownerless'];
    expect(await countRows(aIds)).toEqual({ sessions: 3, inbox: 3, agent: 3 });
    const otherBefore = await countRows(otherIds);
    expect(otherBefore).toEqual({ sessions: 3, inbox: 2, agent: 2 });

    await fireAgentDeleted(h, AGENT_A);

    // Every row of A is gone: sessions (with their bearer tokens), inbox, v2.
    expect(await countRows(aIds)).toEqual({ sessions: 0, inbox: 0, agent: 0 });
    // B and the ownerless session are byte-for-byte where they were.
    expect(await countRows(otherIds)).toEqual(otherBefore);

    // The live sessions got the SAME teardown session:terminate always gets, so
    // subscribers (@ax/conversations, @ax/chat-orchestrator) react as usual.
    // The already-terminated one already had it; B's must not be touched.
    expect([...terminated].sort()).toEqual(['sA-live-1', 'sA-live-2']);

    // The bearer token of a deleted agent's runner stops resolving at once.
    const resolved = await h.bus.call<SessionResolveTokenInput, SessionResolveTokenOutput>(
      'session:resolve-token',
      h.ctx(),
      { token: tokenA1 },
    );
    expect(resolved).toBeNull();
  });

  it('wakes a runner blocked in claim-work on the deleted agent instead of leaving it hanging', async () => {
    const { h } = await makeHarness();
    await createSession(h, 'sA-blocked', AGENT_A);

    const claimP = h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      h.ctx(),
      { sessionId: 'sA-blocked', cursor: 0, timeoutMs: 8000 },
    );
    // Let the claim install its LISTEN.
    await new Promise((r) => setTimeout(r, 150));

    const start = Date.now();
    await fireAgentDeleted(h, AGENT_A);
    const result = await claimP;
    const elapsed = Date.now() - start;

    // Resolved by the terminate wakeup, not by waiting out its own 8s timeout.
    expect(elapsed).toBeLessThan(3000);
    expect(result).toEqual({ type: 'timeout', cursor: 0 });
  });

  it("a runner that polls again after the delete finds its session gone (unknown-session, not an empty inbox)", async () => {
    const { h } = await makeHarness();
    await createSession(h, 'sA-poll', AGENT_A);
    await fireAgentDeleted(h, AGENT_A);

    const claim = h.bus.call<SessionClaimWorkInput, SessionClaimWorkOutput>(
      'session:claim-work',
      h.ctx(),
      { sessionId: 'sA-poll', cursor: 0, timeoutMs: 100 },
    );
    await expect(claim).rejects.toMatchObject({ code: 'unknown-session' });
    const alive = await h.bus.call<{ sessionId: string }, { alive: boolean }>(
      'session:is-alive',
      h.ctx(),
      { sessionId: 'sA-poll' },
    );
    expect(alive).toEqual({ alive: false });
  });

  it('is a no-op the second time: no new terminate events, no errors, B still intact', async () => {
    const { h } = await makeHarness();
    const terminated = spyOnTerminate(h);
    await createSession(h, 'sA-1', AGENT_A);
    await createSession(h, 'sB-1', AGENT_B);
    await queueMessage(h, 'sB-1', 'kept');
    const { records, logger } = makeRecordingLogger();

    await fireAgentDeleted(h, AGENT_A, logger);
    // The first fire really did the work (otherwise "no-op the second time" is vacuous).
    expect(terminated).toEqual(['sA-1']);
    expect(await countRows(['sA-1'])).toEqual({ sessions: 0, inbox: 0, agent: 0 });

    await fireAgentDeleted(h, AGENT_A, logger);
    expect(terminated).toEqual(['sA-1']);
    expect(records.filter((r) => r.level === 'error' || r.level === 'warn')).toEqual([]);
    expect(await countRows(['sB-1'])).toEqual({ sessions: 1, inbox: 1, agent: 1 });
  });

  it('logs a purge summary with counts on success', async () => {
    const { h } = await makeHarness();
    await createSession(h, 'sA-1', AGENT_A);
    await createSession(h, 'sA-2', AGENT_A);
    await queueMessage(h, 'sA-1', 'one');
    await queueMessage(h, 'sA-1', 'two');
    await terminate(h, 'sA-2');
    const { records, logger } = makeRecordingLogger();

    await fireAgentDeleted(h, AGENT_A, logger);

    const info = records.find((r) => r.level === 'info');
    expect(info?.msg).toBe('session_postgres_purged_for_deleted_agent');
    expect(info?.bindings).toMatchObject({
      agentId: AGENT_A,
      sessions: 2,
      inboxEntries: 2,
      terminated: 1,
    });
  });

  it('one session failing to terminate does not stop the others or the delete', async () => {
    const { h } = await makeHarness();
    const terminated = spyOnTerminate(h);
    await createSession(h, 'sA-bad', AGENT_A);
    await createSession(h, 'sA-good', AGENT_A);
    await queueMessage(h, 'sA-bad', 'x');
    await queueMessage(h, 'sA-good', 'y');
    // A real database failure on exactly one session's terminate UPDATE. The
    // trigger fires on UPDATE only, so the purge's DELETEs are unaffected.
    await adminQuery(`
      CREATE FUNCTION session_postgres_test_refuse_update() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'refused by test'; END $$ LANGUAGE plpgsql
    `);
    await adminQuery(`
      CREATE TRIGGER refuse_terminate BEFORE UPDATE ON session_postgres_v1_sessions
      FOR EACH ROW WHEN (OLD.session_id = 'sA-bad')
      EXECUTE FUNCTION session_postgres_test_refuse_update()
    `);
    const { records, logger } = makeRecordingLogger();

    await fireAgentDeleted(h, AGENT_A, logger);

    const warn = records.find(
      (r) => r.level === 'warn' && r.msg === 'session_postgres_terminate_for_deleted_agent_failed',
    );
    expect(warn?.bindings).toMatchObject({ agentId: AGENT_A, sessionId: 'sA-bad' });
    // The healthy session still got its terminate event...
    expect(terminated).toEqual(['sA-good']);
    // ...and the failing one did not stop the delete of anything.
    expect(await countRows(['sA-bad', 'sA-good'])).toEqual({ sessions: 0, inbox: 0, agent: 0 });
    expect(records.some((r) => r.level === 'error')).toBe(false);
  });

  it('a failing store logs an error and does not throw', async () => {
    const { h } = await makeHarness();
    await createSession(h, 'sA-1', AGENT_A);
    // Break the store from underneath the plugin.
    await adminQuery('DROP TABLE session_postgres_v2_session_agent');
    const { records, logger } = makeRecordingLogger();

    await expect(fireAgentDeleted(h, AGENT_A, logger)).resolves.toBeUndefined();

    const error = records.find(
      (r) => r.level === 'error' && r.msg === 'session_postgres_purge_for_deleted_agent_failed',
    );
    expect(error).toBeDefined();
    expect(error?.bindings).toMatchObject({ agentId: AGENT_A });
    expect(error?.bindings?.err).toBeInstanceOf(Error);
    // Nothing was half-purged: the v1 row is still there for a retry / operator.
    expect(await countIn('session_postgres_v1_sessions', ['sA-1'])).toBe(1);
  });

  it.each([
    ['empty', ''],
    ['missing', undefined],
    ['non-string', 42],
  ])('refuses an agentId that is %s: warns, deletes nothing, does not throw', async (_label, agentId) => {
    const { h } = await makeHarness();
    await createSession(h, 'sA-1', AGENT_A);
    const { records, logger } = makeRecordingLogger();

    await expect(fireAgentDeleted(h, agentId, logger)).resolves.toBeUndefined();

    expect(
      records.some(
        (r) => r.level === 'warn' && r.msg === 'session_postgres_agents_deleted_invalid_payload',
      ),
    ).toBe(true);
    expect(await countRows(['sA-1'])).toEqual({ sessions: 1, inbox: 0, agent: 1 });
  });
});

describe('@ax/session-postgres store: agent purge helpers (TASK-718)', () => {
  async function makeStore() {
    const db = new Kysely<SessionDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
    cleanups.push(() => db.destroy());
    await runSessionMigration(db);
    return { db, store: createSessionStore(db) };
  }

  it('listForAgent / deleteForAgent refuse an empty agentId', async () => {
    const { store } = await makeStore();
    await expect(store.listForAgent('')).rejects.toThrow();
    await expect(store.deleteForAgent('')).rejects.toThrow();
  });

  it('listForAgent reports the terminated flag; a v2 row with no v1 row counts as terminated', async () => {
    const { db, store } = await makeStore();
    await store.create('s-live', '/tmp/ws', { userId: 'u', agentId: AGENT_A, agentConfig: AGENT_CONFIG });
    await store.create('s-dead', '/tmp/ws', { userId: 'u', agentId: AGENT_A, agentConfig: AGENT_CONFIG });
    await store.create('s-other', '/tmp/ws', { userId: 'u', agentId: AGENT_B, agentConfig: AGENT_CONFIG });
    await store.terminate('s-dead');
    // Orphan v2 row: nothing left to terminate for it.
    await db
      .insertInto('session_postgres_v2_session_agent')
      .values({
        session_id: 's-orphan',
        user_id: 'u',
        agent_id: AGENT_A,
        agent_config_json: AGENT_CONFIG as never,
        conversation_id: null,
        source: null,
      } as never)
      .execute();

    const listed = await store.listForAgent(AGENT_A);
    expect(listed.map((s) => [s.sessionId, s.terminated]).sort()).toEqual([
      ['s-dead', true],
      ['s-live', false],
      ['s-orphan', true],
    ]);
  });

  it('deleteForAgent removes exactly the agent\'s v1 + v2 + inbox rows, in one go, and reports counts', async () => {
    const { db, store } = await makeStore();
    await store.create('s-1', '/tmp/ws', { userId: 'u', agentId: AGENT_A, agentConfig: AGENT_CONFIG });
    await store.create('s-2', '/tmp/ws', { userId: 'u', agentId: AGENT_A, agentConfig: AGENT_CONFIG });
    await store.create('s-keep', '/tmp/ws', { userId: 'u', agentId: AGENT_B, agentConfig: AGENT_CONFIG });
    await store.create('s-ownerless', '/tmp/ws');
    for (const [session, cursor] of [['s-1', 0], ['s-1', 1], ['s-2', 0], ['s-keep', 0], ['s-ownerless', 0]] as const) {
      await db
        .insertInto('session_postgres_v1_inbox')
        .values({ session_id: session, cursor: cursor as unknown as string, type: 'cancel', payload: null } as never)
        .execute();
    }

    const result = await store.deleteForAgent(AGENT_A);
    expect(result).toEqual({ sessions: 2, inboxEntries: 3 });
    expect(await countRows(['s-1', 's-2'])).toEqual({ sessions: 0, inbox: 0, agent: 0 });
    expect(await countRows(['s-keep', 's-ownerless'])).toEqual({ sessions: 2, inbox: 2, agent: 1 });
    // Idempotent.
    expect(await store.deleteForAgent(AGENT_A)).toEqual({ sessions: 0, inboxEntries: 0 });
  });
});
