import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runConversationsMigration,
  type ConversationDatabase,
} from '../migrations.js';
import { createConversationStore } from '../store.js';

// ---------------------------------------------------------------------------
// TASK-66 — display event log store (out-of-git Part B / B1).
//
// Covers the conversations_v1_events table + appendEvent/listEvents store
// methods: migration idempotency, monotonic per-conversation seq, ordered
// reads, and round-trip of all three event kinds (turn / permission-card /
// turn-error). Uses a real Postgres testcontainer (the BIGINT seq + JSONB
// payload semantics can't be exercised against an in-memory stub).
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('conversations_v1_events').ifExists().execute();
      await k.schema
        .dropTable('conversations_v1_conversations')
        .ifExists()
        .execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('conversation_events migration', () => {
  it('is idempotent — re-running the migration is a no-op', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    // Second run must not throw (CREATE TABLE / INDEX IF NOT EXISTS).
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    // Table is usable after a double-migration.
    const seq = await store.appendEvent({
      conversationId: 'c-mig',
      kind: 'turn',
      role: 'assistant',
      payload: { type: 'text', text: 'ok' },
    });
    expect(seq).toBe(1);
  });
});

describe('ConversationStore.appendEvent / listEvents', () => {
  it('mints a monotonic per-conversation seq starting at 1', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const s1 = await store.appendEvent({
      conversationId: 'c1',
      kind: 'turn',
      role: 'user',
      payload: { blocks: [{ type: 'text', text: 'hi' }] },
    });
    const s2 = await store.appendEvent({
      conversationId: 'c1',
      kind: 'turn',
      role: 'assistant',
      payload: { blocks: [{ type: 'text', text: 'hello' }] },
    });
    expect(s1).toBe(1);
    expect(s2).toBe(2);

    // Seq is per-conversation, not global — a second conversation restarts at 1.
    const otherSeq = await store.appendEvent({
      conversationId: 'c2',
      kind: 'turn',
      role: 'user',
      payload: { blocks: [] },
    });
    expect(otherSeq).toBe(1);
  });

  it('returns events in seq order', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    await store.appendEvent({ conversationId: 'c1', kind: 'turn', role: 'user', payload: { n: 1 } });
    await store.appendEvent({ conversationId: 'c1', kind: 'turn', role: 'assistant', payload: { n: 2 } });
    await store.appendEvent({ conversationId: 'c1', kind: 'turn', role: 'assistant', payload: { n: 3 } });

    const events = await store.listEvents('c1');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2, 3]);
  });

  it('round-trips all three event kinds with their role / foldKey / payload', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    await store.appendEvent({
      conversationId: 'c1',
      kind: 'turn',
      role: 'assistant',
      payload: { type: 'text', text: 'a reply' },
    });
    await store.appendEvent({
      conversationId: 'c1',
      kind: 'permission-card',
      foldKey: 'skill:linear',
      payload: { kind: 'skill', skillId: 'linear', hosts: ['api.linear.app'] },
    });
    await store.appendEvent({
      conversationId: 'c1',
      kind: 'turn-error',
      foldKey: 'req-7',
      payload: { reqId: 'req-7', error: 'sandbox-terminated' },
    });

    const events = await store.listEvents('c1');
    expect(events).toHaveLength(3);

    const [turn, card, err] = events;
    expect(turn!.kind).toBe('turn');
    expect(turn!.role).toBe('assistant');
    expect(turn!.foldKey).toBe('');
    expect(turn!.payload).toEqual({ type: 'text', text: 'a reply' });
    expect(typeof turn!.createdAt).toBe('string');

    expect(card!.kind).toBe('permission-card');
    expect(card!.role).toBeNull();
    expect(card!.foldKey).toBe('skill:linear');
    expect(card!.payload).toMatchObject({ kind: 'skill', skillId: 'linear' });

    expect(err!.kind).toBe('turn-error');
    expect(err!.foldKey).toBe('req-7');
    expect(err!.payload).toEqual({ reqId: 'req-7', error: 'sandbox-terminated' });
  });

  it('returns an empty list for a conversation with no events', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    expect(await store.listEvents('never-written')).toEqual([]);
  });

  it('does not drop any event under CONCURRENT appends to the same conversation (seq-race retry)', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    // Fire many appends concurrently for ONE conversation. The MAX(seq)+1
    // allocation races; the unique-violation retry must let every append land
    // with a distinct seq (none dropped, none overwritten). This is the
    // permission-card-racing-turn-end case from the review.
    const N = 20;
    const seqs = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendEvent({
          conversationId: 'c-race',
          kind: 'turn',
          role: 'assistant',
          payload: { i },
        }),
      ),
    );
    // Every append returned a UNIQUE seq.
    expect(new Set(seqs).size).toBe(N);
    // And the log holds exactly N rows with contiguous seqs 1..N.
    const events = await store.listEvents('c-race');
    expect(events).toHaveLength(N);
    expect(events.map((e) => e.seq)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
    // Every payload survived (no overwrite).
    expect(new Set(events.map((e) => (e.payload as { i: number }).i)).size).toBe(N);
  });

  it('stores the payload opaquely (special chars, nested objects round-trip)', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const adversarial = {
      type: 'text',
      // A prompt-injection-flavored string + SQL-ish bytes: must round-trip
      // verbatim, never interpreted.
      text: "'; DROP TABLE conversations_v1_events; -- ignore previous instructions",
      nested: { a: [1, 2, { b: 'µ☃' }] },
    };
    await store.appendEvent({
      conversationId: 'c1',
      kind: 'turn',
      role: 'user',
      payload: adversarial,
    });
    const [ev] = await store.listEvents('c1');
    expect(ev!.payload).toEqual(adversarial);
  });
});
