import {
  describe, it, expect, beforeAll, afterAll, afterEach,
} from 'vitest';
import { createHash } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '@ax/conversations';
import { createAttachmentsPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// End-to-end contract test (Task 11).
//
// Exercises the @ax/attachments hook surface against real
// @ax/database-postgres and @ax/conversations plugins. workspace:apply and
// workspace:read are stubbed via an in-memory blob map per harness — that's
// the abstraction boundary at this layer (Phase 2 of the workspace plugins
// owns the real backing store).
//
// The transcript-block branch of path-scope (attachment block referenced
// from a stored turn) is unit-tested in download.test.ts. Phase E removed
// conversations:append-turn — transcripts now live in runner-native jsonl
// in the workspace — so injecting a turn via the bus would require a real
// workspace, not a stub. Here we cover the .ax/uploads/<conversationId>/
// prefix branch, which is the canonical commit destination.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// Shared in-memory workspace blob store. workspace:apply writes here;
// workspace:read serves from here. Scoped per-harness via closures.
interface WorkspaceFakeState {
  blobs: Map<string, Uint8Array>;
}

async function makeHarness(): Promise<{ harness: TestHarness; ws: WorkspaceFakeState }> {
  const ws: WorkspaceFakeState = { blobs: new Map() };
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:apply': async (_ctx, input: unknown) => {
        const { changes } = input as {
          changes: Array<{ path: string; kind: 'put' | 'delete'; content?: Uint8Array }>;
        };
        for (const change of changes) {
          if (change.kind === 'put' && change.content !== undefined) {
            ws.blobs.set(change.path, change.content);
          }
          if (change.kind === 'delete') {
            ws.blobs.delete(change.path);
          }
        }
        return { version: 'v-fake', delta: { before: null, after: 'v-fake', changes: [] } };
      },
      'workspace:read': async (_ctx, input: unknown) => {
        const { path } = input as { path: string };
        const bytes = ws.blobs.get(path);
        if (bytes === undefined) {
          return { found: false } as const;
        }
        return { found: true as const, bytes };
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
    const tempResult = await harness.bus.call<unknown, any>(
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
    const convResult = await harness.bus.call<unknown, any>(
      'conversations:create',
      ctx,
      { userId: 'u-1', agentId: 'a-1' },
    );
    const conversationId = convResult.conversationId;
    expect(conversationId).toBeTruthy();
    const turnId = `t-${Date.now()}`;

    // 3) Commit the temp into the workspace.
    const commitResult = await harness.bus.call<unknown, any>(
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
    const downloaded = await harness.bus.call<unknown, any>(
      'attachments:download',
      ctx,
      { path: commitResult.path, conversationId, userId: 'u-1' },
    );
    expect(Buffer.from(downloaded.bytes).toString()).toBe('hello attachments');
    // The .ax/uploads/<conv>/ branch returns octet-stream defaults when
    // there's no transcript block to source metadata from. This is the
    // documented fall-back path in checkPathScope.
    expect(downloaded.mediaType).toBe('application/octet-stream');
  });

  it('rejects foreign user with not-found (cross-user existence-leak)', async () => {
    const { harness } = await makeHarness();
    const ownerCtx = harness.ctx({ userId: 'u-owner', agentId: 'a-1' });

    // Owner creates + commits.
    const tempResult = await harness.bus.call<unknown, any>(
      'attachments:store-temp',
      ownerCtx,
      {
        bytes: Buffer.from('secret'),
        displayName: 'secret.txt',
        mediaType: 'text/plain',
      },
    );
    const conv = await harness.bus.call<unknown, any>(
      'conversations:create',
      ownerCtx,
      { userId: 'u-owner', agentId: 'a-1' },
    );
    const commitResult = await harness.bus.call<unknown, any>(
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
    const conv = await harness.bus.call<unknown, any>(
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

    const tempResult = await harness.bus.call<unknown, any>(
      'attachments:store-temp',
      victim,
      {
        bytes: Buffer.from('secret'),
        displayName: 'secret.txt',
        mediaType: 'text/plain',
      },
    );

    const attackerConv = await harness.bus.call<unknown, any>(
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
