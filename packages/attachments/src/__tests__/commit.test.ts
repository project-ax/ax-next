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

interface ApplyCall {
  ctx: ReturnType<typeof makeCtx>;
  input: { changes: Array<{ path: string; kind: 'put' | 'delete'; content?: Uint8Array }>; parent: string | null; reason?: string };
}

function makeBusWithApply(
  apply: (input: ApplyCall['input']) => Promise<{ version: string; delta: unknown }>,
): { bus: HookBus; calls: ApplyCall[] } {
  const bus = new HookBus();
  const calls: ApplyCall[] = [];
  bus.registerService<ApplyCall['input'], { version: string; delta: unknown }>(
    'workspace:apply',
    'test-mock',
    async (ctx, input) => {
      calls.push({ ctx, input });
      return apply(input);
    },
  );
  return { bus, calls };
}

async function freshSetup() {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  const store = createAttachmentsStore(db);
  return { store };
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

describe('attachments:commit handler', () => {
  it('commits a staged temp to the workspace and returns metadata', async () => {
    const { store } = await freshSetup();
    const { bus, calls } = makeBusWithApply(async () => ({
      version: 'v-after',
      delta: { before: 'v-before', after: 'v-after', changes: [] },
    }));
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
    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(result.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(result.mediaType).toBe('text/plain');
    expect(result.sizeBytes).toBe(11);
    expect(result.displayName).toBe('greeting.txt');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.changes).toHaveLength(1);
    expect(calls[0]!.input.changes[0]!.kind).toBe('put');
    expect(calls[0]!.input.changes[0]!.path).toBe(result.path);
    const content = calls[0]!.input.changes[0]!.content!;
    expect(Buffer.from(content).toString()).toBe('hello world');
    expect(calls[0]!.input.parent).toBeNull();

    const afterRow = await store.getTemp('a-100');
    expect(afterRow).toBeNull();
  });

  it('rejects unknown attachmentId with not-found', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });

    await expect(
      handler(makeCtx('u-1'), {
        attachmentId: 'does-not-exist',
        conversationId: 'c-1',
        turnId: 't-1',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects expired attachmentId with not-found', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-expired', userId: 'u-1',
      bytes: Buffer.from('x'), displayName: 'x', mediaType: 'text/plain',
      sizeBytes: 1,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      handler(makeCtx('u-1'), {
        attachmentId: 'a-expired', conversationId: 'c-1', turnId: 't-1',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects cross-user redemption with forbidden and leaves the temp row intact', async () => {
    const { store } = await freshSetup();
    const { bus, calls } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-foreign', userId: 'u-victim',
      bytes: Buffer.from('secret'), displayName: 'secret.txt',
      mediaType: 'text/plain', sizeBytes: 6,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      handler(makeCtx('u-attacker'), {
        attachmentId: 'a-foreign', conversationId: 'c-1', turnId: 't-1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The attacker's call never reached workspace:apply.
    expect(calls).toHaveLength(0);

    // Temp row preserved.
    // Note: getTemp's expiry filter requires us to use a direct query OR
    // check via the still-valid expiresAt. The row was inserted with +60s,
    // so getTemp should still return it.
    const stillThere = await store.getTemp('a-foreign');
    expect(stillThere).not.toBeNull();
  });

  it('sanitizes the on-disk filename component but preserves the displayName', async () => {
    const { store } = await freshSetup();
    const { bus, calls } = makeBusWithApply(async () => ({
      version: 'v', delta: { before: null, after: 'v', changes: [] },
    }));
    const handler = createCommitHandler({ store, bus });

    const hostileName = '../../etc/passwd ; rm -rf /.txt';
    await store.insertTemp({
      attachmentId: 'a-weird', userId: 'u-1',
      bytes: Buffer.from('x'),
      displayName: hostileName,
      mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await handler(makeCtx('u-1'), {
      attachmentId: 'a-weird', conversationId: 'c-1', turnId: 't-1',
    });

    expect(result.path).not.toContain('..');
    expect(result.path).not.toContain(' ');
    expect(result.path).not.toContain(';');
    expect(result.path.startsWith('.ax/uploads/c-1/t-1/')).toBe(true);
    expect(result.displayName).toBe(hostileName);

    // The path passed to workspace:apply matches what we returned.
    expect(calls[0]!.input.changes[0]!.path).toBe(result.path);
  });

  it('deletes the temp row after a successful workspace:apply', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-del', userId: 'u-1',
      bytes: Buffer.from('x'), displayName: 'x.txt',
      mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await handler(makeCtx('u-1'), {
      attachmentId: 'a-del', conversationId: 'c-1', turnId: 't-1',
    });

    expect(await store.getTemp('a-del')).toBeNull();
  });

  it('throws PluginError instances (not plain Errors)', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });
    try {
      await handler(makeCtx('u-1'), {
        attachmentId: 'does-not-exist',
        conversationId: 'c-1',
        turnId: 't-1',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
    }
  });
});
