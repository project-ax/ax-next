import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { GetMetadataOutputSchema } from '../types.js';
import type {
  ConversationsPurgedEvent,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  GetInput,
  GetMetadataInput,
  GetMetadataOutput,
  GetOutput,
  HideInput,
  ListInput,
  ListOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// W3a (§4.4, §4.7): a chat belongs to at most one project.
//
//   - conversations:create { projectId } is checked with projects:resolve,
//     AS the person the chat is for (input.userId), before anything is written;
//   - with no projects:resolve service, a projectId is refused, never dropped;
//   - projectId round-trips through get / list / get-metadata (the AW-6 strip);
//   - conversations:list filters by project;
//   - projects:deleted purges the project's chats for EVERY user (Q1).
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const pools: pg.Pool[] = [];

interface ResolveCall {
  actor: string;
  projectId: string;
  agentId: string;
}

interface LogRecord {
  msg: string;
  level: string;
  rec: Record<string, unknown>;
}
let logRecords: LogRecord[] = [];

function capturingCtx(userId = 'system'): AgentContext {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId,
    logger: createLogger({
      reqId: 'projects-test',
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

/**
 * `projects` maps a projectId to the set of `actor|agentId` pairs allowed to
 * resolve it. Pass `projects: null` to build a harness with NO projects:resolve
 * service (as when @ax/projects isn't loaded).
 */
async function makeHarness(
  projects: ReadonlyMap<string, ReadonlySet<string>> | null,
): Promise<{ h: TestHarness; resolveCalls: ResolveCall[] }> {
  const resolveCalls: ResolveCall[] = [];
  const services: Record<string, (ctx: AgentContext, input: unknown) => Promise<unknown>> = {
    'agents:resolve': async (_ctx, input: unknown) => {
      const call = input as { agentId: string };
      return { agent: { id: call.agentId, visibility: 'team' } };
    },
  };
  if (projects !== null) {
    services['projects:resolve'] = async (ctx, input: unknown) => {
      const call = input as { projectId: string; agentId: string };
      resolveCalls.push({ actor: ctx.userId, projectId: call.projectId, agentId: call.agentId });
      const allowed = projects.get(call.projectId);
      if (allowed === undefined || !allowed.has(`${ctx.userId}|${call.agentId}`)) {
        throw new PluginError({
          code: 'not-found',
          plugin: 'mock-projects',
          hookName: 'projects:resolve',
          message: 'project not found',
        });
      }
      return {
        projectId: call.projectId,
        name: 'Q4 launch',
        description: null,
        folderId: 'fld_1',
        readOnly: false,
      };
    };
  }
  const h = await createTestHarness({
    services,
    plugins: [createDatabasePostgresPlugin({ connectionString }), createConversationsPlugin()],
  });
  harnesses.push(h);
  return { h, resolveCalls };
}

function makePool(): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 2 });
  pools.push(pool);
  return pool;
}

async function countConversations(pool: pg.Pool): Promise<number> {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM conversations_v1_conversations');
  return (r.rows[0] as { n: number }).n;
}

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

async function create(
  h: TestHarness,
  input: CreateInput,
  ctx: AgentContext = h.ctx({ userId: input.userId }),
): Promise<CreateOutput> {
  return h.bus.call<CreateInput, CreateOutput>('conversations:create', ctx, input);
}

/** Gives a conversation one display event and one transcript row, straight in SQL. */
async function seedChildren(pool: pg.Pool, conversationId: string): Promise<void> {
  await pool.query(
    `INSERT INTO conversations_v1_events (conversation_id, seq, event_kind, role, fold_key, payload)
     VALUES ($1, 1, 'turn', 'user', 'k1', '{"blocks":[]}'::jsonb)`,
    [conversationId],
  );
  await pool.query(
    `INSERT INTO conversations_v1_transcripts (conversation_id, seq, line) VALUES ($1, 1, '{}')`,
    [conversationId],
  );
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
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_pending_purges');
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

const PRJ = 'prj_q4';
const ALICE_CAN_USE_PRJ = new Map([[PRJ, new Set(['alice|agt_a'])]]);

describe('conversations:create with a projectId (W3a §4.4)', () => {
  it('resolves the project as the person the chat is for, then stores it', async () => {
    const { h, resolveCalls } = await makeHarness(ALICE_CAN_USE_PRJ);
    // channel-web creates with a system-ish ctx and names the user in the
    // payload. The actor projects:resolve sees must be that user.
    const conv = await create(
      h,
      { userId: 'alice', agentId: 'agt_a', projectId: PRJ },
      h.ctx({ userId: 'system' }),
    );
    expect(resolveCalls).toEqual([{ actor: 'alice', projectId: PRJ, agentId: 'agt_a' }]);
    expect(conv.projectId).toBe(PRJ);
  });

  it('a chat outside any project has projectId null and never calls projects:resolve', async () => {
    const { h, resolveCalls } = await makeHarness(ALICE_CAN_USE_PRJ);
    const conv = await create(h, { userId: 'alice', agentId: 'agt_a' });
    expect(conv.projectId).toBeNull();
    expect(resolveCalls).toEqual([]);
  });

  it('a caller cannot borrow someone else\'s project access by naming them in ctx', async () => {
    // Alice can use the project; bob cannot. Bob calling with Alice's ctx but
    // his own userId in the payload must resolve as BOB, and be refused.
    const { h, resolveCalls } = await makeHarness(ALICE_CAN_USE_PRJ);
    const pool = makePool();
    await expect(
      create(h, { userId: 'bob', agentId: 'agt_a', projectId: PRJ }, h.ctx({ userId: 'alice' })),
    ).rejects.toMatchObject({ code: 'not-found', plugin: '@ax/conversations' });
    expect(resolveCalls).toEqual([{ actor: 'bob', projectId: PRJ, agentId: 'agt_a' }]);
    expect(await countConversations(pool)).toBe(0);
  });

  it('refuses when projects:resolve fails, and writes nothing', async () => {
    const { h } = await makeHarness(ALICE_CAN_USE_PRJ);
    const pool = makePool();
    // Run init so the table exists to count.
    await create(h, { userId: 'alice', agentId: 'agt_a' });
    await expect(
      create(h, { userId: 'alice', agentId: 'agt_other', projectId: PRJ }),
    ).rejects.toMatchObject({ code: 'not-found', plugin: '@ax/conversations' });
    await expect(
      create(h, { userId: 'alice', agentId: 'agt_a', projectId: 'prj_nope' }),
    ).rejects.toBeInstanceOf(PluginError);
    expect(await countConversations(pool)).toBe(1);
  });

  it('refuses any projectId when projects:resolve is not registered — never drops it', async () => {
    const { h } = await makeHarness(null);
    const pool = makePool();
    await create(h, { userId: 'alice', agentId: 'agt_a' });
    await expect(
      create(h, { userId: 'alice', agentId: 'agt_a', projectId: PRJ }),
    ).rejects.toMatchObject({ code: 'forbidden', plugin: '@ax/conversations' });
    expect(await countConversations(pool)).toBe(1);
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
    ['an oversized string', 'p'.repeat(300)],
  ])('rejects %s as projectId with invalid-payload before any call', async (_label, projectId) => {
    const { h, resolveCalls } = await makeHarness(ALICE_CAN_USE_PRJ);
    await expect(
      create(h, { userId: 'alice', agentId: 'agt_a', projectId } as unknown as CreateInput),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(resolveCalls).toEqual([]);
  });
});

describe('projectId round-trips (W3a §4.4, AW-6 strip)', () => {
  it('survives conversations:get, conversations:list and conversations:get-metadata', async () => {
    const { h } = await makeHarness(ALICE_CAN_USE_PRJ);
    const inProject = await create(h, { userId: 'alice', agentId: 'agt_a', projectId: PRJ });
    const outside = await create(h, { userId: 'alice', agentId: 'agt_a' });
    const ctx = h.ctx({ userId: 'alice' });

    const got = await h.bus.call<GetInput, GetOutput>('conversations:get', ctx, {
      conversationId: inProject.conversationId,
      userId: 'alice',
    });
    expect(got.conversation.projectId).toBe(PRJ);

    const listed = await h.bus.call<ListInput, ListOutput>('conversations:list', ctx, {
      userId: 'alice',
    });
    const byId = new Map(listed.map((c) => [c.conversationId, c.projectId]));
    expect(byId.get(inProject.conversationId)).toBe(PRJ);
    expect(byId.get(outside.conversationId)).toBeNull();

    // get-metadata goes through a stripping z.object `returns` schema: a key
    // missing from the schema vanishes here, so assert the KEY, not just a value.
    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      ctx,
      { conversationId: inProject.conversationId, userId: 'alice' },
    );
    expect(md.projectId).toBe(PRJ);
    const mdOutside = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      ctx,
      { conversationId: outside.conversationId, userId: 'alice' },
    );
    expect(Object.prototype.hasOwnProperty.call(mdOutside, 'projectId')).toBe(true);
    expect(mdOutside.projectId).toBeNull();
  });

  it('GetMetadataOutputSchema keeps projectId (string and null)', () => {
    const base = {
      conversationId: 'c1',
      userId: 'u1',
      agentId: 'a1',
      runnerType: null,
      runnerSessionId: null,
      workspaceRef: null,
      title: null,
      lastActivityAt: null,
      createdAt: '2026-10-16T00:00:00.000Z',
      origin: 'web' as const,
      activeSessionId: null,
    };
    expect(GetMetadataOutputSchema.parse({ ...base, projectId: PRJ }).projectId).toBe(PRJ);
    const parsedNull = GetMetadataOutputSchema.parse({ ...base, projectId: null });
    expect(Object.prototype.hasOwnProperty.call(parsedNull, 'projectId')).toBe(true);
    expect(GetMetadataOutputSchema.safeParse({ ...base, projectId: 7 }).success).toBe(false);
  });
});

describe('conversations:list { projectId } (W3a §4.4)', () => {
  it('returns only the caller\'s chats in that project, newest first, combined with agentId', async () => {
    const projects = new Map([
      [PRJ, new Set(['alice|agt_a', 'alice|agt_b', 'bob|agt_a'])],
      ['prj_other', new Set(['alice|agt_a'])],
    ]);
    const { h } = await makeHarness(projects);
    const p1 = await create(h, { userId: 'alice', agentId: 'agt_a', projectId: PRJ });
    const p2 = await create(h, { userId: 'alice', agentId: 'agt_b', projectId: PRJ });
    await create(h, { userId: 'alice', agentId: 'agt_a', projectId: 'prj_other' });
    await create(h, { userId: 'alice', agentId: 'agt_a' });
    await create(h, { userId: 'bob', agentId: 'agt_a', projectId: PRJ });
    const ctx = h.ctx({ userId: 'alice' });

    const inProject = await h.bus.call<ListInput, ListOutput>('conversations:list', ctx, {
      userId: 'alice',
      projectId: PRJ,
    });
    expect(inProject.map((c) => c.conversationId)).toEqual([p2.conversationId, p1.conversationId]);

    const inProjectAgentA = await h.bus.call<ListInput, ListOutput>('conversations:list', ctx, {
      userId: 'alice',
      agentId: 'agt_a',
      projectId: PRJ,
    });
    expect(inProjectAgentA.map((c) => c.conversationId)).toEqual([p1.conversationId]);
  });

  it.each([
    ['an empty string', ''],
    ['a number', 7],
  ])('rejects %s as projectId with invalid-payload', async (_label, projectId) => {
    const { h } = await makeHarness(ALICE_CAN_USE_PRJ);
    await expect(
      h.bus.call<ListInput, ListOutput>('conversations:list', h.ctx({ userId: 'alice' }), {
        userId: 'alice',
        projectId,
      } as unknown as ListInput),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});

describe('projects:deleted subscriber (W3a §4.7, Q1)', () => {
  it('purges the project\'s chats for every user (hidden + soft-deleted too), leaves others, announces exactly those ids, and a repeat fire is a no-op', async () => {
    const projects = new Map([
      [PRJ, new Set(['alice|agt_a', 'bob|agt_a'])],
      ['prj_keep', new Set(['alice|agt_a'])],
    ]);
    const { h } = await makeHarness(projects);
    const pool = makePool();

    const pAlice = (await create(h, { userId: 'alice', agentId: 'agt_a', projectId: PRJ })).conversationId;
    const pBob = (await create(h, { userId: 'bob', agentId: 'agt_a', projectId: PRJ })).conversationId;
    const pHidden = (await create(h, { userId: 'alice', agentId: 'agt_a', projectId: PRJ })).conversationId;
    await h.bus.call<HideInput, void>('conversations:hide', h.ctx({ userId: 'alice' }), {
      conversationId: pHidden,
      userId: 'alice',
    });
    const pDeleted = (await create(h, { userId: 'bob', agentId: 'agt_a', projectId: PRJ })).conversationId;
    await h.bus.call<DeleteInput, DeleteOutput>('conversations:delete', h.ctx({ userId: 'bob' }), {
      conversationId: pDeleted,
      userId: 'bob',
    });
    const keepOther = (await create(h, { userId: 'alice', agentId: 'agt_a', projectId: 'prj_keep' })).conversationId;
    const keepNone = (await create(h, { userId: 'alice', agentId: 'agt_a' })).conversationId;

    const purgedIds = [pAlice, pBob, pHidden, pDeleted];
    const keptIds = [keepOther, keepNone];
    for (const id of [...purgedIds, ...keptIds]) await seedChildren(pool, id);

    const announced: string[][] = [];
    const seenByListener: Array<{ conversations: number; events: number; transcripts: number }> = [];
    h.bus.subscribe<ConversationsPurgedEvent>('conversations:purged', 'test-listener', async (_c, p) => {
      announced.push([...p.conversationIds]);
      seenByListener.push(await countRows(pool, purgedIds));
      return undefined;
    });

    await h.bus.fire('projects:deleted', capturingCtx(), { projectId: PRJ });

    expect(await countRows(pool, purgedIds)).toEqual({ conversations: 0, events: 0, transcripts: 0 });
    expect(await countRows(pool, keptIds)).toEqual({ conversations: 2, events: 2, transcripts: 2 });
    expect(announced).toHaveLength(1);
    expect([...announced[0]!].sort()).toEqual([...purgedIds].sort());
    // Announced AFTER the commit.
    expect(seenByListener).toEqual([{ conversations: 0, events: 0, transcripts: 0 }]);
    const info = logRecords.filter((r) => r.msg === 'conversations_purged_for_deleted_project');
    expect(info).toHaveLength(1);
    expect(info[0]!.rec.count).toBe(4);
    expect(logRecords.filter((r) => r.level === 'error')).toEqual([]);

    // At-least-once delivery: a second fire finds nothing and announces nothing.
    await h.bus.fire('projects:deleted', capturingCtx(), { projectId: PRJ });
    expect(announced).toHaveLength(1);
    expect(await countRows(pool, keptIds)).toEqual({ conversations: 2, events: 2, transcripts: 2 });
  });

  it('announces in chunks of at most 500 ids', async () => {
    const { h } = await makeHarness(ALICE_CAN_USE_PRJ);
    const pool = makePool();
    const seed = (await create(h, { userId: 'alice', agentId: 'agt_a', projectId: PRJ })).conversationId;
    await pool.query(
      `INSERT INTO conversations_v1_conversations (conversation_id, user_id, agent_id, project_id)
       SELECT 'cnv_bulk_' || g, 'user_' || (g % 7), 'agt_' || (g % 3), $1
         FROM generate_series(1, 600) AS g`,
      [PRJ],
    );
    const fires: string[][] = [];
    h.bus.subscribe<ConversationsPurgedEvent>('conversations:purged', 'test-listener', async (_c, p) => {
      fires.push([...p.conversationIds]);
      return undefined;
    });
    await h.bus.fire('projects:deleted', capturingCtx(), { projectId: PRJ });
    expect(fires.map((f) => f.length)).toEqual([500, 101]);
    expect(new Set(fires.flat()).size).toBe(601);
    expect(fires.flat()).toContain(seed);
  });

  it.each([
    ['a missing projectId', {}],
    ['an empty projectId', { projectId: '' }],
    ['a non-string projectId', { projectId: 42 }],
  ])('refuses %s: deletes nothing, announces nothing, logs and swallows', async (_label, payload) => {
    const { h } = await makeHarness(ALICE_CAN_USE_PRJ);
    const pool = makePool();
    const c = (await create(h, { userId: 'alice', agentId: 'agt_a', projectId: PRJ })).conversationId;
    const fires: string[][] = [];
    h.bus.subscribe<ConversationsPurgedEvent>('conversations:purged', 'test-listener', async (_c, p) => {
      fires.push([...p.conversationIds]);
      return undefined;
    });
    await expect(h.bus.fire('projects:deleted', capturingCtx(), payload)).resolves.toBeDefined();
    const failed = logRecords.filter(
      (r) => r.msg === 'conversations_purge_for_deleted_project_failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.level).toBe('error');
    expect(logRecords.filter((r) => r.msg === 'hook_subscriber_failed')).toEqual([]);
    expect(fires).toEqual([]);
    expect((await countRows(pool, [c])).conversations).toBe(1);
  });
});
