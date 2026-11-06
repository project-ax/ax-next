import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { Logger } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAttachmentsPlugin } from '../plugin.js';
import type { AttachmentsDatabase } from '../migrations.js';
import { createArtifactStore, type ArtifactStore } from '../artifacts/store.js';

// ---------------------------------------------------------------------------
// D12: deleting an agent deletes its artifacts, every version, and nothing of
// any other agent. `agents:deleted` is fired by @ax/agents after the row is gone.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifact_versions');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifacts');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_files');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_temps');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function captureLogger(lines: LogLine[]): Logger {
  const at =
    (level: LogLine['level']) =>
    (msg: string, bindings?: Record<string, unknown>): void => {
      lines.push({ level, msg, bindings });
    };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  return logger;
}

async function rig(): Promise<{
  db: Kysely<AttachmentsDatabase>;
  artifacts: ArtifactStore;
  lines: LogLine[];
  deleted(payload: unknown): Promise<void>;
}> {
  const h = await createTestHarness({
    services: {
      'blob:put': async () => ({ sha256: 'a'.repeat(64), size: 0 }),
      'blob:get': async () => ({ found: false }),
      'blob:stat': async () => ({ found: false }),
      'conversations:get': async () => ({ conversation: { agentId: 'agt-1' }, turns: [] }),
      'agents:resolve': async () => ({ agent: { ownerType: 'user', ownerId: 'u-1' } }),
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAttachmentsPlugin({ janitorIntervalSeconds: 3600 })],
  });
  harnesses.push(h);
  const { db } = await h.bus.call<unknown, { db: Kysely<AttachmentsDatabase> }>('database:get-instance', h.ctx(), {});
  const lines: LogLine[] = [];
  return {
    db,
    artifacts: createArtifactStore(db),
    lines,
    async deleted(payload) {
      await h.bus.fire('agents:deleted', h.ctx({ logger: captureLogger(lines) }), payload);
    },
  };
}

async function publish(artifacts: ArtifactStore, agentId: string, sourcePath: string, n: number): Promise<string> {
  const r = await artifacts.publishVersion({
    agentId,
    sourcePath,
    title: sourcePath,
    sha256: n.toString(16).padStart(64, '0'),
    mediaType: 'text/html',
    sizeBytes: 1,
    conversationId: 'c-1',
    publishedBy: 'u-1',
    quotaOwner: 'u-1',
  });
  if (!r.ok) throw new Error(r.reason);
  return r.artifactId;
}

async function counts(db: Kysely<AttachmentsDatabase>): Promise<{ heads: number; versions: number }> {
  const h = await sql<{ n: number }>`SELECT count(*)::int AS n FROM attachments_v1_artifacts`.execute(db);
  const v = await sql<{ n: number }>`SELECT count(*)::int AS n FROM attachments_v1_artifact_versions`.execute(db);
  return { heads: h.rows[0]!.n, versions: v.rows[0]!.n };
}

describe('@ax/attachments subscribes to agents:deleted', () => {
  it('deletes every artifact and version of the deleted agent and nothing of another agent', async () => {
    const r = await rig();
    await publish(r.artifacts, 'agt-doomed', 'a.html', 1);
    await publish(r.artifacts, 'agt-doomed', 'a.html', 2);
    await publish(r.artifacts, 'agt-doomed', 'b.html', 3);
    const kept = await publish(r.artifacts, 'agt-kept', 'a.html', 4);

    await r.deleted({ agentId: 'agt-doomed', ownerId: 'u-1', ownerType: 'user' });

    expect(await r.artifacts.listForAgent('agt-doomed', 10)).toEqual([]);
    expect(await counts(r.db)).toEqual({ heads: 1, versions: 1 });
    expect((await r.artifacts.getHead(kept))?.agentId).toBe('agt-kept');
    expect(r.lines.find((l) => l.level === 'info')?.bindings).toMatchObject({ agentId: 'agt-doomed', artifacts: 2, versions: 3 });
  });

  it('ignores a malformed payload with a warning, and logs and swallows a store failure', async () => {
    const r = await rig();
    await publish(r.artifacts, 'agt-1', 'a.html', 1);

    for (const payload of [null, 'agt-1', {}, { agentId: 42 }, { agentId: '' }, { agentId: 'x'.repeat(257) }]) {
      await r.deleted(payload);
    }
    expect(r.lines.filter((l) => l.level === 'warn')).toHaveLength(6);
    expect(await counts(r.db)).toEqual({ heads: 1, versions: 1 });

    await sql`DROP TABLE attachments_v1_artifact_versions`.execute(r.db);
    await expect(r.deleted({ agentId: 'agt-1' })).resolves.toBeUndefined();
    const errors = r.lines.filter((l) => l.level === 'error');
    // The subscriber's own line, not the bus's hook_subscriber_failed backstop.
    expect(errors.map((l) => l.msg)).toEqual(['attachments_artifacts_delete_for_agent_failed']);
    expect(errors[0]?.bindings?.err).toBeInstanceOf(Error);
    // Nothing half-deleted: the head survives the failed transaction.
    const heads = await sql<{ n: number }>`SELECT count(*)::int AS n FROM attachments_v1_artifacts`.execute(r.db);
    expect(heads.rows[0]!.n).toBe(1);
  });
});
