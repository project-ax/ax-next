import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createLogger,
  makeAgentContext,
  PluginError,
  type AgentContext,
} from '@ax/core';
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
import { createConversationsPlugin } from '../plugin.js';
import type {
  AppendEventInput,
  AppendEventOutput,
  AppendTranscriptInput,
  AppendTranscriptOutput,
  ConversationsPurgedEvent,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  HideInput,
  ReplaceTranscriptInput,
  ReplaceTranscriptOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-718 — deleting an agent purges its conversations.
//
// Two halves, one real-Postgres container:
//   1. the `agents:deleted` subscriber (purge + `conversations:purged` fan-out);
//   2. the append-path guards that stop an in-flight turn finishing AFTER the
//      purge from resurrecting orphan rows.
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

/** A ctx whose logger records every line, so tests can assert on what was logged. */
function capturingCtx(userId = 'system'): AgentContext {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId,
    logger: createLogger({
      reqId: 'purge-test',
      writer: (line: string) => {
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          logRecords.push({
            msg: String(rec.msg ?? ''),
            level: String(rec.level ?? ''),
            rec,
          });
        } catch {
          /* ignore non-JSON */
        }
      },
    }),
  });
}

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'team' } };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

function makePool(): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 2 });
  pools.push(pool);
  return pool;
}

