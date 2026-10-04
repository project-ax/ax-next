import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';

import {
  BLOB_COLLECT_REFS_HOOK,
  HookBus,
  PluginError,
  answerBlobCollectRefs,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import { createDiskQuotaPlugin, type DiskQuotaPlugin } from '@ax/disk-quota';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-776 (blob GC design D1/D2/D6/D10) -- per-owner blob ledger release
// canary (Invariant 3: no half-wired plugins).
//
// Before this card nothing ever gave a person their quota back for a file:
// `disk_quota_v1_usage` keeps one `(owner, 'blob:<sha>')` row per person per
// blob, and no row was ever removed. Now @ax/disk-quota's reconcile asks every
// holder through `blob:collect-refs` which of its stale blob shas are still
// referenced, and for whom, and drops the rows of owners nobody lists.
//
// This canary drives that through the preset's OWN plugins: @ax/attachments
// (a real holder, on real Postgres), @ax/blob-store-fs, @ax/storage-postgres,
// @ax/database-postgres, and @ax/disk-quota re-created from its factory with
// an injected clock (manifest asserted identical to the preset's) so a test
// can step past the 24 h grace window instead of sleeping through it.
//
// Stubbed: `conversations:get` (attachments hard-calls it for downloads, which
// this canary never does), `http:register-route` and `auth:require-user`
// (disk-quota mounts its storage routes at init; they have their own suite).
// The "agent delete" is the `conversations:purged` notice @ax/conversations
// fires after a hard delete, fired here directly.
//
// NO blob bytes are deleted anywhere in this card; the canary asserts that.
// ---------------------------------------------------------------------------

const DISK_QUOTA_PLUGIN = '@ax/disk-quota';
const KEEP = new Set<string>([
  '@ax/database-postgres',
  '@ax/storage-postgres',
  '@ax/blob-store-fs',
  '@ax/attachments',
]);

const HOUR_MS = 60 * 60 * 1000;
/** Past the default 24 h grace. */
const PAST_GRACE_MS = 25 * HOUR_MS;

const USER_A = 'blr-user-a';
const USER_B = 'blr-user-b';

/** A holder the test controls: answers, throws, or answers `ok: false`. */
const TEST_HOLDER = '@ax/preset-k8s/test/blob-holder';
let testHolderMode: 'answer' | 'throw' | 'not-ok' = 'answer';

function createTestHolderPlugin(): Plugin {
  return {
    manifest: {
      name: TEST_HOLDER,
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: [BLOB_COLLECT_REFS_HOOK],
    },
    init({ bus }) {
      bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, TEST_HOLDER, async (_ctx, payload) => {
        if (testHolderMode === 'throw') throw new Error('test holder crashed');
        return answerBlobCollectRefs(payload, TEST_HOLDER, async () => {
          if (testHolderMode === 'not-ok') throw new Error('test holder could not check');
          return [];
        });
      });
    },
  };
}

function createStubsPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/blob-ledger-stubs';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['http:register-route', 'auth:require-user', 'conversations:get'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('http:register-route', name, async () => ({ unregister() {} }));
      bus.registerService('auth:require-user', name, async () => {
        throw new PluginError({ code: 'unauthenticated', plugin: name, message: 'no http plane' });
      });
      bus.registerService('conversations:get', name, async () => {
        throw new PluginError({ code: 'not-found', plugin: name, message: 'no conversations' });
      });
    },
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Kernel {
  bus: HookBus;
  diskQuota: DiskQuotaPlugin;
  shutdown(): Promise<void>;
}

