import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createLogger, makeAgentContext, type AgentContext } from '@ax/core';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import pg from 'pg';
import { createConversationsPlugin, type ConversationsPlugin } from '../plugin.js';
import type { PendingPurge } from '../store.js';
import type { ConversationsPurgedEvent, CreateInput, CreateOutput } from '../types.js';

// The real store, except that the sweep's read returns `extraDue.rows` ahead of
// what it found. Empty, it changes nothing. duePurges' SQL reads only kinds this
// build knows, so this is the one way to put another kind in a pass; the filter
// itself is untouched.
const extraDue = vi.hoisted(() => ({ rows: [] as Array<{ kind: string; targetId: string }> }));
vi.mock('../store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store.js')>();
  return {
    ...actual,
    createConversationStore: (...args: Parameters<typeof actual.createConversationStore>) => {
      const store = actual.createConversationStore(...args);
      return {
        ...store,
        duePurges: async (now: Date, limit: number): Promise<PendingPurge[]> => [
          ...(extraDue.rows as PendingPurge[]),
          ...(await store.duePurges(now, limit)),
        ],
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Durable chat purge. `agents:deleted` fires ONCE, after the agent row is
// gone. A purge that failed used to be logged and forgotten, leaving the
// deleted agent's chats behind for good. Now the subscriber records a pending
// purge first, the purge transaction removes that record as it commits, and a
// sweep retries whatever is left (a failure, or a crash mid-purge) with
// backoff until it succeeds.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const pools: pg.Pool[] = [];

interface LogRecord {
  msg: string;
  level: string;
  rec: Record<string, unknown>;
}
let logRecords: LogRecord[] = [];

function capturingCtx(): AgentContext {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'system',
    logger: createLogger({
      reqId: 'pending-purge-test',
      writer: (line: string) => {
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          logRecords.push({ msg: String(rec.msg ?? ''), level: String(rec.level ?? ''), rec });
        } catch {
          /* ignore non-JSON */
        }
      },
    }),
  });
}

async function makeHarness(
  plugin: ConversationsPlugin = createConversationsPlugin({ purgeSweepIntervalMs: 0 }),
): Promise<{ h: TestHarness; plugin: ConversationsPlugin; pool: pg.Pool; announced: string[][] }> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'team' } };
      },
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), plugin],
  });
  harnesses.push(h);
  // One hook call so init (and the migration) has certainly run.
  await h.bus.call<CreateInput, CreateOutput>('conversations:create', h.ctx({ userId: 'u0' }), {
    userId: 'u0',
    agentId: 'agt_warmup',
  });
  const pool = new pg.Pool({ connectionString, max: 3 });
  pools.push(pool);
  const announced: string[][] = [];
  h.bus.subscribe<ConversationsPurgedEvent>('conversations:purged', 'test-listener', async (_c, p) => {
    announced.push([...p.conversationIds]);
    return undefined;
  });
  return { h, plugin, pool, announced };
}

const target = 'agt_gone';
const failMsg = 'conversations_purge_for_deleted_agent_failed';
const okMsg = 'conversations_purged_for_deleted_agent';

function fireAgentDeleted(h: TestHarness, agentId: string): Promise<unknown> {
  return h.bus.fire('agents:deleted', capturingCtx(), { agentId, ownerId: 'u_owner', ownerType: 'user' });
}

/** Seed `n` chats for the agent (with a child event + transcript row each) and one bystander. */
async function seed(pool: pg.Pool, agentId: string, n = 3): Promise<{ ids: string[]; other: string }> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `cnv_agent_${agentId}_${i}`;
    ids.push(id);
    await pool.query(
      `INSERT INTO conversations_v1_conversations (conversation_id, user_id, agent_id)
       VALUES ($1, $2, $3)`,
      [id, `user_${i}`, agentId],
    );
    await pool.query(
      `INSERT INTO conversations_v1_events (conversation_id, seq, event_kind, role, fold_key, payload)
       VALUES ($1, 1, 'turn', 'user', 'k1', '{"blocks":[]}'::jsonb)`,
      [id],
    );
    await pool.query(
      `INSERT INTO conversations_v1_transcripts (conversation_id, seq, line) VALUES ($1, 1, '{}')`,
      [id],
    );
  }
  const other = 'cnv_agent_bystander';
  await pool.query(
    `INSERT INTO conversations_v1_conversations (conversation_id, user_id, agent_id)
     VALUES ($1, 'user_0', 'agt_other')`,
    [other],
  );
  return { ids, other };
}

