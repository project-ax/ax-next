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

function makeKysely(poolMax = 4): Kysely<ConversationDatabase> {
  const k = new Kysely<ConversationDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: poolMax }),
    }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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

  // -------------------------------------------------------------------------
  // TASK-731 — the event_kind CHECK is widened to admit 'save-refused'. The
  // original constraint was declared inline, so Postgres auto-named it
  // `<table>_<column>_check`; the widening step re-creates it under that
  // same name so there is only ever ONE event_kind check on the table.
  // -------------------------------------------------------------------------
  async function eventKindChecks(
    db: Kysely<ConversationDatabase>,
  ): Promise<{ conname: string; def: string }[]> {
    const res = await sql<{ conname: string; def: string }>`
      SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'conversations_v1_events'::regclass
         AND contype = 'c'
       ORDER BY conname
    `.execute(db);
    return res.rows;
  }

  async function insertKind(
    db: Kysely<ConversationDatabase>,
    kind: string,
  ): Promise<void> {
    await sql`
      INSERT INTO conversations_v1_events (conversation_id, seq, event_kind, payload)
      VALUES ('c-check', (SELECT COALESCE(MAX(seq), 0) + 1 FROM conversations_v1_events), ${kind}, '{}'::jsonb)
    `.execute(db);
  }

  it('fresh DB, migrated twice: one event_kind CHECK, admitting save-refused and still rejecting bogus (TASK-731)', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    await runConversationsMigration(db);

    const checks = await eventKindChecks(db);
    expect(checks.map((c) => c.conname)).toEqual([
      'conversations_v1_events_event_kind_check',
    ]);
    expect(checks[0]!.def).toContain('save-refused');

    await insertKind(db, 'save-refused');
    await expect(insertKind(db, 'bogus')).rejects.toThrow(/check constraint/i);
  });

  it('widens the CHECK on a DB created by the pre-TASK-731 migration', async () => {
    const db = makeKysely();
    // The table exactly as the old migration created it.
    await sql`
      CREATE TABLE conversations_v1_events (
        conversation_id TEXT NOT NULL,
        seq BIGINT NOT NULL,
        event_kind TEXT NOT NULL
          CHECK (event_kind IN ('turn', 'permission-card', 'turn-error')),
        role TEXT,
        fold_key TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (conversation_id, seq)
      )
    `.execute(db);
    // Pin the auto-generated name the widening step depends on.
    const before = await eventKindChecks(db);
    expect(before.map((c) => c.conname)).toEqual([
      'conversations_v1_events_event_kind_check',
    ]);
    await insertKind(db, 'turn-error');
    await expect(insertKind(db, 'save-refused')).rejects.toThrow(/check constraint/i);

    await runConversationsMigration(db);

    const after = await eventKindChecks(db);
    expect(after.map((c) => c.conname)).toEqual([
      'conversations_v1_events_event_kind_check',
    ]);
    await insertKind(db, 'save-refused');
    await expect(insertKind(db, 'bogus')).rejects.toThrow(/check constraint/i);
  });

  it('two replicas migrating a pre-TASK-731 DB at once both succeed (TASK-731)', async () => {
    const setup = makeKysely();
    await sql`
      CREATE TABLE conversations_v1_events (
        conversation_id TEXT NOT NULL,
        seq BIGINT NOT NULL,
        event_kind TEXT NOT NULL
          CHECK (event_kind IN ('turn', 'permission-card', 'turn-error')),
        role TEXT,
        fold_key TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (conversation_id, seq)
      )
    `.execute(setup);
    // Also create the other tables first so the race is on the widening step
    // and not on unrelated CREATE TABLE IF NOT EXISTS statements.
    await runConversationsMigration(makeKysely()).catch(() => {});
    await sql`ALTER TABLE conversations_v1_events DROP CONSTRAINT conversations_v1_events_event_kind_check`.execute(setup);
    await sql`ALTER TABLE conversations_v1_events ADD CONSTRAINT conversations_v1_events_event_kind_check CHECK (event_kind IN ('turn', 'permission-card', 'turn-error'))`.execute(setup);

    const a = makeKysely();
    const b = makeKysely();
    await Promise.all([runConversationsMigration(a), runConversationsMigration(b)]);

    const checks = await eventKindChecks(setup);
    expect(checks.map((c) => c.conname)).toEqual([
      'conversations_v1_events_event_kind_check',
    ]);
    expect(checks[0]!.def).toContain('save-refused');
  });
});

