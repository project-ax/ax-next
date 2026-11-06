import { afterAll, afterEach, beforeAll } from 'vitest';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { finishArtifactsMigration } from '../artifacts/migrations.js';
import { createArtifactStore, type ArtifactStore } from '../artifacts/store.js';
import { registerArtifactHooks } from '../artifacts/handlers.js';

// Shared by artifacts-hooks.test.ts and artifacts-augment.test.ts: real
// Postgres, the real artifact hooks on a bare bus, and stubs for the hooks
// they call (conversations:get, agents:resolve, blob:stat, blob:get).

/** Who owns which conversation, and which agent it is with. */
export const CONVERSATIONS: Record<string, { userId: string; agentId: string }> = {
  'c-1': { userId: 'u-1', agentId: 'agt-1' },
  'c-1b': { userId: 'u-1', agentId: 'agt-1' },
  'c-team-u1': { userId: 'u-1', agentId: 'agt-team' },
  'c-team-u2': { userId: 'u-2', agentId: 'agt-team' },
  'c-other': { userId: 'u-2', agentId: 'agt-2' },
};

/** Each agent's owner, and who may reach it (agents:resolve answers). */
export const AGENTS: Record<string, { ownerType: 'user' | 'team'; ownerId: string; members: string[] }> = {
  'agt-1': { ownerType: 'user', ownerId: 'u-1', members: ['u-1'] },
  'agt-2': { ownerType: 'user', ownerId: 'u-2', members: ['u-2'] },
  'agt-team': { ownerType: 'team', ownerId: 't-1', members: ['u-1', 'u-2'] },
};

export const SHA = 'a'.repeat(64);
export const SHA2 = 'b'.repeat(64);
export const BYTES: Record<string, Uint8Array> = {
  [SHA]: new Uint8Array([1, 2, 3]),
  [SHA2]: new Uint8Array([4, 5, 6, 7, 8]),
};

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AttachmentsDatabase>[] = [];

export function useArtifactsDb(): void {
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
        /* drained */
      }
      await k.destroy().catch(() => {});
    }
  });

  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });
}

export interface Rig {
  bus: HookBus;
  db: Kysely<AttachmentsDatabase>;
  artifacts: ArtifactStore;
  /** Set to make agents:resolve fail the way an outage does. */
  outage: { on: boolean };
}

export async function makeRig(): Promise<Rig> {
  const db = new Kysely<AttachmentsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(db);
  await runAttachmentsMigration(db);
  await finishArtifactsMigration(db);
  const artifacts = createArtifactStore(db);
  const bus = new HookBus();
  const outage = { on: false };

  bus.registerService<{ conversationId: string; userId: string }, unknown>(
    'conversations:get',
    'test-conversations',
    async (_ctx, { conversationId, userId }) => {
      const c = CONVERSATIONS[conversationId];
      if (c === undefined || c.userId !== userId) {
        throw new PluginError({ code: 'not-found', plugin: 'test-conversations', message: 'conversation not found' });
      }
      return { conversation: { conversationId, userId, agentId: c.agentId }, turns: [] };
    },
  );
  bus.registerService<{ agentId: string; userId: string }, unknown>(
    'agents:resolve',
    'test-agents',
    async (_ctx, { agentId, userId }) => {
      if (outage.on) throw new Error('connection refused');
      const a = AGENTS[agentId];
      if (a === undefined) throw new PluginError({ code: 'not-found', plugin: 'test-agents', message: 'agent not found' });
      if (!a.members.includes(userId)) {
        throw new PluginError({ code: 'forbidden', plugin: 'test-agents', message: 'not yours' });
      }
      return { agent: { id: agentId, ownerType: a.ownerType, ownerId: a.ownerId } };
    },
  );
  bus.registerService<{ sha256: string }, unknown>('blob:stat', 'test-blob', async (_ctx, { sha256 }) => {
    const b = BYTES[sha256];
    return b === undefined ? { found: false } : { size: b.byteLength };
  });
  bus.registerService<{ sha256: string }, unknown>('blob:get', 'test-blob', async (_ctx, { sha256 }) => {
    const b = BYTES[sha256];
    return b === undefined ? { found: false } : { bytes: b };
  });

  registerArtifactHooks(bus, '@ax/attachments', { artifacts, bus });
  return { bus, db, artifacts, outage };
}

/** A person's context (a route call), or an agent's when `agentId` is given. */
export function ctxFor(userId: string, agentId = 'host-route') {
  return makeAgentContext({ sessionId: 's', agentId, userId });
}

export interface PublishArgs {
  conversationId?: string;
  sha256?: string;
  sourcePath?: string;
  title?: string;
  artifactId?: string;
}

/** Publish as u-1's agt-1 from c-1, unless told otherwise. */
export function publish(rig: Rig, args: PublishArgs = {}, userId = 'u-1', agentId?: string) {
  const conversationId = args.conversationId ?? 'c-1';
  return rig.bus.call<Record<string, unknown>, { artifactId: string; version: number; title: string; kind: string; extension: string }>(
    'artifacts:publish',
    ctxFor(userId, agentId ?? CONVERSATIONS[conversationId]!.agentId),
    {
      conversationId,
      sha256: args.sha256 ?? SHA,
      sourcePath: args.sourcePath ?? 'reports/q3.pdf',
      title: args.title ?? 'Q3 pipeline report',
      ...(args.artifactId !== undefined ? { artifactId: args.artifactId } : {}),
    },
  );
}
