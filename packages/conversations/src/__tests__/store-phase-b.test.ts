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
  validateRunnerType,
  validateWorkspaceRefForFreeze,
} from '../store.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29) — store-level tests for the three new methods:
// getMetadata, storeRunnerSession, bumpLastActivity. Plus the two new
// validators. Real postgres via testcontainers (I12 — schema is the
// contract; mocking it would falsify the contract).
//
// store.create gains runnerType + workspaceRef args in Task 5; these
// tests use the original three-arg shape so freshly-created rows have
// runner_type = workspace_ref = NULL (the pre-Phase-B-row case). The
// frozen-value paths get verified in Task 5's create-freezes tests.
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
      await k.schema.dropTable('conversations_v1_turns').ifExists().execute();
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

describe('validateRunnerType', () => {
  it('accepts lowercase + digits + hyphen, 1-64 chars', () => {
    expect(validateRunnerType('claude-sdk')).toBe('claude-sdk');
    expect(validateRunnerType('a')).toBe('a');
    expect(validateRunnerType('claude-sdk-v2')).toBe('claude-sdk-v2');
    expect(validateRunnerType('a'.repeat(64))).toBe('a'.repeat(64));
    expect(validateRunnerType(null)).toBeNull();
    expect(validateRunnerType(undefined)).toBeNull();
  });

  it('rejects empty / oversize / illegal chars', () => {
    expect(() => validateRunnerType('')).toThrow(/runnerType/);
    expect(() => validateRunnerType('A')).toThrow(/runnerType/);
    expect(() => validateRunnerType('claude_sdk')).toThrow(/runnerType/);
    expect(() => validateRunnerType('claude/sdk')).toThrow(/runnerType/);
    expect(() => validateRunnerType('a'.repeat(65))).toThrow(/runnerType/);
    expect(() => validateRunnerType(42)).toThrow(/runnerType/);
  });
});

describe('validateWorkspaceRefForFreeze', () => {
  it('mirrors agents/store WORKSPACE_REF_RE — accepts safe ids and paths', () => {
    expect(validateWorkspaceRefForFreeze('foo/bar.git')).toBe('foo/bar.git');
    expect(validateWorkspaceRefForFreeze('wsp_demo')).toBe('wsp_demo');
    expect(validateWorkspaceRefForFreeze('a'.repeat(256))).toBe(
      'a'.repeat(256),
    );
    expect(validateWorkspaceRefForFreeze(null)).toBeNull();
    expect(validateWorkspaceRefForFreeze(undefined)).toBeNull();
  });

  it('rejects empty / oversize / illegal chars', () => {
    expect(() => validateWorkspaceRefForFreeze('')).toThrow(/workspaceRef/);
    expect(() => validateWorkspaceRefForFreeze('foo bar')).toThrow(
      /workspaceRef/,
    );
    expect(() => validateWorkspaceRefForFreeze('foo;bar')).toThrow(
      /workspaceRef/,
    );
    expect(() => validateWorkspaceRefForFreeze('a'.repeat(257))).toThrow(
      /workspaceRef/,
    );
    expect(() => validateWorkspaceRefForFreeze(42)).toThrow(/workspaceRef/);
  });
});

describe('store.getMetadata', () => {
  it('returns the metadata projection — no turns', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const conv = await store.create({
      userId: 'u1',
      agentId: 'a1',
      title: null,
    });

    const md = await store.getMetadata(conv.conversationId);
    expect(md).toMatchObject({
      conversationId: conv.conversationId,
      userId: 'u1',
      agentId: 'a1',
      runnerType: null,
      runnerSessionId: null,
      workspaceRef: null,
      title: null,
      lastActivityAt: null,
    });
    expect(md?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Projection contract: no turns key (I6 — no turns in metadata).
    expect((md as Record<string, unknown>).turns).toBeUndefined();
  });

  it('returns null for unknown / tombstoned ids', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    expect(await store.getMetadata('cnv_unknown')).toBeNull();

    const conv = await store.create({
      userId: 'u1',
      agentId: 'a1',
      title: null,
    });
    await store.softDelete(conv.conversationId);
    expect(await store.getMetadata(conv.conversationId)).toBeNull();
  });
});

describe('store.storeRunnerSession', () => {
  it('binds runner_session_id idempotently for the same value', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const conv = await store.create({
      userId: 'u1',
      agentId: 'a1',
      title: null,
    });

    const r1 = await store.storeRunnerSession({
      conversationId: conv.conversationId,
      userId: 'u1',
      runnerSessionId: 'sess_abc',
    });
    expect(r1).toBe('bound');

    const r2 = await store.storeRunnerSession({
      conversationId: conv.conversationId,
      userId: 'u1',
      runnerSessionId: 'sess_abc',
    });
    expect(r2).toBe('already-bound-same');

    const md = await store.getMetadata(conv.conversationId);
    expect(md?.runnerSessionId).toBe('sess_abc');
  });

  it('reports conflict when re-binding to a different value', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const conv = await store.create({
      userId: 'u1',
      agentId: 'a1',
      title: null,
    });
    await store.storeRunnerSession({
      conversationId: conv.conversationId,
      userId: 'u1',
      runnerSessionId: 'sess_abc',
    });
    const r = await store.storeRunnerSession({
      conversationId: conv.conversationId,
      userId: 'u1',
      runnerSessionId: 'sess_OTHER',
    });
    expect(r).toBe('conflict');
    // Side-effect check: the original value must still be intact.
    const md = await store.getMetadata(conv.conversationId);
    expect(md?.runnerSessionId).toBe('sess_abc');
  });

  it('returns not-found for foreign user / unknown id / tombstoned row', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const conv = await store.create({
      userId: 'u1',
      agentId: 'a1',
      title: null,
    });

    // Foreign user.
    expect(
      await store.storeRunnerSession({
        conversationId: conv.conversationId,
        userId: 'u-OTHER',
        runnerSessionId: 'x',
      }),
    ).toBe('not-found');

    // Unknown id.
    expect(
      await store.storeRunnerSession({
        conversationId: 'cnv_unknown',
        userId: 'u1',
        runnerSessionId: 'x',
      }),
    ).toBe('not-found');

    // Tombstoned row.
    await store.softDelete(conv.conversationId);
    expect(
      await store.storeRunnerSession({
        conversationId: conv.conversationId,
        userId: 'u1',
        runnerSessionId: 'x',
      }),
    ).toBe('not-found');
  });
});

describe('store.bumpLastActivity', () => {
  it('sets last_activity_at on a live row and returns true', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const conv = await store.create({
      userId: 'u1',
      agentId: 'a1',
      title: null,
    });

    const at = new Date('2026-04-29T13:00:00Z');
    expect(await store.bumpLastActivity(conv.conversationId, at)).toBe(true);

    const md = await store.getMetadata(conv.conversationId);
    expect(md?.lastActivityAt).toBe('2026-04-29T13:00:00.000Z');
  });

  it('returns false for tombstoned / unknown rows', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    expect(await store.bumpLastActivity('cnv_unknown', new Date())).toBe(false);

    const conv = await store.create({
      userId: 'u1',
      agentId: 'a1',
      title: null,
    });
    await store.softDelete(conv.conversationId);
    expect(await store.bumpLastActivity(conv.conversationId, new Date())).toBe(
      false,
    );
  });
});
