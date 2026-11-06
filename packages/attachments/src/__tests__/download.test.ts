import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { createAttachmentsStore, type AttachmentsStore } from '../store.js';
import { finishArtifactsMigration } from '../artifacts/migrations.js';
import { createArtifactStore, type ArtifactStore } from '../artifacts/store.js';
import { createDownloadHandler } from '../handlers.js';

// ---------------------------------------------------------------------------
// attachments:download — serves an upload or a published artifact BY ID.
//
// The ACL ladder: the caller is who they say they are (input.userId ===
// ctx.userId) → the caller owns the conversation they name
// (conversations:get) → the id resolves to an upload in THAT conversation,
// written by that same user, or to an artifact of THAT conversation's agent
// (served at its current version) → blob:get. Every refusal is the same `not-found`, and no
// refusal ever fetches bytes.
//
// The metadata rows are real (Postgres); conversations:get and blob:get are
// fakes on the bus — the ownership answer and the bytes are other plugins'.
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

function makeCtx(userId: string): AgentContext {
  return makeAgentContext({ sessionId: 'test-session', agentId: 'test-agent', userId });
}

const SHA_PDF = 'a'.repeat(64);
const SHA_PNG = 'b'.repeat(64);
const SHA_GONE = 'c'.repeat(64);
const SHA_PNG_V2 = 'd'.repeat(64);

/** Who owns which conversation, as conversations:get would answer. */
const OWNERS: Record<string, string> = {
  'c-1': 'u-1',
  'c-1b': 'u-1',
  'c-2': 'u-1',
  'c-other': 'u-2',
};
/** Which agent each conversation is with. */
const AGENTS: Record<string, string> = {
  'c-1': 'a-1',
  'c-1b': 'a-1',
  'c-2': 'a-2',
  'c-other': 'a-other',
};

interface Rig {
  store: AttachmentsStore;
  artifacts: ArtifactStore;
  download: ReturnType<typeof createDownloadHandler>;
  blobGets: string[];
  conversationGets: Array<{ conversationId: string; userId: string }>;
}

async function rig(
  opts: { conversationsGet?: (input: { conversationId: string; userId: string }) => Promise<unknown> } = {},
): Promise<Rig> {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  await finishArtifactsMigration(db);
  const store = createAttachmentsStore(db);
  const artifacts = createArtifactStore(db);
  const bus = new HookBus();
  const blobGets: string[] = [];
  const conversationGets: Array<{ conversationId: string; userId: string }> = [];
  bus.registerService<{ conversationId: string; userId: string }, unknown>(
    'conversations:get',
    'test-conversations',
    async (_ctx, input) => {
      conversationGets.push(input);
      if (opts.conversationsGet) return opts.conversationsGet(input);
      if (OWNERS[input.conversationId] !== input.userId) {
        throw new PluginError({ code: 'not-found', plugin: 'test-conversations', message: 'conversation not found' });
      }
      return {
        conversation: {
          conversationId: input.conversationId,
          userId: input.userId,
          agentId: AGENTS[input.conversationId],
        },
        turns: [],
      };
    },
  );
  const blobs: Record<string, string> = {
    [SHA_PDF]: 'pdf-bytes',
    [SHA_PNG]: 'png-bytes',
    [SHA_PNG_V2]: 'png-bytes-v2',
  };
  bus.registerService<{ sha256: string }, { bytes: Uint8Array } | { found: false }>(
    'blob:get',
    'test-blob',
    async (_ctx, { sha256 }) => {
      blobGets.push(sha256);
      const bytes = blobs[sha256];
      return bytes === undefined ? { found: false } : { bytes: new Uint8Array(Buffer.from(bytes)) };
    },
  );
  return {
    store,
    artifacts,
    download: createDownloadHandler({ bus, store, artifacts }),
    blobGets,
    conversationGets,
  };
}

async function seedUpload(
  store: AttachmentsStore,
  id: string,
  conversationId: string,
  opts: { userId?: string; sha256?: string } = {},
): Promise<void> {
  await store.insertFile({
    id,
    conversationId,
    userId: opts.userId ?? 'u-1',
    sha256: opts.sha256 ?? SHA_PDF,
    displayName: 'Q4 Report.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 9,
  });
}

