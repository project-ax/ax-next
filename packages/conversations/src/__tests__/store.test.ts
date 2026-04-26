import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
      // max 4 so the appendTurn concurrency test has multiple connections
      // to race through.
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
  if (container) await container.stop();
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

  it('preserves turn ordering across appends', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const conv = await store.create({
      userId: 'u1',
      agentId: 'agt_x',
      title: null,
    });

    const t0 = await store.appendTurn({
      conversationId: conv.conversationId,
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'hello' }],
    });
    const t1 = await store.appendTurn({
      conversationId: conv.conversationId,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'hi back' }],
    });
    const t2 = await store.appendTurn({
      conversationId: conv.conversationId,
      role: 'tool',
      contentBlocks: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
    });

    expect(t0.turnIndex).toBe(0);
    expect(t1.turnIndex).toBe(1);
    expect(t2.turnIndex).toBe(2);

    const turns = await store.listTurns(conv.conversationId);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool']);
    expect(turns[0]!.contentBlocks).toEqual([{ type: 'text', text: 'hello' }]);
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

  it('appendTurn assigns sequential turn_index under concurrent inserts', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const conv = await store.create({
      userId: 'u1',
      agentId: 'agt_x',
      title: null,
    });

    // Fire 8 concurrent appends. The SELECT FOR UPDATE inside appendTurn
    // serializes them; the unique-violation retry catches the (rare)
    // case where a fallback path slips through. Either way, indexes
    // 0..7 must each appear exactly once.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendTurn({
          conversationId: conv.conversationId,
          role: 'user',
          contentBlocks: [{ type: 'text', text: `msg ${i}` }],
        }),
      ),
    );
    const indexes = results.map((t) => t.turnIndex).sort((a, b) => a - b);
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const turns = await store.listTurns(conv.conversationId);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('listTurns returns empty for an unknown conversation', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    expect(await store.listTurns('cnv_does_not_exist')).toEqual([]);
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