async function countConversations(pool: pg.Pool, ids: string[]): Promise<number> {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM conversations_v1_conversations WHERE conversation_id = ANY($1::text[])',
    [ids],
  );
  return (r.rows[0] as { n: number }).n;
}

async function countChildren(pool: pg.Pool, ids: string[]): Promise<number> {
  const r = await pool.query(
    `SELECT (SELECT COUNT(*) FROM conversations_v1_events WHERE conversation_id = ANY($1::text[]))
          + (SELECT COUNT(*) FROM conversations_v1_transcripts WHERE conversation_id = ANY($1::text[])) AS n`,
    [ids],
  );
  return Number((r.rows[0] as { n: string }).n);
}

interface PendingRow {
  kind: string;
  target_id: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
}

async function pendingRows(pool: pg.Pool): Promise<PendingRow[]> {
  const r = await pool.query(
    'SELECT kind, target_id, attempts, next_attempt_at, last_error FROM conversations_v1_pending_purges ORDER BY kind, target_id',
  );
  return r.rows as PendingRow[];
}

const injected = 'injected purge failure';

/**
 * Make every delete of a conversation row fail with `message` (the purge's LAST
 * statement, so the child deletes must roll back too). `message` is a test
 * constant spliced into the SQL: no quotes, no `%`.
 */
