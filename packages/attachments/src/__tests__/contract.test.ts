import {
  describe, it, expect, beforeAll, afterAll, afterEach,
} from 'vitest';
import { createHash } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
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
// End-to-end contract test (Task 11).
//
// Exercises the @ax/attachments hook surface against real
// @ax/database-postgres and @ax/conversations plugins. TASK-68: the bytes now
// ride the content-addressed blob store (blob:put/blob:get), stubbed here via an
// in-memory sha256-keyed map per harness — that's the abstraction boundary at
// this layer (@ax/blob-store-fs owns the real backing store). The attachments
// metadata rows (files/artifacts) ARE real (the postgres harness), so the
// path → row → blob resolution is exercised end-to-end.
//
// The transcript-block branch of path-scope (attachment block referenced from a
// stored turn) is unit-tested in download.test.ts. Here we cover the
// .ax/uploads/<conversationId>/ prefix branch, the canonical commit destination.
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
      // @ax/conversations declares the workspace:* trio as required calls (its
      // transcript path). Stub them so its bootstrap passes — unrelated to the
      // attachments blob path under test.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
      'workspace:apply': async () => ({
        version: 'v-fake',
        delta: { before: null, after: 'v-fake', changes: [] },
      }),
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
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
      createAttachmentsPlugin(),
    ],
  });
  harnesses.push(h);
  return { harness: h, ws };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
  if (container) await container.stop();
});

describe('@ax/attachments bus contract', () => {
  it('full round trip: store-temp → commit → download', async () => {
    const { harness } = await makeHarness();
    const ctx = harness.ctx({ userId: 'u-1', agentId: 'a-1' });

    // 1) Stage a temp upload.
    const tempResult = await harness.bus.call<unknown, StoreTempOutput>(
      'attachments:store-temp',
      ctx,
      {
        bytes: Buffer.from('hello attachments'),
        displayName: 'greeting.txt',
        mediaType: 'text/plain',
      },
    );
    expect(tempResult.attachmentId).toBeTruthy();
    expect(tempResult.sizeBytes).toBe('hello attachments'.length);

    // 2) Create a conversation to scope this attachment.
    const convResult = await harness.bus.call<unknown, ConversationsCreateMin>(
      'conversations:create',
      ctx,
      { userId: 'u-1', agentId: 'a-1' },
    );
    const conversationId = convResult.conversationId;
    expect(conversationId).toBeTruthy();
    const turnId = `t-${Date.now()}`;

    // 3) Commit the temp into the workspace.
    const commitResult = await harness.bus.call<unknown, CommitOutput>(
      'attachments:commit',
      ctx,
      { attachmentId: tempResult.attachmentId, conversationId, turnId },
    );
    expect(commitResult.path).toMatch(
      new RegExp(`^\\.ax/uploads/${conversationId}/${turnId}/`),
    );
    expect(commitResult.sha256).toBe(
      createHash('sha256').update('hello attachments').digest('hex'),
    );
    expect(commitResult.mediaType).toBe('text/plain');
    expect(commitResult.displayName).toBe('greeting.txt');

    // 4) Download — should succeed via the .ax/uploads/<conv>/ prefix
    //    branch of path-scope. No transcript entry needed.
    const downloaded = await harness.bus.call<unknown, DownloadOutput>(
      'attachments:download',
      ctx,
      { path: commitResult.path, conversationId, userId: 'u-1' },
    );
    expect(Buffer.from(downloaded.bytes).toString()).toBe('hello attachments');
    // TASK-68: download now sources mediaType from the AUTHORITATIVE committed
    // files row (text/plain), not the octet-stream fall-back the git path used
    // when there was no transcript block. The row metadata is the better truth.
    expect(downloaded.mediaType).toBe('text/plain');
    expect(downloaded.displayName).toBe('greeting.txt');
  });

  it('rejects foreign user with not-found (cross-user existence-leak)', async () => {
    const { harness } = await makeHarness();
    const ownerCtx = harness.ctx({ userId: 'u-owner', agentId: 'a-1' });

    // Owner creates + commits.
    const tempResult = await harness.bus.call<unknown, StoreTempOutput>(
      'attachments:store-temp',
      ownerCtx,
      {
        bytes: Buffer.from('secret'),
        displayName: 'secret.txt',
        mediaType: 'text/plain',
      },
    );
    const conv = await harness.bus.call<unknown, ConversationsCreateMin>(
      'conversations:create',
      ownerCtx,
      { userId: 'u-owner', agentId: 'a-1' },
    );
    const commitResult = await harness.bus.call<unknown, CommitOutput>(
      'attachments:commit',
      ownerCtx,
      {
        attachmentId: tempResult.attachmentId,
        conversationId: conv.conversationId,
        turnId: 't-1',
      },
    );

    // Foreign user tries to download — must surface not-found.
    const attackerCtx = harness.ctx({ userId: 'u-attacker', agentId: 'a-1' });
    await expect(
      harness.bus.call('attachments:download', attackerCtx, {
        path: commitResult.path,
        conversationId: conv.conversationId,
        userId: 'u-attacker',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects out-of-scope path with forbidden', async () => {
    const { harness } = await makeHarness();
    const ctx = harness.ctx({ userId: 'u-1', agentId: 'a-1' });
    const conv = await harness.bus.call<unknown, ConversationsCreateMin>(
      'conversations:create',
      ctx,
      { userId: 'u-1', agentId: 'a-1' },
    );
    // Try to download a path under a DIFFERENT conversation id — owner
    // gate passes (same userId on the named conversation), but path-scope
    // fails because path isn't under .ax/uploads/<conv.conversationId>/.
    await expect(
      harness.bus.call('attachments:download', ctx, {
        path: '.ax/uploads/c-not-mine/t-not-mine/secret.pdf',
        conversationId: conv.conversationId,
        userId: 'u-1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
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

    const attackerConv = await harness.bus.call<unknown, ConversationsCreateMin>(
      'conversations:create',
      attacker,
      { userId: 'u-attacker', agentId: 'a-1' },
    );

    await expect(
      harness.bus.call('attachments:commit', attacker, {
        attachmentId: tempResult.attachmentId,
        conversationId: attackerConv.conversationId,
        turnId: 't-1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
