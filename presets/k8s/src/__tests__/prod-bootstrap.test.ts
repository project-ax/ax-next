import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { HookBus, bootstrap, type Plugin } from '@ax/core';
import { createSandboxK8sPlugin, type K8sCoreApi } from '@ax/sandbox-k8s';

import {
  createK8sPlugins,
  loadK8sConfigFromEnv,
  type K8sPresetConfig,
} from '../index.js';

// ---------------------------------------------------------------------------
// ARCH-8 — CI-grade production bootstrap lane.
//
// The existing acceptance.test.ts canary imports createK8sPlugins but DROPS
// the entire production backend (postgres trio, real k8s sandbox, http/auth,
// channel-web, conversations, agents, workspace-git, ipc-http, skills,
// attachments, ...) and substitutes CLI-equivalent in-memory/subprocess
// flavors. That verifies chat-path manifest drift, but it NEVER boots the
// production assembly: every prod plugin's init() running together, the real
// DB migrations co-existing on one database, the real http-server answering,
// the kernel topo-sorting the full manifest set.
//
// This lane closes that gap. It boots createK8sPlugins(config) with the
// PRODUCTION plugins KEPT against a real Postgres testcontainer, swapping ONLY
// the k8s-cluster seam: the real @ax/sandbox-k8s plugin is re-added with a
// fake 4-method K8sCoreApi (the "fake-k8s" the card names) so its init()
// registers sandbox:open-session without loading kubeconfig or touching a
// cluster.
//
// It deliberately does NOT drive a chat through the pod: sandbox-k8s'
// open-session waits for a runner POD to connect back over IPC, and no runner
// pod exists in CI. That real-chat-through-the-pod path stays the gated (walk)
// k8s-e2e suite (AX_K8S_E2E, vitest.config.k8s-e2e.ts). Here we assert BOOT +
// a real HTTP surface answering + env-loader parity — the production assembly
// itself, which the old canary could not.
// ---------------------------------------------------------------------------

/**
 * Minimal in-process fake of the narrow K8sCoreApi facade (4 methods).
 * createSandboxK8sPlugin({ api }) takes this so init() never loads kubeconfig
 * or touches a cluster. Mirrors the shape of
 * packages/sandbox-k8s/src/__tests__/mock-k8s.ts (which preset-k8s can't
 * import — it's a test-only module of another package, not exported). The pod
 * always reads back Running with an IP so any future readiness poll would
 * resolve; nothing in this lane drives open-session, so these responses are
 * inert — they exist only to keep the seam total.
 */
