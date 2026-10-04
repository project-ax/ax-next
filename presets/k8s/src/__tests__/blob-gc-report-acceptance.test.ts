import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
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
import { createBlobGcPlugin, type BlobGcPlugin } from '@ax/blob-gc';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-777 (blob GC design D4/D5/D8) -- @ax/blob-gc REPORT MODE canary
// (Invariant 3: no half-wired plugins).
//
// Drives the sweep through the preset's OWN plugins: @ax/blob-store-fs (the
// real `blob:list` and `blob:put` facade, on a real directory),
// @ax/attachments (a real holder, on real Postgres), @ax/storage-postgres,
// @ax/database-postgres, and @ax/blob-gc re-created from its factory with an
// injected clock (manifest asserted identical to the preset's) so a test can
// step past the 24 h grace window instead of sleeping through it.
//
// The blob backend is wrapped so every service call it answers is recorded:
// report mode must never ask it to delete anything, and the bytes on disk must
// be exactly what they were.
//
// Stubbed: `conversations:get` (attachments hard-calls it for downloads, never
// used here), `http:register-route` and `auth:require-user` (the GC's admin
// route has its own suite).
// ---------------------------------------------------------------------------

const BLOB_GC_PLUGIN = '@ax/blob-gc';
const BLOB_BACKEND = '@ax/blob-store-fs';
const KEEP = new Set<string>([
  '@ax/database-postgres',
  '@ax/storage-postgres',
  BLOB_BACKEND,
  '@ax/attachments',
]);

const SEC = 1000;
const HOUR = 60 * 60 * SEC;
/** Past the default 24 h grace. */
const PAST_GRACE_MS = 25 * HOUR;

const USER_A = 'bgc-user-a';

/** A holder the test controls: answers nothing, or throws. */
const TEST_HOLDER = '@ax/preset-k8s/test/blob-gc-holder';
let testHolderMode: 'answer' | 'throw' = 'answer';

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
        return answerBlobCollectRefs(payload, TEST_HOLDER, async () => []);
      });
    },
  };
}

function createStubsPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/blob-gc-stubs';
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

/**
 * The same plugin, with every service it registers recorded in `calls` as it
 * is answered. Manifest untouched, so the kernel wires it exactly as before.
 */
