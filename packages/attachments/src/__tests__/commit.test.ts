import { createHash } from 'node:crypto';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
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
import { createAttachmentsStore, type AttachmentsStore } from '../store.js';
import { createCommitHandler } from '../handlers.js';

// ---------------------------------------------------------------------------
// attachments:commit — stores the upload's bytes in the content-addressed blob
// store (blob:put) and records a files row keyed by the attachment id. It mints
// no path: the transcript block, the download and the runner's copy all
// address the upload by that id.
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

/** A bus with a blob:put that records the bytes it received and returns their
 *  real content hash (so the handler's returned sha256 is exercised). */
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
  return { bus, puts };
}

async function freshSetup(): Promise<{ store: AttachmentsStore; db: Kysely<AttachmentsDatabase> }> {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  const store = createAttachmentsStore(db);
  return { store, db };
}

/** Stage a pending upload the way `attachments:store-temp` does. */
async function stage(
  store: AttachmentsStore,
  attachmentId: string,
  opts: { userId?: string; bytes?: string; displayName?: string; mediaType?: string } = {},
): Promise<void> {
  const bytes = Buffer.from(opts.bytes ?? 'hello world');
  await store.insertTemp({
    attachmentId,
    userId: opts.userId ?? 'u-1',
    bytes,
    displayName: opts.displayName ?? 'greeting.txt',
    mediaType: opts.mediaType ?? 'text/plain',
    sizeBytes: bytes.length,
    expiresAt: new Date(Date.now() + 60_000),
  });
}

// sha256("hello world")
const HELLO_SHA = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('attachments_v1_temps').ifExists().execute();
      await k.schema.dropTable('attachments_v1_files').ifExists().execute();
      await k.schema.dropTable('attachments_v1_artifact_versions').ifExists().execute();
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

