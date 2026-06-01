import { createHash } from 'node:crypto';
import { stopPostgresContainer } from '@ax/test-harness';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import {
  runAttachmentsMigration,
  type AttachmentsDatabase,
} from '../migrations.js';
import { createAttachmentsStore } from '../store.js';
import { createCommitHandler } from '../handlers.js';

// ---------------------------------------------------------------------------
// TASK-68: attachments:commit now stores bytes in the content-addressed blob
// store (blob:put) + a metadata row, NOT a git commit (workspace:apply). The
// shared-mirror parent-mismatch rebase path — and its whole test surface — is
// GONE, which is one of this card's acceptance criteria. These tests prove the
// new path: blob:put receives the exact bytes, a files row maps
// (conversationId, path) → sha256, no workspace:apply is ever called.
// ---------------------------------------------------------------------------

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

function makeCtx(userId: string) {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId,
  });
}

interface PutCall {
  bytes: Uint8Array;
}

/** A bus with a mock blob:put that records the bytes it received and returns
 *  the real content hash (so the handler's returned sha256 is exercised). It
 *  also FAILS if anything calls workspace:apply — proving the git path is gone. */
function makeBusWithBlob(): { bus: HookBus; puts: PutCall[] } {
  const bus = new HookBus();
  const puts: PutCall[] = [];
  bus.registerService<{ bytes: Uint8Array }, { sha256: string; size: number }>(
    'blob:put',
    'test-blob',
    async (_ctx, input) => {
      puts.push({ bytes: input.bytes });
      const sha256 = createHash('sha256').update(Buffer.from(input.bytes)).digest('hex');
      return { sha256, size: input.bytes.length };
    },
  );
  bus.registerService(
    'workspace:apply',
    'test-guard',
    async () => {
      throw new Error('workspace:apply must NOT be called — the git path is removed');
    },
  );
  return { bus, puts };
}

async function freshSetup() {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  const store = createAttachmentsStore(db);
  return { store, db };
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
      await k.schema.dropTable('attachments_v1_files').ifExists().execute();
      await k.schema.dropTable('attachments_v1_artifacts').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('attachments:commit handler (blob-backed)', () => {
  it('stores bytes via blob:put + a files row and returns metadata', async () => {
    const { store } = await freshSetup();
    const { bus, puts } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-100', userId: 'u-1',
      bytes: Buffer.from('hello world'),
      displayName: 'greeting.txt', mediaType: 'text/plain',
      sizeBytes: 11,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const ctx = makeCtx('u-1');
    const result = await handler(ctx, {
      attachmentId: 'a-100',
      conversationId: 'c-1',
      turnId: 't-1',
    });

    expect(result.path).toMatch(/^\.ax\/uploads\/c-1\/t-1\/[a-f0-9]{8}__greeting\.txt$/);
    // sha256("hello world")
    expect(result.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(result.mediaType).toBe('text/plain');
    expect(result.sizeBytes).toBe(11);
    expect(result.displayName).toBe('greeting.txt');

    // The exact bytes reached blob:put.
    expect(puts).toHaveLength(1);
    expect(Buffer.from(puts[0]!.bytes).toString()).toBe('hello world');

    // A files row maps (conversationId, path) → sha256 for the download ACL.
    const row = await store.getFileByPath('c-1', result.path);
    expect(row).not.toBeNull();
    expect(row!.sha256).toBe(result.sha256);
    expect(row!.userId).toBe('u-1');
    expect(row!.displayName).toBe('greeting.txt');

    // Temp row consumed.
    expect(await store.getTemp('a-100')).toBeNull();
  });

  it('de-dups identical bytes to one content hash at the blob level', async () => {
    const { store } = await freshSetup();
    const { bus, puts } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });

    const insert = (id: string) =>
      store.insertTemp({
        attachmentId: id, userId: 'u-1',
        bytes: Buffer.from('same bytes'),
        displayName: 'dup.txt', mediaType: 'text/plain', sizeBytes: 10,
        expiresAt: new Date(Date.now() + 60_000),
      });

    await insert('a-1');
    const r1 = await handler(makeCtx('u-1'), { attachmentId: 'a-1', conversationId: 'c-1', turnId: 't-1' });
    await insert('a-2');
    const r2 = await handler(makeCtx('u-1'), { attachmentId: 'a-2', conversationId: 'c-1', turnId: 't-1' });

    // Identical bytes ⇒ the SAME content hash both times (the blob store stores
    // them once — content-addressed de-dup). The filename component carries a
    // random anti-collision prefix, so each upload gets a distinct PATH/row that
    // both point at the one shared blob — de-dup lives at the blob, not the row.
    expect(r1.sha256).toBe(r2.sha256);
    expect(r1.path).not.toBe(r2.path);
    expect(puts).toHaveLength(2);
    expect(puts[0]!.bytes).toEqual(puts[1]!.bytes);
  });

  it('rejects unknown attachmentId with not-found', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await expect(
      handler(makeCtx('u-1'), { attachmentId: 'does-not-exist', conversationId: 'c-1', turnId: 't-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects expired attachmentId with not-found', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await store.insertTemp({
      attachmentId: 'a-expired', userId: 'u-1',
      bytes: Buffer.from('x'), displayName: 'x', mediaType: 'text/plain',
      sizeBytes: 1, expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      handler(makeCtx('u-1'), { attachmentId: 'a-expired', conversationId: 'c-1', turnId: 't-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects cross-user redemption with forbidden, never calls blob:put, leaves temp intact', async () => {
    const { store } = await freshSetup();
    const { bus, puts } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await store.insertTemp({
      attachmentId: 'a-foreign', userId: 'u-victim',
      bytes: Buffer.from('secret'), displayName: 'secret.txt',
      mediaType: 'text/plain', sizeBytes: 6,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      handler(makeCtx('u-attacker'), { attachmentId: 'a-foreign', conversationId: 'c-1', turnId: 't-1' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(puts).toHaveLength(0);
    expect(await store.getTemp('a-foreign')).not.toBeNull();
  });

  it('sanitizes the on-disk filename component but preserves the displayName', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    const hostileName = '../../etc/passwd ; rm -rf /.txt';
    await store.insertTemp({
      attachmentId: 'a-weird', userId: 'u-1',
      bytes: Buffer.from('x'), displayName: hostileName,
      mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await handler(makeCtx('u-1'), { attachmentId: 'a-weird', conversationId: 'c-1', turnId: 't-1' });
    expect(result.path).not.toContain('..');
    expect(result.path).not.toContain(' ');
    expect(result.path).not.toContain(';');
    expect(result.path.startsWith('.ax/uploads/c-1/t-1/')).toBe(true);
    expect(result.displayName).toBe(hostileName);
  });

  it('throws PluginError instances (not plain Errors)', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    try {
      await handler(makeCtx('u-1'), { attachmentId: 'does-not-exist', conversationId: 'c-1', turnId: 't-1' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
    }
  });
});