async function breakPurge(pool: pg.Pool, message = injected): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION test_fail_purge() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION '${message}'; END
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER test_fail_purge BEFORE DELETE ON conversations_v1_conversations
      FOR EACH STATEMENT EXECUTE FUNCTION test_fail_purge()
  `);
}

async function fixPurge(pool: pg.Pool): Promise<void> {
  await pool.query('DROP TRIGGER IF EXISTS test_fail_purge ON conversations_v1_conversations');
}

const SEC = 1000;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  logRecords = [];
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  while (pools.length > 0) {
    await pools.pop()!.end().catch(() => {});
  }
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_pending_purges');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_transcripts');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_events');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('durable purge — agents:deleted', () => {
  it('success path: purges, announces once, and leaves no pending row', async () => {
    const { h, pool, announced } = await makeHarness();
    const { ids, other } = await seed(pool, target);

    await fireAgentDeleted(h, target);

    expect(await countConversations(pool, ids)).toBe(0);
    expect(await countChildren(pool, ids)).toBe(0);
    expect(await countConversations(pool, [other])).toBe(1);
    expect(announced).toHaveLength(1);
    expect([...announced[0]!].sort()).toEqual([...ids].sort());
    expect(await pendingRows(pool)).toEqual([]);
    expect(logRecords.filter((r) => r.level === 'error')).toEqual([]);
  });

  it('a failed purge leaves a pending row (attempts=1, 30 s backoff, the error message) and announces nothing; a later sweep purges, dequeues and announces exactly once', async () => {
    const { h, plugin, pool, announced } = await makeHarness();
    const { ids, other } = await seed(pool, target);
    await breakPurge(pool);

    const before = Date.now();
    await expect(fireAgentDeleted(h, target)).resolves.toBeDefined();
    const after = Date.now();

    // Rolled back entirely: chats AND their children are all still there.
    expect(await countConversations(pool, ids)).toBe(ids.length);
    expect(await countChildren(pool, ids)).toBe(ids.length * 2);
    expect(announced).toEqual([]);
    const failed = logRecords.filter((r) => r.msg === failMsg);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.level).toBe('error');
    expect(logRecords.filter((r) => r.msg === 'hook_subscriber_failed')).toEqual([]);

    const rows = await pendingRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('agent');
    expect(rows[0]!.target_id).toBe(target);
    expect(rows[0]!.attempts).toBe(1);
    // The message only: no error name, no stack.
    expect(rows[0]!.last_error).toBe(injected);
    const due = rows[0]!.next_attempt_at.getTime();
    expect(due).toBeGreaterThanOrEqual(before + 30 * SEC - 1000);
    expect(due).toBeLessThanOrEqual(after + 30 * SEC + 1000);

    // Not due yet: a sweep now leaves it alone (even with the failure cleared).
    await fixPurge(pool);
    expect(await plugin.sweepPendingPurges(new Date(after))).toEqual({ attempted: 0, purged: 0 });
    expect(await countConversations(pool, ids)).toBe(ids.length);
    expect(announced).toEqual([]);

    // Due: the sweep purges, dequeues, and announces exactly those ids once.
    expect(await plugin.sweepPendingPurges(new Date(due + SEC))).toEqual({ attempted: 1, purged: 1 });
    expect(await countConversations(pool, ids)).toBe(0);
    expect(await countChildren(pool, ids)).toBe(0);
    expect(await countConversations(pool, [other])).toBe(1);
    expect(await pendingRows(pool)).toEqual([]);
    expect(announced).toHaveLength(1);
    expect([...announced[0]!].sort()).toEqual([...ids].sort());

    // And again: nothing left to do, nothing announced.
    expect(await plugin.sweepPendingPurges(new Date(due + 10 * 3600 * SEC))).toEqual({ attempted: 0, purged: 0 });
    expect(announced).toHaveLength(1);
  });

  it('re-delivery of the same event with nothing left to purge is a no-op: no announce, no pending row, no error', async () => {
    const { h, pool, announced } = await makeHarness();
    await seed(pool, target);
    await fireAgentDeleted(h, target);
    expect(announced).toHaveLength(1);

    await fireAgentDeleted(h, target);
    expect(announced).toHaveLength(1);
    expect(await pendingRows(pool)).toEqual([]);
    expect(logRecords.filter((r) => r.level === 'error')).toEqual([]);
    const ok = logRecords.filter((r) => r.msg === okMsg);
    expect(ok.map((r) => r.rec.count)).toEqual([3, 0]);
  });

  it('a pending row left by a crash (no event ever retried) is purged by the first sweep', async () => {
    const { plugin, pool, announced } = await makeHarness();
    const { ids, other } = await seed(pool, target);
    await pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ($1, $2)`,
      ['agent', target],
    );

    // Allow for clock skew between this process and the database container.
    const res = await plugin.sweepPendingPurges(new Date(Date.now() + 60 * SEC));
    expect(res).toEqual({ attempted: 1, purged: 1 });
    expect(await countConversations(pool, ids)).toBe(0);
    expect(await countConversations(pool, [other])).toBe(1);
    expect(await pendingRows(pool)).toEqual([]);
    expect(announced).toHaveLength(1);
    expect([...announced[0]!].sort()).toEqual([...ids].sort());
  });

  it('overlapping sweep passes are joined: one purge, one announcement', async () => {
    const { plugin, pool, announced } = await makeHarness();
    const { ids } = await seed(pool, target);
    await pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ($1, $2)`,
      ['agent', target],
    );
    const now = new Date(Date.now() + 60 * SEC);
    const [a, b] = await Promise.all([plugin.sweepPendingPurges(now), plugin.sweepPendingPurges(now)]);
    expect(a).toEqual({ attempted: 1, purged: 1 });
    expect(b).toBe(a);
    expect(announced).toHaveLength(1);
    expect([...announced[0]!].sort()).toEqual([...ids].sort());
  });

  it('two hosts sweeping the same pending row at once purge it once and announce once', async () => {
    // Two plugin instances on one database: the in-process single-flight can't
    // help here, only the row locks inside the purge transaction can.
    const one = await makeHarness();
    const two = await makeHarness();
    const { ids } = await seed(one.pool, target);
    await one.pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ($1, $2)`,
      ['agent', target],
    );
    const now = new Date(Date.now() + 60 * SEC);
    await Promise.all([one.plugin.sweepPendingPurges(now), two.plugin.sweepPendingPurges(now)]);
    const all = [...one.announced, ...two.announced];
    expect(all).toHaveLength(1);
    expect([...all[0]!].sort()).toEqual([...ids].sort());
    expect(await countConversations(one.pool, ids)).toBe(0);
    expect(await pendingRows(one.pool)).toEqual([]);
  });

  it('backoff doubles from 30 s per failed attempt and caps at one hour', async () => {
    const { plugin, pool, announced } = await makeHarness();
    const { ids } = await seed(pool, target);
    await pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ($1, $2)`,
      ['agent', target],
    );
    await breakPurge(pool);

    const delays: number[] = [];
    let now = new Date(Date.now() + 60 * SEC);
    for (let i = 0; i < 9; i++) {
      expect(await plugin.sweepPendingPurges(now)).toEqual({ attempted: 1, purged: 0 });
      const [row] = await pendingRows(pool);
      expect(row!.attempts).toBe(i + 1);
      expect(row!.last_error).toBe(injected);
      delays.push((row!.next_attempt_at.getTime() - now.getTime()) / SEC);
      now = new Date(row!.next_attempt_at.getTime() + SEC);
    }
    expect(delays).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600]);
    expect(announced).toEqual([]);
    expect(await countConversations(pool, ids)).toBe(ids.length);

    await fixPurge(pool);
    expect(await plugin.sweepPendingPurges(now)).toEqual({ attempted: 1, purged: 1 });
    expect(await countConversations(pool, ids)).toBe(0);
    expect(await pendingRows(pool)).toEqual([]);
    expect(announced).toHaveLength(1);
  });

  it('last_error keeps a long message cut to 500 characters and an ellipsis', async () => {
    const { h, pool } = await makeHarness();
    await seed(pool, target);
    await breakPurge(pool, 'x'.repeat(2000));

    await fireAgentDeleted(h, target);

    const rows = await pendingRows(pool);
    expect(rows.map((r) => r.last_error)).toEqual([`${'x'.repeat(500)}…`]);
  });

  it('the timer runs the sweep on its own (startup pass included) — no manual call', async () => {
    const { pool, announced } = await makeHarness(createConversationsPlugin({ purgeSweepIntervalMs: 50 }));
    const { ids } = await seed(pool, target);
    await pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id, next_attempt_at)
       VALUES ($1, $2, NOW() - interval '1 hour')`,
      ['agent', target],
    );
    const deadline = Date.now() + 10 * SEC;
    while ((await pendingRows(pool)).length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await pendingRows(pool)).toEqual([]);
    expect(await countConversations(pool, ids)).toBe(0);
    expect(announced).toHaveLength(1);
  });
});

