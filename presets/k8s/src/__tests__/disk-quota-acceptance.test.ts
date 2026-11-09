import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';

import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import { blobFullMessage, createDiskQuotaPlugin, type DiskQuotaPlugin } from '@ax/disk-quota';
import { createSandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { createWorkspaceLocaldirPlugin } from '@ax/workspace-localdir';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-690 -- per-owner storage limit canary (Invariant 3: no half-wired
// plugins).
//
// @ax/disk-quota only means something when it sits on the REAL write path:
//
//   GATE   -- `blob:pre-put` (fired by the @ax/core `blob:put` facade the blob
//             backend registers behind) refuses an upload or a published file
//             that would put its owner past the limit.
//   METER  -- `blob:stored` charges the writer.
//
// TASK-993 adds agent FILES (each agent's durable /files folder) to the same
// per-person budget, METERED but not write-enforced: every assistant
// `chat:turn-end` (and the sweep) makes the plugin measure the folder through
// `sandbox:user-files-usage` and charge the agent's owner, and `agents:deleted`
// drops that row. There is NO `chat:start` gate any more: a full person can
// still talk to their agent (and ask it to tidy up); only the upload gate
// above refuses. Block (7) proves that loop with a real directory, through the
// subprocess provider's implementation of the hook (the production k8s
// provider walks an NFS mount; its own suite covers that). Linux only.
//
// TASK-995 removed the git workspace tier, and with it the canary's git half
// (its gate, meter and release are gone from @ax/disk-quota; boot deletes the
// rows it left, which the package's own tests cover).
//
// The package tests prove each half against fakes. This canary proves the
// LOOP through the real chokepoints: the preset's own @ax/blob-store-fs (a
// temp root), its own @ax/database-postgres + @ax/storage-postgres pointed at
// a postgres testcontainer, and the real @ax/disk-quota.
//
// Assembly follows usage-limits-acceptance.test.ts: take
// createK8sPlugins(...) (so preset drift breaks this file), drop what needs
// real k8s / http / auth / a chat path, keep the persistence plugins, and
// re-add the plugin under test from the SAME factory with an injected clock
// (manifest asserted equal to the preset's instance). The clock only lets a
// test step past the 15 s limits-cache TTL instead of sleeping through it, and
// `sweepIntervalMs: 0` keeps the background sweep from firing on its own so
// the test decides when it runs.
//
// Stubbed, because they have no business here: `http:register-route` and
// `auth:require-user` (the plugin mounts /settings/storage and /admin/storage*
// at init; the route handlers have their own suite), `agents:resolve` (who owns
// an agent) and `agents:list-personal-owners` (what the sweep walks).
//
// "Nearly full" is reached by inserting a ledger row straight into
// disk_quota_v1_usage instead of writing 64 MB of test data; the persistence
// test fills the ledger the honest way, with real bytes.
// ---------------------------------------------------------------------------

const DISK_QUOTA_PLUGIN = '@ax/disk-quota';

/** Same guard as @ax/user-files-read's walk tests: the walk needs /proc/self/fd. */
const ON_LINUX = process.platform === 'linux' && nodeFs.existsSync('/proc/self/fd');

const PLUGINS_TO_DROP = new Set<string>([
  // Postgres pair we DON'T need: nothing here uses the cross-replica eventbus
  // or a persisted session. database-postgres and storage-postgres are KEPT.
  '@ax/eventbus-postgres',
  '@ax/session-postgres',
  // No chat path: this canary drives the write chokepoints directly.
  '@ax/chat-orchestrator',
  '@ax/agent-activity',
  // K8s sandbox and credential proxy -- no sandbox is spawned.
  '@ax/sandbox-k8s',
  '@ax/credential-proxy',
  // HTTP control plane -- stubbed below where the plugin under test needs it.
  '@ax/http-server',
  '@ax/auth-better',
  '@ax/teams',
  '@ax/static-files',
  '@ax/channel-web',
  // Not on this canary's path; each also needs http/auth or a dropped peer.
  // Same reasons as usage-limits-acceptance.test.ts' PLUGINS_TO_DROP.
  '@ax/conversations',
  '@ax/connectors',
  '@ax/mcp-oauth',
  '@ax/agents',
  '@ax/ipc-http',
  '@ax/mcp-client',
  '@ax/onboarding',
  '@ax/routines',
  '@ax/routines-admin-routes',
  '@ax/admin-settings-routes',
  '@ax/branding',
  '@ax/model-policy',
  '@ax/attachments',
  '@ax/skills',
  '@ax/skill-broker',
  '@ax/host-grants',
  '@ax/decisions',
  '@ax/tool-policy',
  '@ax/llm-anthropic',
  '@ax/llm-openrouter',
  '@ax/conversation-titles',
  '@ax/step-summaries',
  '@ax/memory-facts-postgres',
  '@ax/preset-k8s/retire-strata-index',
  // The spend/rate-limit plugin has its own canary and is not on this path.
  '@ax/usage-limits',
  // Blob GC, report mode (TASK-777): has its own canary
  // (blob-gc-report-acceptance.test.ts) and is not on this path.
  '@ax/blob-gc',
  // Re-added below with an injected clock (manifest asserted identical).
  DISK_QUOTA_PLUGIN,
]);

const MB = 1_048_576;
/** The smallest limit the setting accepts (LIMIT_BOUNDS.limitMb.min). */
const MIN_LIMIT_MB = 64;
const MIN_LIMIT_BYTES = MIN_LIMIT_MB * MB;
/** The plugin caches the limits setting for 15 s; step the injected clock past it. */
const PAST_LIMITS_TTL_MS = 16_000;
/** "Nearly full" leaves this many bytes of room: any real write is bigger. */
const HEADROOM_BYTES = 10_000;

const USER_A = 'dq-user-a';
const USER_B = 'dq-user-b';

// ---------------------------------------------------------------------------
// Test-only plugins
// ---------------------------------------------------------------------------

/** agentId -> who owns it. Filled per test; an unknown id is "not found". */
const agentOwners = new Map<string, { ownerId: string; ownerType: 'user' | 'team' }>();
/** What the stubbed `agents:list-personal-owners` tells the sweep. */
let sweepAgents: Array<{ agentId: string; ownerUserId: string }> = [];

function createAgentsStubPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/disk-quota-agents-stub';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['agents:resolve', 'agents:list-personal-owners'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('agents:resolve', name, async (_ctx: AgentContext, input) => {
        const { agentId } = input as { agentId: string };
        const owner = agentOwners.get(agentId);
        if (owner === undefined) {
          throw new PluginError({
            code: 'not-found',
            plugin: name,
            message: `agent '${agentId}' not found`,
          });
        }
        return { agent: { id: agentId, ...owner } };
      });
      bus.registerService('agents:list-personal-owners', name, async () => ({
        agents: sweepAgents,
      }));
    },
  };
}

