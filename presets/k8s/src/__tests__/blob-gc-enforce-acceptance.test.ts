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
import {
  SETTINGS_BOUNDS,
  SETTINGS_STORAGE_KEY,
  createBlobGcPlugin,
  type BlobGcPlugin,
} from '@ax/blob-gc';
import { blobPath, retiredPath } from '@ax/blob-store-fs';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-778 (blob GC design D3/D8/D9) -- @ax/blob-gc ENFORCE MODE canary
// (Invariant 3: no half-wired plugins). The sibling of
// blob-gc-report-acceptance.test.ts, same boot approach, plus the preset's own
// @ax/branding.
//
// Real: @ax/database-postgres, @ax/storage-postgres, @ax/blob-store-fs (on a
// real directory, so "retired" and "purged" are checked on disk), the holders
// @ax/attachments and @ax/branding, and @ax/blob-gc re-created from its factory
// with an injected clock and no timer (manifest asserted identical to the
// preset's). Enforce is switched on the way an admin's PUT lands: the
// `settings:blob-gc` row in storage.
//
// The blob backend is wrapped so every service call it answers is recorded
// with its sha: the assertions are about what it was ASKED to move or free.
//
// Stubbed: `http:register-route` (routes are captured; branding's real
// PUT /admin/branding handler is invoked directly), `auth:require-user`
// (always an admin), and `conversations:get` (attachments downloads, unused).
// ---------------------------------------------------------------------------

const BLOB_GC_PLUGIN = '@ax/blob-gc';
const BLOB_BACKEND = '@ax/blob-store-fs';
const KEEP = new Set<string>([
  '@ax/database-postgres',
  '@ax/storage-postgres',
  BLOB_BACKEND,
  '@ax/attachments',
  '@ax/branding',
]);

const SEC = 1000;
const HOUR = 60 * 60 * SEC;
/** The smallest settings the GC accepts: 1 h grace, 1 day retention. */
const GRACE_MS = SETTINGS_BOUNDS.graceMs.min;
const RETENTION_MS = SETTINGS_BOUNDS.retentionMs.min;
/** Past the grace window. */
const T_RETIRE = GRACE_MS + HOUR;
/** Past retention for something retired at T_RETIRE. */
const T_PURGE = T_RETIRE + RETENTION_MS + HOUR;

const USER_A = 'bgc-enf-user-a';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A holder the test controls: answers nothing, or throws. */
const TEST_HOLDER = '@ax/preset-k8s/test/blob-gc-enforce-holder';
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

interface FakeRes {
  status(n: number): FakeRes;
  header(name: string, value: string): FakeRes;
  json(v: unknown): void;
  text(t: string): void;
  body(buf: Buffer, ct?: string): void;
  end(): void;
}

interface CapturedRoute {
  method: string;
  path: string;
  handler: (req: unknown, res: FakeRes) => Promise<void>;
}

function createStubsPlugin(routes: CapturedRoute[]): Plugin {
  const name = '@ax/preset-k8s/test/blob-gc-enforce-stubs';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['http:register-route', 'auth:require-user', 'conversations:get'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<CapturedRoute, { unregister: () => void }>(
        'http:register-route',
        name,
        async (_ctx, input) => {
          routes.push(input);
          return { unregister() {} };
        },
      );
      bus.registerService('auth:require-user', name, async () => ({
        user: { id: 'bgc-admin', isAdmin: true },
      }));
      bus.registerService('conversations:get', name, async () => {
        throw new PluginError({ code: 'not-found', plugin: name, message: 'no conversations' });
      });
    },
  };
}

interface BackendCall {
  hook: string;
  sha256: string | undefined;
}

/**
 * The same plugin, with every service it registers recorded (hook + the sha it
 * was asked about) as it is answered. Manifest untouched.
 */
