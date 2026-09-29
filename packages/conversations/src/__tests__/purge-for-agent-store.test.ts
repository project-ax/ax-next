import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runConversationsMigration,
  type ConversationDatabase,
} from '../migrations.js';
import { createConversationStore, type ConversationStore } from '../store.js';

// ---------------------------------------------------------------------------
// TASK-718 — ConversationStore.purgeForAgent + conversationExists.
//
// `purgeForAgent` is the ONLY hard-delete path for conversations_v1_*: it backs
// the `agents:deleted` subscriber. Real Postgres testcontainer — the guarantees
// under test (one transaction, keyed on agent_id alone, soft-deleted rows
// included) are SQL semantics an in-memory stub cannot fake.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<ConversationDatabase>[] = [];

function makeKysely(): Kysely<ConversationDatabase> {
  const k = new Kysely<ConversationDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 4 }),
    }),
  });
  opened.push(k);
  return k;
}

async function makeStore(): Promise<{
  db: Kysely<ConversationDatabase>;
  store: ConversationStore;
}> {
  const db = makeKysely();
  await runConversationsMigration(db);
  return { db, store: createConversationStore(db) };
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      // The atomicity test installs a trigger; dropping the table drops it too.
      await k.schema.dropTable('conversations_v1_transcripts').ifExists().execute();
      await k.schema.dropTable('conversations_v1_events').ifExists().execute();
      await k.schema.dropTable('conversations_v1_conversations').ifExists().execute();
      await sql`DROP FUNCTION IF EXISTS conversations_test_block_delete()`.execute(k);
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

/** Give a conversation two display events and two transcript lines. */
async function seedChildren(
  store: ConversationStore,
  conversationId: string,
): Promise<void> {
  await store.appendEvent({
    conversationId,
    kind: 'turn',
    role: 'user',
    payload: { blocks: [] },
  });
  await store.appendEvent({
    conversationId,
    kind: 'turn',
    role: 'assistant',
    payload: { blocks: [] },
  });
  await store.appendTranscriptLines(conversationId, 0, ['{"a":1}', '{"b":2}']);
}

async function counts(
  db: Kysely<ConversationDatabase>,
  conversationIds: string[],
): Promise<{ conversations: number; events: number; transcripts: number }> {
  const conversations = await db
    .selectFrom('conversations_v1_conversations')
    .select('conversation_id')
    .where('conversation_id', 'in', conversationIds)
    .execute();
  const events = await db
    .selectFrom('conversations_v1_events')
    .select('conversation_id')
    .where('conversation_id', 'in', conversationIds)
    .execute();
  const transcripts = await db
    .selectFrom('conversations_v1_transcripts')
    .select('conversation_id')
    .where('conversation_id', 'in', conversationIds)
    .execute();
  return {
    conversations: conversations.length,
    events: events.length,
    transcripts: transcripts.length,
  };
}

describe('ConversationStore.purgeForAgent (TASK-718)', () => {
  it('hard-deletes conversations + events + transcripts of the agent — every user, soft-deleted and hidden included — and leaves other agents alone', async () => {
    const { db, store } = await makeStore();

    // Agent A is a TEAM agent: two different users hold conversations with it.
    const aAlice = await store.create({ userId: 'alice', agentId: 'agt_a', title: 'a1' });
    const aBob = await store.create({ userId: 'bob', agentId: 'agt_a', title: 'b1' });
    const aHidden = await store.create({
      userId: 'alice',
      agentId: 'agt_a',
      title: null,
      hidden: true,
      externalKey: 'routine:r1',
    });
    const aTombstoned = await store.create({ userId: 'bob', agentId: 'agt_a', title: 'gone' });
    expect(await store.softDelete(aTombstoned.conversationId)).toBe(true);

    // Agent B belongs to the same users: must survive untouched.
    const bAlice = await store.create({ userId: 'alice', agentId: 'agt_b', title: 'keep' });
    const bBob = await store.create({ userId: 'bob', agentId: 'agt_b', title: 'keep too' });
    const bTombstoned = await store.create({ userId: 'bob', agentId: 'agt_b', title: 'old' });
    await store.softDelete(bTombstoned.conversationId);

    const aIds = [aAlice, aBob, aHidden, aTombstoned].map((c) => c.conversationId);
    const bIds = [bAlice, bBob, bTombstoned].map((c) => c.conversationId);
    for (const id of [...aIds, ...bIds]) await seedChildren(store, id);

    expect(await counts(db, aIds)).toEqual({ conversations: 4, events: 8, transcripts: 8 });
    expect(await counts(db, bIds)).toEqual({ conversations: 3, events: 6, transcripts: 6 });

    const purged = await store.purgeForAgent('agt_a');

    // Exactly the ids that were removed — no more, no fewer.
    expect([...purged].sort()).toEqual([...aIds].sort());
    expect(await counts(db, aIds)).toEqual({ conversations: 0, events: 0, transcripts: 0 });
    // Agent B: every row of every table survives, tombstone included.
    expect(await counts(db, bIds)).toEqual({ conversations: 3, events: 6, transcripts: 6 });
  });

  it('returns [] and deletes nothing for an agent that has no conversations', async () => {
    const { db, store } = await makeStore();
    const keep = await store.create({ userId: 'alice', agentId: 'agt_b', title: null });
    await seedChildren(store, keep.conversationId);

    expect(await store.purgeForAgent('agt_never_had_any')).toEqual([]);
    expect(await counts(db, [keep.conversationId])).toEqual({
      conversations: 1,
      events: 2,
      transcripts: 2,
    });
  });

  it('is idempotent: a second purge returns [] and still leaves other agents alone', async () => {
    const { db, store } = await makeStore();
    const a = await store.create({ userId: 'alice', agentId: 'agt_a', title: null });
    const b = await store.create({ userId: 'alice', agentId: 'agt_b', title: null });
    await seedChildren(store, a.conversationId);
    await seedChildren(store, b.conversationId);

    expect(await store.purgeForAgent('agt_a')).toEqual([a.conversationId]);
    expect(await store.purgeForAgent('agt_a')).toEqual([]);
    expect(await counts(db, [b.conversationId])).toEqual({
      conversations: 1,
      events: 2,
      transcripts: 2,
    });
  });

  it('matches agent_id exactly — no prefix or wildcard reach', async () => {
    const { db, store } = await makeStore();
    const target = await store.create({ userId: 'u', agentId: 'agt_a', title: null });
    const prefixed = await store.create({ userId: 'u', agentId: 'agt_ab', title: null });
    const wild = await store.create({ userId: 'u', agentId: 'agt_%', title: null });
    await seedChildren(store, target.conversationId);
    await seedChildren(store, prefixed.conversationId);
    await seedChildren(store, wild.conversationId);

    expect(await store.purgeForAgent('agt_a')).toEqual([target.conversationId]);
    expect(
      await counts(db, [prefixed.conversationId, wild.conversationId]),
    ).toEqual({ conversations: 2, events: 4, transcripts: 4 });
  });

  it('refuses an empty agentId and deletes nothing (never a delete with an empty key)', async () => {
    const { db, store } = await makeStore();
    const c = await store.create({ userId: 'alice', agentId: 'agt_a', title: null });
    await seedChildren(store, c.conversationId);

    await expect(store.purgeForAgent('')).rejects.toMatchObject({
      code: 'invalid-payload',
    });
    // Not a string at all (a payload that skipped type checking).
    await expect(
      store.purgeForAgent(undefined as unknown as string),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(await counts(db, [c.conversationId])).toEqual({
      conversations: 1,
      events: 2,
      transcripts: 2,
    });
  });

  it('is one transaction: a failure on the last delete rolls the earlier deletes back', async () => {
    const { db, store } = await makeStore();
    const c = await store.create({ userId: 'alice', agentId: 'agt_a', title: null });
    await seedChildren(store, c.conversationId);

    // Make the conversations-table delete (the LAST statement) blow up.
    await sql`
      CREATE FUNCTION conversations_test_block_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'delete blocked for test'; END;
      $$ LANGUAGE plpgsql
    `.execute(db);
    await sql`
      CREATE TRIGGER conversations_test_block_delete
        BEFORE DELETE ON conversations_v1_conversations
        FOR EACH ROW EXECUTE FUNCTION conversations_test_block_delete()
    `.execute(db);

    await expect(store.purgeForAgent('agt_a')).rejects.toThrow();
    // Events + transcripts were deleted BEFORE the failing statement; a
    // non-transactional implementation would have lost them. All must be back.
    expect(await counts(db, [c.conversationId])).toEqual({
      conversations: 1,
      events: 2,
      transcripts: 2,
    });
  });
});

describe('ConversationStore.conversationExists (TASK-718)', () => {
  it('is true for a live row and for a soft-deleted row, false for an unknown id', async () => {
    const { store } = await makeStore();
    const live = await store.create({ userId: 'alice', agentId: 'agt_a', title: null });
    const tombstoned = await store.create({ userId: 'alice', agentId: 'agt_a', title: null });
    await store.softDelete(tombstoned.conversationId);

    expect(await store.conversationExists(live.conversationId)).toBe(true);
    // A soft-deleted row still exists: the guard must not change what appends
    // do for a conversation the user merely deleted from their sidebar.
    expect(await store.conversationExists(tombstoned.conversationId)).toBe(true);
    expect(await store.conversationExists('cnv_never_existed')).toBe(false);
  });

  it('turns false once the conversation is purged', async () => {
    const { store } = await makeStore();
    const c = await store.create({ userId: 'alice', agentId: 'agt_a', title: null });
    expect(await store.conversationExists(c.conversationId)).toBe(true);
    await store.purgeForAgent('agt_a');
    expect(await store.conversationExists(c.conversationId)).toBe(false);
  });
});