describe('ConversationStore.listEvents — unknown kinds (TASK-731)', () => {
  it('skips a row with an unknown event_kind and reports it, instead of throwing', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    await store.appendEvent({
      conversationId: 'c-unk',
      kind: 'turn',
      role: 'assistant',
      payload: { blocks: [] },
    });
    // Simulate a row a NEWER release wrote under its own wider constraint.
    await sql`ALTER TABLE conversations_v1_events DROP CONSTRAINT conversations_v1_events_event_kind_check`.execute(db);
    await sql`
      INSERT INTO conversations_v1_events (conversation_id, seq, event_kind, payload)
      VALUES ('c-unk', 2, 'from-the-future', '{}'::jsonb)
    `.execute(db);
    await store.appendEvent({
      conversationId: 'c-unk',
      kind: 'save-refused',
      foldKey: 'r1',
      payload: { code: 'refused' },
    });

    const skipped: unknown[] = [];
    const events = await store.listEvents('c-unk', {
      onSkippedRow: (row) => skipped.push(row),
    });
    expect(events.map((e) => [e.seq, e.kind])).toEqual([
      [1, 'turn'],
      [3, 'save-refused'],
    ]);
    expect(skipped).toEqual([{ seq: 2, eventKind: 'from-the-future' }]);

    // The callback is optional.
    expect((await store.listEvents('c-unk')).map((e) => e.seq)).toEqual([1, 3]);
  });

  it('still refuses to WRITE an unknown kind (writes stay strict)', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    await expect(
      store.appendEvent({
        conversationId: 'c-w',
        kind: 'bogus' as never,
        payload: {},
      }),
    ).rejects.toThrow();
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

    // Fire many appends concurrently for ONE conversation. Without
    // serialization the MAX(seq)+1 allocation races on the
    // (conversation_id, seq) PK; the store's per-conversation advisory lock
    // must let every append land with a distinct seq (none dropped, none
    // overwritten). This is the permission-card-racing-turn-end case from the
    // review.
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
  }, 60_000);

  // TASK-220 regression. The old implementation minted seq with an unlocked
  // INSERT ... SELECT MAX(seq)+1 and swallowed the resulting PK collisions
  // with a fixed budget of 8 retries. With k contenders a single append can
  // lose the race up to k-1 times, so beyond ~8-way concurrency the unique
  // violation escaped to the caller and the event was DROPPED — a silent
  // correctness cliff on the redisplay source of truth. N is deliberately far
  // above that old ceiling, on a pool wide enough for genuine DB-level
  // contention, so this fails loudly if the serialization ever regresses.
  it('holds the no-drop guarantee far above the old 8-retry ceiling (N=50)', async () => {
    const db = makeKysely(16);
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const N = 50;
    const seqs = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendEvent({
          conversationId: 'c-race-50',
          kind: 'turn',
          role: 'assistant',
          payload: { i },
        }),
      ),
    );
    expect(new Set(seqs).size).toBe(N);

    const events = await store.listEvents('c-race-50');
    expect(events).toHaveLength(N);
    // Gapless + contiguous 1..N: nothing dropped, nothing overwritten.
    expect(events.map((e) => e.seq)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
    expect(new Set(events.map((e) => (e.payload as { i: number }).i)).size).toBe(N);
    // 50 SERIALIZED round-trip transactions against a testcontainer, run in
    // parallel with 23 other Postgres-backed files, comfortably outruns
    // vitest's 5s default on a loaded machine. Generous, not load-bearing —
    // the assertions above are what this test is for.
  }, 60_000);

  it('keeps seq per-conversation under interleaved concurrent appends', async () => {
    // The lock is keyed per conversation, so two conversations appended to
    // concurrently each get their own independent, contiguous 1..N sequence
    // (each conversation gets its own gapless run (NOTE: this proves correctness, not that the two do not serialize against each other — a mistakenly GLOBAL lock would also pass. A timing assertion would be flaky; the N=50 test is the real guard)).
    const db = makeKysely(8);
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) => i).flatMap((i) =>
        ['c-a', 'c-b'].map((conversationId) =>
          store.appendEvent({
            conversationId,
            kind: 'turn',
            role: 'assistant',
            payload: { i },
          }),
        ),
      ),
    );

    for (const id of ['c-a', 'c-b']) {
      const events = await store.listEvents(id);
      expect(events.map((e) => e.seq)).toEqual(
        Array.from({ length: N }, (_, i) => i + 1),
      );
    }
  }, 60_000);

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
