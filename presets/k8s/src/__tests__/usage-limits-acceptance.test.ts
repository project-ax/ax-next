import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

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
  type AgentOutcome,
  type Plugin,
} from '@ax/core';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createSandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createMcpClientPlugin } from '@ax/mcp-client';
import { createUsageLimitsPlugin } from '@ax/usage-limits';
import {
  encodeScript,
  startTestContainer,
  stopPostgresContainer,
  stubRunnerPath,
  TEST_PROXY_AUTH_TOKEN,
  type StubRunnerScript,
} from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-692 — per-user spend + rate limits canary (Invariant 3: no half-wired
// plugins).
//
// @ax/usage-limits is two halves that only mean something together:
//
//   GATE  — `chat:start` veto, fired by agent:invoke before a sandbox spawns.
//   METER — the runner's assistant `event.turn-end` carries `usage`; @ax/ipc-core
//           fires it as `chat:turn-end`; the plugin charges it to the user.
//
// Its package tests prove each half against a real postgres in isolation. This
// canary proves the LOOP through the real chat path: a stub runner process
// POSTs `event.turn-end` over the real IPC listener, the real orchestrator
// fires the real hooks, and the real plugin writes and reads real rows in a
// postgres testcontainer — then refuses the next turn before any sandbox
// exists. It also proves the counter is DB-backed: a brand-new kernel on the
// same database still refuses the over-cap user.
//
// Assembly follows acceptance.test.ts: take createK8sPlugins(...) (so preset
// drift breaks this file), drop what needs real k8s/http/auth, splice in the
// subprocess sandbox + unix-socket IPC. Differences from its drop list:
//
//   * @ax/database-postgres and @ax/storage-postgres are KEPT, pointed at the
//     container — the production pool the plugin borrows through
//     `database:get-instance`, and the production store the limits setting
//     (`settings:usage-limits`) lives in.
//   * @ax/usage-limits is taken OUT of the preset list and re-added from the
//     same factory with an injected clock. The manifest is asserted equal to
//     the preset's, so this is the preset's plugin, not a look-alike; the
//     clock only lets a test step past the 15 s limits-cache TTL instead of
//     sleeping through it.
//   * http:register-route / auth:require-user are tiny stubs: the plugin
//     hard-calls both for its /admin/usage* routes, and http-server +
//     auth-better are out of scope here (the route handlers have their own
//     suite in @ax/usage-limits).
// ---------------------------------------------------------------------------

const USAGE_PLUGIN = '@ax/usage-limits';

const PLUGINS_TO_DROP = new Set<string>([
  // Postgres pair we DON'T need: the in-memory session store stands in for
  // session-postgres, and nothing here uses the cross-replica eventbus.
  '@ax/eventbus-postgres',
  '@ax/session-postgres',
  // K8s sandbox — replaced by sandbox-subprocess.
  '@ax/sandbox-k8s',
  // Real credential-proxy — replaced by the scripted proxy below.
  '@ax/credential-proxy',
  // HTTP control plane — stubbed below where the plugin under test needs it.
  '@ax/http-server',
  '@ax/auth-better',
  '@ax/teams',
  '@ax/static-files',
  '@ax/channel-web',
  // Not on this canary's path; each also needs http/auth or a dropped peer.
  // Same reasons as acceptance.test.ts' PLUGINS_TO_DROP.
  '@ax/conversations',
  '@ax/connectors',
  '@ax/mcp-oauth',
  '@ax/agents',
  '@ax/workspace-git',
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
  '@ax/conversation-titles',
  '@ax/memory-facts-postgres',
  '@ax/preset-k8s/retire-strata-index',
  // Re-added below with an injected clock (manifest asserted identical).
  USAGE_PLUGIN,
  // Per-owner storage limit (TASK-690): not on this canary's path (it gates
  // writes, not turns); its own canary is disk-quota-acceptance.test.ts.
  '@ax/disk-quota',
  // Blob GC, report mode (TASK-777): not on this canary's path; its own canary
  // is blob-gc-report-acceptance.test.ts.
  '@ax/blob-gc',
]);

const AGENT_ID = 'usage-canary-agent';
const USER_A = 'usage-user-a';
const USER_B = 'usage-user-b';
const USER_D = 'usage-user-d';
const USER_E = 'usage-user-e';

const SONNET_USAGE = {
  model: 'anthropic/claude-sonnet-4-6',
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
/** Sonnet: $3/M input + $15/M output -> 3*1000 + 15*500 micro-USD. */
const SONNET_COST_MICROS = 3 * 1000 + 15 * 500;
/** The default `assumedTurnCostUsd` ($0.25) in micro-USD. */
const ASSUMED_COST_MICROS = 250_000;

const DEFAULT_LIMITS = { dailySpendUsd: 5, turnsPerHour: 60, assumedTurnCostUsd: 0.25 };
/** The plugin caches limits for 15 s; step the injected clock past it. */
const PAST_LIMITS_TTL_MS = 16_000;

const meteredScript = (): StubRunnerScript => ({
  entries: [
    { kind: 'assistant-text', content: 'metered' },
    { kind: 'turn-end', usage: SONNET_USAGE },
    { kind: 'finish', reason: 'end_turn' },
  ],
});

const unreportedScript = (): StubRunnerScript => ({
  entries: [
    { kind: 'assistant-text', content: 'unreported' },
    { kind: 'turn-end' },
    { kind: 'finish', reason: 'end_turn' },
  ],
});

// ---------------------------------------------------------------------------
// Test-only plugins
// ---------------------------------------------------------------------------

function createPermissiveAgentsStubPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/usage-permissive-agents-stub';
  return {
    manifest: { name, version: '0.0.0', registers: ['agents:resolve'], calls: [], subscribes: [] },
    init({ bus }) {
      bus.registerService('agents:resolve', name, async (_ctx: AgentContext, input) => {
        const i = input as { agentId?: string; userId?: string };
        return {
          agent: {
            id: i.agentId ?? AGENT_ID,
            ownerId: i.userId ?? 'unknown',
            ownerType: 'user' as const,
            visibility: 'personal' as const,
            displayName: 'Usage limits canary agent',
            systemPrompt: 'You are a helpful assistant.',
            allowedTools: [] as string[],
            mcpConfigIds: [] as string[],
            runner: 'claude-sdk',
            model: 'anthropic/claude-sonnet-4-6',
            workspaceRef: null,
            allowedHosts: [] as string[],
            requiredCredentials: {} as Record<string, { ref: string; kind: string }>,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        };
      });
    },
  };
}

/**
 * Stand-ins for the http control plane @ax/usage-limits hard-calls at init to
 * mount /admin/usage*. Registration succeeds and is recorded; nothing ever
 * serves a request (the route handlers have their own suite).
 */
function createControlPlaneStubPlugin(mountedPaths: string[]): Plugin {
  const name = '@ax/preset-k8s/test/usage-control-plane-stub';
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
        mountedPaths.push(`${route.method} ${route.path}`);
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

function createDispatcherDepsStubPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/usage-dispatcher-deps-stub';
  return {
    manifest: { name, version: '0.0.0', registers: ['workspace:read'], calls: [], subscribes: [] },
    init({ bus }) {
      bus.registerService('workspace:read', name, async () => ({ found: false }));
    },
  };
}

// Same never-validated PEM shape the harness's test-proxy uses.
const DUMMY_CA_PEM =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBkTCB+wIJAJtest-only-never-validated\n' +
  '-----END CERTIFICATE-----\n';

/**
 * proxy:open-session stand-in whose stub-runner script is chosen per turn
 * (createTestProxyPlugin encodes one script at init). Reads `state.script` at
 * open time.
 */
function createScriptedProxyPlugin(state: { script: StubRunnerScript }): Plugin {
  const name = '@ax/preset-k8s/test/usage-scripted-proxy';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['proxy:open-session', 'proxy:close-session'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('proxy:open-session', name, async () => ({
        proxyEndpoint: 'tcp://127.0.0.1:1',
        caCertPem: DUMMY_CA_PEM,
        envMap: { AX_TEST_STUB_SCRIPT: encodeScript(state.script) },
        proxyAuthToken: TEST_PROXY_AUTH_TOKEN,
      }));
      bus.registerService('proxy:close-session', name, async () => ({}));
    },
  };
}

/**
 * The real subprocess sandbox, with `sandbox:open-session` counted. A refused
 * turn must be refused BEFORE a sandbox exists, and this counter is how the
 * canary sees that (not log text).
 */
function countingSandboxPlugin(counter: { spawns: number }): Plugin {
  const inner = createSandboxSubprocessPlugin();
  return {
    manifest: inner.manifest,
    init(initCtx) {
      const bus = initCtx.bus;
      const counted = new Proxy(bus, {
        get(target, prop) {
          if (prop === 'registerService') {
            return (hook: string, plugin: string, handler: (...a: unknown[]) => unknown, ...rest: unknown[]) => {
              const wrapped =
                hook === 'sandbox:open-session'
                  ? async (...args: unknown[]) => {
                      counter.spawns += 1;
                      return handler(...args);
                    }
                  : handler;
              return (target.registerService as (...a: unknown[]) => unknown)(hook, plugin, wrapped, ...rest);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      return inner.init({ ...initCtx, bus: counted });
    },
    ...(inner.shutdown !== undefined ? { shutdown: () => inner.shutdown!() } : {}),
  };
}

// ---------------------------------------------------------------------------

interface Kernel {
  bus: HookBus;
  shutdown(): Promise<void>;
  sandbox: { spawns: number };
  mountedPaths: string[];
}

interface UsageRow {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
}

describe('@ax/preset-k8s usage limits canary (stub runner + postgres)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let connectionString = '';
  let tmp = '';
  let originalCredKey: string | undefined;
  let kernel: Kernel | null = null;
  const proxyState: { script: StubRunnerScript } = { script: meteredScript() };
  // Injected clock for @ax/usage-limits: real time plus a skew the tests
  // advance to step past the limits cache.
  let clockSkewMs = 0;
  const clock = (): Date => new Date(Date.now() + clockSkewMs);
  let sessionSeq = 0;

  function presetConfig(): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      workspace: { backend: 'local', repoRoot: path.join(tmp, 'repo-stub') },
      blob: { backend: 'fs', root: path.join(tmp, 'blobs') },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: { 'claude-sdk': stubRunnerPath }, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
    };
  }

  async function bootKernel(): Promise<Kernel> {
    const presetPlugins = createK8sPlugins(presetConfig());
    const presetUsage = presetPlugins.find((p) => p.manifest.name === USAGE_PLUGIN);
    // The production preset registers the plugin (the half this canary
    // exists to keep honest)...
    expect(presetUsage, 'createK8sPlugins must load @ax/usage-limits').toBeDefined();
    const usage = createUsageLimitsPlugin({ now: clock });
    // ...and the instance booted here is the same plugin, not a look-alike.
    expect(usage.manifest).toEqual(presetUsage!.manifest);

    const kept = presetPlugins.filter((p) => !PLUGINS_TO_DROP.has(p.manifest.name));
    // The two postgres plugins this canary relies on are the preset's own.
    const keptNames = kept.map((p) => p.manifest.name);
    expect(keptNames).toContain('@ax/database-postgres');
    expect(keptNames).toContain('@ax/storage-postgres');

    const sandbox = { spawns: 0 };
    const mountedPaths: string[] = [];
    const plugins: Plugin[] = [
      ...kept,
      usage,
      createSessionInmemoryPlugin(),
      countingSandboxPlugin(sandbox),
      createIpcServerPlugin(),
      createDispatcherDepsStubPlugin(),
      createScriptedProxyPlugin(proxyState),
      createPermissiveAgentsStubPlugin(),
      createControlPlaneStubPlugin(mountedPaths),
      createMcpClientPlugin(),
    ];
    const bus = new HookBus();
    const handle = await bootstrap({ bus, plugins, config: {} });
    return { bus, shutdown: () => handle.shutdown(), sandbox, mountedPaths };
  }

  function live(): Kernel {
    if (kernel === null) throw new Error('kernel not booted');
    return kernel;
  }

  async function db(): Promise<Kysely<unknown>> {
    const { db: handle } = await live().bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      makeAgentContext({ sessionId: 'canary', agentId: 'canary', userId: 'system' }),
      {},
    );
    return handle;
  }

  async function usageFor(userId: string): Promise<UsageRow> {
    const res = await sql<{
      turns: string | null;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_write_tokens: string | null;
      cost_micros: string | null;
    }>`
      SELECT SUM(turns) AS turns, SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_write_tokens) AS cache_write_tokens,
             SUM(cost_micros) AS cost_micros
      FROM usage_limits_v1_buckets WHERE user_id = ${userId}
    `.execute(await db());
    const r = res.rows[0];
    const n = (v: string | null | undefined): number => (v == null ? 0 : Number(v));
    return {
      turns: n(r?.turns),
      inputTokens: n(r?.input_tokens),
      outputTokens: n(r?.output_tokens),
      cacheReadTokens: n(r?.cache_read_tokens),
      cacheWriteTokens: n(r?.cache_write_tokens),
      costMicros: n(r?.cost_micros),
    };
  }

  /** `chat:turn-end` is broadcast after the runner's ack, so the meter's write
   *  can land just after agent:invoke returns. Wait for it. */
  async function waitForCost(userId: string, costMicros: number): Promise<UsageRow> {
    await vi.waitFor(
      async () => expect((await usageFor(userId)).costMicros).toBe(costMicros),
      { timeout: 10_000, interval: 50 },
    );
    return usageFor(userId);
  }

  /** Write the limits the way an admin change lands (the storage key), then
   *  step the plugin's clock past its cache so the next admit reads it. */
  async function setLimits(limits: typeof DEFAULT_LIMITS & { fleetDailySpendUsd?: number }): Promise<void> {
    await live().bus.call(
      'storage:set',
      makeAgentContext({ sessionId: 'canary', agentId: 'canary', userId: 'system' }),
      {
        key: 'settings:usage-limits',
        value: new TextEncoder().encode(JSON.stringify(limits)),
      },
    );
    clockSkewMs += PAST_LIMITS_TTL_MS;
  }

  async function runTurn(userId: string, script: StubRunnerScript): Promise<AgentOutcome> {
    proxyState.script = script;
    sessionSeq += 1;
    const ctx = makeAgentContext({
      sessionId: `usage-canary-${userId}-${sessionSeq}`,
      agentId: AGENT_ID,
      userId,
      workspace: { rootPath: tmp },
    });
    return live().bus.call<unknown, AgentOutcome>('agent:invoke', ctx, {
      message: { role: 'user', content: `turn ${sessionSeq} from ${userId}` },
    });
  }

  async function expectRefused(userId: string, reason: string): Promise<void> {
    const spawnsBefore = live().sandbox.spawns;
    const outcome = await runTurn(userId, meteredScript());
    expect(outcome).toEqual({ kind: 'terminated', reason });
    // Refused at the door: no sandbox, so no runner and no tokens.
    expect(live().sandbox.spawns).toBe(spawnsBefore);
  }

  async function expectAdmitted(userId: string, script: StubRunnerScript): Promise<void> {
    const spawnsBefore = live().sandbox.spawns;
    const outcome = await runTurn(userId, script);
    expect(outcome.kind, JSON.stringify(outcome)).toBe('complete');
    expect(live().sandbox.spawns).toBe(spawnsBefore + 1);
  }

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-usage-canary-')));
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    // @ax/credentials (kept from the preset) throws at init without it.
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
    pgContainer = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = pgContainer.getConnectionUri();
    kernel = await bootKernel();
  });

  beforeEach(async () => {
    await sql`TRUNCATE usage_limits_v1_buckets, usage_limits_v1_suspensions, usage_limits_v1_user_limits, usage_limits_v1_turns`.execute(await db());
    await setLimits(DEFAULT_LIMITS);
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

  it('boots with the admin routes mounted through http:register-route', () => {
    expect(live().mountedPaths).toEqual([
      'GET /api/usage',
      'PUT /admin/usage/users/:userId/limits',
      'DELETE /admin/usage/users/:userId/limits',
      'PUT /admin/usage/prices',
      'GET /admin/usage',
      'PUT /admin/usage/limits',
      'PUT /admin/usage/users/:userId/suspension',
      'DELETE /admin/usage/users/:userId/suspension',
    ]);
  });

  it('(a) meters a real turn: runner turn-end usage -> IPC -> chat:turn-end -> bucket row', async () => {
    await expectAdmitted(USER_A, meteredScript());
    const row = await waitForCost(USER_A, SONNET_COST_MICROS);
    expect(row).toEqual({
      turns: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 10_500,
    });
  });

  it('(b) refuses an over-cap user with chat:start:usage-limit-daily, before any sandbox', async () => {
    await expectAdmitted(USER_A, meteredScript());
    await waitForCost(USER_A, SONNET_COST_MICROS);

    // $0.01 cap; A has spent $0.0105.
    await setLimits({ dailySpendUsd: 0.01, turnsPerHour: 60, assumedTurnCostUsd: 0.25 });
    await expectRefused(USER_A, 'chat:start:usage-limit-daily');
    // The refused turn was not counted and cost nothing.
    expect(await usageFor(USER_A)).toMatchObject({ turns: 1, costMicros: SONNET_COST_MICROS });
  });

  it('(c) another user on the same host is unaffected by an over-cap user', async () => {
    await expectAdmitted(USER_A, meteredScript());
    await waitForCost(USER_A, SONNET_COST_MICROS);
    await setLimits({ dailySpendUsd: 0.01, turnsPerHour: 60, assumedTurnCostUsd: 0.25 });
    await expectRefused(USER_A, 'chat:start:usage-limit-daily');

    await expectAdmitted(USER_B, meteredScript());
    const b = await waitForCost(USER_B, SONNET_COST_MICROS);
    expect(b.turns).toBe(1);
    // And A's row was not touched by B's turn.
    expect(await usageFor(USER_A)).toMatchObject({ turns: 1, costMicros: SONNET_COST_MICROS });
  });

  it('(d) a turn whose runner reports no usage is charged the flat assumed cost', async () => {
    await expectAdmitted(USER_D, unreportedScript());
    const row = await waitForCost(USER_D, ASSUMED_COST_MICROS);
    expect(row).toEqual({
      turns: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 250_000,
    });
  });

  it('(e) a suspended user is refused with chat:start:usage-suspended, and admitted again once lifted', async () => {
    const handle = await db();
    await sql`
      INSERT INTO usage_limits_v1_suspensions (user_id, suspended_at, suspended_by, note)
      VALUES (${USER_E}, now(), 'usage-canary-admin', 'canary')
    `.execute(handle);
    await expectRefused(USER_E, 'chat:start:usage-suspended');
    expect((await usageFor(USER_E)).turns).toBe(0);

    await sql`DELETE FROM usage_limits_v1_suspensions WHERE user_id = ${USER_E}`.execute(handle);
    await expectAdmitted(USER_E, meteredScript());
    await waitForCost(USER_E, SONNET_COST_MICROS);
  });

  it('charges a real runner that exits without turn-end usage', async () => {
    const outcome = await runTurn(USER_D, {entries:[{kind:'assistant-text',content:'interrupted'}]});
    expect(outcome.kind).toBe('terminated');
    expect(await waitForCost(USER_D, ASSUMED_COST_MICROS)).toMatchObject({turns:1,costMicros:ASSUMED_COST_MICROS});
  });

  it('stops a different person through the real chat path when workspace spend reaches its cap', async () => {
    await setLimits({ ...DEFAULT_LIMITS, fleetDailySpendUsd: 0.01 });
    await expectAdmitted(USER_A, meteredScript());
    await waitForCost(USER_A, SONNET_COST_MICROS);
    await expectRefused(USER_B, 'chat:start:usage-limit-fleet');
    expect((await usageFor(USER_B)).turns).toBe(0);
    const ctx = makeAgentContext({sessionId:'canary',agentId:AGENT_ID,userId:USER_B});
    expect(await live().bus.call('usage:check',ctx,{})).toEqual({blocked:true,reason:'usage-limit-fleet'});
    expect(await live().bus.call('usage:provider-status',ctx,{})).toEqual({blocked:true,reason:'usage-limit-fleet'});
  });

  it('(f) the counter survives a restart: a brand-new kernel on the same database still refuses', async () => {
    await expectAdmitted(USER_A, meteredScript());
    await waitForCost(USER_A, SONNET_COST_MICROS);
    await setLimits({ dailySpendUsd: 0.01, turnsPerHour: 60, assumedTurnCostUsd: 0.25 });
    await expectRefused(USER_A, 'chat:start:usage-limit-daily');

    // Tear the whole host down: every plugin's shutdown, the pg pool closed,
    // nothing held in memory survives.
    await live().shutdown();
    kernel = null;

    // A brand-new set of plugins (fresh usage-limits instance, fresh limits
    // cache) on the SAME postgres.
    kernel = await bootKernel();
    await expectRefused(USER_A, 'chat:start:usage-limit-daily');
    // The new host still admits and meters someone else.
    await expectAdmitted(USER_B, meteredScript());
    await waitForCost(USER_B, SONNET_COST_MICROS);
  });
});
