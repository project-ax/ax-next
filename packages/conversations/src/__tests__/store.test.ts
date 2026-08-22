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
import {
  createConversationStore,
  validateContentBlocks,
  validateRole,
  validateTitle,
} from '../store.js';
import { scopedConversations } from '../scope.js';

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
      await k.schema
        .dropTable('conversations_v1_turns')
        .ifExists()
        .execute();
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

describe('validation', () => {
  it('rejects non-string title', () => {
    expect(() => validateTitle(42)).toThrow(/title must be a string or null/);
  });

  it('rejects empty-string title', () => {
    expect(() => validateTitle('')).toThrow(/title must be 1-/);
  });

  it('rejects > 256-char title', () => {
    expect(() => validateTitle('x'.repeat(257))).toThrow(/title must be 1-256/);
  });

  it('accepts null and short string title', () => {
    expect(validateTitle(null)).toBeNull();
    expect(validateTitle(undefined)).toBeNull();
    expect(validateTitle('Hello')).toBe('Hello');
  });

  it('rejects unknown role', () => {
    expect(() => validateRole('owner')).toThrow(/role must be/);
  });

  it('accepts the three valid roles', () => {
    expect(validateRole('user')).toBe('user');
    expect(validateRole('assistant')).toBe('assistant');
    expect(validateRole('tool')).toBe('tool');
  });

  it('rejects non-array contentBlocks', () => {
    expect(() => validateContentBlocks('hi')).toThrow(
      /array of ContentBlock objects/,
    );
  });

  it('rejects array with non-object element', () => {
    expect(() => validateContentBlocks(['plain string'])).toThrow(
      /array of ContentBlock objects/,
    );
  });

  it('rejects unknown discriminant', () => {
    expect(() =>
      validateContentBlocks([{ type: 'banana' }]),
    ).toThrow(/array of ContentBlock objects/);
  });

  it('rejects a thinking block missing the thinking field', () => {
    // Canonical schema requires `thinking: string`. The pre-Task-4 shim
    // accepted any object — this test pins the regression so future shim
    // reintroductions show up loudly in CI.
    expect(() =>
      validateContentBlocks([{ type: 'thinking', text: 'hmm' }]),
    ).toThrow(/array of ContentBlock objects/);
  });

  it('accepts a valid array of canonical content blocks', () => {
    const out = validateContentBlocks([
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hmm' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('store + migrations round-trip', () => {
  it('creates a conversation and reads it back', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const created = await store.create({
      userId: 'u1',
      agentId: 'agt_x',
      title: 'My Convo',
    });
    expect(created.conversationId).toMatch(/^cnv_/);
    expect(created.userId).toBe('u1');
    expect(created.agentId).toBe('agt_x');
    expect(created.title).toBe('My Convo');
    expect(created.activeSessionId).toBeNull();
    expect(created.activeReqId).toBeNull();

    const round = await store.getByIdNotDeleted(created.conversationId);
    expect(round).not.toBeNull();
    expect(round!.conversationId).toBe(created.conversationId);
  });

  // ---- AW-6: origin -------------------------------------------------------

  it('defaults origin to web', async () => {
    // No backfill and no column DEFAULT: NULL is what an untaught caller
    // writes, and an existing conversation is by definition one a human
    // opened. `'web'` is what NULL means.
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const c = await store.create({ userId: 'u1', agentId: 'agt_x', title: null });
    expect(c.origin).toBe('web');
    expect((await store.getByIdNotDeleted(c.conversationId))!.origin).toBe('web');
    expect((await store.getMetadata(c.conversationId))!.origin).toBe('web');
  });

  it('records a routine origin', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const c = await store.create({
      userId: 'u1',
      agentId: 'agt_x',
      title: null,
      origin: 'routine',
    });
    expect(c.origin).toBe('routine');
    expect((await store.getByIdNotDeleted(c.conversationId))!.origin).toBe('routine');
    expect((await store.getMetadata(c.conversationId))!.origin).toBe('routine');
  });

  it('reads a stored value it does not recognise as web, not as itself', async () => {
    // A hand-edited row (or a future channel talking to an old host) must not
    // widen the union that everything downstream switches on. Narrowing to the
    // permissive-but-safe default beats leaking an unknown string.
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const c = await store.create({ userId: 'u1', agentId: 'agt_x', title: null });
    await db
      .updateTable('conversations_v1_conversations')
      .set({ origin: 'slack' })
      .where('conversation_id', '=', c.conversationId)
      .execute();

    expect((await store.getByIdNotDeleted(c.conversationId))!.origin).toBe('web');
    expect((await store.getMetadata(c.conversationId))!.origin).toBe('web');
  });

  it('get-metadata carries the live session id', async () => {
    // AW-6 delivers a resolved decision to the warm agent through this field.
    // It rides the same single row read as the attendance lookup.
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const c = await store.create({ userId: 'u1', agentId: 'agt_x', title: null });
    expect((await store.getMetadata(c.conversationId))!.activeSessionId).toBeNull();

    await store.setActiveSession({
      conversationId: c.conversationId,
      userId: 'u1',
      sessionId: 'sess-1',
      reqId: 'req-1',
    });
    expect((await store.getMetadata(c.conversationId))!.activeSessionId).toBe('sess-1');
  });

  it('soft-delete sets deleted_at; scopedConversations filters it out', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const a = await store.create({
      userId: 'u1',
      agentId: 'agt_x',
      title: 'Keep',
    });
    const b = await store.create({
      userId: 'u1',
      agentId: 'agt_x',
      title: 'Tombstone',
    });

    expect(await store.softDelete(b.conversationId)).toBe(true);
    // idempotent — second call against the same row returns false because
    // the WHERE deleted_at IS NULL clause excludes it.
    expect(await store.softDelete(b.conversationId)).toBe(false);

    // listForUser uses scopedConversations under the hood; tombstone hidden.
    const list = await store.listForUser('u1');
    expect(list.map((c) => c.conversationId)).toEqual([a.conversationId]);

    // getByIdNotDeleted hides the tombstone too.
    expect(await store.getByIdNotDeleted(b.conversationId)).toBeNull();
  });

  it('scopedConversations filters by user_id', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    await store.create({ userId: 'u1', agentId: 'agt_a', title: 'A' });
    await store.create({ userId: 'u2', agentId: 'agt_a', title: 'B' });

    const u1 = await scopedConversations(db, { userId: 'u1' }).execute();
    expect(u1).toHaveLength(1);
    expect(u1[0]!.user_id).toBe('u1');

    const u3 = await scopedConversations(db, { userId: 'u3' }).execute();
    expect(u3).toHaveLength(0);
  });

  it('listForUser filters by agentId when supplied', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    await store.create({ userId: 'u1', agentId: 'agt_a', title: 'A' });
    await store.create({ userId: 'u1', agentId: 'agt_b', title: 'B' });

    const all = await store.listForUser('u1');
    expect(all.map((c) => c.title).sort()).toEqual(['A', 'B']);

    const justA = await store.listForUser('u1', 'agt_a');
    expect(justA.map((c) => c.title)).toEqual(['A']);
  });

  it('runConversationsMigration is idempotent', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    await runConversationsMigration(db);
    // Table still usable.
    const store = createConversationStore(db);
    const c = await store.create({
      userId: 'u1',
      agentId: 'agt_x',
      title: null,
    });
    expect(c.conversationId).toMatch(/^cnv_/);
  });
});