describe('attachments:commit handler (blob-backed, id-addressed)', () => {
  it('commit returns the attachment id and mints no path', async () => {
    const { store } = await freshSetup();
    const { bus, puts } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await stage(store, 'a-100');

    const result = await handler(makeCtx('u-1'), {
      attachmentId: 'a-100',
      conversationId: 'c-1',
    });

    expect(result).toStrictEqual({
      attachmentId: 'a-100',
      filename: 'greeting.txt',
      sha256: HELLO_SHA,
      mediaType: 'text/plain',
      sizeBytes: 11,
    });
    // The exact bytes reached blob:put.
    expect(puts).toHaveLength(1);
    expect(Buffer.from(puts[0]!.bytes).toString()).toBe('hello world');
    // The files row is keyed by the attachment id and scoped to the
    // conversation + the committing user.
    expect(await store.getFileById('a-100')).toStrictEqual({
      id: 'a-100',
      conversationId: 'c-1',
      userId: 'u-1',
      sha256: HELLO_SHA,
      displayName: 'greeting.txt',
      mediaType: 'text/plain',
      sizeBytes: 11,
    });
    // Temp row consumed.
    expect(await store.getTemp('a-100')).toBeNull();
  });

  it('returns the uploaded name verbatim as filename (display text, not a path)', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    const hostileName = '../../etc/passwd ; rm -rf /.txt';
    await stage(store, 'a-weird', { displayName: hostileName });

    const result = await handler(makeCtx('u-1'), { attachmentId: 'a-weird', conversationId: 'c-1' });

    expect(result.filename).toBe(hostileName);
    expect(result).not.toHaveProperty('path');
  });

  it('identical bytes share one content hash but keep separate ids and rows', async () => {
    const { store } = await freshSetup();
    const { bus, puts } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });

    await stage(store, 'a-1', { bytes: 'same bytes', displayName: 'dup.txt' });
    const r1 = await handler(makeCtx('u-1'), { attachmentId: 'a-1', conversationId: 'c-1' });
    await stage(store, 'a-2', { bytes: 'same bytes', displayName: 'dup.txt' });
    const r2 = await handler(makeCtx('u-1'), { attachmentId: 'a-2', conversationId: 'c-1' });

    expect(r1.sha256).toBe(r2.sha256);
    expect([r1.attachmentId, r2.attachmentId]).toEqual(['a-1', 'a-2']);
    expect((await store.getFileById('a-1'))?.sha256).toBe(r1.sha256);
    expect((await store.getFileById('a-2'))?.sha256).toBe(r1.sha256);
    expect(puts).toHaveLength(2);
  });

  // The temp row's delete is best-effort, so a retried send can redeem the
  // same id twice. Into the same conversation that is the same upload; the
  // first row stands, and the retry answers with it as stored.
  it('a repeated commit of the same id into the same conversation is idempotent', async () => {
    const { store, db } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await stage(store, 'a-retry');
    const first = await handler(makeCtx('u-1'), { attachmentId: 'a-retry', conversationId: 'c-1' });

    // The temp row survived the first commit (re-staged here with different
    // details, so an answer built from it rather than the row would show).
    await stage(store, 'a-retry', { bytes: 'other bytes', displayName: 'renamed.txt' });
    const second = await handler(makeCtx('u-1'), { attachmentId: 'a-retry', conversationId: 'c-1' });

    expect(second).toStrictEqual(first);
    const rows = await db.selectFrom('attachments_v1_files').select('attachment_id').execute();
    expect(rows).toEqual([{ attachment_id: 'a-retry' }]);
  });

  // ...but redeeming it into a DIFFERENT conversation would hand that
  // conversation a chip whose row lives elsewhere (a guaranteed 404). Refuse
  // instead, and leave the first conversation's row alone.
  it('refuses to commit an id already committed to another conversation', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await stage(store, 'a-twice');
    await handler(makeCtx('u-1'), { attachmentId: 'a-twice', conversationId: 'c-1' });

    await stage(store, 'a-twice');
    await expect(
      handler(makeCtx('u-1'), { attachmentId: 'a-twice', conversationId: 'c-2' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect((await store.getFileById('a-twice'))?.conversationId).toBe('c-1');
  });

  // TASK-1063: the commit deletes the staged row, so a second commit of the
  // same id usually finds no staged row at all. Resend after a turn refused
  // before the person's message was saved does exactly that: it names the
  // same ids again, in the same conversation.
  it('TASK-1063: naming a committed id again in the same conversation, after its staged upload is gone, answers with the stored row', async () => {
    const { store, db } = await freshSetup();
    const { bus, puts } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await stage(store, 'a-again');
    const first = await handler(makeCtx('u-1'), { attachmentId: 'a-again', conversationId: 'c-1' });
    expect(await store.getTemp('a-again')).toBeNull();

    const second = await handler(makeCtx('u-1'), { attachmentId: 'a-again', conversationId: 'c-1' });

    const stored = {
      attachmentId: 'a-again',
      filename: 'greeting.txt',
      sha256: HELLO_SHA,
      mediaType: 'text/plain',
      sizeBytes: 11,
    };
    expect(first).toStrictEqual(stored);
    expect(second).toStrictEqual(stored);
    // The bytes are stored once; the second commit writes nothing.
    expect(puts).toHaveLength(1);
    const rows = await db.selectFrom('attachments_v1_files').select('attachment_id').execute();
    expect(rows).toEqual([{ attachment_id: 'a-again' }]);
  });

  it('TASK-1063: a committed id named again in another conversation is still not found, and the first row stands', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await stage(store, 'a-elsewhere');
    await handler(makeCtx('u-1'), { attachmentId: 'a-elsewhere', conversationId: 'c-1' });

    await expect(
      handler(makeCtx('u-1'), { attachmentId: 'a-elsewhere', conversationId: 'c-2' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect((await store.getFileById('a-elsewhere'))?.conversationId).toBe('c-1');
  });

  it('TASK-1063: a committed id named again by another person is refused exactly like an unknown id', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await stage(store, 'a-mine', { userId: 'u-1' });
    await handler(makeCtx('u-1'), { attachmentId: 'a-mine', conversationId: 'c-1' });

    const err = await handler(makeCtx('u-2'), { attachmentId: 'a-mine', conversationId: 'c-1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err).toMatchObject({ code: 'not-found', message: "attachmentId 'a-mine' not found or expired" });

    // The words an id that never existed gets: nothing says the file is real.
    await expect(
      handler(makeCtx('u-2'), { attachmentId: 'a-unknown', conversationId: 'c-1' }),
    ).rejects.toMatchObject({ code: 'not-found', message: "attachmentId 'a-unknown' not found or expired" });
  });

  it('rejects unknown attachmentId with not-found', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await expect(
      handler(makeCtx('u-1'), { attachmentId: 'does-not-exist', conversationId: 'c-1' }),
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
      handler(makeCtx('u-1'), { attachmentId: 'a-expired', conversationId: 'c-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects cross-user redemption with forbidden, never calls blob:put, leaves temp intact', async () => {
    const { store } = await freshSetup();
    const { bus, puts } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    await stage(store, 'a-foreign', { userId: 'u-victim', bytes: 'secret', displayName: 'secret.txt' });
    await expect(
      handler(makeCtx('u-attacker'), { attachmentId: 'a-foreign', conversationId: 'c-1' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(puts).toHaveLength(0);
    expect(await store.getTemp('a-foreign')).not.toBeNull();
    expect(await store.getFileById('a-foreign')).toBeNull();
  });

  it('throws PluginError instances (not plain Errors)', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithBlob();
    const handler = createCommitHandler({ store, bus });
    const err = await handler(makeCtx('u-1'), { attachmentId: 'does-not-exist', conversationId: 'c-1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
  });
});
