import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { sql, type Kysely } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  HookBus,
  bootstrap,
  makeChatContext,
  type KernelHandle,
  type Plugin,
} from '@ax/core';
import type {
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { llmMockPlugin } from '@ax/llm-mock';
import {
  createSandboxK8sPlugin,
  type K8sCoreApi,
} from '@ax/sandbox-k8s';
import type {
  EventbusEmitInput,
  EventbusSubscribeInput,
  EventbusSubscription,
} from '@ax/eventbus-postgres';
import type {
  SessionCreateInput,
  SessionCreateOutput,
  SessionResolveTokenInput,
  SessionResolveTokenOutput,
} from '@ax/session-postgres';
import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// CI acceptance test for @ax/preset-k8s.
//
// What this proves:
//   - `createK8sPlugins(cfg)` returns a coherent plugin list that bootstraps
//     against a real postgres + a real on-disk git repo.
//   - The five backend-bearing hooks every replica of a multi-tenant
//     deployment depends on (storage / eventbus / session / workspace) all
//     round-trip through the bus with the postgres + git backends wired
//     in by the preset.
//   - Invariant 1 (transport/storage-agnostic hooks): the same hook
//     signatures the local preset exercises against sqlite + git work
//     identically against postgres + git here. If a hook payload carried
//     backend-specific vocabulary, this test wouldn't be writable without
//     reaching into backend internals — and it doesn't.
//
// What this does NOT prove:
//   - Real k8s pod scheduling. The `@ax/sandbox-k8s` plugin is loaded
//     with a no-op K8sCoreApi stub so its init succeeds, but we never
//     call `sandbox:open-session`. End-to-end pod-spawn coverage lives
//     in `deploy/MANUAL-ACCEPTANCE.md` (Task 21) — that's where a human
//     points the same preset at a real cluster + Anthropic key and runs
//     a chat. This file is the laptop-runnable companion.
//   - Real Anthropic LLM behavior. We swap `@ax/llm-anthropic` for
//     `@ax/llm-mock` so CI doesn't need an API key, and we never invoke
//     `chat:run` (which would require a runner binary connecting back over
//     IPC). The acceptance test exercises wiring, not chat orchestration.
//
// Runtime: ~25-40s. Almost all of that is the testcontainer cold-start +
// postgres image pull on the first run; subsequent runs reuse the layer
// cache and finish in ~10-15s. If this looks slow, it's not broken — it's
// real network and a real database.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
let bus: HookBus;
let workspaceRoot: string;
let kysely: Kysely<unknown>;
let kernelHandle: KernelHandle;

// Minimal K8sCoreApi stub. Every method throws if called — and that's the
// point. The acceptance test never calls `sandbox:open-session`, so the
// stub being unusable for real pod work is the assertion that this test
// isn't accidentally reaching into k8s code paths.
function makeNoopK8sApi(): K8sCoreApi {
  const reject = async (): Promise<never> => {
    throw new Error(
      'no-op K8sCoreApi: sandbox:open-session must not be called from the acceptance test',
    );
  };
  return {
    createNamespacedPod: reject,
    readNamespacedPod: reject,
    deleteNamespacedPod: reject,
    listNamespacedPod: reject,
  };
}

beforeAll(async () => {
  // 32-byte hex key for the credentials plugin. Constant value is fine
  // because the testcontainer postgres lives only for this run.
  process.env.AX_CREDENTIALS_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();

  workspaceRoot = mkdtempSync(join(tmpdir(), 'ax-preset-k8s-acceptance-'));

  const presetConfig: K8sPresetConfig = {
    database: { connectionString },
    eventbus: { connectionString },
    session: { connectionString },
    workspace: { backend: 'local', repoRoot: workspaceRoot },
    sandbox: { namespace: 'ax-acceptance' },
    // Use port 0 so the @ax/ipc-http listener binds to a free OS-assigned
    // port — the acceptance test never invokes the listener, but the
    // plugin's init() does call .listen(). Loopback bind keeps any
    // accidental bind from being externally reachable.
    ipc: {
      host: '127.0.0.1',
      port: 0,
      hostIpcUrl: 'http://test-host.test.svc.cluster.local:80',
    },
    anthropic: { model: 'claude-sonnet-4-6' },
    // Pin the runner binary to a stub path. The chat-orchestrator validates
    // it only when `sandbox:open-session` is invoked — which the acceptance
    // test never does.
    chat: { runnerBinary: '/tmp/stub-runner.js' },
  };

  // Build the production plugin set, then patch two slots:
  //   1. Drop @ax/llm-anthropic (no API key in CI) and substitute @ax/llm-mock.
  //      llm-mock registers the same `llm:call` service hook — this is the
  //      one swap that proves the preset's `llm:call` slot is replaceable
  //      (Invariant 4: one source of truth, but the source can vary).
  //   2. Replace @ax/sandbox-k8s with one that uses a no-op K8sCoreApi
  //      stub instead of touching kubeconfig. Same plugin name, same hooks,
  //      just an api override — the manifest is unchanged so the preset's
  //      coherence checks still pass.
  const built = createK8sPlugins(presetConfig);
  const plugins: Plugin[] = built.map((p) => {
    if (p.manifest.name === '@ax/sandbox-k8s') {
      // Recreate sandbox-k8s with the stub api. resolveConfig is fine with
      // the same defaults the preset would have produced — namespace is the
      // only field we care about for the manifest scan. hostIpcUrl is
      // required by the resolved-config validator, so we pass the same
      // stub URL the preset config holds.
      return createSandboxK8sPlugin({
        namespace: 'ax-acceptance',
        hostIpcUrl: 'http://test-host.test.svc.cluster.local:80',
        api: makeNoopK8sApi(),
      });
    }
    return p;
  });
  // llm-anthropic has the only `init()` in the preset that throws without
  // ANTHROPIC_API_KEY — strip it and add llm-mock in its place.
  const filtered = plugins.filter(
    (p) => p.manifest.name !== '@ax/llm-anthropic',
  );
  filtered.push(llmMockPlugin());

  bus = new HookBus();
  // The kernel handle drives all per-plugin shutdowns in reverse-topological
  // order on `kernelHandle.shutdown()` — pg pools, LISTEN clients, and the
  // ipc-http listener all close cleanly before the testcontainer stops.
  kernelHandle = await bootstrap({ bus, plugins: filtered, config: {} });

  // Capture the singleton kysely so afterAll can drain its pool before the
  // container goes away.
  const initCtx = makeChatContext({
    sessionId: 'acceptance-init',
    agentId: 'acceptance',
    userId: 'acceptance',
  });
  const { db } = await bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    initCtx,
    {},
  );
  kysely = db;
}, 120_000);