/** Row counts for a set of conversation ids, straight from the tables. */
async function countRows(
  pool: pg.Pool,
  conversationIds: string[],
): Promise<{ conversations: number; events: number; transcripts: number }> {
  const one = async (table: string): Promise<number> => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE conversation_id = ANY($1::text[])`,
      [conversationIds],
    );
    return (r.rows[0] as { n: number }).n;
  };
  return {
    conversations: await one('conversations_v1_conversations'),
    events: await one('conversations_v1_events'),
    transcripts: await one('conversations_v1_transcripts'),
  };
}

async function createConv(
  h: TestHarness,
  userId: string,
  agentId: string,
): Promise<string> {
  const created = await h.bus.call<CreateInput, CreateOutput>(
    'conversations:create',
    h.ctx({ userId }),
    { userId, agentId },
  );
  return created.conversationId;
}

const EMPTY_HASH = createHash('sha256').digest('hex');
const LINE_A = '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}';
const LINE_B =
  '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}';

/** Give a conversation one display event and one transcript line, via the hooks. */
async function seedChildren(h: TestHarness, conversationId: string): Promise<void> {
  await h.bus.call<AppendEventInput, AppendEventOutput>(
    'conversations:append-event',
    h.ctx({ userId: 'system' }),
    { conversationId, kind: 'turn', role: 'user', payload: { blocks: [] } },
  );
  await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
    'conversations:append-transcript',
    h.ctx({ userId: 'system' }),
    { conversationId, fromSeq: 0, prefixHash: EMPTY_HASH, lines: [LINE_A] },
  );
}

async function fireAgentDeleted(
  h: TestHarness,
  ctx: AgentContext,
  agentId: string,
): Promise<void> {
  await h.bus.fire('agents:deleted', ctx, {
    agentId,
    ownerId: 'u_owner',
    ownerType: 'user',
  });
}

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
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_transcripts');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_events');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
  while (pools.length > 0) {
    await pools.pop()!.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('conversations: agents:deleted subscriber (TASK-718)', () => {
  it('purges every conversation of the agent (all users, hidden, soft-deleted) with its events and transcripts, leaves other agents alone, and announces the ids AFTER the commit', async () => {
    const h = await makeHarness();
    const pool = makePool();

    // Agent A (a team agent): two users, one hidden, one soft-deleted.
    const aAlice = await createConv(h, 'alice', 'agt_a');
    const aBob = await createConv(h, 'bob', 'agt_a');
    const aHidden = await createConv(h, 'alice', 'agt_a');
    await h.bus.call<HideInput, void>('conversations:hide', h.ctx({ userId: 'alice' }), {
      conversationId: aHidden,
      userId: 'alice',
    });
    const aDeleted = await createConv(h, 'bob', 'agt_a');
    await h.bus.call<DeleteInput, DeleteOutput>(
      'conversations:delete',
      h.ctx({ userId: 'bob' }),
      { conversationId: aDeleted, userId: 'bob' },
    );
    // Agent B: same users, must survive.
    const bAlice = await createConv(h, 'alice', 'agt_b');
    const bBob = await createConv(h, 'bob', 'agt_b');

    const aIds = [aAlice, aBob, aHidden, aDeleted];
    const bIds = [bAlice, bBob];
    for (const id of [...aIds, ...bIds]) await seedChildren(h, id);
    expect(await countRows(pool, aIds)).toEqual({ conversations: 4, events: 4, transcripts: 4 });

    // Listen for the announcement, and look at the database FROM the listener:
    // a fire inside the (uncommitted) transaction would still see the rows.
    const announced: string[][] = [];
    const rowsSeenByListener: Array<{ conversations: number; events: number; transcripts: number }> = [];
    h.bus.subscribe<ConversationsPurgedEvent>(
      'conversations:purged',
      'test-listener',
      async (_ctx, payload) => {
        announced.push([...payload.conversationIds]);
        rowsSeenByListener.push(await countRows(pool, aIds));
        return undefined;
      },
    );

    const ctx = capturingCtx();
    await fireAgentDeleted(h, ctx, 'agt_a');

    expect(await countRows(pool, aIds)).toEqual({ conversations: 0, events: 0, transcripts: 0 });
    expect(await countRows(pool, bIds)).toEqual({ conversations: 2, events: 2, transcripts: 2 });

    expect(announced).toHaveLength(1);
    expect([...announced[0]!].sort()).toEqual([...aIds].sort());
    expect(rowsSeenByListener).toEqual([{ conversations: 0, events: 0, transcripts: 0 }]);

    const info = logRecords.filter((r) => r.msg === 'conversations_purged_for_deleted_agent');
    expect(info).toHaveLength(1);
    expect(info[0]!.level).toBe('info');
    expect(info[0]!.rec.agentId).toBe('agt_a');
    expect(info[0]!.rec.count).toBe(4);
    // Nothing failed, so nothing shouted.
    expect(logRecords.filter((r) => r.level === 'error')).toEqual([]);
  });

  it('announces at most 500 ids per fire, and every purged id exactly once', async () => {
    const h = await makeHarness();
    const pool = makePool();
    // A first hook call runs init (and the migration); after that the tables exist.
    const seedId = await createConv(h, 'alice', 'agt_big');
    const other = await createConv(h, 'alice', 'agt_other');
    // 1202 more rows for agt_big, inserted in bulk (creating them one hook call
    // at a time would take minutes and prove nothing extra).
    await pool.query(
      `INSERT INTO conversations_v1_conversations (conversation_id, user_id, agent_id)
       SELECT 'cnv_bulk_' || g, 'user_' || (g % 7), 'agt_big' FROM generate_series(1, 1202) AS g`,
    );
    const total = 1203;

    const fires: string[][] = [];
    h.bus.subscribe<ConversationsPurgedEvent>(
      'conversations:purged',
      'test-listener',
      async (_ctx, payload) => {
        fires.push([...payload.conversationIds]);
        return undefined;
      },
    );

    await fireAgentDeleted(h, capturingCtx(), 'agt_big');

    expect(fires.map((f) => f.length)).toEqual([500, 500, 203]);
    const all = fires.flat();
    expect(all).toHaveLength(total);
    expect(new Set(all).size).toBe(total);
    expect(all).toContain(seedId);
    expect(all).not.toContain(other);

    const left = await pool.query(
      `SELECT COUNT(*)::int AS n FROM conversations_v1_conversations WHERE agent_id = 'agt_big'`,
    );
    expect((left.rows[0] as { n: number }).n).toBe(0);
    expect((await countRows(pool, [other])).conversations).toBe(1);
  });

  it('fires nothing when the agent has no conversations', async () => {
    const h = await makeHarness();
    const pool = makePool();
    const keep = await createConv(h, 'alice', 'agt_b');

    const fires: string[][] = [];
    h.bus.subscribe<ConversationsPurgedEvent>(
      'conversations:purged',
      'test-listener',
      async (_ctx, payload) => {
        fires.push([...payload.conversationIds]);
        return undefined;
      },
    );

    await fireAgentDeleted(h, capturingCtx(), 'agt_never_chatted');

    expect(fires).toEqual([]);
    expect((await countRows(pool, [keep])).conversations).toBe(1);
    expect(logRecords.filter((r) => r.level === 'error')).toEqual([]);
    // Proves the subscriber actually RAN and found nothing, as opposed to no
    // subscriber existing (which would also fire nothing).
    const info = logRecords.filter((r) => r.msg === 'conversations_purged_for_deleted_agent');
    expect(info).toHaveLength(1);
    expect(info[0]!.rec.count).toBe(0);
  });

  it('logs an error and swallows when the purge fails — never throws, keeps the rows, announces nothing', async () => {
    const h = await makeHarness();
    const pool = makePool();
    const c = await createConv(h, 'alice', 'agt_a');
    await seedChildren(h, c);

    // Break the purge transaction's first statement.
    await pool.query('DROP TABLE conversations_v1_events');

    const fires: string[][] = [];
    h.bus.subscribe<ConversationsPurgedEvent>(
      'conversations:purged',
      'test-listener',
      async (_ctx, payload) => {
        fires.push([...payload.conversationIds]);
        return undefined;
      },
    );

    await expect(fireAgentDeleted(h, capturingCtx(), 'agt_a')).resolves.toBeUndefined();

    const failed = logRecords.filter(
      (r) => r.msg === 'conversations_purge_for_deleted_agent_failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.level).toBe('error');
    expect(failed[0]!.rec.agentId).toBe('agt_a');
    expect(failed[0]!.rec.err).toBeDefined();
    // The subscriber swallowed it: the bus's own "a subscriber threw" report
    // must NOT have fired.
    expect(logRecords.filter((r) => r.msg === 'hook_subscriber_failed')).toEqual([]);
    expect(fires).toEqual([]);
    // The transaction rolled back: the conversation row is still there. (Read
    // it directly: countRows also counts events, and that table is gone.)
    const rows = await pool.query(
      'SELECT COUNT(*)::int AS n FROM conversations_v1_conversations WHERE conversation_id = $1',
      [c],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it.each([
    ['a missing agentId', {}],
    ['an empty agentId', { agentId: '' }],
    ['a non-string agentId', { agentId: 42 }],
  ])('refuses %s: deletes nothing, announces nothing, logs and swallows', async (_label, payload) => {
    const h = await makeHarness();
    const pool = makePool();
    const c = await createConv(h, 'alice', 'agt_a');
    await seedChildren(h, c);

    const fires: string[][] = [];
    h.bus.subscribe<ConversationsPurgedEvent>(
      'conversations:purged',
      'test-listener',
      async (_ctx, p) => {
        fires.push([...p.conversationIds]);
        return undefined;
      },
    );

    await expect(
      h.bus.fire('agents:deleted', capturingCtx(), payload),
    ).resolves.toBeDefined();

    expect(
      logRecords.filter((r) => r.msg === 'conversations_purge_for_deleted_agent_failed'),
    ).toHaveLength(1);
    expect(logRecords.filter((r) => r.msg === 'hook_subscriber_failed')).toEqual([]);
    expect(fires).toEqual([]);
    expect(await countRows(pool, [c])).toEqual({ conversations: 1, events: 1, transcripts: 1 });
  });
});

describe('conversations: append paths after a purge (TASK-718)', () => {
  /** Create a conversation with children, then purge its agent. */
  async function purgedConversation(h: TestHarness): Promise<string> {
    const c = await createConv(h, 'alice', 'agt_gone');
    await seedChildren(h, c);
    await fireAgentDeleted(h, capturingCtx(), 'agt_gone');
    return c;
  }

  it('conversations:append-event on a purged conversation writes nothing and does not throw', async () => {
    const h = await makeHarness();
    const pool = makePool();
    const c = await purgedConversation(h);
    expect(await countRows(pool, [c])).toEqual({ conversations: 0, events: 0, transcripts: 0 });

    // The in-flight turn that finishes after the delete.
    await expect(
      h.bus.call<AppendEventInput, AppendEventOutput>(
        'conversations:append-event',
        h.ctx({ userId: 'alice' }),
        { conversationId: c, kind: 'turn', role: 'assistant', payload: { blocks: [] } },
      ),
    ).resolves.toBeUndefined();

    expect(await countRows(pool, [c])).toEqual({ conversations: 0, events: 0, transcripts: 0 });
  });

  it('conversations:append-event on an id that never existed writes nothing', async () => {
    const h = await makeHarness();
    const pool = makePool();
    await createConv(h, 'alice', 'agt_a'); // init + migration
    await h.bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      h.ctx({ userId: 'alice' }),
      { conversationId: 'cnv_never_existed', kind: 'turn', role: 'user', payload: { blocks: [] } },
    );
    expect(await countRows(pool, ['cnv_never_existed'])).toEqual({
      conversations: 0,
      events: 0,
      transcripts: 0,
    });
  });

  it('conversations:append-transcript on a purged conversation throws not-found and writes nothing', async () => {
    const h = await makeHarness();
    const pool = makePool();
    const c = await purgedConversation(h);

    // fromSeq 0 + the empty-prefix hash is a VALID append against an empty
    // transcript: an unguarded handler would happily write this row.
    const err = await h.bus
      .call<AppendTranscriptInput, AppendTranscriptOutput>(
        'conversations:append-transcript',
        h.ctx({ userId: 'alice' }),
        { conversationId: c, fromSeq: 0, prefixHash: EMPTY_HASH, lines: [LINE_B] },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('not-found');
    expect((err as PluginError).plugin).toBe('@ax/conversations');
    expect(await countRows(pool, [c])).toEqual({ conversations: 0, events: 0, transcripts: 0 });
  });

  it('conversations:replace-transcript on a purged conversation throws not-found and writes nothing', async () => {
    const h = await makeHarness();
    const pool = makePool();
    const c = await purgedConversation(h);

    const err = await h.bus
      .call<ReplaceTranscriptInput, ReplaceTranscriptOutput>(
        'conversations:replace-transcript',
        h.ctx({ userId: 'alice' }),
        { conversationId: c, lines: [LINE_A, LINE_B] },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('not-found');
    expect(await countRows(pool, [c])).toEqual({ conversations: 0, events: 0, transcripts: 0 });
  });

  it('still writes for a conversation that exists — live, or soft-deleted from the sidebar', async () => {
    const h = await makeHarness();
    const pool = makePool();
    const live = await createConv(h, 'alice', 'agt_a');
    const tombstoned = await createConv(h, 'alice', 'agt_a');
    await h.bus.call<DeleteInput, DeleteOutput>(
      'conversations:delete',
      h.ctx({ userId: 'alice' }),
      { conversationId: tombstoned, userId: 'alice' },
    );

    for (const id of [live, tombstoned]) {
      await h.bus.call<AppendEventInput, AppendEventOutput>(
        'conversations:append-event',
        h.ctx({ userId: 'alice' }),
        { conversationId: id, kind: 'turn', role: 'user', payload: { blocks: [] } },
      );
      const appended = await h.bus.call<AppendTranscriptInput, AppendTranscriptOutput>(
        'conversations:append-transcript',
        h.ctx({ userId: 'alice' }),
        { conversationId: id, fromSeq: 0, prefixHash: EMPTY_HASH, lines: [LINE_A] },
      );
      expect(appended).toEqual({ outcome: 'appended', maxSeq: 1 });
      const replaced = await h.bus.call<ReplaceTranscriptInput, ReplaceTranscriptOutput>(
        'conversations:replace-transcript',
        h.ctx({ userId: 'alice' }),
        { conversationId: id, lines: [LINE_A, LINE_B] },
      );
      expect(replaced).toEqual({ maxSeq: 2 });
      expect(await countRows(pool, [id])).toEqual({ conversations: 1, events: 1, transcripts: 2 });
    }
  });
});