function recordingServices(plugin: Plugin, calls: BackendCall[]): Plugin {
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
                  const sha = (input as { sha256?: unknown } | null)?.sha256;
                  calls.push({ hook, sha256: typeof sha === 'string' ? sha : undefined });
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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

const shaOf = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const png = (n: number): Buffer => Buffer.concat([PNG_MAGIC, randomBytes(n)]);

describe('@ax/preset-k8s blob GC enforce-mode canary (TASK-778)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let tmp = '';
  let blobRoot = '';
  let bus: HookBus | null = null;
  let gc: BlobGcPlugin | null = null;
  let shutdown: (() => Promise<void>) | null = null;
  const backendCalls: BackendCall[] = [];
  const routes: CapturedRoute[] = [];
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
    return makeAgentContext({ sessionId: `bgc-enf-${seq}`, agentId: 'bgc-agent', userId });
  }

  async function db(): Promise<Kysely<unknown>> {
    const { db: handle } = await live().bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctxFor('system'),
      {},
    );
    return handle;
  }

  async function putBlob(bytes: Buffer): Promise<string> {
    const out = await live().bus.call<{ bytes: Buffer }, { sha256: string }>(
      'blob:put',
      ctxFor(USER_A),
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
    >('attachments:store-temp', ctx, { bytes, displayName: 'pic.png', mediaType: 'image/png' });
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

  /** Branding's real `PUT /admin/branding`, as an admin. Resolves the status. */
  async function putLightLogo(bytes: Buffer): Promise<number> {
    const route = routes.find((r) => r.method === 'PUT' && r.path === '/admin/branding');
    if (route === undefined) throw new Error('branding did not register PUT /admin/branding');
    let status = 200;
    const res: FakeRes = {
      status(n) {
        status = n;
        return res;
      },
      header() {
        return res;
      },
      json() {},
      text() {},
      body() {},
      end() {},
    };
    await route.handler(
      {
        headers: {},
        body: Buffer.from(
          JSON.stringify({ light: { contentType: 'image/png', dataBase64: bytes.toString('base64') } }),
        ),
        cookies: {},
        query: {},
        params: {},
        signedCookie: () => null,
      },
      res,
    );
    return status;
  }

  async function setEnforce(): Promise<void> {
    await live().bus.call('storage:set', ctxFor('system'), {
      key: SETTINGS_STORAGE_KEY,
      value: new TextEncoder().encode(
        JSON.stringify({ mode: 'enforce', graceMs: GRACE_MS, retentionMs: RETENTION_MS }),
      ),
    });
  }

  async function gcRow(sha: string): Promise<{ state: string } | undefined> {
    const res = await sql<{ state: string }>`
      SELECT state FROM blob_gc_v1_blobs WHERE sha256 = ${sha}
    `.execute(await db());
    return res.rows[0];
  }

  async function getBytes(sha: string): Promise<Buffer | undefined> {
    const out = await live().bus.call<{ sha256: string }, { bytes?: Uint8Array; found?: false }>(
      'blob:get',
      ctxFor('system'),
      { sha256: sha },
    );
    return out.bytes === undefined ? undefined : Buffer.from(out.bytes);
  }

  const livePath = (sha: string): string => blobPath(blobRoot, sha);
  const retPath = (sha: string): string => retiredPath(blobRoot, sha);
  const freeing = (sha?: string): BackendCall[] =>
    backendCalls.filter(
      (c) => (c.hook === 'blob:retire' || c.hook === 'blob:purge') && (sha === undefined || c.sha256 === sha),
    );

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-blob-gc-enforce-')));
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
    const backend = kept.find((p) => p.manifest.name === BLOB_BACKEND)!;
    for (const hook of ['blob:list', 'blob:retire', 'blob:purge']) {
      expect(backend.manifest.registers).toContain(hook);
    }

    bus = new HookBus();
    const handle = await bootstrap({
      bus,
      plugins: [...kept, blobGc, createStubsPlugin(routes), createTestHolderPlugin()],
      config: {},
    });
    gc = blobGc;
    shutdown = () => handle.shutdown();
  }, 180_000);

  beforeEach(async () => {
    clockSkewMs = 0;
    testHolderMode = 'answer';
    const d = await db();
    await sql`TRUNCATE blob_gc_v1_blobs, blob_gc_v1_roster`.execute(d);
    await sql`TRUNCATE attachments_v1_files, attachments_v1_artifacts`.execute(d);
    // The GC settings, the GC report and branding's pointers all live here.
    await sql`TRUNCATE storage_postgres_v1_kv`.execute(d);
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

  it('branding regression: a replaced logo that shares its sha with an attachment is never retired', async () => {
    const x = png(600);
    const y = png(700);
    const shaX = await attach(USER_A, 'conv-logo', x);
    expect(shaX).toBe(shaOf(x));
    await setEnforce();
    expect(await putLightLogo(x)).toBe(204);
    expect(await putLightLogo(y)).toBe(204);

    clockSkewMs = T_RETIRE;
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { mode: 'enforce', candidates: 2, held: 2, wouldRetire: 0, retired: 0 },
    });
    clockSkewMs = T_PURGE;
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { mode: 'enforce', retired: 0, purged: 0 },
    });

    expect(freeing(shaX)).toEqual([]);
    expect(await exists(livePath(shaX))).toBe(true);
    expect(await exists(retPath(shaX))).toBe(false);
    expect(await getBytes(shaX)).toEqual(x);
    // The current logo is held by branding.
    expect(await getBytes(shaOf(y))).toEqual(y);
  });

  it('full cycle: an orphan is retired past grace and purged past retention', async () => {
    const bytes = randomBytes(3000);
    const sha = await putBlob(bytes);
    await setEnforce();

    // Inside grace: nothing moves.
    clockSkewMs = GRACE_MS - HOUR / 2;
    expect(await live().gc.sweep()).toMatchObject({ report: { candidates: 0, retired: 0 } });
    expect(await exists(livePath(sha))).toBe(true);

    clockSkewMs = T_RETIRE;
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { mode: 'enforce', candidates: 1, wouldRetire: 1, retired: 1, purged: 0 },
    });
    expect(await exists(livePath(sha))).toBe(false);
    expect(await exists(retPath(sha))).toBe(true);
    expect(retPath(sha).startsWith(path.join(blobRoot, '.retired') + path.sep)).toBe(true);
    expect(freeing(sha).map((c) => c.hook)).toEqual(['blob:retire']);

    // Retired before retention: a sweep leaves it alone.
    clockSkewMs = T_RETIRE + RETENTION_MS - HOUR;
    expect(await live().gc.sweep()).toMatchObject({ report: { retired: 0, purged: 0 } });
    expect(await exists(retPath(sha))).toBe(true);

    clockSkewMs = T_PURGE;
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { purged: 1, bytesPurged: 3000, restored: 0 },
    });
    expect(await exists(livePath(sha))).toBe(false);
    expect(await exists(retPath(sha))).toBe(false);
    expect(await gcRow(sha)).toBeUndefined();
    expect(await getBytes(sha)).toBeUndefined();
    expect(freeing(sha).map((c) => c.hook)).toEqual(['blob:retire', 'blob:purge']);
  });

  it('a read restores a retired blob; the purge pass then frees nothing and re-lives the row; it is retired again later and purging it frees real bytes', async () => {
    const bytes = randomBytes(2500);
    const sha = await putBlob(bytes);
    await setEnforce();

    clockSkewMs = T_RETIRE;
    expect(await live().gc.sweep()).toMatchObject({ report: { retired: 1 } });
    expect(await exists(retPath(sha))).toBe(true);

    // Before retention, a read brings it back live.
    clockSkewMs = T_RETIRE + HOUR;
    expect(await getBytes(sha)).toEqual(bytes);
    expect(await exists(livePath(sha))).toBe(true);
    expect(await exists(retPath(sha))).toBe(false);

    // The read recorded nothing in the GC's table, so its row still says
    // retired until the purge pass looks at it. Past retention, that pass
    // purges the (absent) retired copy, sees the bytes are live, and must
    // neither count them as freed nor drop the row: it goes back to live.
    clockSkewMs = T_PURGE;
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { purged: 0, bytesPurged: 0 },
    });
    expect(await exists(livePath(sha))).toBe(true);
    expect(await gcRow(sha)).toMatchObject({ state: 'live' });

    // Nobody holds it, so a sweep past a fresh grace window retires it again.
    clockSkewMs = T_PURGE + T_RETIRE;
    expect(await live().gc.sweep()).toMatchObject({ outcome: 'reported', report: { retired: 1 } });
    expect(await exists(livePath(sha))).toBe(false);
    expect(await exists(retPath(sha))).toBe(true);

    // ...and past retention after THAT retire, it is purged: a purge the
    // report counts is one that removed bytes from disk.
    clockSkewMs = T_PURGE + T_PURGE;
    const res = await live().gc.sweep();
    expect(res).toMatchObject({ outcome: 'reported', report: { purged: 1, bytesPurged: 2500 } });
    expect(await exists(livePath(sha))).toBe(false);
    expect(await exists(retPath(sha))).toBe(false);
    expect(await gcRow(sha)).toBeUndefined();
  });

  it('purge re-check: a retired blob re-put by an attachment commit stays live and is never purged', async () => {
    const bytes = png(900);
    const sha = await putBlob(bytes);
    await setEnforce();
    clockSkewMs = T_RETIRE;
    expect(await live().gc.sweep()).toMatchObject({ report: { retired: 1 } });
    expect(await exists(livePath(sha))).toBe(false);

    clockSkewMs = T_RETIRE + HOUR;
    expect(await attach(USER_A, 'conv-reput', bytes)).toBe(sha);
    expect(await exists(livePath(sha))).toBe(true);
    expect(await gcRow(sha)).toEqual({ state: 'live' });
    // The re-put wrote a live copy; the retired one is still there too.
    expect(await exists(retPath(sha))).toBe(true);

    // TASK-836: the next enforce sweep sees the sha in both listings under a
    // live row, claims the row (a fresh grace window, so it is not a retire
    // candidate this sweep), confirms the live copy, and purges only the
    // retired duplicate.
    clockSkewMs = T_PURGE + HOUR;
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { candidates: 0, retired: 0, purged: 0 },
    });
    expect(await exists(livePath(sha))).toBe(true);
    expect(await exists(retPath(sha))).toBe(false);
    expect(await gcRow(sha)).toEqual({ state: 'live' });
    expect(await getBytes(sha)).toEqual(bytes);
    expect(freeing(sha).map((c) => c.hook)).toEqual(['blob:retire', 'blob:purge']);
  });

  it('purge re-check: a row that appears WITHOUT a put restores the retired blob instead of purging it', async () => {
    const bytes = randomBytes(1800);
    const sha = await putBlob(bytes);
    await setEnforce();
    clockSkewMs = T_RETIRE;
    expect(await live().gc.sweep()).toMatchObject({ report: { retired: 1 } });
    expect(await exists(retPath(sha))).toBe(true);

    // A holder row written long after the put, with no put of its own.
    await sql`
      INSERT INTO attachments_v1_files
        (attachment_id, conversation_id, user_id, sha256, path, display_name, media_type, size_bytes)
      VALUES
        ('att-late', 'conv-late', ${USER_A}, ${sha}, 'late.bin', 'late.bin', 'application/octet-stream', ${bytes.length})
    `.execute(await db());

    clockSkewMs = T_PURGE;
    expect(await live().gc.sweep()).toMatchObject({
      outcome: 'reported',
      report: { restored: 1, purged: 0 },
    });
    expect(await exists(livePath(sha))).toBe(true);
    expect(await exists(retPath(sha))).toBe(false);
    expect(await gcRow(sha)).toEqual({ state: 'live' });
    expect(await getBytes(sha)).toEqual(bytes);
    expect(freeing(sha).map((c) => c.hook)).toEqual(['blob:retire']);
  });

  it('roster abort under enforce: a holder that throws stops the sweep before anything moves', async () => {
    await putBlob(randomBytes(1000));
    await setEnforce();
    // First sweep: every holder answers once and joins the roster.
    expect(await live().gc.sweep()).toMatchObject({ outcome: 'reported', report: { retired: 0 } });
    const before = await filesUnder(blobRoot);

    testHolderMode = 'throw';
    clockSkewMs = T_RETIRE;
    expect(await live().gc.sweep()).toEqual({ outcome: 'aborted' });
    expect(freeing()).toEqual([]);
    expect(await filesUnder(blobRoot)).toEqual(before);

    // Same at the purge pass: retire with everyone answering, then crash.
    testHolderMode = 'answer';
    expect(await live().gc.sweep()).toMatchObject({ report: { retired: 1 } });
    const retired = await filesUnder(blobRoot);
    testHolderMode = 'throw';
    clockSkewMs = T_PURGE;
    expect(await live().gc.sweep()).toEqual({ outcome: 'aborted' });
    expect(freeing().map((c) => c.hook)).toEqual(['blob:retire']);
    expect(await filesUnder(blobRoot)).toEqual(retired);
  });

  it('default safety: with no settings row, sweeps never retire or purge, past grace and past retention', async () => {
    const held = await attach(USER_A, 'conv-def', png(400));
    const orphan = await putBlob(randomBytes(1200));
    const before = await filesUnder(blobRoot);
    // Past the DEFAULT 24 h grace and 7 day retention, by a wide margin.
    for (const skew of [25 * HOUR, 9 * 24 * HOUR, 40 * 24 * HOUR]) {
      clockSkewMs = skew;
      expect(await live().gc.sweep()).toMatchObject({
        outcome: 'reported',
        report: { mode: 'report', wouldRetire: 1, retired: 0, purged: 0 },
      });
    }
    expect(freeing()).toEqual([]);
    expect(await filesUnder(blobRoot)).toEqual(before);
    for (const sha of [held, orphan]) expect(await exists(livePath(sha))).toBe(true);
  });
});