// The production preset passes no options, so the defaults are what runs: a
// pass every 60 s, plus one 5 s after init for rows a crash left behind.
describe('durable purge — the sweep schedule', () => {
  /**
   * The delays of the timers that run the sweep, set while `boot` runs. They
   * are picked out by what they run, so the harness's and pg's own timers
   * don't count.
   */
  async function sweepTimers(boot: () => Promise<unknown>): Promise<{ intervals: unknown[]; timeouts: unknown[] }> {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await boot();
      const delays = (calls: unknown[][]) =>
        calls.filter(([fn]) => String(fn).includes('sweepInBackground')).map(([, ms]) => ms);
      return { intervals: delays(setIntervalSpy.mock.calls), timeouts: delays(setTimeoutSpy.mock.calls) };
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  }

  it('with no options, sweeps every 60 s and once 5 s after init', async () => {
    expect(await sweepTimers(() => makeHarness(createConversationsPlugin()))).toEqual({
      intervals: [60_000],
      timeouts: [5_000],
    });
  });

  it('purgeSweepIntervalMs: 0 sets neither timer', async () => {
    expect(
      await sweepTimers(() => makeHarness(createConversationsPlugin({ purgeSweepIntervalMs: 0 }))),
    ).toEqual({ intervals: [], timeouts: [] });
  });
});