afterAll(async () => {
  // Drain plugins via the kernel handle BEFORE stopping the container,
  // otherwise the abrupt server shutdown surfaces as unhandled
  // `terminating connection due to administrator command` from pg-protocol.
  // The handle's reverse-topological order closes ipc-http's listener,
  // session-postgres's LISTEN client, and the postgres pools in the right
  // sequence — same teardown the production SIGTERM path runs.
  await kernelHandle?.shutdown();
  await kysely?.destroy().catch(() => {});
  if (container) await container.stop();
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}, 60_000);

// Wait until `predicate()` is true (or fail at timeout). LISTEN/NOTIFY
// delivery is async, so polling with a short ceiling is the canonical
// shape for these tests.
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitFor: predicate never became true within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function ctx(suffix: string) {
  return makeChatContext({
    sessionId: `acceptance-${suffix}`,
    agentId: 'acceptance',
    userId: 'acceptance',
  });
}

describe('@ax/preset-k8s acceptance (postgres + workspace-git end-to-end)', () => {
  it('createK8sPlugins produces a non-empty plugin array and bootstraps successfully', async () => {
    // The beforeAll bootstrap is the test — if any plugin's init failed,
    // we'd never reach this it() body. We still assert a few invariants
    // about the assembled bus to catch silent regressions.
    expect(bus.hasService('storage:set')).toBe(true);
    expect(bus.hasService('storage:get')).toBe(true);
    expect(bus.hasService('eventbus:emit')).toBe(true);
    expect(bus.hasService('eventbus:subscribe')).toBe(true);
    expect(bus.hasService('session:create')).toBe(true);
    expect(bus.hasService('session:resolve-token')).toBe(true);
    expect(bus.hasService('workspace:apply')).toBe(true);
    expect(bus.hasService('workspace:read')).toBe(true);
    // Sanity-check: postgres is actually reachable through the kysely
    // singleton the database-postgres plugin minted.
    const r = await sql<{ one: number }>`SELECT 1::int as one`.execute(kysely);
    expect(r.rows[0]?.one).toBe(1);
  });

  it('storage:set then storage:get round-trips bytes against the postgres backend', async () => {
    const c = ctx('storage');
    const value = new TextEncoder().encode('hello postgres acceptance');
    await bus.call('storage:set', c, { key: 'k-storage', value });
    const got = await bus.call<
      { key: string },
      { value: Uint8Array | undefined }
    >('storage:get', c, { key: 'k-storage' });
    expect(got.value).toBeDefined();
    expect(new TextDecoder().decode(got.value!)).toBe(
      'hello postgres acceptance',
    );
  });

  it('eventbus:subscribe + eventbus:emit deliver a payload via LISTEN/NOTIFY', async () => {
    const c = ctx('eventbus');
    const seen: unknown[] = [];
    await bus.call<EventbusSubscribeInput, EventbusSubscription>(
      'eventbus:subscribe',
      c,
      {
        channel: 'acceptance_demo',
        handler: async (p) => {
          seen.push(p);
        },
      },
    );
    await bus.call<EventbusEmitInput, void>('eventbus:emit', c, {
      channel: 'acceptance_demo',
      payload: { from: 'acceptance', n: 42 },
    });
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual([{ from: 'acceptance', n: 42 }]);
  });

  it('session:create mints a token; session:resolve-token returns the matching sessionId', async () => {
    const c = ctx('session');
    const created = await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      c,
      { sessionId: 'acceptance-session-1', workspaceRoot: '/tmp/ws-stub' },
    );
    expect(created.sessionId).toBe('acceptance-session-1');
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const resolved = await bus.call<
      SessionResolveTokenInput,
      SessionResolveTokenOutput
    >('session:resolve-token', c, { token: created.token });
    expect(resolved).toEqual({
      sessionId: 'acceptance-session-1',
      workspaceRoot: '/tmp/ws-stub',
    });
  });

  it('workspace:apply writes a snapshot; workspace:read returns the bytes', async () => {
    const c = ctx('workspace');
    const enc = new TextEncoder();
    const applied = await bus.call<
      WorkspaceApplyInput,
      WorkspaceApplyOutput
    >('workspace:apply', c, {
      changes: [
        { path: 'hello.txt', kind: 'put', content: enc.encode('hello git') },
      ],
      parent: null,
    });
    expect(applied.version).toBeTruthy();
    expect(applied.delta.before).toBeNull();
    expect(applied.delta.changes).toHaveLength(1);
    expect(applied.delta.changes[0]).toMatchObject({
      path: 'hello.txt',
      kind: 'added',
    });

    const read = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      c,
      { path: 'hello.txt' },
    );
    expect(read.found).toBe(true);
    if (read.found) {
      expect(new TextDecoder().decode(read.bytes)).toBe('hello git');
    }
  });
});
