import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
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
// TASK-67 — resume transcript store (out-of-git Part B / B2).
//
// Covers conversations_v1_transcripts + the append/replace/read store methods:
// byte-identical round-trip, monotonic seq, prefix-hash determinism (must match
// the runner's sha256(fileBytes[0..sentOffset))), and the B3 role projection.
// Real Postgres testcontainer (BIGINT seq + the DELETE+INSERT txn can't be
// faithfully exercised against an in-memory stub).
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
      await k.schema
        .dropTable('conversations_v1_transcripts')
        .ifExists()
        .execute();
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
  if (container) await container.stop();
});

// Verbatim sample jsonl lines — includes unicode + a tool_result echo so the
// round-trip and role-projection are exercised on realistic SDK output.
const LINES = [
  '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi \\u00e9"}}',
  '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}',
  '{"type":"queue-operation","op":"flush"}',
  '{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"42"}]}}',
  '{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
];

function onDisk(lines: string[]): string {
  // The on-disk SDK jsonl: each line '\n'-terminated (incl. the last).
  return lines.map((l) => l + '\n').join('');
}

describe('ConversationStore — transcript store (TASK-67)', () => {
  it('migration is idempotent and the table is usable after a double run', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    const max = await store.appendTranscriptLines('c-mig', 0, ['{"type":"x"}']);
    expect(max).toBe(1);
  });

  it('appends lines and reconstructs the jsonl byte-identically', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    const max = await store.appendTranscriptLines('c1', 0, LINES);
    expect(max).toBe(LINES.length);
    expect(await store.getTranscriptMaxSeq('c1')).toBe(LINES.length);

    const bytes = await store.getTranscriptBytes('c1');
    // Reconstructs the on-disk SDK jsonl byte-for-byte: each line `\n`-terminated.
    expect(bytes).toBe(onDisk(LINES));
  });

  it('a second delta appends after the threaded fromSeq', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    await store.appendTranscriptLines('c2', 0, LINES.slice(0, 2));
    const max = await store.appendTranscriptLines('c2', 2, LINES.slice(2));
    expect(max).toBe(LINES.length);
    expect(await store.getTranscriptBytes('c2')).toBe(onDisk(LINES));
  });

  it('rejects a stale fromSeq (PK violation) so the host can resync', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    await store.appendTranscriptLines('c3', 0, LINES.slice(0, 3));
    // A second writer that thinks fromSeq is still 0 collides on the PK.
    await expect(
      store.appendTranscriptLines('c3', 0, ['{"type":"x"}']),
    ).rejects.toBeTruthy();
  });

  it('prefix-hash matches sha256(verbatim lines + trailing newlines)', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    await store.appendTranscriptLines('c4', 0, LINES);

    for (const through of [0, 1, 3, LINES.length]) {
      const expected = createHash('sha256');
      for (const line of LINES.slice(0, through)) {
        expected.update(line);
        expected.update('\n');
      }
      expect(await store.getTranscriptPrefixHash('c4', through)).toBe(
        expected.digest('hex'),
      );
    }
  });

  it('empty prefix hashes the empty string', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    expect(await store.getTranscriptPrefixHash('nope', 0)).toBe(
      createHash('sha256').digest('hex'),
    );
    expect(await store.getTranscriptMaxSeq('nope')).toBe(0);
    expect(await store.getTranscriptBytes('nope')).toBe('');
  });

  it('replaceTranscript wipes and re-inserts in one shot', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);

    await store.appendTranscriptLines('c5', 0, LINES);
    const rewritten = ['{"type":"user","uuid":"r1"}', '{"type":"assistant","uuid":"r2"}'];
    const max = await store.replaceTranscript('c5', rewritten);
    expect(max).toBe(2);
    expect(await store.getTranscriptMaxSeq('c5')).toBe(2);
    expect(await store.getTranscriptBytes('c5')).toBe(onDisk(rewritten));
  });

  it('projects per-line roles for the B3 detector (bookkeeping → null, tool_result → tool)', async () => {
    const db = makeKysely();
    await runConversationsMigration(db);
    const store = createConversationStore(db);
    await store.appendTranscriptLines('c6', 0, LINES);

    expect(await store.getTranscriptRoles('c6')).toEqual([
      'user',
      'assistant',
      null, // queue-operation bookkeeping
      'tool', // user line carrying a tool_result block
      'assistant',
    ]);
  });
});