function makeFakeK8sApi(): K8sCoreApi {
  return {
    async createNamespacedPod() {
      return { metadata: { name: 'fake-runner' } };
    },
    async readNamespacedPod() {
      return {
        metadata: { name: 'fake-runner' },
        status: {
          phase: 'Running',
          podIP: '10.0.0.2',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      };
    },
    async deleteNamespacedPod() {
      return { status: 'Success' };
    },
    async listNamespacedPod() {
      return { items: [] };
    },
  };
}

/**
 * Build the production plugin list via createK8sPlugins, then swap the real
 * @ax/sandbox-k8s (which would load kubeconfig at init) for the SAME plugin
 * with a fake K8sCoreApi. Everything else is the real production plugin.
 */
function buildProdAssemblyWithFakeK8s(config: K8sPresetConfig): Plugin[] {
  const prod = createK8sPlugins(config);
  const withoutSandbox = prod.filter(
    (p) => p.manifest.name !== '@ax/sandbox-k8s',
  );
  // Re-add the REAL sandbox plugin with a fake cluster API. We pass the same
  // sandbox config fields the preset would (namespace/image don't matter for
  // the fake; runtimeClassName '' silences the gVisor warn path, matching the
  // kind-dev posture).
  const fakeSandbox = createSandboxK8sPlugin({
    api: makeFakeK8sApi(),
    hostIpcUrl: config.ipc.hostIpcUrl,
    runtimeClassName: '',
    ...(config.sandbox?.namespace !== undefined
      ? { namespace: config.sandbox.namespace }
      : {}),
    ...(config.sandbox?.image !== undefined
      ? { image: config.sandbox.image }
      : {}),
  });
  return [...withoutSandbox, fakeSandbox];
}

describe('@ax/preset-k8s production bootstrap (testcontainer + fake-k8s)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let tmp: string;
  // Env the prod plugins read at init:
  //   AX_CREDENTIALS_KEY  — @ax/credentials (throws without it)
  //   ANTHROPIC_API_KEY   — gates titles/web-tools/memory-strata branch; the
  //     stub value is never used to make a real call at boot
  //   AX_BOOTSTRAP_TOKEN  — @ax/onboarding
  const savedEnv: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string): void {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  async function ensurePostgresStarted(): Promise<string> {
    if (pgContainer === null) {
      pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    }
    return pgContainer.getConnectionUri();
  }

  beforeEach(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-prod-bootstrap-')),
    );
    setEnv('AX_CREDENTIALS_KEY', '42'.repeat(32));
    setEnv('ANTHROPIC_API_KEY', 'stub-anthropic-key');
    setEnv('AX_BOOTSTRAP_TOKEN', 'stub-bootstrap-token');
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (pgContainer !== null) {
      await pgContainer.stop();
      pgContainer = null;
    }
  });

  /**
   * Build a K8sPresetConfig whose backend-bound fields point at hermetic test
   * infra: the real testcontainer DSN (postgres trio), a tmpdir
   * credential-proxy socket + CA dir, port 0 for both listeners, the local
   * workspace backend on a tmpdir, and a stub runner binary. `titles` is set
   * (matching the ANTHROPIC_API_KEY env) so the full prod branch loads.
   */
  function makeConfig(connectionString: string): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString },
      session: { connectionString },
      workspace: { backend: 'local', repoRoot: path.join(tmp, 'repo') },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: {
        host: '127.0.0.1',
        port: 0,
        hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80',
      },
      chat: { runnerBinary: '/tmp/stub-runner.js', chatTimeoutMs: 60_000 },
      http: {
        host: '127.0.0.1',
        port: 0,
        cookieKey: randomBytes(32).toString('hex'),
        allowedOrigins: [],
      },
      credentialProxy: {
        socketPath: path.join(tmp, 'proxy.sock'),
        caDir: path.join(tmp, 'proxy-ca'),
      },
      titles: { model: 'anthropic/claude-haiku-4-5-20251001' },
      onboarding: { publicBaseUrl: 'http://127.0.0.1:0' },
    };
  }

  // The UNCONDITIONAL production plugins createK8sPlugins always assembles for
  // this config shape (the config-gated ones — credentials-admin-routes,
  // static-files, and the titles branch llm-anthropic/web-tools/
  // conversation-titles/memory-strata* — are deliberately NOT here; they're
  // pinned separately where the config turns them on). Most of these are
  // plugins the OLD canary used to DROP: keeping every one in a real boot is
  // the whole point of this lane, so if a future refactor pulls any out of the
  // preset the drift-guard test below fails loudly.
  const REQUIRED_PROD_PLUGINS = [
    '@ax/database-postgres',
    '@ax/storage-postgres',
    '@ax/credentials-store-db',
    '@ax/credentials',
    '@ax/credential-proxy',
    '@ax/eventbus-postgres',
    '@ax/session-postgres',
    '@ax/workspace-git',
    '@ax/audit-log',
    '@ax/routines',
    '@ax/routines-admin-routes',
    '@ax/sandbox-k8s',
    '@ax/ipc-http',
    '@ax/http-server',
    '@ax/auth-better',
    '@ax/onboarding',
    '@ax/teams',
    '@ax/chat-orchestrator',
    '@ax/mcp-client',
    '@ax/agents',
    '@ax/skills',
    '@ax/admin-settings-routes',
    '@ax/conversations',
    '@ax/attachments',
    '@ax/channel-web',
  ] as const;

  it(
    'createK8sPlugins assembles the full production plugin set (drift guard, pre-splice)',
    () => {
      const config = makeConfig('postgres://stub:5432/stub');
      // Assert against the PRE-SPLICE preset output — NOT the post-splice list
      // (buildProdAssemblyWithFakeK8s re-adds @ax/sandbox-k8s unconditionally,
      // which would mask the preset itself dropping it). This is a pure
      // manifest check; no init() runs, so it needs no postgres / docker and
      // catches production-assembly drift even when the testcontainer lane is
      // unavailable.
      const presetPlugins = createK8sPlugins(config);
      const names = presetPlugins.map((p) => p.manifest.name);
      const nameSet = new Set(names);
      for (const required of REQUIRED_PROD_PLUGINS) {
        expect(nameSet.has(required)).toBe(true);
      }
      // Exactly one sandbox plugin in the real preset output — guards against
      // both a drop and an accidental double-push.
      expect(names.filter((n) => n === '@ax/sandbox-k8s')).toHaveLength(1);
      // The titles branch is on (config.titles set), so its gated plugins must
      // also be present — pins the ANTHROPIC_API_KEY-driven production path.
      for (const gated of [
        '@ax/llm-anthropic',
        '@ax/web-tools',
        '@ax/conversation-titles',
        '@ax/memory-strata',
        '@ax/memory-strata-index-postgres',
      ]) {
        expect(nameSet.has(gated)).toBe(true);
      }
    },
  );

  it(
    'boots the full createK8sPlugins assembly against postgres with a fake k8s api',
    { timeout: 180_000 },
    async () => {
      const connectionString = await ensurePostgresStarted();
      const config = makeConfig(connectionString);
      const plugins = buildProdAssemblyWithFakeK8s(config);

      const bus = new HookBus();
      const handle = await bootstrap({ bus, plugins, config: {} });
      try {
        // The whole production graph topo-sorted and every init() ran:
        // postgres trio migrations, credential-proxy CA + socket, http-server
        // + ipc-http listeners bound, auth/agents/teams/skills/attachments/
        // conversations/onboarding migrations, the titles+web-tools+memory
        // branch. Reaching here without a throw IS the assertion; the
        // hasService probes pin the load-bearing seams concretely.
        expect(bus.hasService('agent:invoke')).toBe(true);
        expect(bus.hasService('sandbox:open-session')).toBe(true);
        expect(bus.hasService('auth:require-user')).toBe(true);
        expect(bus.hasService('conversations:create')).toBe(true);
      } finally {
        await handle.shutdown();
      }
    },
  );

  it(
    'serves a request through the real http-server + auth-better chain (401 unauth)',
    { timeout: 180_000 },
    async () => {
      const connectionString = await ensurePostgresStarted();
      const config = makeConfig(connectionString);
      const plugins = buildProdAssemblyWithFakeK8s(config);

      // The http-server plugin object exposes boundPort(); find it in the
      // assembled list so we can hit the real listener after bootstrap.
      const httpPlugin = plugins.find(
        (p) => p.manifest.name === '@ax/http-server',
      ) as (Plugin & { boundPort?: () => number }) | undefined;
      expect(httpPlugin).toBeTruthy();
      expect(typeof httpPlugin?.boundPort).toBe('function');

      const bus = new HookBus();
      const handle = await bootstrap({ bus, plugins, config: {} });
      try {
        const port = httpPlugin!.boundPort!();
        expect(port).toBeGreaterThan(0);

        // GET /admin/me with no session → 401 through the real auth-better
        // handler mounted on the real http-server. Proves the route chain is
        // live end-to-end (listener → router → auth-better handler), which the
        // old canary (no http-server at all) could not.
        const resp = await fetch(`http://127.0.0.1:${port}/admin/me`, {
          method: 'GET',
        });
        expect(resp.status).toBe(401);
      } finally {
        await handle.shutdown();
      }
    },
  );

  it(
    'loadK8sConfigFromEnv builds a config that boots the prod assembly with fake-k8s',
    { timeout: 180_000 },
    async () => {
      const connectionString = await ensurePostgresStarted();
      // Build the env the way the Helm chart stamps it onto the host pod.
      const env: NodeJS.ProcessEnv = {
        DATABASE_URL: connectionString,
        AX_K8S_HOST_IPC_URL: 'http://ax-next-host.ax-next.svc.cluster.local:80',
        AX_WORKSPACE_BACKEND: 'local',
        AX_WORKSPACE_ROOT: path.join(tmp, 'repo-env'),
        AX_HTTP_HOST: '127.0.0.1',
        AX_HTTP_PORT: '0',
        AX_HTTP_COOKIE_KEY: randomBytes(32).toString('hex'),
        AX_HTTP_ALLOWED_ORIGINS: '',
        AX_PROXY_SOCKET_PATH: path.join(tmp, 'proxy-env.sock'),
        AX_PROXY_CA_DIR: path.join(tmp, 'proxy-ca-env'),
        ANTHROPIC_API_KEY: 'stub-anthropic-key',
      };

      const config = loadK8sConfigFromEnv(env);
      // The env loader produced the production-shaped config.
      expect(config.database.connectionString).toBe(connectionString);
      expect(config.workspace.backend).toBe('local');
      expect(config.titles).toBeDefined(); // ANTHROPIC_API_KEY present

      const plugins = buildProdAssemblyWithFakeK8s(config);
      const bus = new HookBus();
      const handle = await bootstrap({ bus, plugins, config: {} });
      try {
        expect(bus.hasService('agent:invoke')).toBe(true);
        expect(bus.hasService('sandbox:open-session')).toBe(true);
      } finally {
        await handle.shutdown();
      }
    },
  );
});