/**
 * Stand-ins for the http control plane @ax/disk-quota hard-calls at init to
 * mount its routes. Registration succeeds and is recorded; nothing ever
 * serves a request.
 */
function createControlPlaneStubPlugin(mountedRoutes: string[]): Plugin {
  const name = '@ax/preset-k8s/test/disk-quota-control-plane-stub';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['http:register-route', 'auth:require-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('http:register-route', name, async (_ctx, input) => {
        const route = input as { method: string; path: string };
        mountedRoutes.push(`${route.method} ${route.path}`);
        return { unregister() {} };
      });
      bus.registerService('auth:require-user', name, async () => {
        throw new PluginError({
          code: 'unauthenticated',
          plugin: name,
          message: 'no http plane in this canary',
        });
      });
    },
  };
}

/**
 * @ax/sandbox-subprocess hard-calls ipc:start/ipc:stop for its LIVE session
 * path. Nothing here opens a session -- the usage meter never enters a sandbox
 * -- but bootstrap's verifyCalls walk is static, so the producers must exist.
 * Stubbed rather than satisfied with @ax/ipc-server (which would drag in the
 * whole tool-dispatcher chain). Same stub as acceptance.test.ts' F4 canary.
 */
function createIpcStubPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/disk-quota-ipc-stub';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['ipc:start', 'ipc:stop'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('ipc:start', name, async () => ({ socketPath: '/dev/null' }));
      bus.registerService('ipc:stop', name, async () => undefined);
    },
  };
}

