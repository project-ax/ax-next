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
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { createAttachmentsStore } from '../store.js';
import { finishArtifactsMigration } from '../artifacts/migrations.js';
import { createArtifactStore } from '../artifacts/store.js';
import { createListForConversationHandler } from '../handlers.js';
import { createArtifactsPublishHandler } from '../artifacts/handlers.js';

// ---------------------------------------------------------------------------
// TASK-68: attachments:list-for-conversation, and the shared publish chain the
// IPC `artifact.publish` action drives through `artifacts:publish`, against a
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

function makeCtx(userId: string, agentId = 'a') {
  return makeAgentContext({ sessionId: 's', agentId, userId });
}

/** The ctx a runner's publish arrives with: the session's own agent. */
function agentCtx(userId: string, agentId = 'agt-1') {
  return makeCtx(userId, agentId);
}

async function freshSetup() {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  await finishArtifactsMigration(db);
  return { db, store: createAttachmentsStore(db), artifacts: createArtifactStore(db) };
}

async function artifactRowCount(db: Kysely<AttachmentsDatabase>): Promise<number> {
  const rows = await db.selectFrom('attachments_v1_artifact_versions').select('artifact_id').execute();
  return rows.length;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('attachments_v1_files').ifExists().execute();
      await k.schema.dropTable('attachments_v1_artifact_versions').ifExists().execute();
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
const SHA2 = 'b'.repeat(64);

/** Who owns which conversation, as conversations:get would answer. */
const OWNERS: Record<string, string> = { 'c-1': 'u-1', 'c-2': 'u-1', 'c-team': 'u-1', 'c-gone': 'u-1', 'c-other': 'u-2' };
/** Each conversation's agent; and each agent's owner, as agents:resolve would answer. */
const AGENT_OF: Record<string, string> = { 'c-1': 'agt-1', 'c-2': 'agt-1', 'c-team': 'agt-team', 'c-gone': 'agt-gone', 'c-other': 'agt-other' };
const OWNER_OF: Record<string, { ownerType: string; ownerId: string }> = {
  'agt-1': { ownerType: 'user', ownerId: 'u-1' },
  'agt-team': { ownerType: 'team', ownerId: 't-1' },
  'agt-other': { ownerType: 'user', ownerId: 'u-2' },
};

// D10: `artifacts:publish` asks the blob store whether the sha is there
// before it writes a row. `stored` maps the shas this fake store holds to their
// size. It also asks conversations:get whether the caller owns the
// conversation (and which agent it is with), then agents:resolve for the
// agent's owner (the version's quota owner, C4).
function makeBlobStatBus(
  stored: Record<string, number> = { [SHA]: 2048, [SHA2]: 4096 },
): { bus: HookBus; stats: string[]; resolves: string[] } {
  const bus = new HookBus();
  const stats: string[] = [];
  const resolves: string[] = [];
  bus.registerService<{ sha256: string }, { size: number } | { found: false }>(
    'blob:stat',
    'test-blob',
    async (_ctx, { sha256 }) => {
      stats.push(sha256);
      const size = stored[sha256];
      return size === undefined ? { found: false } : { size };
    },
  );
  bus.registerService<{ conversationId: string; userId: string }, unknown>(
    'conversations:get',
    'test-conversations',
    async (_ctx, { conversationId, userId }) => {
      if (OWNERS[conversationId] !== userId) {
        throw new PluginError({ code: 'not-found', plugin: 'test-conversations', message: 'conversation not found' });
      }
      return { conversation: { conversationId, userId, agentId: AGENT_OF[conversationId] }, turns: [] };
    },
  );
  bus.registerService<{ agentId: string; userId: string }, unknown>(
    'agents:resolve',
    'test-agents',
    async (_ctx, { agentId }) => {
      resolves.push(agentId);
      const owner = OWNER_OF[agentId];
      if (owner === undefined) {
        throw new PluginError({ code: 'not-found', plugin: 'test-agents', message: 'agent not found' });
      }
      return { agent: { id: agentId, ...owner } };
    },
  );
  return { bus, stats, resolves };
}

// No media type or size: the type comes from the path, the size from the store.
const REPORT = {
  conversationId: 'c-1',
  sha256: SHA,
  sourcePath: 'reports/report.pdf',
  title: 'report.pdf',
};

const publishWith = createArtifactsPublishHandler;

describe('the publish chain, through artifacts:publish', () => {
  it("publishes v1 of the conversation's agent's artifact and returns an opaque id", async () => {
    const { artifacts } = await freshSetup();
    const handler = publishWith({ artifacts, bus: makeBlobStatBus().bus });
    const out = await handler(agentCtx('u-1'), REPORT);
    expect(out.artifactId).toMatch(/^[a-f0-9]{32}$/);
    const head = await artifacts.getHead(out.artifactId);
    expect(head).toMatchObject({
      agentId: 'agt-1',
      title: 'report.pdf',
      sourcePath: 'reports/report.pdf',
      currentVersion: 1,
      createdByUserId: 'u-1',
    });
    expect(head!.current).toMatchObject({
      sha256: SHA,
      mediaType: 'application/pdf',
      sizeBytes: 2048,
      conversationId: 'c-1',
      publishedBy: 'u-1',
      quotaOwner: 'u-1',
    });
  });

  it('a re-publish of the same path adds a version to the same artifact, from any chat with the agent', async () => {
    const { db, artifacts } = await freshSetup();
    const handler = publishWith({ artifacts, bus: makeBlobStatBus().bus });
    const first = await handler(agentCtx('u-1'), REPORT);
    const second = await handler(agentCtx('u-1'), { ...REPORT, conversationId: 'c-2', sha256: SHA2 });
    expect(second.artifactId).toBe(first.artifactId);
    expect((await artifacts.getHead(first.artifactId))!.current).toMatchObject({
      version: 2,
      sha256: SHA2,
      conversationId: 'c-2',
    });
    expect(await artifactRowCount(db)).toBe(2);
  });

  it('identical bytes under different paths are different artifacts', async () => {
    const { artifacts } = await freshSetup();
    const handler = publishWith({ artifacts, bus: makeBlobStatBus().bus });
    const a = await handler(agentCtx('u-1'), { ...REPORT, sourcePath: 'a.txt' });
    const b = await handler(agentCtx('u-1'), { ...REPORT, sourcePath: 'b.txt' });
    expect(a.artifactId).not.toBe(b.artifactId);
  });

  it("charges a team agent's version to the team (C4)", async () => {
    const { artifacts } = await freshSetup();
    const handler = publishWith({ artifacts, bus: makeBlobStatBus().bus });
    const out = await handler(agentCtx('u-1', 'agt-team'), { ...REPORT, conversationId: 'c-team' });
    expect((await artifacts.getHead(out.artifactId))!.current).toMatchObject({ publishedBy: 'u-1', quotaOwner: 'team:t-1' });
  });

  it('normalizes the proposed title, and refuses one with nothing visible', async () => {
    const { artifacts } = await freshSetup();
    const handler = publishWith({ artifacts, bus: makeBlobStatBus().bus });
    const named = await handler(agentCtx('u-1'), { ...REPORT, sourcePath: 'a.html', title: ' Deal\u000atracker\u202e ' });
    expect((await artifacts.getHead(named.artifactId))!.title).toBe('Deal tracker');
    await expect(
      handler(agentCtx('u-1'), { ...REPORT, sourcePath: 'out/q3.html', title: '\u200b' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  // TASK-776 / design D10. The bug this closes: a runner could publish a row
  // pointing at a sha the blob store no longer (or never) held, and the person
  // got a download link that 404s. The row must not be written at all.
  it('publish of an unknown sha writes no row', async () => {
    const { db, artifacts } = await freshSetup();
    const { bus, stats } = makeBlobStatBus({}); // the store holds nothing
    const handler = publishWith({ artifacts, bus });
    const err = await handler(agentCtx('u-1'), REPORT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('not-found');
    expect((err as PluginError).plugin).toBe('@ax/attachments');
    expect((err as PluginError).hookName).toBe('artifacts:publish');
    expect(stats).toEqual([SHA]);
    expect(await artifactRowCount(db)).toBe(0);
  });

  it('a blob:stat failure propagates and writes no row (never "assume it is there")', async () => {
    const { db, artifacts } = await freshSetup();
    const bus = new HookBus();
    bus.registerService('conversations:get', 'test-conversations', async () => ({ conversation: { agentId: 'agt-1' } }));
    bus.registerService('agents:resolve', 'test-agents', async () => ({ agent: { ownerType: 'user', ownerId: 'u-1' } }));
    bus.registerService('blob:stat', 'test-blob', async () => {
      throw new Error('blob store unreachable');
    });
    const handler = publishWith({ artifacts, bus });
    await expect(handler(agentCtx('u-1'), REPORT)).rejects.toThrow(/blob store unreachable/);
    expect(await artifactRowCount(db)).toBe(0);
  });

  it('an agents:resolve outage propagates and writes no row', async () => {
    const { db, artifacts } = await freshSetup();
    const bus = new HookBus();
    bus.registerService('conversations:get', 'test-conversations', async () => ({ conversation: { agentId: 'agt-1' } }));
    bus.registerService('agents:resolve', 'test-agents', async () => {
      throw new Error('agents store unreachable');
    });
    bus.registerService('blob:stat', 'test-blob', async () => ({ size: 1 }));
    const handler = publishWith({ artifacts, bus });
    await expect(handler(agentCtx('u-1'), REPORT)).rejects.toThrow(/agents store unreachable/);
    expect(await artifactRowCount(db)).toBe(0);
  });

  it('a re-publish of an unknown sha leaves the earlier version current', async () => {
    const { artifacts } = await freshSetup();
    const first = await publishWith({ artifacts, bus: makeBlobStatBus().bus })(agentCtx('u-1'), REPORT);
    const gone = publishWith({ artifacts, bus: makeBlobStatBus({}).bus });
    await expect(gone(agentCtx('u-1'), { ...REPORT, sha256: SHA2 })).rejects.toThrow(PluginError);
    expect((await artifacts.getHead(first.artifactId))!.current).toMatchObject({ version: 1, sha256: SHA });
  });

  // Where a version lands decides who can read it, so only the conversation's
  // owner may publish through it.
  it('refuses to publish into a conversation the caller does not own, and writes no row', async () => {
    const { db, artifacts } = await freshSetup();
    const { bus, stats, resolves } = makeBlobStatBus();
    const handler = publishWith({ artifacts, bus });
    await expect(
      handler(agentCtx('u-1'), { ...REPORT, conversationId: 'c-other', sourcePath: 'out/planted.html' }),
    ).rejects.toMatchObject({ code: 'forbidden', hookName: 'artifacts:publish' });
    // A refused caller must not learn whether a sha is in the store.
    expect(stats).toEqual([]);
    expect(resolves).toEqual([]);
    expect(await artifactRowCount(db)).toBe(0);
  });

  it('refuses as forbidden when the agent no longer resolves for the caller, before blob:stat', async () => {
    const { db, artifacts } = await freshSetup();
    const { bus, stats } = makeBlobStatBus();
    const handler = publishWith({ artifacts, bus });
    await expect(handler(agentCtx('u-1', 'agt-gone'), { ...REPORT, conversationId: 'c-gone' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(stats).toEqual([]);
    expect(await artifactRowCount(db)).toBe(0);
  });
});

describe('attachments:list-for-conversation handler', () => {
  // The runner names its copies in list order (a later duplicate becomes
  // `name (2)`), so a fresh runner must get the SAME order every time: oldest
  // first, ties broken by id.
  it('list-for-conversation returns oldest first with id and filename', async () => {
    const { db, store } = await freshSetup();
    const t0 = new Date('2026-10-31T10:00:00.000Z');
    const t1 = new Date('2026-10-31T10:05:00.000Z');
    const row = (id: string, conversationId: string, userId: string, createdAt: Date) => ({
      attachment_id: id,
      conversation_id: conversationId,
      user_id: userId,
      sha256: SHA,
      display_name: `${id}.pdf`,
      media_type: 'application/pdf',
      size_bytes: 10,
      created_at: createdAt,
    });
    await db
      .insertInto('attachments_v1_files')
      .values([
        row('late', 'c-1', 'u-1', t1),
        row('tie-b', 'c-1', 'u-1', t0),
        row('tie-a', 'c-1', 'u-1', t0),
        row('elsewhere', 'c-2', 'u-1', t0),
        row('not-mine', 'c-1', 'u-2', t0),
      ])
      .execute();

    const out = await createListForConversationHandler({ store })(makeCtx('u-1'), { conversationId: 'c-1' });

    expect(out.files).toStrictEqual([
      { attachmentId: 'tie-a', filename: 'tie-a.pdf', sha256: SHA, mediaType: 'application/pdf', sizeBytes: 10 },
      { attachmentId: 'tie-b', filename: 'tie-b.pdf', sha256: SHA, mediaType: 'application/pdf', sizeBytes: 10 },
      { attachmentId: 'late', filename: 'late.pdf', sha256: SHA, mediaType: 'application/pdf', sizeBytes: 10 },
    ]);
  });

  it('returns the empty set for a foreign user (no existence leak)', async () => {
    const { store } = await freshSetup();
    await store.insertFile({
      id: 'a-1', conversationId: 'c-1', userId: 'u-owner', sha256: SHA,
      displayName: 'a.png', mediaType: 'image/png', sizeBytes: 99,
    });
    const handler = createListForConversationHandler({ store });
    const out = await handler(makeCtx('u-attacker'), { conversationId: 'c-1' });
    expect(out.files).toEqual([]);
  });
});