describe('durable purge — when the pending record itself cannot be written', () => {
  it('still never throws, logs the enqueue failure, and announces nothing for a purge that cannot commit', async () => {
    const { h, pool, announced } = await makeHarness();
    const { ids } = await seed(pool, 'agt_gone');
    await pool.query('DROP TABLE conversations_v1_pending_purges');

    await expect(fireAgentDeleted(h, 'agt_gone')).resolves.toBeDefined();

    expect(logRecords.filter((r) => r.msg === 'conversations_purge_enqueue_failed')).toHaveLength(1);
    expect(logRecords.filter((r) => r.msg === 'hook_subscriber_failed')).toEqual([]);
    // The dequeue is part of the purge transaction, so with no table the purge rolls back.
    expect(await countConversations(pool, ids)).toBe(ids.length);
    expect(announced).toEqual([]);
  });
});

// The sweep purges one row after another, so one attempt that throws ends the
// pass and strands every row behind it. On the sweep's path a row's kind comes
// back from the database.
describe('durable purge — a pending row of a kind this build does not know', () => {
  it('is logged and skipped, and the agent row behind it in the same pass is still purged', async () => {
    const { plugin, pool, announced } = await makeHarness();
    const { ids } = await seed(pool, target);
    await pool.query(`INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ('agent', $1)`, [target]);
    // The sweep logs through its own ctx, whose logger writes JSON lines to stdout.
    const stdout = vi.spyOn(process.stdout, 'write');
    extraDue.rows = [{ kind: 'project', targetId: 'prj_gone' }];
    let lines: string[];
    try {
      expect(await plugin.sweepPendingPurges(new Date(Date.now() + 60 * SEC))).toEqual({ attempted: 2, purged: 1 });
    } finally {
      extraDue.rows = [];
      lines = stdout.mock.calls.map(([chunk]) => String(chunk));
      stdout.mockRestore();
    }

    expect(await countConversations(pool, ids)).toBe(0);
    expect(announced).toHaveLength(1);
    expect(await pendingRows(pool)).toEqual([]);
    const unknown = lines
      .filter((line) => line.includes('conversations_purge_unknown_kind'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(unknown).toEqual([
      expect.objectContaining({ level: 'error', msg: 'conversations_purge_unknown_kind', kind: 'project', targetId: 'prj_gone' }),
    ]);
  });
});

// TASK-904. W3 (#991, reverted in #1004) shipped this same outbox, but its
// CHECK also allowed a 'project' kind, and a database that ran it may still
// hold a project row. CREATE TABLE IF NOT EXISTS keeps that table as it is;
// only agent rows are ever read, so a leftover project row is never retried.
describe('durable purge — over a database that ran the reverted W3 migration', () => {
  it('a database that ran the reverted W3 migration keeps its table, and the sweep never touches a leftover project row', async () => {
    // W3's DDL (#991): the same table, but its CHECK also allowed 'project'.
    const pre = new pg.Client({ connectionString });
    await pre.connect();
    try {
      await pre.query(`CREATE TABLE conversations_v1_pending_purges (
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'project')), target_id TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT NULL, PRIMARY KEY (kind, target_id))`);
      await pre.query(`INSERT INTO conversations_v1_pending_purges (kind, target_id, next_attempt_at)
        VALUES ('project', 'prj_gone', NOW() - interval '1 hour')`);
    } finally {
      await pre.end();
    }
    const { plugin, pool, announced } = await makeHarness();
    const { ids } = await seed(pool, 'agt_gone');
    await pool.query(`INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ('agent', 'agt_gone')`);

    expect(await plugin.sweepPendingPurges(new Date(Date.now() + 60 * SEC))).toEqual({ attempted: 1, purged: 1 });
    expect(await countConversations(pool, ids)).toBe(0);
    expect(announced).toHaveLength(1);
    expect((await pendingRows(pool)).map((r) => [r.kind, r.target_id, r.attempts])).toEqual([
      ['project', 'prj_gone', 0],
    ]);
  });
});