// ---------------------------------------------------------------------------

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Kernel {
  bus: HookBus;
  diskQuota: DiskQuotaPlugin;
  shutdown(): Promise<void>;
  mountedRoutes: string[];
}

interface LedgerRow {
  ownerId: string;
  source: string;
  kind: string;
  bytes: number;
}

describe('@ax/preset-k8s disk quota canary (real blob store + agent files + postgres)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let connectionString = '';
  let tmp = '';
  let originalCredKey: string | undefined;
  let kernel: Kernel | null = null;
  // Injected clock for @ax/disk-quota: real time plus a skew the tests advance
  // to step past the limits cache.
  let clockSkewMs = 0;
  const clock = (): Date => new Date(Date.now() + clockSkewMs);
  let seq = 0;

  function presetConfig(): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      blob: { backend: 'fs', root: path.join(tmp, 'blobs') },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: {}, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
    };
  }

  async function bootKernel(opts: { userFilesRoot?: string } = {}): Promise<Kernel> {
    const presetPlugins = createK8sPlugins(presetConfig());
    const presetDiskQuota = presetPlugins.find((p) => p.manifest.name === DISK_QUOTA_PLUGIN);
    // The production preset registers the plugin (the half this canary exists
    // to keep honest)...
    expect(presetDiskQuota, 'createK8sPlugins must load @ax/disk-quota').toBeDefined();
    const diskQuota = createDiskQuotaPlugin({ now: clock, sweepIntervalMs: 0 });
    // ...and the instance booted here is the same plugin, not a look-alike.
    expect(diskQuota.manifest).toEqual(presetDiskQuota!.manifest);

    const kept = presetPlugins.filter((p) => !PLUGINS_TO_DROP.has(p.manifest.name));
    // The real things this canary exists to exercise are the preset's own.
    const keptNames = kept.map((p) => p.manifest.name);
    for (const name of ['@ax/database-postgres', '@ax/storage-postgres', '@ax/blob-store-fs']) {
      expect(keptNames, `createK8sPlugins must load ${name}`).toContain(name);
    }

    const mountedRoutes: string[] = [];
    const plugins: Plugin[] = [
      ...kept,
      diskQuota,
      createAgentsStubPlugin(),
      createControlPlaneStubPlugin(mountedRoutes),
      // Block (7) only: a real per-agent /files home on a temp directory and
      // the subprocess provider that measures it. The canary's preset config
      // has no `filestore`, and @ax/sandbox-k8s is dropped, so this is the only
      // `sandbox:resolve-mounts` and `sandbox:user-files-usage` on the bus.
      ...(opts.userFilesRoot !== undefined
        ? [
            createWorkspaceLocaldirPlugin({ root: opts.userFilesRoot }),
            createSessionInmemoryPlugin(),
            createIpcStubPlugin(),
            createSandboxSubprocessPlugin(),
          ]
        : []),
    ];
    const bus = new HookBus();
    const handle = await bootstrap({ bus, plugins, config: {} });
    return { bus, diskQuota, shutdown: () => handle.shutdown(), mountedRoutes };
  }

  function live(): Kernel {
    if (kernel === null) throw new Error('kernel not booted');
    return kernel;
  }

  function ctxFor(userId: string, agentId: string): AgentContext {
    seq += 1;
    return makeAgentContext({ sessionId: `dq-canary-${seq}`, agentId, userId });
  }

  async function db(): Promise<Kysely<unknown>> {
    const { db: handle } = await live().bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      ctxFor('system', 'canary'),
      {},
    );
    return handle;
  }

  // ---- the ledger, read straight from postgres ------------------------------

  async function ledger(ownerId: string): Promise<LedgerRow[]> {
    const res = await sql<{ owner_id: string; source: string; kind: string; bytes: string }>`
      SELECT owner_id, source, kind, bytes FROM disk_quota_v1_usage
      WHERE owner_id = ${ownerId} ORDER BY source
    `.execute(await db());
    return res.rows.map((r) => ({
      ownerId: r.owner_id,
      source: r.source,
      kind: r.kind,
      bytes: Number(r.bytes),
    }));
  }

  async function ledgerRow(ownerId: string, source: string): Promise<LedgerRow | undefined> {
    return (await ledger(ownerId)).find((r) => r.source === source);
  }

  async function usedBy(ownerId: string): Promise<number> {
    return (await ledger(ownerId)).reduce((sum, r) => sum + r.bytes, 0);
  }

  /**
   * Put `ownerId` `roomBytes` short of the 64 MB limit by inserting one ledger
   * row (the cheap way to be "nearly full"). Re-callable: it replaces its own
   * previous seed.
   */
  async function seedLedger(ownerId: string, roomBytes: number): Promise<void> {
    const others = (await ledger(ownerId))
      .filter((r) => r.source !== 'blob:seed')
      .reduce((sum, r) => sum + r.bytes, 0);
    const seedBytes = MIN_LIMIT_BYTES - roomBytes - others;
    expect(seedBytes, 'the seed must be a positive number of bytes').toBeGreaterThan(0);
    await sql`
      INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes)
      VALUES (${ownerId}, 'blob:seed', 'blob', ${seedBytes})
      ON CONFLICT (owner_id, source) DO UPDATE SET bytes = EXCLUDED.bytes
    `.execute(await db());
  }

  /** Room for HEADROOM_BYTES and no more: any real write is refused. */
  const seedNearlyFull = (ownerId: string): Promise<void> => seedLedger(ownerId, HEADROOM_BYTES);
  /** Exactly at the limit: every write is refused (turns still go through, TASK-993). */
  const seedFull = (ownerId: string): Promise<void> => seedLedger(ownerId, 0);

  /** Write the limits setting the way an admin change lands (the storage key),
   *  then step the plugin's clock past its cache so the next admit reads it. */
  async function setLimits(limits: { limitMb: number; warnPercent?: number }): Promise<void> {
    await live().bus.call('storage:set', ctxFor('system', 'canary'), {
      key: 'settings:disk-quota',
      value: new TextEncoder().encode(JSON.stringify(limits)),
    });
    clockSkewMs += PAST_LIMITS_TTL_MS;
  }

  // ---- the two write facades ------------------------------------------------

  async function blobPut(
    userId: string,
    bytes: Uint8Array,
  ): Promise<{ sha256: string; size: number }> {
    return live().bus.call<{ bytes: Uint8Array }, { sha256: string; size: number }>(
      'blob:put',
      ctxFor(userId, 'dq-blob-writer'),
      { bytes },
    );
  }

  async function blobStat(sha256: string): Promise<{ size: number } | { found: false }> {
    return live().bus.call('blob:stat', ctxFor('system', 'canary'), { sha256 });
  }

  /** A write that must be refused: the PluginError the facade throws. */
  async function refusalOf(write: Promise<unknown>): Promise<PluginError> {
    try {
      await write;
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      return err as PluginError;
    }
    throw new Error('expected the write to be refused, but it went through');
  }

  // ---- lifecycle -------------------------------------------------------------

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-disk-quota-canary-')));
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    // @ax/credentials (kept from the preset) throws at init without it.
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
    pgContainer = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = pgContainer.getConnectionUri();
    kernel = await bootKernel();
  });

  beforeEach(async () => {
    agentOwners.clear();
    sweepAgents = [];
    await live().diskQuota.drain();
    await sql`TRUNCATE disk_quota_v1_usage`.execute(await db());
    await setLimits({ limitMb: MIN_LIMIT_MB, warnPercent: 80 });
  });

  afterEach(async () => {
    // A background re-measure landing after the next test's TRUNCATE would put
    // a stray row in a ledger that test believes is empty.
    if (kernel !== null) await kernel.diskQuota.drain();
  });

  afterAll(async () => {
    if (kernel !== null) await kernel.shutdown();
    kernel = null;
    await stopPostgresContainer(pgContainer ?? undefined);
    pgContainer = null;
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('boots with the storage routes mounted through http:register-route', () => {
    expect(live().mountedRoutes).toEqual([
      'GET /settings/storage',
      'GET /admin/storage',
      'PUT /admin/storage/limits',
      'POST /admin/storage/ref-holders/forget',
    ]);
  });

  // -------------------------------------------------------------------------
  // 1. BLOBS -- blob:put facade -> blob:pre-put veto -> backend -> blob:stored
  // -------------------------------------------------------------------------

  it('(1) blob:put: charged once per owner and sha, refused (and never stored) past the limit, other owners and system unaffected', async () => {
    const fewMb = randomBytes(3 * MB);
    const put = await blobPut(USER_A, fewMb);
    expect(put.size).toBe(fewMb.length);
    // METER: the facade's blob:stored charged the writer, for this sha.
    expect(await ledger(USER_A)).toEqual([
      { ownerId: USER_A, source: `blob:${put.sha256}`, kind: 'blob', bytes: fewMb.length },
    ]);

    // The same bytes put again by the same person are one blob on disk and
    // must stay one charge.
    await blobPut(USER_A, fewMb);
    expect(await ledger(USER_A)).toHaveLength(1);
    expect(await usedBy(USER_A)).toBe(fewMb.length);

    // GATE: nearly full, and one more upload no longer fits.
    await seedNearlyFull(USER_A);
    const used = await usedBy(USER_A);
    const refused = randomBytes(1 * MB);
    const err = await refusalOf(blobPut(USER_A, refused));
    expect(err.code).toBe('rejected');
    expect(err.message).toBe(blobFullMessage(used, MIN_LIMIT_BYTES));
    // It says what is true (storage is used up) and does NOT send anyone off
    // to delete things: deleting a whole agent gives its files back, but
    // attachments and artifacts cannot be deleted, so there is no small chore
    // that makes room.
    expect(err.message.toLowerCase()).toContain('storage');
    expect(err.message.toLowerCase()).not.toContain('delete');
    // The veto fired BEFORE the backend: the refused bytes are not in the
    // store, and nothing was charged for them.
    expect(await blobStat(sha256Hex(refused))).toEqual({ found: false });
    expect(await usedBy(USER_A)).toBe(used);

    // Another person, same moment, the very bytes A was just refused: fine.
    const bPut = await blobPut(USER_B, refused);
    expect(bPut.sha256).toBe(sha256Hex(refused));
    expect(await blobStat(bPut.sha256)).toEqual({ size: refused.length });
    expect(await ledger(USER_B)).toEqual([
      { ownerId: USER_B, source: `blob:${bPut.sha256}`, kind: 'blob', bytes: refused.length },
    ]);

    // A write with no person behind it (the branding logo, a skill bundle with
    // no owner) is charged to nobody and never refused -- not even one bigger
    // than the whole limit, which is the only size at which "checked against
    // an empty ledger" and "exempt" would differ.
    const sys = randomBytes(MIN_LIMIT_BYTES + 1);
    const sysPut = await blobPut('system', sys);
    expect(await blobStat(sysPut.sha256)).toEqual({ size: sys.length });
    expect(await ledger('system')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. THE FRONT DOOR STAYS OPEN -- the real chat:start hook the orchestrator
  //    fires before any sandbox exists. Over quota blocks writes, never a turn
  //    (TASK-993): a full person can still ask their agent to tidy up.
  // -------------------------------------------------------------------------

  it('(5) a full owner can still start a turn; only their writes are refused', async () => {
    const { bus } = live();
    agentOwners.set('dq-agt-turn-a', { ownerId: USER_A, ownerType: 'user' });
    agentOwners.set('dq-agt-turn-team-full', { ownerId: 'tm2', ownerType: 'team' });
    const start = (userId: string, agentId: string) =>
      bus.fire('chat:start', ctxFor(userId, agentId), {
        message: { role: 'user', content: 'hi' },
      });

    // A and the team `tm2` are exactly at their limit.
    await seedFull(USER_A);
    await seedFull('team:tm2');

    // A full person's turn goes through, on their own agent...
    expect(await start(USER_A, 'dq-agt-turn-a')).toMatchObject({ rejected: false });
    // ...and on a full team's agent, whoever sends it.
    expect(await start(USER_B, 'dq-agt-turn-team-full')).toMatchObject({ rejected: false });

    // The write gate still holds: A's next upload is refused, before the
    // backend, and nothing is charged for it.
    const used = await usedBy(USER_A);
    const refused = randomBytes(4096);
    const err = await refusalOf(blobPut(USER_A, refused));
    expect(err.code).toBe('rejected');
    expect(err.message).toBe(blobFullMessage(used, MIN_LIMIT_BYTES));
    expect(await blobStat(sha256Hex(refused))).toEqual({ found: false });
    expect(await usedBy(USER_A)).toBe(used);
  });

  // -------------------------------------------------------------------------
  // 6. PERSISTENCE and RUNTIME CHANGE (it restarts the kernel; (7) follows it
  //    and swaps in its own, so nothing may come after (7))
  // -------------------------------------------------------------------------

  it('(6) the ledger survives a restart, and raising the limit admits the owner again with no restart', async () => {
    // Fill A the honest way, with real bytes: 62 MB against the 64 MB limit.
    const big = randomBytes(62 * MB);
    const bigPut = await blobPut(USER_A, big);
    const three = randomBytes(3 * MB);
    expect(await usedBy(USER_A)).toBe(big.length);
    const before = await refusalOf(blobPut(USER_A, three));
    expect(before.message).toBe(blobFullMessage(big.length, MIN_LIMIT_BYTES));

    // Tear the whole host down: every plugin's shutdown, the pg pool closed,
    // nothing held in memory survives. Then boot a brand-new set of plugins
    // (fresh plugin instance, fresh limits and owner caches) on the SAME
    // postgres and blob root.
    await live().shutdown();
    kernel = null;
    kernel = await bootKernel();

    expect(await blobStat(bigPut.sha256)).toEqual({ size: big.length });
    const afterBlob = await refusalOf(blobPut(USER_A, three));
    expect(afterBlob.code).toBe('rejected');
    expect(afterBlob.message).toBe(blobFullMessage(big.length, MIN_LIMIT_BYTES));

    // An admin raises the limit (a partial setting: only limitMb). No restart:
    // the next write, on this very kernel, is admitted.
    await setLimits({ limitMb: 4096 });
    const admitted = await blobPut(USER_A, three);
    expect(await ledgerRow(USER_A, `blob:${admitted.sha256}`)).toMatchObject({
      kind: 'blob',
      bytes: three.length,
    });
  });

  // -------------------------------------------------------------------------
  // 7. AGENT FILES (TASK-993) -- chat:turn-end -> sandbox:user-files-usage ->
  //    an `agent-files:<agentId>` ledger row, charged to the agent's owner;
  //    `agents:deleted` removes the folder and the row. A REAL directory under
  //    a temp root, walked by the real @ax/sandbox-subprocess implementation
  //    of the hook. Last in the file: it replaces the shared kernel.
  // -------------------------------------------------------------------------

  describe.skipIf(!ON_LINUX)('(7) agent files are metered and count toward the limit', () => {
    let userFilesRoot = '';

    beforeAll(async () => {
      userFilesRoot = path.join(tmp, 'user-files');
      await fs.mkdir(userFilesRoot, { recursive: true });
      await live().shutdown();
      kernel = null;
      kernel = await bootKernel({ userFilesRoot });
    });

    /** What the walk should say: allocated bytes of `dir` and everything in it,
     *  by `lstat` (a link counts as itself and is never followed). */
    async function allocatedBytes(dir: string): Promise<number> {
      const allocated = (st: nodeFs.Stats): number =>
        Number.isFinite(st.blocks) ? st.blocks * 512 : st.size;
      let total = allocated(await fs.lstat(dir));
      for (const entry of await fs.readdir(dir)) {
        const child = path.join(dir, entry);
        const st = await fs.lstat(child);
        total += st.isDirectory() ? await allocatedBytes(child) : allocated(st);
      }
      return total;
    }

    /** The runner's assistant turn end, through the real bus. */
    function turnEnd(userId: string, agentId: string) {
      return live().bus.fire('chat:turn-end', ctxFor(userId, agentId), {
        reason: 'user-message-wait',
        role: 'assistant',
      });
    }

    async function exists(p: string): Promise<boolean> {
      try {
        await fs.lstat(p);
        return true;
      } catch {
        return false;
      }
    }

    it('(7a) agent files are metered at turn end and count toward the owner; uploads are refused, chat is not, and cleaning up makes room', async () => {
      const owner = 'dq-user-files';
      const agentId = 'dq-agt-files';
      agentOwners.set(agentId, { ownerId: owner, ownerType: 'user' });
      const home = path.join(userFilesRoot, agentId);
      const sibling = path.join(userFilesRoot, 'dq-agt-other');
      await fs.mkdir(path.join(home, 'sub'), { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(path.join(home, 'report.bin'), randomBytes(MB));
      await fs.writeFile(path.join(home, 'sub', 'notes.txt'), 'some notes');
      // Another agent's folder, and a link inside this one that points at it:
      // neither the sibling nor the link's target may be counted for this agent.
      await fs.writeFile(path.join(sibling, 'big.bin'), randomBytes(2 * MB));
      await fs.symlink('../dq-agt-other', path.join(home, 'peek'));

      const source = `agent-files:${agentId}`;
      expect(await ledgerRow(owner, source), 'nothing is metered before a turn ends').toBeUndefined();

      await turnEnd(owner, agentId);
      await live().diskQuota.drain();
      const first = await ledgerRow(owner, source);
      expect(first).toMatchObject({ ownerId: owner, kind: 'agent-files' });
      const expected = await allocatedBytes(home);
      expect(expected).toBeGreaterThanOrEqual(MB);
      expect(expected, 'the sibling (2 MiB) is not in the oracle').toBeLessThan(2 * MB);
      expect(first!.bytes).toBe(expected);

      // Counts toward the owner: the same budget the upload gate enforces.
      await setLimits({ limitMb: MIN_LIMIT_MB });
      await seedNearlyFull(owner);
      const upload = randomBytes(100_000);
      const refused = await refusalOf(blobPut(owner, upload));
      expect(refused.code).toBe('rejected');
      expect(refused.message).toBe(
        blobFullMessage(MIN_LIMIT_BYTES - HEADROOM_BYTES, MIN_LIMIT_BYTES),
      );
      // ...but the person can still talk to their agent (and ask it to tidy up).
      expect(
        await live().bus.fire('chat:start', ctxFor(owner, agentId), {
          message: { role: 'user', content: 'please clean up my files' },
        }),
      ).toMatchObject({ rejected: false });

      // The agent cleans up: the next turn end shrinks the row and frees room.
      await fs.rm(path.join(home, 'report.bin'));
      await turnEnd(owner, agentId);
      await live().diskQuota.drain();
      const after = await ledgerRow(owner, source);
      expect(after!.bytes).toBe(await allocatedBytes(home));
      expect(after!.bytes).toBeLessThan(first!.bytes);
      const admitted = await blobPut(owner, upload);
      expect(admitted.size).toBe(upload.length);
    });

    it('(7b) deleting the agent removes its files and its row, and a late turn end writes nothing', async () => {
      const owner = 'dq-user-gone';
      const agentId = 'dq-agt-gone';
      // Kept resolvable on purpose, so it is the tombstone (not a failed
      // owner lookup) that keeps the late measurements from writing a row.
      agentOwners.set(agentId, { ownerId: owner, ownerType: 'user' });
      const home = path.join(userFilesRoot, agentId);
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(path.join(home, 'data.bin'), randomBytes(MB));
      const source = `agent-files:${agentId}`;

      await turnEnd(owner, agentId);
      await live().diskQuota.drain();
      expect(await ledgerRow(owner, source), 'metered before the delete').toMatchObject({
        kind: 'agent-files',
      });

      await live().bus.fire('agents:deleted', ctxFor(owner, 'dq-agents-delete'), {
        agentId,
        ownerId: owner,
        ownerType: 'user',
      });
      expect(await exists(home), "@ax/sandbox-subprocess removed the agent's folder").toBe(false);
      expect(await ledgerRow(owner, source), 'the row is gone').toBeUndefined();

      // A warm runner's late turn end, then a sweep that still lists the agent.
      await turnEnd(owner, agentId);
      await live().diskQuota.drain();
      sweepAgents = [{ agentId, ownerUserId: owner }];
      await live().diskQuota.reconcile();
      expect(await ledgerRow(owner, source), 'nothing is metered for a deleted agent').toBeUndefined();
    });
  });
});
