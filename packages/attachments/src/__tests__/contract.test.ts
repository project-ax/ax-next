import {
  describe, it, expect, beforeAll, afterAll, afterEach,
} from 'vitest';
import { createHash } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '@ax/conversations';
import { createAttachmentsPlugin } from '../plugin.js';
import type {
  StoreTempOutput,
  CommitOutput,
  DownloadOutput,
} from '../types.js';

// Narrow projection of `conversations:create` output — we only read
// `conversationId` in this test, so we avoid coupling to the full
// Conversation shape from `@ax/conversations`.
interface ConversationsCreateMin {
  conversationId: string;
}

// ---------------------------------------------------------------------------
// End-to-end contract test.
//
// Exercises the @ax/attachments hook surface against real
// @ax/database-postgres and @ax/conversations plugins, so the download's owner
// gate is the real `conversations:get`. The bytes ride the content-addressed
// blob store (blob:put/blob:get), stubbed here via an in-memory sha256-keyed map
// per harness — that's the abstraction boundary at this layer
// (@ax/blob-store-fs owns the real backing store). The metadata rows are real,
// so commit → id → row → blob is exercised end-to-end.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// Shared in-memory content-addressed blob store. blob:put hashes + stores;
// blob:get serves by sha. Scoped per-harness via closures.
interface BlobFakeState {
  blobs: Map<string, Uint8Array>;
}

async function makeHarness(): Promise<{ harness: TestHarness; ws: BlobFakeState }> {
  const ws: BlobFakeState = { blobs: new Map() };
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
      'blob:put': async (_ctx, input: unknown) => {
        const { bytes } = input as { bytes: Uint8Array };
        const sha256 = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
        ws.blobs.set(sha256, bytes);
        return { sha256, size: bytes.length };
      },
      'blob:get': async (_ctx, input: unknown) => {
        const { sha256 } = input as { sha256: string };
        const bytes = ws.blobs.get(sha256);
        if (bytes === undefined) return { found: false } as const;
        return { bytes };
      },
      'blob:stat': async (_ctx, input: unknown) => {
        const { sha256 } = input as { sha256: string };
        const bytes = ws.blobs.get(sha256);
        if (bytes === undefined) return { found: false } as const;
        return { size: bytes.length };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin({ purgeSweepIntervalMs: 0 }),
      createAttachmentsPlugin(),
    ],
  });
  harnesses.push(h);
  return { harness: h, ws };
}

/** store-temp → commit, the way the chat send path does it. */
async function upload(
  harness: TestHarness,
  userId: string,
  conversationId: string,
  text: string,
): Promise<CommitOutput> {
  const ctx = harness.ctx({ userId, agentId: 'a-1' });
  const temp = await harness.bus.call<unknown, StoreTempOutput>('attachments:store-temp', ctx, {
    bytes: Buffer.from(text),
    displayName: 'greeting.txt',
    mediaType: 'text/plain',
  });
  return harness.bus.call<unknown, CommitOutput>('attachments:commit', ctx, {
    attachmentId: temp.attachmentId,
    conversationId,
  });
}

async function createConversation(harness: TestHarness, userId: string): Promise<string> {
  const conv = await harness.bus.call<unknown, ConversationsCreateMin>(
    'conversations:create',
    harness.ctx({ userId, agentId: 'a-1' }),
    { userId, agentId: 'a-1' },
  );
  return conv.conversationId;
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
  // Drop tables between tests so each starts on a fresh schema. Mirrors
  // the pattern in find-or-create.test.ts. The attachments plugin owns
  // attachments_v1_temps; conversations owns the two conversations tables.
  const pg = (await import('pg')).default;
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_temps');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_files');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifacts');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/attachments bus contract', () => {
  it('full round trip: store-temp → commit → download by id', async () => {
    const { harness } = await makeHarness();
    const conversationId = await createConversation(harness, 'u-1');

    const committed = await upload(harness, 'u-1', conversationId, 'hello attachments');
    expect(committed).toStrictEqual({
      attachmentId: committed.attachmentId,
      filename: 'greeting.txt',
      sha256: createHash('sha256').update('hello attachments').digest('hex'),
      mediaType: 'text/plain',
      sizeBytes: 'hello attachments'.length,
    });

    const downloaded = await harness.bus.call<unknown, DownloadOutput>(
      'attachments:download',
      harness.ctx({ userId: 'u-1', agentId: 'a-1' }),
      { attachmentId: committed.attachmentId, conversationId, userId: 'u-1' },
    );
    expect(Buffer.from(downloaded.bytes).toString()).toBe('hello attachments');
    expect(downloaded.mediaType).toBe('text/plain');
    expect(downloaded.displayName).toBe('greeting.txt');
  });

  it('lists the conversation uploads by id for the runner', async () => {
    const { harness } = await makeHarness();
    const conversationId = await createConversation(harness, 'u-1');
    const committed = await upload(harness, 'u-1', conversationId, 'listed');

    const listed = await harness.bus.call<unknown, { files: unknown[] }>(
      'attachments:list-for-conversation',
      harness.ctx({ userId: 'u-1', agentId: 'a-1' }),
      { conversationId },
    );
    expect(listed.files).toStrictEqual([
      {
        attachmentId: committed.attachmentId,
        filename: 'greeting.txt',
        sha256: committed.sha256,
        mediaType: 'text/plain',
        sizeBytes: committed.sizeBytes,
      },
    ]);
  });

  it('rejects foreign user with not-found (cross-user existence-leak)', async () => {
    const { harness } = await makeHarness();
    const conversationId = await createConversation(harness, 'u-owner');
    const committed = await upload(harness, 'u-owner', conversationId, 'secret');

    // Foreign user tries to download — must surface not-found.
    const attackerCtx = harness.ctx({ userId: 'u-attacker', agentId: 'a-1' });
    await expect(
      harness.bus.call('attachments:download', attackerCtx, {
        attachmentId: committed.attachmentId,
        conversationId,
        userId: 'u-attacker',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses an attachment from another conversation, even the same owner\'s', async () => {
    const { harness } = await makeHarness();
    const convA = await createConversation(harness, 'u-1');
    const convB = await createConversation(harness, 'u-1');
    const inA = await upload(harness, 'u-1', convA, 'only in A');

    // The owner gate passes (u-1 owns B) but the row belongs to A.
    await expect(
      harness.bus.call('attachments:download', harness.ctx({ userId: 'u-1', agentId: 'a-1' }), {
        attachmentId: inA.attachmentId,
        conversationId: convB,
        userId: 'u-1',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects cross-user commit redemption with forbidden', async () => {
    const { harness } = await makeHarness();
    const victim = harness.ctx({ userId: 'u-victim', agentId: 'a-1' });
    const attacker = harness.ctx({ userId: 'u-attacker', agentId: 'a-1' });

    const tempResult = await harness.bus.call<unknown, StoreTempOutput>(
      'attachments:store-temp',
      victim,
      {
        bytes: Buffer.from('secret'),
        displayName: 'secret.txt',
        mediaType: 'text/plain',
      },
    );
    const attackerConv = await createConversation(harness, 'u-attacker');

    await expect(
      harness.bus.call('attachments:commit', attacker, {
        attachmentId: tempResult.attachmentId,
        conversationId: attackerConv,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