describe('@ax/preset-k8s blob ledger release canary (TASK-776)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let tmp = '';
  let kernel: Kernel | null = null;
  let clockSkewMs = 0;
  const clock = (): Date => new Date(Date.now() + clockSkewMs);
  let seq = 0;

  function presetConfig(connectionString: string): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      workspace: { backend: 'local', repoRoot: path.join(tmp, 'repos') },
      blob: { backend: 'fs', root: path.join(tmp, 'blobs') },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: {}, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
    };
  }

  function live(): Kernel {
    if (kernel === null) throw new Error('kernel not booted');
    return kernel;
  }

  function ctxFor(userId: string): AgentContext {
    seq += 1;
    return makeAgentContext({ sessionId: `blr-${seq}`, agentId: 'blr-agent', userId });
  }

  async function db(): Promise<Kysely<unknown>> {
    const { db: handle } = await live().bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctxFor('system'),
      {},
    );
    return handle;
  }

  async function blobRows(): Promise<Array<{ owner: string; source: string }>> {
    const res = await sql<{ owner_id: string; source: string }>`
      SELECT owner_id, source FROM disk_quota_v1_usage
      WHERE kind = 'blob' ORDER BY owner_id, source
    `.execute(await db());
    return res.rows.map((r) => ({ owner: r.owner_id, source: r.source }));
  }

  /** Upload `bytes` as `userId` into `conversationId` the way chat send does. */
  async function attach(userId: string, conversationId: string, bytes: Buffer): Promise<string> {
    const { bus } = live();
    const ctx = ctxFor(userId);
    const temp = await bus.call<
      { bytes: Buffer; displayName: string; mediaType: string },
      { attachmentId: string }
    >('attachments:store-temp', ctx, { bytes, displayName: 'notes.txt', mediaType: 'text/plain' });
    const out = await bus.call<
      { attachmentId: string; conversationId: string; turnId: string },
      { sha256: string }
    >('attachments:commit', ctx, {
      attachmentId: temp.attachmentId,
      conversationId,
      turnId: `turn-${seq}`,
    });
    return out.sha256;
  }

  async function purgeConversation(conversationId: string): Promise<void> {
    await live().bus.fire('conversations:purged', ctxFor('system'), {
      conversationIds: [conversationId],
    });
  }

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-blob-ledger-canary-')));
    pgContainer = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    const presetPlugins = createK8sPlugins(presetConfig(pgContainer.getConnectionUri()));
    const presetDiskQuota = presetPlugins.find((p) => p.manifest.name === DISK_QUOTA_PLUGIN);
    expect(presetDiskQuota, 'createK8sPlugins must load @ax/disk-quota').toBeDefined();
    const diskQuota = createDiskQuotaPlugin({ now: clock, sweepIntervalMs: 0 });
    expect(diskQuota.manifest).toEqual(presetDiskQuota!.manifest);
    const kept = presetPlugins.filter((p) => KEEP.has(p.manifest.name));
    expect(kept.map((p) => p.manifest.name).sort()).toEqual([...KEEP].sort());
    // The holder this canary leans on is the preset's own, and it answers.
    expect(
      kept.find((p) => p.manifest.name === '@ax/attachments')!.manifest.subscribes,
    ).toContain(BLOB_COLLECT_REFS_HOOK);

    const bus = new HookBus();
    const handle = await bootstrap({
      bus,
      plugins: [...kept, diskQuota, createStubsPlugin(), createTestHolderPlugin()],
      config: {},
    });
    kernel = { bus, diskQuota, shutdown: () => handle.shutdown() };
  }, 180_000);

  beforeEach(async () => {
    clockSkewMs = 0;
    testHolderMode = 'answer';
    await live().diskQuota.drain();
    await sql`TRUNCATE disk_quota_v1_usage`.execute(await db());
    await sql`TRUNCATE disk_quota_v1_ref_holders`.execute(await db());
    await sql`TRUNCATE attachments_v1_files`.execute(await db());
    await sql`TRUNCATE attachments_v1_artifacts`.execute(await db());
  });

  afterAll(async () => {
    if (kernel !== null) await kernel.shutdown();
    kernel = null;
    await stopPostgresContainer(pgContainer ?? undefined);
    pgContainer = null;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("releases A's charge when A's file goes, keeps B's for the same bytes, and frees no bytes", async () => {
    const bytes = randomBytes(5000);
    const sha = await attach(USER_A, 'conv-a', bytes);
    expect(await attach(USER_B, 'conv-b', bytes)).toBe(sha);
    expect(await blobRows()).toEqual([
      { owner: USER_A, source: `blob:${sha}` },
      { owner: USER_B, source: `blob:${sha}` },
    ]);

    // Agent delete: A's conversation (and its file row) is hard-deleted.
    await purgeConversation('conv-a');

    // Inside the grace window nothing is a candidate, so nothing is released.
    await live().diskQuota.reconcile();
    expect(await blobRows()).toHaveLength(2);

    clockSkewMs = PAST_GRACE_MS;
    await live().diskQuota.reconcile();
    expect(await blobRows()).toEqual([{ owner: USER_B, source: `blob:${sha}` }]);

    // The bytes are still there for B: this card frees ledger rows only.
    const stat = await live().bus.call('blob:stat', ctxFor('system'), { sha256: sha });
    expect(stat).toEqual({ size: 5000 });
  });

  it('a re-put refreshes the charge, so a row that just landed is never released', async () => {
    const bytes = randomBytes(3000);
    const sha = await attach(USER_A, 'conv-a', bytes);
    await purgeConversation('conv-a');
    // Backdate the row to before the grace window...
    await sql`
      UPDATE disk_quota_v1_usage SET updated_at = now() - interval '30 hours'
      WHERE owner_id = ${USER_A}
    `.execute(await db());
    // ...then A puts the same bytes again (a fresh upload whose row has not
    // landed yet, from the ledger's point of view): updated_at is refreshed.
    await live().bus.call('blob:put', ctxFor(USER_A), { bytes });
    await live().diskQuota.reconcile();
    expect(await blobRows()).toEqual([{ owner: USER_A, source: `blob:${sha}` }]);
  });

  it.each([
    ['a holder that throws', 'throw'],
    ['a holder answering ok:false', 'not-ok'],
  ] as const)('%s aborts the pass with nothing released', async (_case, mode) => {
    const bytes = randomBytes(2000);
    const sha = await attach(USER_A, 'conv-a', bytes);
    await attach(USER_B, 'conv-b', bytes);
    await purgeConversation('conv-a');
    // First pass inside the grace window: every holder answers once and joins
    // disk-quota's roster; nothing is a candidate yet.
    await live().diskQuota.reconcile();
    const roster = await sql<{ holder: string }>`
      SELECT holder FROM disk_quota_v1_ref_holders ORDER BY holder
    `.execute(await db());
    expect(roster.rows.map((r) => r.holder)).toEqual(['@ax/attachments', TEST_HOLDER].sort());

    testHolderMode = mode;
    clockSkewMs = PAST_GRACE_MS;
    await live().diskQuota.reconcile();
    expect(await blobRows()).toEqual([
      { owner: USER_A, source: `blob:${sha}` },
      { owner: USER_B, source: `blob:${sha}` },
    ]);

    // Once the holder answers again, the release goes through.
    testHolderMode = 'answer';
    await live().diskQuota.reconcile();
    expect(await blobRows()).toEqual([{ owner: USER_B, source: `blob:${sha}` }]);
  });

  it('keeps the charge for bytes nobody references while the bytes are still stored', async () => {
    // Nothing deletes blob bytes yet (the byte GC is a later card). Releasing
    // this charge would leave the bytes on the shared volume charged to nobody,
    // and a person could upload, delete, wait a day and repeat past their limit.
    const bytes = randomBytes(4000);
    const sha = await attach(USER_A, 'conv-a', bytes);
    await purgeConversation('conv-a');
    clockSkewMs = PAST_GRACE_MS;
    await live().diskQuota.reconcile();
    expect(await blobRows()).toEqual([{ owner: USER_A, source: `blob:${sha}` }]);
  });

  it('artifacts:publish-blob refuses a sha that is not stored and writes no row (D10)', async () => {
    const missing = sha256Hex(randomBytes(64));
    let err: unknown;
    try {
      await live().bus.call('artifacts:publish-blob', ctxFor(USER_A), {
        conversationId: 'conv-a',
        sha256: missing,
        path: 'out/report.md',
        displayName: 'report.md',
        mediaType: 'text/markdown',
        size: 10,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('not-found');
    const rows = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM attachments_v1_artifacts
    `.execute(await db());
    expect(rows.rows[0]!.n).toBe('0');
  });
});