function recordingServices(plugin: Plugin, calls: string[]): Plugin {
  return {
    manifest: plugin.manifest,
    init(args) {
      const bus = args.bus;
      const proxy = new Proxy(bus, {
        get(target, key, receiver) {
          if (key === 'registerService') {
            return (hook: string, owner: string, handler: (ctx: unknown, input: unknown) => unknown, opts?: unknown) =>
              target.registerService(
                hook,
                owner,
                async (ctx: never, input: never) => {
                  calls.push(hook);
                  return handler(ctx, input);
                },
                opts as never,
              );
          }
          const v = Reflect.get(target, key, receiver) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      return plugin.init({ ...args, bus: proxy });
    },
    ...(plugin.shutdown !== undefined ? { shutdown: plugin.shutdown.bind(plugin) } : {}),
  };
}

/** Every regular file under `dir`, relative, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(dir, p));
    }
  }
  await walk(dir);
  return out.sort();
}

describe('@ax/preset-k8s blob GC report-mode canary (TASK-777)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let tmp = '';
  let blobRoot = '';
  let bus: HookBus | null = null;
  let gc: BlobGcPlugin | null = null;
  let shutdown: (() => Promise<void>) | null = null;
  const backendCalls: string[] = [];
  let clockSkewMs = 0;
  const clock = (): Date => new Date(Date.now() + clockSkewMs);
  let seq = 0;

  function presetConfig(connectionString: string): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      workspace: { backend: 'local', repoRoot: path.join(tmp, 'repos') },
      blob: { backend: 'fs', root: blobRoot },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: {}, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
    };
  }

  function live(): { bus: HookBus; gc: BlobGcPlugin } {
    if (bus === null || gc === null) throw new Error('kernel not booted');
    return { bus, gc };
  }

  function ctxFor(userId: string): AgentContext {
    seq += 1;
    return makeAgentContext({ sessionId: `bgc-${seq}`, agentId: 'bgc-agent', userId });
  }

  async function db(): Promise<Kysely<unknown>> {
    const { db: handle } = await live().bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctxFor('system'),
      {},
    );
    return handle;
  }

  async function putBlob(userId: string, bytes: Buffer): Promise<string> {
    const out = await live().bus.call<{ bytes: Buffer }, { sha256: string }>(
      'blob:put',
      ctxFor(userId),
      { bytes },
    );
    return out.sha256;
  }

  /** Upload `bytes` as `userId` into `conversationId` the way chat send does. */
  async function attach(userId: string, conversationId: string, bytes: Buffer): Promise<string> {
    const b = live().bus;
    const ctx = ctxFor(userId);
    const temp = await b.call<
      { bytes: Buffer; displayName: string; mediaType: string },
      { attachmentId: string }
    >('attachments:store-temp', ctx, { bytes, displayName: 'notes.txt', mediaType: 'text/plain' });
    const out = await b.call<
      { attachmentId: string; conversationId: string; turnId: string },
      { sha256: string }
    >('attachments:commit', ctx, {
      attachmentId: temp.attachmentId,
      conversationId,
      turnId: `turn-${seq}`,
    });
    return out.sha256;
  }

  async function lastPutAt(sha: string): Promise<Date | undefined> {
    const res = await sql<{ last_put_at: Date }>`
      SELECT last_put_at FROM blob_gc_v1_blobs WHERE sha256 = ${sha}
    `.execute(await db());
    return res.rows[0]?.last_put_at;
  }

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-blob-gc-canary-')));
    blobRoot = path.join(tmp, 'blobs');
    pgContainer = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    const presetPlugins = createK8sPlugins(presetConfig(pgContainer.getConnectionUri()));
    const presetGc = presetPlugins.find((p) => p.manifest.name === BLOB_GC_PLUGIN);
    expect(presetGc, 'createK8sPlugins must load @ax/blob-gc').toBeDefined();
    const blobGc = createBlobGcPlugin({ now: clock, sweepIntervalMs: 0 });
    expect(blobGc.manifest).toEqual(presetGc!.manifest);
    const kept = presetPlugins
      .filter((p) => KEEP.has(p.manifest.name))
      .map((p) => (p.manifest.name === BLOB_BACKEND ? recordingServices(p, backendCalls) : p));
    expect(kept.map((p) => p.manifest.name).sort()).toEqual([...KEEP].sort());
    // The backend answers the listing the GC depends on.
    expect(
      kept.find((p) => p.manifest.name === BLOB_BACKEND)!.manifest.registers,
    ).toContain('blob:list');

    bus = new HookBus();
    const handle = await bootstrap({
      bus,
      plugins: [...kept, blobGc, createStubsPlugin(), createTestHolderPlugin()],
      config: {},
    });
    gc = blobGc;
    shutdown = () => handle.shutdown();
  }, 180_000);

  beforeEach(async () => {
    clockSkewMs = 0;
    testHolderMode = 'answer';
    await sql`TRUNCATE blob_gc_v1_blobs, blob_gc_v1_roster`.execute(await db());
    await sql`TRUNCATE attachments_v1_files`.execute(await db());
    await sql`TRUNCATE attachments_v1_artifacts`.execute(await db());
    await fs.rm(blobRoot, { recursive: true, force: true });
    await fs.mkdir(blobRoot, { recursive: true });
    backendCalls.length = 0;
  });

  afterAll(async () => {
    if (shutdown !== null) await shutdown();
    shutdown = null;
    await stopPostgresContainer(pgContainer ?? undefined);
    pgContainer = null;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reports what nobody holds, keeps what a holder holds, and deletes NOTHING', async () => {
    const held = await attach(USER_A, 'conv-a', randomBytes(5000));
    const orphan = await putBlob(USER_A, randomBytes(3000));
    const before = await filesUnder(blobRoot);
    expect(before).toHaveLength(2);

    // Inside the grace window nothing is a candidate.
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { candidates: 0, wouldRetire: 0 },
    });

    clockSkewMs = PAST_GRACE_MS;
    const res = await live().gc.sweep();
    expect(res).toMatchObject({
      outcome: 'reported',
      report: {
        mode: 'report',
        discovered: 0,
        candidates: 2,
        held: 1,
        wouldRetire: 1,
        wouldRetireBytes: 3000,
        perHolder: { '@ax/attachments': 1, [TEST_HOLDER]: 0 },
      },
    });

    // Report mode: the backend was asked to list, never to delete, and every
    // byte is still where it was.
    expect(backendCalls).toContain('blob:list');
    expect(backendCalls).not.toContain('blob:delete');
    expect(backendCalls.filter((h) => /retire|purge|delete/.test(h))).toEqual([]);
    expect(await filesUnder(blobRoot)).toEqual(before);
    for (const sha of [held, orphan]) {
      expect(await live().bus.call('blob:stat', ctxFor('system'), { sha256: sha })).not.toEqual({
        found: false,
      });
    }
  });

  it('a pre-existing blob the table never saw is discovered with last_put_at = now, and temp files never count', async () => {
    // Written behind the facade's back, so no `blob:stored` notice: the way
    // every blob stored before this plugin shipped looks to it.
    const out = await live().bus.call<{ bytes: Buffer }, { sha256: string }>(
      'blob:put-internal',
      ctxFor(USER_A),
      { bytes: randomBytes(1234) },
    );
    const sha = out.sha256;
    // A crashed put's leftover temp file next to it.
    const shard = path.join(blobRoot, sha.slice(0, 2), sha.slice(2, 4));
    await fs.writeFile(path.join(shard, `${sha}.tmp.4242.leftover`), 'partial');
    expect(await lastPutAt(sha)).toBeUndefined();

    clockSkewMs = 72 * HOUR;
    const startedAt = clock().getTime();
    expect(await live().gc.sweep()).toMatchObject({ report: { discovered: 1, candidates: 0 } });
    const seen = await lastPutAt(sha);
    expect(seen).toBeDefined();
    expect(seen!.getTime()).toBeGreaterThanOrEqual(startedAt);
    const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM blob_gc_v1_blobs`.execute(
      await db(),
    );
    expect(rows.rows[0]!.n).toBe('1');
  });

  it('a blob put 10 s before its referencing row lands is never a candidate', async () => {
    const bytes = randomBytes(2048);
    const sha = await putBlob(USER_A, bytes);
    clockSkewMs = 5 * SEC;
    expect(await live().gc.sweep()).toMatchObject({ report: { candidates: 0 } });
    clockSkewMs = 10 * SEC;
    expect(await attach(USER_A, 'conv-late', bytes)).toBe(sha);
    clockSkewMs = PAST_GRACE_MS;
    expect(await live().gc.sweep()).toMatchObject({
      report: { candidates: 1, held: 1, wouldRetire: 0 },
    });
  });

  it('a holder that throws aborts the sweep, with nothing reported', async () => {
    await putBlob(USER_A, randomBytes(1000));
    // First sweep: every holder answers once and joins the GC's roster.
    expect(await live().gc.sweep()).toMatchObject({ outcome: 'reported' });
    testHolderMode = 'throw';
    clockSkewMs = PAST_GRACE_MS;
    expect(await live().gc.sweep()).toEqual({ outcome: 'aborted' });
    testHolderMode = 'answer';
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { wouldRetire: 1 },
    });
    expect(backendCalls.filter((h) => /retire|purge|delete/.test(h))).toEqual([]);
  });
});
