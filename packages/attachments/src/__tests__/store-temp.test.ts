import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { PluginError, makeAgentContext } from '@ax/core';
import {
  runAttachmentsMigration,
  type AttachmentsDatabase,
} from '../migrations.js';
import { createAttachmentsStore } from '../store.js';
import { createStoreTempHandler } from '../handlers.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PENDING_BYTES_PER_USER,
  DEFAULT_TEMP_TTL_SECONDS,
  DEFAULT_ALLOWED_MEDIA_TYPES,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AttachmentsDatabase>[] = [];

function makeKysely(): Kysely<AttachmentsDatabase> {
  const k = new Kysely<AttachmentsDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
    }),
  });
  opened.push(k);
  return k;
}

const cfg = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxPendingBytesPerUser: DEFAULT_MAX_PENDING_BYTES_PER_USER,
  tempTtlSeconds: DEFAULT_TEMP_TTL_SECONDS,
  allowedMediaTypes: DEFAULT_ALLOWED_MEDIA_TYPES,
};

function makeCtx(userId: string) {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId,
  });
}

async function freshSetup() {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  const store = createAttachmentsStore(db);
  const handler = createStoreTempHandler({ store, config: cfg });
  return { store, handler };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('attachments_v1_temps').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('attachments:store-temp handler', () => {
  it('returns attachmentId + sizeBytes + expiresAt for a valid upload', async () => {
    const { handler } = await freshSetup();
    const ctx = makeCtx('u-1');
    const result = await handler(ctx, {
      bytes: Buffer.from('hello world'),
      displayName: 'greeting.txt',
      mediaType: 'text/plain',
    });
    expect(result.attachmentId).toMatch(/^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$/);
    expect(result.sizeBytes).toBe(11);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('persists the row so the store can read it back', async () => {
    const { handler, store } = await freshSetup();
    const ctx = makeCtx('u-1');
    const result = await handler(ctx, {
      bytes: Buffer.from('persisted'),
      displayName: 'p.txt',
      mediaType: 'text/plain',
    });
    const row = await store.getTemp(result.attachmentId);
    expect(row).not.toBeNull();
    expect(row!.userId).toBe('u-1');
    expect(row!.bytes.toString()).toBe('persisted');
  });

  it('mints unique attachmentIds across calls', async () => {
    const { handler } = await freshSetup();
    const ctx = makeCtx('u-1');
    const a = await handler(ctx, {
      bytes: Buffer.from('x'), displayName: 'x', mediaType: 'text/plain',
    });
    const b = await handler(ctx, {
      bytes: Buffer.from('y'), displayName: 'y', mediaType: 'text/plain',
    });
    expect(a.attachmentId).not.toBe(b.attachmentId);
  });

  it('rejects oversized files with invalid-payload', async () => {
    const { handler } = await freshSetup();
    const ctx = makeCtx('u-1');
    const bytes = Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1);
    await expect(
      handler(ctx, { bytes, displayName: 'big', mediaType: 'application/octet-stream' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects disallowed mime types with invalid-payload', async () => {
    const { handler } = await freshSetup();
    const ctx = makeCtx('u-1');
    await expect(
      handler(ctx, {
        bytes: Buffer.from('x'),
        displayName: 'evil.exe',
        mediaType: 'application/x-msdownload',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects when over per-user quota with too-many-pending', async () => {
    const { handler, store } = await freshSetup();
    const ctx = makeCtx('u-overlimit');
    const nearLimit = DEFAULT_MAX_PENDING_BYTES_PER_USER - 100;
    await store.insertTemp({
      attachmentId: 'a-pre', userId: 'u-overlimit',
      bytes: Buffer.alloc(nearLimit), displayName: 'pre',
      mediaType: 'application/octet-stream',
      sizeBytes: nearLimit,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      handler(ctx, {
        bytes: Buffer.alloc(200),
        displayName: 'over',
        mediaType: 'application/octet-stream',
      }),
    ).rejects.toMatchObject({ code: 'too-many-pending' });
  });

  it('honors image/* wildcard in the allowlist', async () => {
    const { store } = await freshSetup();
    const wildcardHandler = createStoreTempHandler({
      store,
      config: { ...cfg, allowedMediaTypes: ['image/*'] },
    });
    const ctx = makeCtx('u-img');
    const result = await wildcardHandler(ctx, {
      bytes: Buffer.from('PNG-bytes'),
      displayName: 'pic.png',
      mediaType: 'image/png',
    });
    expect(result.attachmentId).toBeTruthy();
  });

  it('throws PluginError instances (not plain Errors)', async () => {
    const { handler } = await freshSetup();
    const ctx = makeCtx('u-1');
    try {
      await handler(ctx, {
        bytes: Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1),
        displayName: 'big',
        mediaType: 'application/octet-stream',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
    }
  });
});
