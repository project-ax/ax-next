import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { makeAgentContext } from '@ax/core';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { createAttachmentsStore } from '../store.js';
import {
  createListForConversationHandler,
  createPublishArtifactBlobHandler,
} from '../handlers.js';

// ---------------------------------------------------------------------------
// TASK-68: attachments:list-for-conversation + artifacts:publish-blob against a
// real Postgres metadata store.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AttachmentsDatabase>[] = [];

function makeKysely(): Kysely<AttachmentsDatabase> {
  const k = new Kysely<AttachmentsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(k);
  return k;
}

function makeCtx(userId: string) {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId });
}

async function freshSetup() {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  return { store: createAttachmentsStore(db) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('attachments_v1_files').ifExists().execute();
      await k.schema.dropTable('attachments_v1_artifacts').ifExists().execute();
    } catch {
      /* drained */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const SHA = 'a'.repeat(64);

describe('artifacts:publish-blob handler', () => {
  it('inserts an artifact row scoped to ctx.userId and returns the sha-prefix id', async () => {
    const { store } = await freshSetup();
    const handler = createPublishArtifactBlobHandler({ store });
    const out = await handler(makeCtx('u-1'), {
      conversationId: 'c-1',
      sha256: SHA,
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 2048,
    });
    expect(out.artifactId).toBe(SHA.slice(0, 16));
    const row = await store.getArtifactByPath('c-1', 'workspace/report.pdf');
    expect(row).not.toBeNull();
    expect(row!.sha256).toBe(SHA);
    expect(row!.userId).toBe('u-1');
    expect(row!.mediaType).toBe('application/pdf');
  });

  it('is idempotent on (conversationId, path) — re-publish upserts', async () => {
    const { store } = await freshSetup();
    const handler = createPublishArtifactBlobHandler({ store });
    const base = {
      conversationId: 'c-1',
      path: 'workspace/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 1,
    };
    await handler(makeCtx('u-1'), { ...base, sha256: SHA });
    const SHA2 = 'b'.repeat(64);
    await handler(makeCtx('u-1'), { ...base, sha256: SHA2 });
    const row = await store.getArtifactByPath('c-1', 'workspace/report.pdf');
    expect(row!.sha256).toBe(SHA2); // refreshed, not duplicated
  });
});

describe('attachments:list-for-conversation handler', () => {
  it('returns the conversation uploads scoped to ctx.userId', async () => {
    const { store } = await freshSetup();
    await store.upsertFile({
      id: 'a-1', conversationId: 'c-1', userId: 'u-1', sha256: SHA,
      path: '.ax/uploads/c-1/t-1/a.png', displayName: 'a.png',
      mediaType: 'image/png', sizeBytes: 99,
    });
    const handler = createListForConversationHandler({ store });
    const out = await handler(makeCtx('u-1'), { conversationId: 'c-1' });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toEqual({
      path: '.ax/uploads/c-1/t-1/a.png',
      sha256: SHA,
      mediaType: 'image/png',
      displayName: 'a.png',
      sizeBytes: 99,
    });
  });

  it('returns the empty set for a foreign user (no existence leak)', async () => {
    const { store } = await freshSetup();
    await store.upsertFile({
      id: 'a-1', conversationId: 'c-1', userId: 'u-owner', sha256: SHA,
      path: '.ax/uploads/c-1/t-1/a.png', displayName: 'a.png',
      mediaType: 'image/png', sizeBytes: 99,
    });
    const handler = createListForConversationHandler({ store });
    const out = await handler(makeCtx('u-attacker'), { conversationId: 'c-1' });
    expect(out.files).toEqual([]);
  });
});
