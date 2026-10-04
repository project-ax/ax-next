import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
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
  asWorkspaceVersion,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceVersion,
} from '@ax/core';
import { workspaceCommitNotifyHandler } from '@ax/ipc-core';
import {
  blobFullMessage,
  createDiskQuotaPlugin,
  workspaceFullMessage,
  type DiskQuotaPlugin,
} from '@ax/disk-quota';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-690 -- per-owner storage limit canary (Invariant 3: no half-wired
// plugins).
//
// @ax/disk-quota only means something when it sits on the REAL write paths:
//
//   GATE   -- `blob:pre-put` (fired by the @ax/core `blob:put` facade the blob
//             backend registers behind) and `workspace:pre-apply` (fired by
//             the @ax/core `workspace:apply` facade AND by @ax/ipc-core's
//             runner commit handler) refuse a write that would put its owner
//             past the limit.
//   METER  -- `blob:stored` charges the writer; `workspace:applied` makes the
//             plugin re-measure that agent's repo through the backend's
//             `workspace:usage`; a periodic sweep backfills and repairs.
//   FREE   -- `agents:deleted` makes the preset's @ax/workspace-git remove that
//             agent's repo and fire `workspace:deleted`, which makes the plugin
//             drop the agent's ledger row (TASK-719). Blob bytes are NOT freed.
//
// The package tests prove each half against fakes. This canary proves the
// LOOP through the real chokepoints: the preset's own @ax/workspace-git (a
// local backend on a temp repoRoot, real bare git repos), its own
// @ax/blob-store-fs (a temp root), its own @ax/database-postgres +
// @ax/storage-postgres pointed at a postgres testcontainer, the real
// @ax/disk-quota, and the real host-side commit-notify handler fed real git
// thin bundles. No sandbox is spawned: the "runner" is `git` in a temp dir,
// exactly like acceptance.test.ts' Phase 3 canaries.
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
  '@ax/memory-facts-postgres',
  '@ax/preset-k8s/retire-strata-index',
  // The spend/rate-limit plugin has its own canary and is not on this path.
  '@ax/usage-limits',
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
const ADMIN = 'dq-admin';

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
 * A one-shot gate on `workspace:applied` for ONE agent, armed by the test that
 * needs to hold that agent's post-write notice (and with it @ax/disk-quota's
 * re-measure, which it triggers) shut until the test says go. Unarmed, or for
 * any other agent, it lets everything through untouched.
 *
 * It only works because the kernel boots this plugin FIRST: subscribers run in
 * registration order, so the gate is reached before disk-quota's own
 * `workspace:applied` subscriber and nothing measures while it is shut.
 */
let appliedGate: { agentId: string; entered: () => void; opened: Promise<void> } | null = null;

function createAppliedGatePlugin(): Plugin {
  const name = '@ax/preset-k8s/test/disk-quota-applied-gate';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['workspace:applied'],
    },
    init({ bus }) {
      bus.subscribe<unknown>('workspace:applied', name, async (ctx) => {
        const gate = appliedGate;
        if (gate === null || gate.agentId !== ctx.agentId) return undefined;
        appliedGate = null;
        gate.entered();
        await gate.opened;
        return undefined;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Real git, playing the runner
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function git(args: readonly string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function gitOrThrow(args: readonly string[], cwd?: string): Promise<SpawnResult> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  return r;
}

/** `git bundle create - baseline..main main`, base64 (the runner's wire shape). */
async function thinBundleB64(wt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['-C', wt, 'bundle', 'create', '-', 'baseline..main', 'main']);
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString('base64'))
        : reject(new Error(`bundle exit=${code}: ${stderr}`)),
    );
  });
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

