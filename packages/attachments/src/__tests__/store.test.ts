import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runAttachmentsMigration,
  type AttachmentsDatabase,
} from '../migrations.js';
import { createAttachmentsStore, type AttachmentsStore } from '../store.js';

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

async function freshDbAndStore(): Promise<{
  db: Kysely<AttachmentsDatabase>;
  store: AttachmentsStore;
}> {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  const store = createAttachmentsStore(db);
  return { db, store };
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

describe('AttachmentsStore', () => {
  describe('insertTemp / getTemp', () => {
    it('inserts and returns the row by id', async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-1',
        userId: 'u-1',
        bytes: Buffer.from('hello'),
        displayName: 'hello.txt',
        mediaType: 'text/plain',
        sizeBytes: 5,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const row = await store.getTemp('a-1');
      expect(row).not.toBeNull();
      expect(row!.userId).toBe('u-1');
      expect(row!.bytes.toString()).toBe('hello');
      expect(row!.displayName).toBe('hello.txt');
      expect(row!.mediaType).toBe('text/plain');
      expect(row!.sizeBytes).toBe(5);
    });

    it('returns null for unknown id', async () => {
      const { store } = await freshDbAndStore();
      const row = await store.getTemp('does-not-exist');
      expect(row).toBeNull();
    });

    it('returns null for an expired row (without auto-deleting)', async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-expired',
        userId: 'u-1',
        bytes: Buffer.from('x'),
        displayName: 'x.txt',
        mediaType: 'text/plain',
        sizeBytes: 1,
        expiresAt: new Date(Date.now() - 60_000),
      });
      const row = await store.getTemp('a-expired');
      expect(row).toBeNull();
    });
  });

  describe('sumPendingBytesForUser', () => {
    it('returns 0 when the user has no rows', async () => {
      const { store } = await freshDbAndStore();
      const sum = await store.sumPendingBytesForUser('u-empty');
      expect(sum).toBe(0);
    });

    it('sums non-expired rows for the user', async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-1', userId: 'u-quota', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 100,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-2', userId: 'u-quota', bytes: Buffer.from('y'),
        displayName: 'y', mediaType: 'text/plain', sizeBytes: 200,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const sum = await store.sumPendingBytesForUser('u-quota');
      expect(sum).toBe(300);
    });

    it('ignores expired rows when summing', async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-live', userId: 'u-mix', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 100,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-dead', userId: 'u-mix', bytes: Buffer.from('y'),
        displayName: 'y', mediaType: 'text/plain', sizeBytes: 999,
        expiresAt: new Date(Date.now() - 60_000),
      });
      const sum = await store.sumPendingBytesForUser('u-mix');
      expect(sum).toBe(100);
    });

    it("ignores another user's rows when summing", async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-mine', userId: 'u-a', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 50,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-theirs', userId: 'u-b', bytes: Buffer.from('y'),
        displayName: 'y', mediaType: 'text/plain', sizeBytes: 999,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await store.sumPendingBytesForUser('u-a')).toBe(50);
      expect(await store.sumPendingBytesForUser('u-b')).toBe(999);
    });
  });

  describe('deleteTemp', () => {
    it('removes the row', async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-del', userId: 'u', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.deleteTemp('a-del');
      const row = await store.getTemp('a-del');
      expect(row).toBeNull();
    });

    it('is a no-op for an unknown id', async () => {
      const { store } = await freshDbAndStore();
      await store.deleteTemp('does-not-exist'); // must not throw
    });
  });

  describe('purgeExpired', () => {
    it('deletes all rows past expires_at and returns the count', async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-keep', userId: 'u', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-old1', userId: 'u', bytes: Buffer.from('y'),
        displayName: 'y', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-old2', userId: 'u', bytes: Buffer.from('z'),
        displayName: 'z', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() - 120_000),
      });
      const count = await store.purgeExpired();
      expect(count).toBe(2);
      const remaining = await store.getTemp('a-keep');
      expect(remaining).not.toBeNull();
    });

    it('returns 0 when nothing is expired', async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-live', userId: 'u', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const count = await store.purgeExpired();
      expect(count).toBe(0);
    });
  });

  describe('insertTempIfWithinQuota', () => {
    it('inserts when room is available', async () => {
      const { store } = await freshDbAndStore();
      const result = await store.insertTempIfWithinQuota(
        {
          attachmentId: 'a-1', userId: 'u-1',
          bytes: Buffer.from('hi'), displayName: 'x',
          mediaType: 'text/plain', sizeBytes: 2,
          expiresAt: new Date(Date.now() + 60_000),
        },
        100,
      );
      expect(result).toEqual({ ok: true });
      const row = await store.getTemp('a-1');
      expect(row).not.toBeNull();
    });

    it('returns quota-exceeded and inserts nothing when over the limit', async () => {
      const { store } = await freshDbAndStore();
      await store.insertTemp({
        attachmentId: 'a-pre', userId: 'u-q',
        bytes: Buffer.alloc(90), displayName: 'pre',
        mediaType: 'application/octet-stream', sizeBytes: 90,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const result = await store.insertTempIfWithinQuota(
        {
          attachmentId: 'a-over', userId: 'u-q',
          bytes: Buffer.alloc(20), displayName: 'over',
          mediaType: 'application/octet-stream', sizeBytes: 20,
          expiresAt: new Date(Date.now() + 60_000),
        },
        100,
      );
      expect(result).toEqual({ ok: false, reason: 'quota-exceeded' });
      expect(await store.getTemp('a-over')).toBeNull();
    });

    it('serializes concurrent inserts so the second goes over and rolls back', async () => {
      const { store } = await freshDbAndStore();
      // Each insert is 60 bytes; quota is 100. Sequentially the first fits,
      // the second should not. Running both concurrently must NOT result in
      // both committing — exactly one wins.
      const [a, b] = await Promise.all([
        store.insertTempIfWithinQuota(
          {
            attachmentId: 'a-conc1', userId: 'u-c',
            bytes: Buffer.alloc(60), displayName: '1',
            mediaType: 'application/octet-stream', sizeBytes: 60,
            expiresAt: new Date(Date.now() + 60_000),
          },
          100,
        ),
        store.insertTempIfWithinQuota(
          {
            attachmentId: 'a-conc2', userId: 'u-c',
            bytes: Buffer.alloc(60), displayName: '2',
            mediaType: 'application/octet-stream', sizeBytes: 60,
            expiresAt: new Date(Date.now() + 60_000),
          },
          100,
        ),
      ]);
      const okCount = [a, b].filter((r) => r.ok).length;
      expect(okCount).toBe(1);
      expect(await store.sumPendingBytesForUser('u-c')).toBe(60);
    });
  });
});