/** Publish a version of `agentId`'s out/chart.png; returns the artifact id. */
async function seedArtifact(
  artifacts: ArtifactStore,
  agentId: string,
  opts: { sha256?: string; title?: string; conversationId?: string } = {},
): Promise<string> {
  const r = await artifacts.publishVersion({
    agentId,
    sourcePath: 'out/chart.png',
    title: opts.title ?? 'chart.png',
    sha256: opts.sha256 ?? SHA_PNG,
    mediaType: 'image/png',
    sizeBytes: 9,
    conversationId: opts.conversationId ?? 'c-1',
    publishedBy: 'u-1',
    quotaOwner: 'u-1',
  });
  if (!r.ok) throw new Error(r.reason);
  return r.artifactId;
}

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

describe('attachments:download (by id)', () => {
  it('download serves an upload by id to the owner of its conversation', async () => {
    const r = await rig();
    await seedUpload(r.store, 'up-1', 'c-1');

    const out = await r.download(makeCtx('u-1'), { attachmentId: 'up-1', conversationId: 'c-1', userId: 'u-1' });

    expect(Buffer.from(out.bytes).toString()).toBe('pdf-bytes');
    expect(out.mediaType).toBe('application/pdf');
    expect(out.displayName).toBe('Q4 Report.pdf');
    expect(out.sizeBytes).toBe(9);
    expect(r.conversationGets).toEqual([{ conversationId: 'c-1', userId: 'u-1' }]);
  });

  it('download serves an artifact by id', async () => {
    const r = await rig();
    const id = await seedArtifact(r.artifacts, 'a-1');

    const out = await r.download(makeCtx('u-1'), { attachmentId: id, conversationId: 'c-1', userId: 'u-1' });

    expect(Buffer.from(out.bytes).toString()).toBe('png-bytes');
    expect(out.mediaType).toBe('image/png');
    expect(out.displayName).toBe('chart.png');
  });

  it("an old chip id downloads the artifact's current version", async () => {
    const r = await rig();
    const id = await seedArtifact(r.artifacts, 'a-1', { title: 'Sales chart' });
    // The same file published again: the chip from v1 now means v2.
    await seedArtifact(r.artifacts, 'a-1', { sha256: SHA_PNG_V2, title: 'Sales chart' });

    const out = await r.download(makeCtx('u-1'), { attachmentId: id, conversationId: 'c-1', userId: 'u-1' });

    expect(Buffer.from(out.bytes).toString()).toBe('png-bytes-v2');
    expect(r.blobGets).toEqual([SHA_PNG_V2]);
    // Saved under the title plus the extension of its type.
    expect(out.displayName).toBe('Sales chart.png');
  });

  // Artifacts are the agent's (D12): any of the caller's chats with that agent
  // reaches them, including after the chat that made them is gone.
  it("downloads an artifact from another of the caller's chats with the same agent", async () => {
    const r = await rig();
    const id = await seedArtifact(r.artifacts, 'a-1', { conversationId: 'c-1' });
    const out = await r.download(makeCtx('u-1'), { attachmentId: id, conversationId: 'c-1b', userId: 'u-1' });
    expect(Buffer.from(out.bytes).toString()).toBe('png-bytes');
  });

  it('an artifact of another agent, named from my own conversation, is a 404', async () => {
    const r = await rig();
    const mineElsewhere = await seedArtifact(r.artifacts, 'a-2', { conversationId: 'c-2' });
    const someoneElses = await seedArtifact(r.artifacts, 'a-other', { conversationId: 'c-other' });

    for (const attachmentId of [mineElsewhere, someoneElses]) {
      await expect(
        r.download(makeCtx('u-1'), { attachmentId, conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    }
    expect(r.blobGets).toEqual([]);
  });

  // Review focus 2: a chip in a conversation the caller owns, pointing at an
  // id from ANOTHER conversation (the caller's own other chat, or someone
  // else's), must not serve that file.
  it('download refuses an upload that belongs to another conversation', async () => {
    const r = await rig();
    await seedUpload(r.store, 'up-in-c2', 'c-2');

    await expect(
      r.download(makeCtx('u-1'), { attachmentId: 'up-in-c2', conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.blobGets).toEqual([]);
  });

  // An owner-gate answer without a usable agent id fails closed.
  it('refuses an artifact when conversations:get names no agent', async () => {
    const r = await rig({
      conversationsGet: async (input) => ({ conversation: { conversationId: input.conversationId }, turns: [] }),
    });
    const id = await seedArtifact(r.artifacts, 'a-1');
    await expect(
      r.download(makeCtx('u-1'), { attachmentId: id, conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.blobGets).toEqual([]);
  });

  it("refuses another user's attachment named through the caller's own conversation", async () => {
    const r = await rig();
    await seedUpload(r.store, 'up-foreign', 'c-other', { userId: 'u-2' });

    await expect(
      r.download(makeCtx('u-1'), { attachmentId: 'up-foreign', conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.blobGets).toEqual([]);
  });

  it('download refuses a conversation the caller does not own', async () => {
    const r = await rig();
    await seedUpload(r.store, 'up-foreign', 'c-other', { userId: 'u-2' });

    await expect(
      r.download(makeCtx('u-1'), { attachmentId: 'up-foreign', conversationId: 'c-other', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.blobGets).toEqual([]);
  });

  it('collapses forbidden from conversations:get to not-found', async () => {
    const r = await rig({
      conversationsGet: async () => {
        throw new PluginError({ code: 'forbidden', plugin: 'test-conversations', message: 'no' });
      },
    });
    await seedUpload(r.store, 'up-1', 'c-1');

    await expect(
      r.download(makeCtx('u-1'), { attachmentId: 'up-1', conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.blobGets).toEqual([]);
  });

  // A conversation has one owner, and every row in it was written by that
  // owner (their upload, or their own runner's publish). A row in the caller's
  // conversation that someone else recorded is not theirs to read.
  it("refuses a row in the caller's conversation that another user recorded", async () => {
    const r = await rig();
    await seedUpload(r.store, 'up-planted', 'c-1', { userId: 'u-2' });

    await expect(
      r.download(makeCtx('u-1'), { attachmentId: 'up-planted', conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.blobGets).toEqual([]);
  });

  it('rejects input.userId !== ctx.userId with not-found (spoof attempt)', async () => {
    const r = await rig();
    await seedUpload(r.store, 'up-1', 'c-1');

    await expect(
      r.download(makeCtx('u-2'), { attachmentId: 'up-1', conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.conversationGets).toEqual([]);
    expect(r.blobGets).toEqual([]);
  });

  it.each(['../x', 'a/b', '', 'a'.repeat(129), '.ax/uploads/c-1/t/x.pdf'])(
    'rejects the malformed attachment id %j with not-found',
    async (attachmentId) => {
      const r = await rig();
      await expect(
        r.download(makeCtx('u-1'), { attachmentId, conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
      expect(r.blobGets).toEqual([]);
    },
  );

  it('returns not-found for an id with no row', async () => {
    const r = await rig();
    await expect(
      r.download(makeCtx('u-1'), { attachmentId: 'never-committed', conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.blobGets).toEqual([]);
  });

  it('returns not-found when the row exists but the blob is gone', async () => {
    const r = await rig();
    await seedUpload(r.store, 'up-gone', 'c-1', { sha256: SHA_GONE });

    await expect(
      r.download(makeCtx('u-1'), { attachmentId: 'up-gone', conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(r.blobGets).toEqual([SHA_GONE]);
  });

  // An outage is not an ACL answer: it must surface as the failure it is,
  // never as a quiet "not found".
  it('propagates a conversations:get failure that is not an ACL answer', async () => {
    const r = await rig({
      conversationsGet: async () => {
        throw new Error('conversations store unreachable');
      },
    });
    await seedUpload(r.store, 'up-1', 'c-1');

    await expect(
      r.download(makeCtx('u-1'), { attachmentId: 'up-1', conversationId: 'c-1', userId: 'u-1' }),
    ).rejects.toThrow(/conversations store unreachable/);
    expect(r.blobGets).toEqual([]);
  });
});