describe('@ax/preset-k8s disk quota canary (real git + blob store + postgres)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let connectionString = '';
  let tmp = '';
  let repoRoot = '';
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
      workspace: { backend: 'local', repoRoot },
      blob: { backend: 'fs', root: path.join(tmp, 'blobs') },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: {}, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
    };
  }

  async function bootKernel(): Promise<Kernel> {
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
    for (const name of [
      '@ax/database-postgres',
      '@ax/storage-postgres',
      '@ax/workspace-git',
      '@ax/blob-store-fs',
    ]) {
      expect(keptNames, `createK8sPlugins must load ${name}`).toContain(name);
    }

    const mountedRoutes: string[] = [];
    const plugins: Plugin[] = [
      // First on purpose: see createAppliedGatePlugin.
      createAppliedGatePlugin(),
      ...kept,
      diskQuota,
      createAgentsStubPlugin(),
      createControlPlaneStubPlugin(mountedRoutes),
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
  /** Exactly at the limit: writes and turns are both refused. */
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

  async function workspaceApply(
    ctx: AgentContext,
    files: Record<string, Uint8Array>,
    parent: WorkspaceVersion | null,
  ): Promise<WorkspaceApplyOutput> {
    return live().bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes: Object.entries(files).map(([p, content]) => ({
        path: p,
        kind: 'put' as const,
        content,
      })),
      parent,
      reason: 'disk-quota canary',
    });
  }

  async function workspaceUsage(ctx: AgentContext): Promise<number> {
    const out = await live().bus.call<Record<string, never>, { bytes: number }>(
      'workspace:usage',
      ctx,
      {},
    );
    return out.bytes;
  }

  async function workspaceList(ctx: AgentContext): Promise<string[]> {
    const out = await live().bus.call<Record<string, never>, { paths: string[] }>(
      'workspace:list',
      ctx,
      {},
    );
    return [...out.paths].sort();
  }

  async function workspaceRead(
    ctx: AgentContext,
    p: string,
  ): Promise<{ found: true; bytes: Uint8Array; version?: string } | { found: false }> {
    return live().bus.call('workspace:read', ctx, { path: p });
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

  /**
   * Play the runner: build a real thin bundle of `files` on top of the
   * workspace's baseline at `parent` (null = the first commit) and hand it to
   * the real host-side commit-notify handler.
   */
  async function runnerCommit(
    ctx: AgentContext,
    parent: string | null,
    files: Record<string, Uint8Array>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const { bus } = live();
    const baseline = await bus.call<{ version: WorkspaceVersion | null }, { bundleBytes: string }>(
      'workspace:export-baseline-bundle',
      ctx,
      { version: parent === null ? null : asWorkspaceVersion(parent) },
    );
    const root = await fs.mkdtemp(path.join(tmp, 'runner-'));
    try {
      const baselineBundle = path.join(root, 'baseline.bundle');
      await fs.writeFile(baselineBundle, Buffer.from(baseline.bundleBytes, 'base64'));
      const wt = path.join(root, 'wt');
      await gitOrThrow(['clone', '--branch', 'main', baselineBundle, wt]);
      await gitOrThrow(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);
      await gitOrThrow(['-C', wt, 'config', 'user.name', 'ax-runner']);
      await gitOrThrow(['-C', wt, 'config', 'user.email', 'ax-runner@example.com']);
      await gitOrThrow(['-C', wt, 'config', 'commit.gpgsign', 'false']);
      for (const [p, content] of Object.entries(files)) {
        const abs = path.join(wt, p);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
      await gitOrThrow(['-C', wt, 'add', '-A']);
      await gitOrThrow(['-C', wt, 'commit', '-m', 'turn']);
      const bundleB64 = await thinBundleB64(wt);
      const result = await workspaceCommitNotifyHandler(
        { parentVersion: parent, reason: 'turn', bundleBytes: bundleB64 },
        ctx,
        bus,
      );
      if (!('body' in result)) throw new Error('commit-notify answered with a binary body');
      return { status: result.status, body: result.body as Record<string, unknown> };
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  // ---- lifecycle -------------------------------------------------------------

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-disk-quota-canary-')));
    repoRoot = path.join(tmp, 'repos');
    await fs.mkdir(repoRoot, { recursive: true });
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
    appliedGate = null;
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
    // to delete things: deleting a whole agent gives its workspace back, but
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
  // 2. WORKSPACES, in-process -- the @ax/core workspace:apply facade
  // -------------------------------------------------------------------------

  it('(2) workspace:apply: metered from the real repo, refused with the head unchanged past the limit', async () => {
    const agentId = 'dq-agt-a';
    agentOwners.set(agentId, { ownerId: USER_A, ownerType: 'user' });
    const asA = ctxFor(USER_A, agentId);
    const report = randomBytes(300_000);

    const first = await workspaceApply(asA, { 'docs/report.bin': report }, null);
    await live().diskQuota.drain();
    // METER: the ledger row is what the backend's workspace:usage measures --
    // the whole repo, so more than the bytes we wrote.
    const measured = await workspaceUsage(asA);
    expect(measured).toBeGreaterThan(report.length);
    expect(await ledgerRow(USER_A, `workspace:${agentId}`)).toEqual({
      ownerId: USER_A,
      source: `workspace:${agentId}`,
      kind: 'workspace',
      bytes: measured,
    });

    // A change made by someone else (an admin fixing a file) is charged to the
    // agent's OWNER.
    const asAdmin = ctxFor(ADMIN, agentId);
    const second = await workspaceApply(
      asAdmin,
      { 'docs/notes.txt': new TextEncoder().encode('hello') },
      first.version,
    );
    await live().diskQuota.drain();
    expect(await ledger(ADMIN)).toEqual([]);
    expect((await ledgerRow(USER_A, `workspace:${agentId}`))?.bytes).toBe(
      await workspaceUsage(asA),
    );

    // GATE: nearly full, and the next change no longer fits.
    await seedNearlyFull(USER_A);
    const used = await usedBy(USER_A);
    const usageBefore = await workspaceUsage(asA);
    const err = await refusalOf(
      workspaceApply(asA, { 'docs/more.bin': randomBytes(300_000) }, second.version),
    );
    expect(err.code).toBe('rejected');
    expect(err.message).toBe(workspaceFullMessage(used, MIN_LIMIT_BYTES));
    expect(err.message).toContain('not saved');
    // Nothing landed: same files, same head, same size on disk.
    expect(await workspaceList(asA)).toEqual(['docs/notes.txt', 'docs/report.bin']);
    expect(await workspaceRead(asA, 'docs/more.bin')).toEqual({ found: false });
    expect(await workspaceRead(asA, 'docs/report.bin')).toMatchObject({
      found: true,
      version: second.version,
    });
    expect(await workspaceUsage(asA)).toBe(usageBefore);
    await live().diskQuota.drain();
    expect(await usedBy(USER_A)).toBe(used);

    // Another person's agent, same moment: unaffected.
    agentOwners.set('dq-agt-b', { ownerId: USER_B, ownerType: 'user' });
    await workspaceApply(ctxFor(USER_B, 'dq-agt-b'), { 'docs/b.bin': randomBytes(300_000) }, null);
    await live().diskQuota.drain();
    expect(await ledgerRow(USER_B, 'workspace:dq-agt-b')).toMatchObject({ kind: 'workspace' });
  });

  it('(2b) a team agent charges the team, and a full team refuses its members', async () => {
    const teamAgent = 'dq-agt-team';
    agentOwners.set(teamAgent, { ownerId: 'tm1', ownerType: 'team' });
    const asA = ctxFor(USER_A, teamAgent);

    const first = await workspaceApply(asA, { 'shared/plan.bin': randomBytes(100_000) }, null);
    await live().diskQuota.drain();
    // Charged to `team:<id>` -- not to the person who happened to make the change.
    expect(await ledger(USER_A)).toEqual([]);
    expect(await ledgerRow('team:tm1', `workspace:${teamAgent}`)).toEqual({
      ownerId: 'team:tm1',
      source: `workspace:${teamAgent}`,
      kind: 'workspace',
      bytes: await workspaceUsage(asA),
    });

    // The team is full. A has plenty of room of their own, and it is the
    // team's budget that decides.
    await seedNearlyFull('team:tm1');
    const teamUsed = await usedBy('team:tm1');
    const err = await refusalOf(
      workspaceApply(asA, { 'shared/more.bin': randomBytes(100_000) }, first.version),
    );
    expect(err.code).toBe('rejected');
    expect(err.message).toBe(workspaceFullMessage(teamUsed, MIN_LIMIT_BYTES));

    // ...while A's own agent is still writable.
    agentOwners.set('dq-agt-a-own', { ownerId: USER_A, ownerType: 'user' });
    await workspaceApply(
      ctxFor(USER_A, 'dq-agt-a-own'),
      { 'mine.bin': randomBytes(100_000) },
      null,
    );
    await live().diskQuota.drain();
    expect(await ledgerRow(USER_A, 'workspace:dq-agt-a-own')).toMatchObject({
      kind: 'workspace',
    });
  });

  // -------------------------------------------------------------------------
  // 3. WORKSPACES, from the runner -- the real workspace.commit-notify handler
  //    fed a real git thin bundle. This is the test that proves the refusal
  //    reaches the runner in the shape it acts on.
  // -------------------------------------------------------------------------

  it('(3) runner commit: accepted and metered under the limit; refused as a plain non-recoverable answer past it', async () => {
    const agentId = 'dq-agt-runner';
    agentOwners.set(agentId, { ownerId: USER_A, ownerType: 'user' });
    const ctx = ctxFor(USER_A, agentId);
    expect(await ledger(USER_A)).toEqual([]);

    const turn1 = await runnerCommit(ctx, null, { 'work/report.bin': randomBytes(200_000) });
    expect(turn1.status).toBe(200);
    expect(turn1.body).toMatchObject({ accepted: true });
    const v1 = turn1.body.version as string;
    await live().diskQuota.drain();
    // METER: the row moved from nothing to what the backend measures.
    const row = await ledgerRow(USER_A, `workspace:${agentId}`);
    expect(row?.bytes).toBe(await workspaceUsage(ctx));
    expect(row?.bytes).toBeGreaterThan(200_000);

    // GATE: the owner is nearly full, the same kind of commit comes back refused.
    await seedNearlyFull(USER_A);
    const used = await usedBy(USER_A);
    const turn2 = await runnerCommit(ctx, v1, { 'work/more.bin': randomBytes(200_000) });
    expect(turn2.status).toBe(200);
    // `recoverable: false` is what makes the runner throw the work away and
    // hand the reason to the agent; no `discardPaths`, because it is the whole
    // turn that does not fit, not one file. `code` is the machine-readable
    // twin of that prose (TASK-720): the runner maps it to `saveRefused` on
    // event.turn-end so the PERSON learns their files were not saved, instead
    // of the refusal reaching the model and stopping there.
    expect(turn2.body).toEqual({
      accepted: false,
      recoverable: false,
      code: 'storage-full',
      reason: workspaceFullMessage(used, MIN_LIMIT_BYTES),
    });
    expect(turn2.body).not.toHaveProperty('discardPaths');
    expect(turn2.body.reason).toContain('were not saved');
    // The workspace head did not advance.
    expect(await workspaceRead(ctx, 'work/report.bin')).toMatchObject({
      found: true,
      version: v1,
    });
    expect(await workspaceRead(ctx, 'work/more.bin')).toEqual({ found: false });
    await live().diskQuota.drain();
    expect(await usedBy(USER_A)).toBe(used);
  });

  // -------------------------------------------------------------------------
  // 4. THE SWEEP -- backfill and repair
  // -------------------------------------------------------------------------

  it('(4) the sweep backfills a repo the write path never saw, and repairs a stale figure', async () => {
    const agentId = 'dq-agt-sweep';
    const ctx = ctxFor(USER_A, agentId);
    const { bus } = live();
    const rawApply = async (
      p: string,
      parent: WorkspaceVersion | null,
    ): Promise<WorkspaceApplyOutput> =>
      bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply-internal', ctx, {
        changes: [{ path: p, kind: 'put', content: randomBytes(150_000) }],
        parent,
        reason: 'predates the quota',
      });

    // A repo that predates the plugin: written through the backend's raw hook,
    // which fires none of the policy or notify hooks, so nothing metered it.
    const first = await rawApply('legacy/old.bin', null);
    await live().diskQuota.drain();
    expect(await ledger(USER_A)).toEqual([]);

    sweepAgents = [{ agentId, ownerUserId: USER_A }];
    expect(await live().diskQuota.reconcile()).toEqual({ measured: 1, failed: 0, blobsReleased: 0, blobReleaseAborted: false });
    const backfilled = await ledgerRow(USER_A, `workspace:${agentId}`);
    expect(backfilled?.bytes).toBe(await workspaceUsage(ctx));
    expect(backfilled?.bytes).toBeGreaterThan(150_000);

    // Drift: the repo grows behind the plugin's back; the ledger is stale until
    // the next sweep.
    await rawApply('legacy/new.bin', first.version);
    expect((await ledgerRow(USER_A, `workspace:${agentId}`))?.bytes).toBe(backfilled?.bytes);
    expect(await live().diskQuota.reconcile()).toEqual({ measured: 1, failed: 0, blobsReleased: 0, blobReleaseAborted: false });
    const repaired = await ledgerRow(USER_A, `workspace:${agentId}`);
    expect(repaired?.bytes).toBe(await workspaceUsage(ctx));
    expect(repaired!.bytes).toBeGreaterThan(backfilled!.bytes);
  });

  // chmod cannot lock root out, so the "unmeasurable repo" needs a non-root user.
  it.skipIf(process.getuid?.() === 0)(
    '(4b) an agent whose repo cannot be measured does not stop the sweep for the others',
    async () => {
      const { bus } = live();
      const dirs = new Map<string, string>();
      for (const agentId of ['dq-agt-sw-ok1', 'dq-agt-sw-bad', 'dq-agt-sw-ok2']) {
        const before = new Set(await fs.readdir(repoRoot));
        await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply-internal',
          ctxFor(USER_A, agentId),
          {
            changes: [{ path: 'f.bin', kind: 'put', content: randomBytes(50_000) }],
            parent: null,
            reason: 'predates the quota',
          },
        );
        const created = (await fs.readdir(repoRoot)).filter((n) => !before.has(n));
        expect(created, `one new repo for ${agentId}`).toHaveLength(1);
        dirs.set(agentId, path.join(repoRoot, created[0]!));
      }
      const badDir = dirs.get('dq-agt-sw-bad')!;
      await fs.chmod(badDir, 0o000);
      try {
        // The unmeasurable one is listed FIRST: a sweep that gave up at the
        // first failure would measure nothing.
        sweepAgents = [
          { agentId: 'dq-agt-sw-bad', ownerUserId: USER_A },
          { agentId: 'dq-agt-sw-ok1', ownerUserId: USER_A },
          { agentId: 'dq-agt-sw-ok2', ownerUserId: USER_A },
        ];
        expect(await live().diskQuota.reconcile()).toEqual({ measured: 2, failed: 1, blobsReleased: 0, blobReleaseAborted: false });
      } finally {
        await fs.chmod(badDir, 0o755);
      }
      expect((await ledger(USER_A)).map((r) => r.source)).toEqual([
        'workspace:dq-agt-sw-ok1',
        'workspace:dq-agt-sw-ok2',
      ]);
    },
  );

  // -------------------------------------------------------------------------
  // 5. THE FRONT DOOR -- the real chat:start hook the orchestrator fires
  //    before any sandbox exists
  // -------------------------------------------------------------------------

  it('(5) chat:start: a full owner is turned away with storage-full, judged per owner, admitted again once the limit is raised', async () => {
    const { bus } = live();
    agentOwners.set('dq-agt-turn-a', { ownerId: USER_A, ownerType: 'user' });
    agentOwners.set('dq-agt-turn-b', { ownerId: USER_B, ownerType: 'user' });
    agentOwners.set('dq-agt-turn-team-full', { ownerId: 'tm2', ownerType: 'team' });
    agentOwners.set('dq-agt-turn-team-roomy', { ownerId: 'tm3', ownerType: 'team' });
    const start = (userId: string, agentId: string) =>
      bus.fire('chat:start', ctxFor(userId, agentId), {
        message: { role: 'user', content: 'hi' },
      });

    // Nobody is full yet: every turn passes.
    for (const [userId, agentId] of [
      [USER_A, 'dq-agt-turn-a'],
      [USER_B, 'dq-agt-turn-b'],
      [USER_B, 'dq-agt-turn-team-full'],
    ] as const) {
      expect(await start(userId, agentId), `${userId} on ${agentId}`).toMatchObject({
        rejected: false,
      });
    }

    // A and the team `tm2` are at their limit; B and the team `tm3` have room.
    await seedFull(USER_A);
    await seedFull('team:tm2');

    // The veto is a CODE (`chat:start:storage-full` once the orchestrator
    // prefixes it), and it comes from this plugin.
    expect(await start(USER_A, 'dq-agt-turn-a')).toMatchObject({
      rejected: true,
      reason: 'storage-full',
      source: DISK_QUOTA_PLUGIN,
    });
    // B has room to spare, on their own agent.
    expect(await start(USER_B, 'dq-agt-turn-b')).toMatchObject({ rejected: false });
    // A team agent's turn is judged by the TEAM's total, whoever sends it: B
    // has room but the team does not...
    expect(await start(USER_B, 'dq-agt-turn-team-full')).toMatchObject({
      rejected: true,
      reason: 'storage-full',
      source: DISK_QUOTA_PLUGIN,
    });
    // ...and A is full but a team with room is not.
    expect(await start(USER_A, 'dq-agt-turn-team-roomy')).toMatchObject({ rejected: false });

    // An admin raises the limit (storage:set + clock past the cache): the very
    // next turn, on this very kernel, passes.
    await setLimits({ limitMb: 4096 });
    expect(await start(USER_A, 'dq-agt-turn-a')).toMatchObject({ rejected: false });
    expect(await start(USER_B, 'dq-agt-turn-team-full')).toMatchObject({ rejected: false });
  });

  // -------------------------------------------------------------------------
  // 5b. AGENT DELETE -- `agents:deleted` frees the agent's workspace. The real
  //     bus fans the event to the preset's own @ax/workspace-git (removes the
  //     repo, refuses late writes, fires `workspace:deleted`), which reaches the
  //     real @ax/disk-quota (drops the ledger row). No stub sits between them:
  //     the only test-only pieces are the agent-owner lookup and the gates in
  //     (5b-c).
  // -------------------------------------------------------------------------

  describe('(5b) deleting an agent frees its storage', () => {
    interface SeededAgent {
      id: string;
      /** The agent's bare repo on disk. */
      dir: string;
      /** The head after its one write: what a warm runner would still name as parent. */
      version: WorkspaceVersion;
      /** Its `workspace:<id>` ledger row, as metered from the real repo. */
      row: LedgerRow;
    }
    interface Seeded {
      owner: string;
      a: SeededAgent;
      b: SeededAgent;
      blobSource: string;
      /** The owner's blob row: nothing in this feature ever frees it. */
      blobRow: LedgerRow;
    }

    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
    let deleteSeq = 0;

    /** How long (5b-c) waits for a gate it is counting on before it says which one never opened. */
    const GATE_TIMEOUT_MS = 5_000;

    /**
     * Wait for a gate to be reached, or fail in a few seconds with `problem`
     * instead of waiting out vitest's 60 s test timeout (which gives a generic
     * message and never reaches the test's `finally`).
     */
    async function gateReached(gate: Promise<void>, problem: string): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(problem)), GATE_TIMEOUT_MS);
      });
      try {
        await Promise.race([gate, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    }

    async function exists(p: string): Promise<boolean> {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    }

    /** Every entry in the repo root, sorted: the repos, and nothing else made behind them. */
    async function repoDirs(): Promise<string[]> {
      return (await fs.readdir(repoRoot)).sort();
    }

    async function requireRow(ownerId: string, source: string): Promise<LedgerRow> {
      const row = await ledgerRow(ownerId, source);
      if (row === undefined) throw new Error(`no ledger row for ${ownerId} / ${source}`);
      return row;
    }

    /**
     * An agent's first write creates its repo, in a directory named after a hash
     * of its id: find it the way (4b) does, as the one entry that was not there
     * before.
     */
    async function firstWrite(
      ctx: AgentContext,
      files: Record<string, Uint8Array>,
    ): Promise<{ dir: string; version: WorkspaceVersion }> {
      const before = new Set(await fs.readdir(repoRoot));
      const out = await workspaceApply(ctx, files, null);
      const created = (await fs.readdir(repoRoot)).filter((n) => !before.has(n));
      expect(created, `one new repo for ${ctx.agentId}`).toHaveLength(1);
      return { dir: path.join(repoRoot, created[0]!), version: out.version };
    }

    /**
     * Owner O with two agents that each made a real write (so each has a repo
     * on disk and a metered `workspace:<id>` row) and one uploaded blob (a blob
     * row). Everything is written through the real facades and drained.
     */
    async function seedOwnerWithTwoAgents(): Promise<Seeded> {
      const owner = USER_A;
      // A fresh pair of ids per test: a deleted agent stays deleted for the life
      // of the host (workspace-git's tombstone), and the kernel is shared.
      deleteSeq += 1;
      const ids = { a: `dq-del-agt-a-${deleteSeq}`, b: `dq-del-agt-b-${deleteSeq}` };
      agentOwners.set(ids.a, { ownerId: owner, ownerType: 'user' });
      agentOwners.set(ids.b, { ownerId: owner, ownerType: 'user' });

      const blob = await blobPut(owner, randomBytes(200_000));
      const wa = await firstWrite(ctxFor(owner, ids.a), { 'docs/a.bin': randomBytes(300_000) });
      const wb = await firstWrite(ctxFor(owner, ids.b), { 'docs/b.bin': randomBytes(150_000) });
      await live().diskQuota.drain();

      const seeded: Seeded = {
        owner,
        a: { id: ids.a, ...wa, row: await requireRow(owner, `workspace:${ids.a}`) },
        b: { id: ids.b, ...wb, row: await requireRow(owner, `workspace:${ids.b}`) },
        blobSource: `blob:${blob.sha256}`,
        blobRow: await requireRow(owner, `blob:${blob.sha256}`),
      };
      // The starting point is honest: three rows, and the owner's usage is
      // exactly their sum. Each workspace row is the whole repo (more than the
      // bytes written into it).
      expect(seeded.a.row.bytes).toBeGreaterThan(300_000);
      expect(seeded.b.row.bytes).toBeGreaterThan(150_000);
      expect(await usedBy(owner)).toBe(
        seeded.a.row.bytes + seeded.b.row.bytes + seeded.blobRow.bytes,
      );
      return seeded;
    }

    /** What @ax/agents fires once the agent's row is gone, through the real bus. */
    function agentDeleted(agentId: string, ownerId: string) {
      return live().bus.fire('agents:deleted', ctxFor(ownerId, 'dq-agents-delete'), {
        agentId,
        ownerId,
        ownerType: 'user',
      });
    }

    /** B's repo and row, and the owner's blob row, exactly as they were seeded. */
    async function expectSiblingsIntact(t: Seeded): Promise<void> {
      expect(await exists(t.b.dir)).toBe(true);
      expect(await ledgerRow(t.owner, `workspace:${t.b.id}`)).toEqual(t.b.row);
      expect(await ledgerRow(t.owner, t.blobSource)).toEqual(t.blobRow);
      const asB = ctxFor(t.owner, t.b.id);
      expect(await workspaceRead(asB, 'docs/b.bin')).toMatchObject({
        found: true,
        version: t.b.version,
      });
      // The row still matches what is really on disk.
      expect(await workspaceUsage(asB)).toBe(t.b.row.bytes);
    }

    /**
     * Hold `gitdir`'s write mutex open. The first file read under it is the
     * `resolveHead` a write makes INSIDE the mutex, so the write that trips the
     * gate is holding the mutex, and anything else for that agent (the delete)
     * queues behind it. Same trick as workspace-git-core's own delete tests, and
     * it works here because `node:fs` is one shared module. Only that gitdir is
     * gated, and only its first read.
     */
    function holdRepoMutexOnFirstRead(gitdir: string): {
      entered: Promise<void>;
      release: () => void;
      restore: () => void;
    } {
      const realReadFile = nodeFs.promises.readFile.bind(nodeFs.promises);
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve));
      let release!: () => void;
      const opened = new Promise<void>((resolve) => (release = resolve));
      let tripped = false;
      const spy = vi.spyOn(nodeFs.promises, 'readFile').mockImplementation((async (
        p: Parameters<typeof realReadFile>[0],
        ...rest: unknown[]
      ) => {
        if (!tripped && typeof p === 'string' && p.startsWith(`${gitdir}/`)) {
          tripped = true;
          enter();
          await opened;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return realReadFile(p, ...(rest as any));
      }) as typeof nodeFs.promises.readFile);
      return { entered, release, restore: () => spy.mockRestore() };
    }

    it('(5b-a) agents:deleted removes that agent\'s repo and its ledger row; the sibling agent and the owner\'s blobs are untouched, and the owner\'s usage falls by exactly what the workspace held', async () => {
      const t = await seedOwnerWithTwoAgents();
      const usedBefore = await usedBy(t.owner);
      const dirsBefore = await repoDirs();

      const fired = await agentDeleted(t.a.id, t.owner);
      expect(fired).toMatchObject({ rejected: false });

      // A's repo is gone from the disk, and A's row from the ledger.
      expect(await exists(t.a.dir)).toBe(false);
      expect(await ledgerRow(t.owner, `workspace:${t.a.id}`)).toBeUndefined();
      // Nothing else in the repo root went with it.
      expect(await repoDirs()).toEqual(
        dirsBefore.filter((name) => path.join(repoRoot, name) !== t.a.dir),
      );
      // B and the blob are exactly as they were.
      await expectSiblingsIntact(t);
      // The owner got back exactly A's workspace bytes: no more, no less.
      expect(await usedBy(t.owner)).toBe(usedBefore - t.a.row.bytes);
      expect(await usedBy(t.owner)).toBe(t.b.row.bytes + t.blobRow.bytes);
    });

    it('(5b-a2) the room is real: an owner too full to save a change can save it once another agent is deleted', async () => {
      const t = await seedOwnerWithTwoAgents();
      const asB = ctxFor(t.owner, t.b.id);
      const change = { 'docs/more.bin': randomBytes(200_000) };

      // Nearly full: B's next change does not fit, and the refusal is the
      // storage-full one (the code, not just the sentence).
      await seedNearlyFull(t.owner);
      const refused = await refusalOf(workspaceApply(asB, change, t.b.version));
      expect(refused.code).toBe('rejected');
      expect(refused.reasonCode).toBe('storage-full');

      // A's workspace goes away: the same change now fits.
      await agentDeleted(t.a.id, t.owner);
      const saved = await workspaceApply(asB, change, t.b.version);
      expect(await workspaceRead(asB, 'docs/more.bin')).toMatchObject({
        found: true,
        version: saved.version,
      });
    });

    it('(5b-b) a write for the deleted agent afterwards is refused with agent-deleted: no directory comes back and no ledger row appears', async () => {
      const t = await seedOwnerWithTwoAgents();
      const asA = ctxFor(t.owner, t.a.id);
      await agentDeleted(t.a.id, t.owner);
      expect(await exists(t.a.dir), 'the delete removed the repo').toBe(false);
      const dirsAfterDelete = await repoDirs();

      // The write a warm runner would still send: a first commit that would
      // succeed on a fresh repo.
      const fresh = await refusalOf(
        workspaceApply(asA, { 'late/report.bin': randomBytes(100_000) }, null),
      );
      expect(fresh.code).toBe('agent-deleted');
      // ...and one naming the parent it last knew.
      const stale = await refusalOf(
        workspaceApply(asA, { 'late/more.bin': randomBytes(100_000) }, t.a.version),
      );
      expect(stale.code).toBe('agent-deleted');
      // Reads and measurements are refused too, and none of them makes a repo.
      await expect(workspaceRead(asA, 'docs/a.bin')).rejects.toMatchObject({
        code: 'agent-deleted',
      });
      await expect(workspaceList(asA)).rejects.toMatchObject({ code: 'agent-deleted' });
      await expect(workspaceUsage(asA)).rejects.toMatchObject({ code: 'agent-deleted' });

      // Let any background measurement a write could have triggered land.
      await live().diskQuota.drain();
      expect(await exists(t.a.dir)).toBe(false);
      expect(await repoDirs()).toEqual(dirsAfterDelete);
      expect(await ledgerRow(t.owner, `workspace:${t.a.id}`)).toBeUndefined();

      // The sibling is unaffected and still takes writes.
      await expectSiblingsIntact(t);
      const asB = ctxFor(t.owner, t.b.id);
      await workspaceApply(asB, { 'docs/next.bin': randomBytes(50_000) }, t.b.version);
      await live().diskQuota.drain();
      expect((await requireRow(t.owner, `workspace:${t.b.id}`)).bytes).toBeGreaterThan(
        t.b.row.bytes,
      );
    });

    it('(5b-c) a write that holds the mutex when the delete arrives lands, and its late measurement cannot bring the ledger row back', async () => {
      const t = await seedOwnerWithTwoAgents();
      const asA = ctxFor(t.owner, t.a.id);

      // Two gates make the interleaving exact instead of a race:
      //   1. The repo mutex is held open, so the write is INSIDE it (and will
      //      succeed: it names the right parent) when the delete arrives.
      //   2. The write's `workspace:applied` notice is held shut, so
      //      disk-quota's re-measure of the write cannot start until the whole
      //      delete has finished. The measurement therefore lands strictly
      //      AFTER the delete: the order that would resurrect the row if
      //      workspace:usage answered 0 for a deleted agent.
      const mutexGate = holdRepoMutexOnFirstRead(t.a.dir);
      let openApplied!: () => void;
      let appliedReached!: () => void;
      const appliedEntered = new Promise<void>((resolve) => (appliedReached = resolve));
      appliedGate = {
        agentId: t.a.id,
        entered: appliedReached,
        opened: new Promise<void>((resolve) => (openApplied = resolve)),
      };
      // Started work the `finally` waits out, so a failure here cannot leave a
      // write or a delete still running into the next test.
      const inFlight: Array<Promise<unknown>> = [];
      try {
        const write = workspaceApply(asA, { 'docs/late.bin': randomBytes(100_000) }, t.a.version);
        const writeOutcome = write.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        inFlight.push(writeOutcome);
        await gateReached(
          mutexGate.entered,
          'this test needs workspace-git-core to read through fs.promises.readFile inside the per-agent mutex, ' +
            "so the write can be held there; the write never reached its first read under the agent's repo",
        );

        // The delete arrives while the write holds the mutex. It sets its
        // tombstone and queues behind the write; nothing is removed yet.
        const delivered = agentDeleted(t.a.id, t.owner);
        inFlight.push(delivered);
        await tick();
        expect(await exists(t.a.dir), 'the delete waits for the write holding the mutex').toBe(true);
        expect(await ledgerRow(t.owner, `workspace:${t.a.id}`)).toEqual(t.a.row);

        // Let the write finish. It commits, then parks at the applied gate.
        mutexGate.release();
        await gateReached(
          appliedEntered,
          "this test needs the released write to commit and fire workspace:applied, and its gate plugin to be booted before @ax/disk-quota's own workspace:applied subscriber; the write never reached the applied gate",
        );
        await delivered;

        // The delete is complete (repo removed, then row released), and the
        // write's measurement has not even started.
        expect(await exists(t.a.dir)).toBe(false);
        expect(await ledgerRow(t.owner, `workspace:${t.a.id}`)).toBeUndefined();

        // Now the notice reaches disk-quota and the late measurement runs.
        openApplied();
        const outcome = await writeOutcome;
        expect(outcome.ok, 'the in-flight write itself succeeded').toBe(true);
        await live().diskQuota.drain();

        // The measurement was refused, not answered with 0: no row came back
        // (the harm), and the reason is that measuring a deleted agent throws.
        expect(await ledgerRow(t.owner, `workspace:${t.a.id}`)).toBeUndefined();
        expect(await exists(t.a.dir)).toBe(false);
        await expect(workspaceUsage(asA)).rejects.toMatchObject({ code: 'agent-deleted' });
        await expectSiblingsIntact(t);
        expect(await usedBy(t.owner)).toBe(t.b.row.bytes + t.blobRow.bytes);
      } finally {
        // An assertion that failed while a gate was shut must not leave the
        // parked write hanging the rest of the file.
        mutexGate.release();
        openApplied();
        mutexGate.restore();
        appliedGate = null;
        await Promise.allSettled(inFlight);
      }
    });

    it('(5b-d) delivering the same agents:deleted again is a harmless no-op', async () => {
      const t = await seedOwnerWithTwoAgents();
      await agentDeleted(t.a.id, t.owner);
      // The first delivery really did the work, so there is something for the
      // second to be a no-op about.
      expect(await exists(t.a.dir)).toBe(false);
      expect(await ledgerRow(t.owner, `workspace:${t.a.id}`)).toBeUndefined();
      const usedAfterFirst = await usedBy(t.owner);
      const dirsAfterFirst = await repoDirs();

      await expect(agentDeleted(t.a.id, t.owner)).resolves.toMatchObject({ rejected: false });
      await live().diskQuota.drain();
      expect(await repoDirs()).toEqual(dirsAfterFirst);
      expect(await usedBy(t.owner)).toBe(usedAfterFirst);
      await expectSiblingsIntact(t);

      // An agent that never wrote a byte (no repo, no row) is just as quiet.
      await expect(agentDeleted(`dq-del-agt-never-wrote-${deleteSeq}`, t.owner)).resolves.toMatchObject({
        rejected: false,
      });
      expect(await repoDirs()).toEqual(dirsAfterFirst);
      expect(await usedBy(t.owner)).toBe(usedAfterFirst);
      await expectSiblingsIntact(t);
    });
  });

  // -------------------------------------------------------------------------
  // 6. PERSISTENCE and RUNTIME CHANGE (keep last: it restarts the kernel)
  // -------------------------------------------------------------------------

  it('(6) the ledger survives a restart, and raising the limit admits the owner again with no restart', async () => {
    const agentId = 'dq-agt-persist';
    agentOwners.set(agentId, { ownerId: USER_A, ownerType: 'user' });

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
    // postgres, repo root and blob root.
    await live().shutdown();
    kernel = null;
    kernel = await bootKernel();

    expect(await blobStat(bigPut.sha256)).toEqual({ size: big.length });
    const afterBlob = await refusalOf(blobPut(USER_A, three));
    expect(afterBlob.code).toBe('rejected');
    expect(afterBlob.message).toBe(blobFullMessage(big.length, MIN_LIMIT_BYTES));
    // The same ledger gates the workspace side too.
    const afterWorkspace = await refusalOf(
      workspaceApply(ctxFor(USER_A, agentId), { 'big.bin': three }, null),
    );
    expect(afterWorkspace.code).toBe('rejected');
    expect(afterWorkspace.message).toBe(workspaceFullMessage(big.length, MIN_LIMIT_BYTES));

    // An admin raises the limit (a partial setting: only limitMb). No restart:
    // the next write, on this very kernel, is admitted.
    await setLimits({ limitMb: 4096 });
    const admitted = await blobPut(USER_A, three);
    expect(await ledgerRow(USER_A, `blob:${admitted.sha256}`)).toMatchObject({
      kind: 'blob',
      bytes: three.length,
    });
    await workspaceApply(ctxFor(USER_A, agentId), { 'big.bin': three }, null);
    await live().diskQuota.drain();
    expect(await ledgerRow(USER_A, `workspace:${agentId}`)).toMatchObject({
      kind: 'workspace',
    });
  });
});
