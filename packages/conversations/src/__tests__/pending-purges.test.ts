import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import type { ConversationsPurgedEvent, CreateInput, CreateOutput } from '../types.js';

// ---------------------------------------------------------------------------
// Durable chat purge. `agents:deleted` and `projects:deleted` each fire ONCE,
// after the source row is gone. A purge that failed used to be logged and
// forgotten, leaving the deleted agent's / project's chats behind for good.
// Now the subscriber records a pending purge first, the purge transaction
// removes that record as it commits, and a sweep retries whatever is left
// (a failure, or a crash mid-purge) with backoff until it succeeds.
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
  purgeSweepIntervalMs = 0,
): Promise<{ h: TestHarness; plugin: ConversationsPlugin; pool: pg.Pool; announced: string[][] }> {
  const plugin = createConversationsPlugin({ purgeSweepIntervalMs });
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

interface KindCase {
  kind: 'agent' | 'project';
  column: 'agent_id' | 'project_id';
  failMsg: string;
  okMsg: string;
  fire(h: TestHarness, targetId: string): Promise<unknown>;
}

const KINDS: KindCase[] = [
  {
    kind: 'agent',
    column: 'agent_id',
    failMsg: 'conversations_purge_for_deleted_agent_failed',
    okMsg: 'conversations_purged_for_deleted_agent',
    fire: (h, agentId) =>
      h.bus.fire('agents:deleted', capturingCtx(), { agentId, ownerId: 'u_owner', ownerType: 'user' }),
  },
  {
    kind: 'project',
    column: 'project_id',
    failMsg: 'conversations_purge_for_deleted_project_failed',
    okMsg: 'conversations_purged_for_deleted_project',
    fire: (h, projectId) => h.bus.fire('projects:deleted', capturingCtx(), { projectId }),
  },
];

/** Seed `n` chats for the target (with a child event + transcript row each) and one bystander. */
async function seed(pool: pg.Pool, k: KindCase, targetId: string, n = 3): Promise<{ ids: string[]; other: string }> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `cnv_${k.kind}_${targetId}_${i}`;
    ids.push(id);
    await pool.query(
      `INSERT INTO conversations_v1_conversations (conversation_id, user_id, agent_id, project_id)
       VALUES ($1, $2, $3, $4)`,
      [id, `user_${i}`, k.kind === 'agent' ? targetId : 'agt_x', k.kind === 'project' ? targetId : null],
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
  const other = `cnv_${k.kind}_bystander`;
  await pool.query(
    `INSERT INTO conversations_v1_conversations (conversation_id, user_id, agent_id, project_id)
     VALUES ($1, 'user_0', 'agt_other', 'prj_other')`,
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

/** Make every delete of a conversation row fail (the purge's LAST statement, so the child deletes must roll back too). */
async function breakPurge(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION test_fail_purge() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected purge failure'; END
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

describe.each(KINDS)('durable purge — $kind', (k) => {
  const target = k.kind === 'agent' ? 'agt_gone' : 'prj_gone';

  it('success path: purges, announces once, and leaves no pending row', async () => {
    const { h, pool, announced } = await makeHarness();
    const { ids, other } = await seed(pool, k, target);

    await k.fire(h, target);

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
    const { ids, other } = await seed(pool, k, target);
    await breakPurge(pool);

    const before = Date.now();
    await expect(k.fire(h, target)).resolves.toBeDefined();
    const after = Date.now();

    // Rolled back entirely: chats AND their children are all still there.
    expect(await countConversations(pool, ids)).toBe(ids.length);
    expect(await countChildren(pool, ids)).toBe(ids.length * 2);
    expect(announced).toEqual([]);
    const failed = logRecords.filter((r) => r.msg === k.failMsg);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.level).toBe('error');
    expect(logRecords.filter((r) => r.msg === 'hook_subscriber_failed')).toEqual([]);

    const rows = await pendingRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(k.kind);
    expect(rows[0]!.target_id).toBe(target);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.last_error).toContain('injected purge failure');
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
    await seed(pool, k, target);
    await k.fire(h, target);
    expect(announced).toHaveLength(1);

    await k.fire(h, target);
    expect(announced).toHaveLength(1);
    expect(await pendingRows(pool)).toEqual([]);
    expect(logRecords.filter((r) => r.level === 'error')).toEqual([]);
    const ok = logRecords.filter((r) => r.msg === k.okMsg);
    expect(ok.map((r) => r.rec.count)).toEqual([3, 0]);
  });

  it('a pending row left by a crash (no event ever retried) is purged by the first sweep', async () => {
    const { plugin, pool, announced } = await makeHarness();
    const { ids, other } = await seed(pool, k, target);
    await pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ($1, $2)`,
      [k.kind, target],
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
    const { ids } = await seed(pool, k, target);
    await pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ($1, $2)`,
      [k.kind, target],
    );
    const now = new Date(Date.now() + 60 * SEC);
    const [a, b] = await Promise.all([plugin.sweepPendingPurges(now), plugin.sweepPendingPurges(now)]);
    expect(a).toEqual({ attempted: 1, purged: 1 });
    expect(b).toBe(a);
    expect(announced).toHaveLength(1);
    expect([...announced[0]!].sort()).toEqual([...ids].sort());
  });

  it('backoff doubles from 30 s per failed attempt and caps at one hour', async () => {
    const { plugin, pool, announced } = await makeHarness();
    const { ids } = await seed(pool, k, target);
    await pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ($1, $2)`,
      [k.kind, target],
    );
    await breakPurge(pool);

    const delays: number[] = [];
    let now = new Date(Date.now() + 60 * SEC);
    for (let i = 0; i < 9; i++) {
      expect(await plugin.sweepPendingPurges(now)).toEqual({ attempted: 1, purged: 0 });
      const [row] = await pendingRows(pool);
      expect(row!.attempts).toBe(i + 1);
      expect(row!.last_error).toContain('injected purge failure');
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

  it('the timer runs the sweep on its own (startup pass included) — no manual call', async () => {
    const { pool, announced } = await makeHarness(50);
    const { ids } = await seed(pool, k, target);
    await pool.query(
      `INSERT INTO conversations_v1_pending_purges (kind, target_id, next_attempt_at)
       VALUES ($1, $2, NOW() - interval '1 hour')`,
      [k.kind, target],
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

describe('durable purge — when the pending record itself cannot be written', () => {
  it('still never throws, logs the enqueue failure, and announces nothing for a purge that cannot commit', async () => {
    const { h, pool, announced } = await makeHarness();
    const { ids } = await seed(pool, KINDS[0]!, 'agt_gone');
    await pool.query('DROP TABLE conversations_v1_pending_purges');

    await expect(KINDS[0]!.fire(h, 'agt_gone')).resolves.toBeDefined();

    expect(logRecords.filter((r) => r.msg === 'conversations_purge_enqueue_failed')).toHaveLength(1);
    expect(logRecords.filter((r) => r.msg === 'hook_subscriber_failed')).toEqual([]);
    // The dequeue is part of the purge transaction, so with no table the purge rolls back.
    expect(await countConversations(pool, ids)).toBe(ids.length);
    expect(announced).toEqual([]);
  });
});
