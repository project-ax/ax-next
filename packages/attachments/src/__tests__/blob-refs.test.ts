import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import {
  BLOB_COLLECT_REFS_HOOK,
  readBlobCollectRefsAnswers,
  type BlobCollectRefsPayload,
} from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAttachmentsPlugin } from '../plugin.js';
import type { AttachmentsDatabase } from '../migrations.js';
import { createAttachmentsStore } from '../store.js';

// ---------------------------------------------------------------------------
// TASK-776 (blob-gc design D2/D7): @ax/attachments is a `blob:collect-refs`
// holder. It answers from BOTH of its sha columns, for every row, whatever
// state the conversation is in (a soft-deleted conversation still holds its
// files — soft delete exists so it can come back).
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);

// `conversations:get` throws if it is ever asked: the holder must read no
// conversation state at all, so a soft-deleted conversation keeps its files.
async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'blob:put': async () => ({ sha256: A, size: 0 }),
      'blob:get': async () => ({ found: false }) as const,
      'blob:stat': async () => ({ size: 1 }),
      'conversations:get': async () => {
        throw new Error('the blob:collect-refs holder must not consult conversation state');
      },
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAttachmentsPlugin()],
  });
  harnesses.push(h);
  return h;
}

async function dbOf(h: TestHarness): Promise<Kysely<AttachmentsDatabase>> {
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  return db as Kysely<AttachmentsDatabase>;
}

async function ask(h: TestHarness, candidates: string[]): Promise<BlobCollectRefsPayload> {
  const start: BlobCollectRefsPayload = { candidates, answers: [] };
  const res = await h.bus.fire<unknown>(BLOB_COLLECT_REFS_HOOK, h.ctx(), start);
  expect(res.rejected).toBe(false);
  return (res.rejected ? start : res.payload) as BlobCollectRefsPayload;
}

function fileRow(id: string, conversationId: string, userId: string, sha256: string) {
  return {
    id,
    conversationId,
    userId,
    sha256,
    path: `${id}.txt`,
    displayName: `${id}.txt`,
    mediaType: 'text/plain',
    sizeBytes: 1,
  };
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_temps');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_files');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifacts');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('AttachmentsStore.blobRefs', () => {
  it('returns every row of BOTH tables that points at a candidate, with its owner', async () => {
    const h = await makeHarness();
    const store = createAttachmentsStore(await dbOf(h));
    await store.upsertFile(fileRow('f1', 'c1', 'u1', A));
    await store.upsertArtifact(fileRow('r1', 'c1', 'u2', B));
    const refs = await store.blobRefs([A, B, C]);
    expect(refs).toHaveLength(2);
    expect(refs).toContainEqual({ sha256: A, userIds: ['u1'] });
    expect(refs).toContainEqual({ sha256: B, userIds: ['u2'] });
  });

  it('returns one entry per row, so every user holding the same bytes appears', async () => {
    const h = await makeHarness();
    const store = createAttachmentsStore(await dbOf(h));
    await store.upsertFile(fileRow('f1', 'c1', 'u1', A));
    await store.upsertFile(fileRow('f2', 'c2', 'u2', A));
    await store.upsertArtifact(fileRow('r1', 'c3', 'u3', A));
    const refs = await store.blobRefs([A]);
    expect(refs.every((r) => r.sha256 === A)).toBe(true);
    expect(refs.flatMap((r) => r.userIds).sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('leaves out rows whose sha is not a candidate', async () => {
    const h = await makeHarness();
    const store = createAttachmentsStore(await dbOf(h));
    await store.upsertFile(fileRow('f1', 'c1', 'u1', A));
    await store.upsertArtifact(fileRow('r1', 'c1', 'u1', D));
    expect(await store.blobRefs([B, C])).toEqual([]);
    expect(await store.blobRefs([])).toEqual([]);
  });
});

describe('@ax/attachments as a blob:collect-refs holder', () => {
  it('appends one ok answer covering both tables, per user', async () => {
    const h = await makeHarness();
    const store = createAttachmentsStore(await dbOf(h));
    await store.upsertFile(fileRow('f1', 'c1', 'u1', A));
    await store.upsertFile(fileRow('f2', 'c2', 'u2', A));
    await store.upsertArtifact(fileRow('r1', 'c1', 'u3', B));

    const out = await ask(h, [A, B, C]);
    expect(out.answers).toHaveLength(1);
    expect(out.answers[0]!.holder).toBe('@ax/attachments');
    expect(out.answers[0]!.ok).toBe(true);

    const read = readBlobCollectRefsAnswers(out, [A, B, C]);
    expect(read.failed).toEqual([]);
    expect([...read.held.get(A)!.userIds].sort()).toEqual(['u1', 'u2']);
    expect([...read.held.get(B)!.userIds]).toEqual(['u3']);
    expect(read.held.get(A)!.unattributed).toBe(false);
    // C is held by nobody — and not by an unattributed holder either.
    expect(read.held.has(C)).toBe(false);
  });

  it('keeps holding for a conversation that no longer resolves (soft-deleted)', async () => {
    // `conversations:get` throws in this harness, so a holder that tried to
    // filter by conversation state would answer ok:false instead of refs.
    const h = await makeHarness();
    const store = createAttachmentsStore(await dbOf(h));
    await store.upsertFile(fileRow('f1', 'c-soft-deleted', 'u1', A));
    const out = await ask(h, [A]);
    const read = readBlobCollectRefsAnswers(out, [A]);
    expect(read.failed).toEqual([]);
    expect(read.held.get(A)?.userIds.has('u1')).toBe(true);
  });

  it('answers ok:false (never "no refs") when it cannot read its own table', async () => {
    const h = await makeHarness();
    const db = await dbOf(h);
    await sql`DROP TABLE attachments_v1_artifacts`.execute(db);

    const out = await ask(h, [A]);
    expect(out.answers).toEqual([{ holder: '@ax/attachments', ok: false, refs: [] }]);
    expect(readBlobCollectRefsAnswers(out, [A]).failed).toEqual(['@ax/attachments']);
  });

  it('answers ok:false for a payload it cannot trust, and never throws', async () => {
    const h = await makeHarness();
    const res = await h.bus.fire<unknown>(BLOB_COLLECT_REFS_HOOK, h.ctx(), {
      candidates: ['not-a-sha'],
      answers: [],
    });
    expect(res.rejected).toBe(false);
    const answers = res.rejected ? [] : (res.payload as BlobCollectRefsPayload).answers;
    expect(answers).toEqual([{ holder: '@ax/attachments', ok: false, refs: [] }]);
  });
});
