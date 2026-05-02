import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type AgentOutcome,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
} from '@ax/core';
import {
  buildBaselineBundle,
  workspaceCommitNotifyHandler,
} from '@ax/ipc-core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createSandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createMcpClientPlugin } from '@ax/mcp-client';
import {
  createTestProxyPlugin,
  stubRunnerPath,
  type StubRunnerScript,
} from '@ax/test-harness';
import { workspaceIdFor } from '@ax/workspace-git-server';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '@ax/workspace-git-server/server';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// Phase 6.6 Task 9 — preset-k8s acceptance canary (Invariant I_R4).
//
// Rebuilds the canary acceptance test that was deleted alongside the legacy
// llm-mock packages (commit c9870bc^). The brief reads "k8s preset boots its
// full plugin set and runs a chat through" — but a full k8s boot requires
// postgres + a real kube-apiserver + a host-side HTTP listener with auth +
// the credential proxy on a unix socket. None of that is reachable from a
// hermetic vitest run without testcontainers.
//
// Pragmatic compromise: we IMPORT the assembled plugin list from
// `createK8sPlugins(stubConfig)` (so the test breaks when the preset's
// chat-path plugin set drifts) and substitute the backend-bound plugins
// with their CLI-equivalent in-memory / subprocess flavors. What this
// catches:
//
//   * Manifest drift in the chat-path plugins the preset shares with the
//     CLI (chat-orchestrator, tool-dispatcher, audit-log, mcp-client).
//   * The chat-orchestrator's interaction with the preset's runnerBinary
//     resolution path (we pass an explicit override here, but the type
//     contract still goes through the preset's K8sPresetConfig.chat shape).
//   * That chat:end still fires once per agent:invoke (I1). Audit-log no
//     longer subscribes to chat:end (Phase 7 Slice A / I24); the inline
//     chatEndRecorder is the independent witness.
//
// What this does NOT catch:
//   * Postgres schema drift (out of scope; that's the testcontainer test
//     that the legacy acceptance.test used to be — deferred until we have
//     a CI lane for it).
//   * Real k8s sandbox provider behavior (subprocess sandbox stands in).
//   * HTTP listener / OIDC auth wiring (the static preset.test.ts already
//     pins those manifests; integration is future-Phase territory).
//
// The filter list below is the shape of the compromise: each name is a
// plugin we either replace with a test-friendly version or skip entirely.
// When the preset evolves, this list should be the second touch-point
// after the wiring smoke test in preset.test.ts.
// ---------------------------------------------------------------------------

const PLUGINS_TO_DROP = new Set<string>([
  // Postgres trio — replaced by storage-sqlite + session-inmemory.
  '@ax/database-postgres',
  '@ax/storage-postgres',
  '@ax/eventbus-postgres',
  '@ax/session-postgres',
  // K8s sandbox — replaced by sandbox-subprocess.
  '@ax/sandbox-k8s',
  // Real credential-proxy needs a unix-socket listener + seeded credentials;
  // test-proxy stands in (registers proxy:open-session / proxy:close-session
  // and feeds the stub-runner script through envMap).
  '@ax/credential-proxy',
  // HTTP control plane — out of scope; there's no public listener in this
  // test, so the auth/teams/static-files chain comes off too.
  '@ax/http-server',
  '@ax/auth-oidc',
  '@ax/teams',
  '@ax/static-files',
  // Agents plugin is postgres-backed and depends on http+auth above; we
  // mount a permissive `agents:resolve` mock plugin further down.
  '@ax/agents',
  // Workspace plugins talk to a real git repo / git-server pod; the chat
  // path here doesn't exercise workspace ops. Drop them.
  '@ax/workspace-git',
  '@ax/workspace-git-http',
  // Anthropic OAuth sub-service: we never dispatch an OAuth-keyed
  // credential because the test-proxy serves the runner directly without
  // touching credentials:resolve at all.
  '@ax/credentials-anthropic-oauth',
  // ipc-http binds a TCP listener. Replaced by ipc-server (unix socket)
  // because sandbox-subprocess + ipc-server is the wired CLI pair.
  '@ax/ipc-http',
  // The preset configures mcp-client with `mountAdminRoutes: true`, which
  // expands its manifest.calls to require http:register-route +
  // auth:require-user. We just dropped both — replace with a non-admin
  // version below so the chat-path coverage stays.
  '@ax/mcp-client',
]);

// Stub `agents:resolve` — production presets register `@ax/agents` (postgres-
// backed); we stand in with a minimal permissive impl because every chat
// flows through this gate (chat-orchestrator hard-dep). Inlined rather than
// imported from `@ax/cli/dev-agents-stub` to avoid the cli → preset-k8s →
// cli dep cycle the import would create.
const PERMISSIVE_AGENTS_STUB_NAME = '@ax/preset-k8s/test/permissive-agents-stub';

function createPermissiveAgentsStubPlugin(): Plugin {
  return {
    manifest: {
      name: PERMISSIVE_AGENTS_STUB_NAME,
      version: '0.0.0',
      registers: ['agents:resolve'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService(
        'agents:resolve',
        PERMISSIVE_AGENTS_STUB_NAME,
        async (_ctx: AgentContext, input) => {
          const i = input as { agentId?: string; userId?: string };
          const agentId = i.agentId ?? 'preset-test-agent';
          const userId = i.userId ?? 'preset-test-user';
          return {
            agent: {
              id: agentId,
              ownerId: userId,
              ownerType: 'user' as const,
              visibility: 'personal' as const,
              displayName: 'Preset acceptance test agent',
              systemPrompt: 'You are a helpful assistant.',
              allowedTools: [] as string[],
              mcpConfigIds: [] as string[],
              model: 'claude-sonnet-4-7',
              workspaceRef: null,
              // The test-proxy ignores allowedHosts/requiredCredentials —
              // the orchestrator just forwards them through to the runner
              // env. Empty values keep the surface area minimal.
              allowedHosts: [] as string[],
              requiredCredentials: {} as Record<
                string,
                { ref: string; kind: string }
              >,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        },
      );
    },
  };
}

// Sentinel content the runner emits — searching for it in
// outcome.messages[].content is the load-bearing assertion that the
// chat actually ran (vs. a wiring-only happy path).
const CANARY_TEXT = 'preset-ok';

describe('@ax/preset-k8s acceptance (stub runner)', () => {
  let tmp: string;
  let originalCredKey: string | undefined;

  beforeEach(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-preset-k8s-')),
    );
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    // @ax/credentials.init() throws without this. The preset always loads
    // the credentials facade, so we keep that contract live even though
    // the test-proxy short-circuits the resolve path.
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });

  afterEach(async () => {
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it(
    'boots a preset-equivalent plugin set and completes a chat through the stub runner',
    { timeout: 30_000 },
    async () => {
      const script: StubRunnerScript = {
        entries: [
          { kind: 'assistant-text', content: CANARY_TEXT },
          { kind: 'finish', reason: 'end_turn' },
        ],
      };

      // The preset config we hand to createK8sPlugins. None of these values
      // matter at factory time for the plugins we KEEP — we only filter
      // them out once the manifests have been built. The values that DO
      // matter are: chat.runnerBinary (consumed by chat-orchestrator) and
      // the auth + http fields (parsed even though we drop the resulting
      // plugin — keeps the K8sPresetConfig contract honest).
      const presetConfig: K8sPresetConfig = {
        database: { connectionString: 'postgres://stub:5432/stub' },
        eventbus: { connectionString: 'postgres://stub:5432/stub' },
        session: { connectionString: 'postgres://stub:5432/stub' },
        workspace: {
          backend: 'local',
          repoRoot: path.join(tmp, 'repo-stub'),
        },
        sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
        ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
        chat: { runnerBinary: stubRunnerPath, chatTimeoutMs: 60_000 },
        http: {
          host: '127.0.0.1',
          port: 0,
          cookieKey: '0'.repeat(64),
          allowedOrigins: [],
        },
        auth: { devBootstrap: { token: 'preset-test-bootstrap' } },
      };

      // Build the preset's plugin list, drop the production-only ones, and
      // splice in test replacements. We assemble through createK8sPlugins
      // (rather than a parallel list) so the next time someone adds a new
      // chat-path plugin to the preset, this test either picks it up
      // automatically or fails LOUDLY at the duplicate-registrant check
      // — both better than silent drift.
      const presetPlugins = createK8sPlugins(presetConfig);
      const kept = presetPlugins.filter(
        (p) => !PLUGINS_TO_DROP.has(p.manifest.name),
      );

      // chat:end recorder — independent witness that the event still fires
      // once per agent:invoke even after Phase 7 Slice A removed audit-log's
      // subscription. The recorder kept post-Slice-A is the I1 (chat:end
      // fires once) canary; the audit-log row assertion was dropped because
      // audit-log no longer writes a `chat:<reqId>` row at all (I24).
      const observedChatEndReqIds: string[] = [];
      const chatEndRecorder: Plugin = {
        manifest: {
          name: '@ax/preset-k8s/test/chat-end-recorder',
          version: '0.0.0',
          registers: [],
          calls: [],
          subscribes: ['chat:end'],
        },
        init({ bus }) {
          bus.subscribe(
            'chat:end',
            '@ax/preset-k8s/test/chat-end-recorder',
            async (recCtx: AgentContext) => {
              observedChatEndReqIds.push(recCtx.reqId);
              return undefined;
            },
          );
        },
      };

      const sqlitePath = path.join(tmp, 'preset-k8s-acceptance.sqlite');
      const replacements: Plugin[] = [
        // storage:get/set — sqlite vs. in-memory is arbitrary post-Slice-A
        // (no row read-back happens in this test any more). Kept on sqlite
        // because it's what the CLI canary uses, so a single storage
        // backend exercises both canaries.
        createStorageSqlitePlugin({ databasePath: sqlitePath }),
        // session:queue-work + session:* — in-memory variant, single-process.
        createSessionInmemoryPlugin(),
        // sandbox:open-session — spawns a child node process that runs the
        // stub-runner binary; the runner reads AX_TEST_STUB_SCRIPT (set by
        // test-proxy via envMap) and emits the script entries over IPC.
        createSandboxSubprocessPlugin(),
        // IPC listener the runner subprocess connects back to.
        createIpcServerPlugin(),
        // proxy:open-session / proxy:close-session — no-op stand-in that
        // injects the encoded script via envMap.
        createTestProxyPlugin({ script }),
        // agents:resolve — permissive mock (one source of truth replaced).
        createPermissiveAgentsStubPlugin(),
        // mcp-client without admin routes: keeps chat-path coverage (it
        // registers tool descriptors via tool:register on init when the
        // configured set is non-empty; here we boot it empty, which is the
        // no-op path) without depending on the http-server we dropped.
        createMcpClientPlugin(),
        // Records the reqId so the I1 witness assertion below can confirm
        // chat:end fired at all. Audit-log used to consume this event;
        // post-Slice-A it does not, so this recorder IS the chat:end canary.
        chatEndRecorder,
      ];

      const plugins: Plugin[] = [...kept, ...replacements];

      const bus = new HookBus();
      const handle = await bootstrap({ bus, plugins, config: {} });

      try {
        const ctx = makeAgentContext({
          sessionId: 'preset-acceptance-session',
          agentId: 'preset-test-agent',
          userId: 'preset-test-user',
          workspace: { rootPath: tmp },
        });

        const outcome: AgentOutcome = await bus.call('agent:invoke', ctx, {
          message: { role: 'user', content: 'hi' },
        });

        // Chat outcome assertions — the load-bearing "did a chat actually
        // run" check. Anything short of `kind === 'complete'` means the
        // preset's chat path failed somewhere (sandbox spawn, IPC routing,
        // or the runner itself).
        expect(outcome.kind).toBe('complete');
        if (outcome.kind !== 'complete') {
          // Type narrowing for the assertions below; the line above already
          // failed if we got here, but the cast keeps tsc happy.
          throw new Error(
            `expected complete, got ${outcome.kind}: ${JSON.stringify(outcome)}`,
          );
        }
        const lastAssistant = [...outcome.messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        expect(lastAssistant?.content).toContain(CANARY_TEXT);

        // chat:end fires EXACTLY once per agent:invoke (I1). The recorder
        // is an independent witness — audit-log no longer subscribes to
        // chat:end (Phase 7 Slice A / I24), so this is the only assertion
        // that proves the event flowed through end-to-end. Exact length is
        // load-bearing: a double-fire regression would slip past
        // `toBeGreaterThanOrEqual(1)` while still violating the invariant.
        expect(observedChatEndReqIds).toHaveLength(1);
      } finally {
        await handle.shutdown();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 2 Task 18 — git-protocol backend acceptance.
  //
  // Parallel to the local-backend test above. The difference: instead of
  // letting `@ax/workspace-git` write a bare repo on a tempdir, we boot an
  // in-process `@ax/workspace-git-server` storage tier and point the preset
  // at it via `workspace: { backend: 'git-protocol', baseUrl, token }`. That
  // exercises the full chain — preset → bootstrap → workspace plugin → REST
  // create-repo → git smart-HTTP push — that the chart wires up when an
  // operator flips `gitServer.experimental.gitProtocol=true`.
  //
  // The chat path itself doesn't touch workspace ops (stub-runner just emits
  // assistant-text + finish), so the load-bearing test for the new plugin's
  // wiring is the explicit `workspace:apply` BEFORE the chat. That call:
  //   1. Forces the workspace-git-server plugin to register its hooks
  //      (otherwise the bus.call would throw `unknown service`).
  //   2. Routes through `ensureRepoCreated` → POST /repos on the storage tier.
  //   3. Pushes one commit via git smart-HTTP, materializing a bare repo at
  //      `<serverRepoRoot>/<workspaceId>.git`.
  // The post-chat filesystem assertion proves all three.
  // ---------------------------------------------------------------------------
  it(
    'boots a preset-equivalent plugin set with the git-protocol workspace and completes a chat',
    { timeout: 30_000 },
    async () => {
      // ---- Storage tier: boot an in-process workspace-git-server. -------
      // Token: 32 random bytes (hex) per test run. Real deploys use a
      // chart-managed Secret; the test value never leaves this process.
      const serverToken = randomBytes(32).toString('hex');
      const serverRepoRoot = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'ax-preset-k8s-gitsrv-')),
      );

      // `server` and `handle` are constructed inside the try below so that a
      // throw during `createWorkspaceGitServer` (e.g. EADDRINUSE) or during
      // `bootstrap` (e.g. a plugin init failure) doesn't leak the listener
      // or any half-initialized state. The finally block gates each cleanup
      // step on truthy so partial initialization unwinds in the right order.
      let server: WorkspaceGitServer | null = null;
      let handle: Awaited<ReturnType<typeof bootstrap>> | null = null;

      try {
        server = await createWorkspaceGitServer({
          repoRoot: serverRepoRoot,
          host: '127.0.0.1',
          port: 0,
          token: serverToken,
        });

        const script: StubRunnerScript = {
          entries: [
            { kind: 'assistant-text', content: CANARY_TEXT },
            { kind: 'finish', reason: 'end_turn' },
          ],
        };

        // Preset config — same shape as the local case except `workspace` flips
        // to `git-protocol` and points at the tempdir storage tier.
        const presetConfig: K8sPresetConfig = {
          database: { connectionString: 'postgres://stub:5432/stub' },
          eventbus: { connectionString: 'postgres://stub:5432/stub' },
          session: { connectionString: 'postgres://stub:5432/stub' },
          workspace: {
            backend: 'git-protocol',
            baseUrl: `http://127.0.0.1:${server.port}`,
            token: serverToken,
          },
          sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
          ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
          chat: { runnerBinary: stubRunnerPath, chatTimeoutMs: 60_000 },
          http: {
            host: '127.0.0.1',
            port: 0,
            cookieKey: '0'.repeat(64),
            allowedOrigins: [],
          },
          auth: { devBootstrap: { token: 'preset-test-bootstrap' } },
        };

        // Same filter as the local test. PLUGINS_TO_DROP doesn't list
        // `@ax/workspace-git-server`, so the new workspace plugin is kept and
        // exercised end-to-end.
        const presetPlugins = createK8sPlugins(presetConfig);
        const kept = presetPlugins.filter(
          (p) => !PLUGINS_TO_DROP.has(p.manifest.name),
        );

        const observedChatEndReqIds: string[] = [];
        const chatEndRecorder: Plugin = {
          manifest: {
            name: '@ax/preset-k8s/test/chat-end-recorder',
            version: '0.0.0',
            registers: [],
            calls: [],
            subscribes: ['chat:end'],
          },
          init({ bus }) {
            bus.subscribe(
              'chat:end',
              '@ax/preset-k8s/test/chat-end-recorder',
              async (recCtx: AgentContext) => {
                observedChatEndReqIds.push(recCtx.reqId);
                return undefined;
              },
            );
          },
        };

        const sqlitePath = path.join(tmp, 'preset-k8s-acceptance-gitproto.sqlite');
        const replacements: Plugin[] = [
          createStorageSqlitePlugin({ databasePath: sqlitePath }),
          createSessionInmemoryPlugin(),
          createSandboxSubprocessPlugin(),
          createIpcServerPlugin(),
          createTestProxyPlugin({ script }),
          createPermissiveAgentsStubPlugin(),
          createMcpClientPlugin(),
          chatEndRecorder,
        ];

        const plugins: Plugin[] = [...kept, ...replacements];

        const bus = new HookBus();
        handle = await bootstrap({ bus, plugins, config: {} });

        const userId = 'preset-test-user';
        const agentId = 'preset-test-agent';
        const ctx = makeAgentContext({
          sessionId: 'preset-acceptance-session-gitproto',
          agentId,
          userId,
          workspace: { rootPath: tmp },
        });

        // 1. Exercise the workspace plugin BEFORE the chat. This proves the
        // git-protocol plugin's hooks actually wired up and round-trip through
        // the storage tier — apply → ensureRepoCreated (POST /repos) → push
        // first commit via git smart-HTTP. The chat itself doesn't touch
        // workspace ops, so without this the storage tier stays empty.
        const apply = await bus.call<
          WorkspaceApplyInput,
          WorkspaceApplyOutput
        >('workspace:apply', ctx, {
          changes: [
            {
              path: 'canary.txt',
              kind: 'put',
              content: new TextEncoder().encode('hi'),
            },
          ],
          parent: null,
          reason: 'acceptance canary',
        });
        expect(typeof apply.version).toBe('string');
        expect(apply.delta.before).toBeNull();
        expect(apply.delta.changes).toHaveLength(1);
        expect(apply.delta.changes[0]).toMatchObject({
          path: 'canary.txt',
          kind: 'added',
        });

        // 2. Run the chat path through the same kernel. The stub-runner emits
        // CANARY_TEXT + finish; same chat-end / outcome assertions as the
        // local-backend test.
        const outcome: AgentOutcome = await bus.call('agent:invoke', ctx, {
          message: { role: 'user', content: 'hi' },
        });
        expect(outcome.kind).toBe('complete');
        if (outcome.kind !== 'complete') {
          throw new Error(
            `expected complete, got ${outcome.kind}: ${JSON.stringify(outcome)}`,
          );
        }
        const lastAssistant = [...outcome.messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        expect(lastAssistant?.content).toContain(CANARY_TEXT);
        expect(observedChatEndReqIds).toHaveLength(1);

        // 3. Filesystem assertion against the storage tier. The bare repo
        // lives at `<serverRepoRoot>/<workspaceId>.git`; existence proves the
        // workspace:apply above wrote through to the storage tier (vs. the
        // mirror cache only). `workspaceIdFor` is the same derivation the
        // production plugin uses (no override path in this preset), so the
        // path here matches what the chart's storage tier would see.
        const expectedWorkspaceId = workspaceIdFor({ userId, agentId });
        const bareRepoPath = path.join(
          serverRepoRoot,
          `${expectedWorkspaceId}.git`,
        );
        expect(existsSync(bareRepoPath)).toBe(true);
      } finally {
        // Tear down in reverse order of construction. Kernel shutdown drains
        // the workspace plugin's mirror cache + git engine before the server
        // closes; closing the server first would cause in-flight smart-HTTP
        // calls to error out instead of completing cleanly.
        //
        // Each step is gated on truthy: if `createWorkspaceGitServer` threw,
        // `server` is null and there's nothing to close; if `bootstrap` threw,
        // `handle` is null and there's no kernel to drain. The tempdir rm
        // is unconditional — `serverRepoRoot` was created BEFORE the try, so
        // we always own it for cleanup.
        if (handle !== null) await handle.shutdown();
        if (server !== null) await server.close();
        await fs.rm(serverRepoRoot, { recursive: true, force: true });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 3 canary — bundler-driven workspace.commit-notify pipeline.
  //
  // Drives the REAL host-side handler (not the IPC transport) against a
  // REAL workspace-git-server backend. Three scenarios:
  //
  //   1. Valid SKILL.md add → accepted, storage tier has the new commit.
  //   2. Malformed SKILL.md add → rejected by validator-skill, storage
  //      tier unchanged.
  //   3. Bash-style delete (the gap that motivated Phase 3) → accepted,
  //      storage tier reflects the delete.
  //
  // Each scenario uses a SEPARATE sub-test for clean isolation (the
  // storage tier is per-workspace, but a fresh bareRepo per scenario
  // makes parent-mismatch logic easier to reason about).
  // ---------------------------------------------------------------------------

  /** Spawn `git` for the runner-side simulation. */
  async function git(
    args: readonly string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...args], { cwd, env: env ?? process.env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  /**
   * Simulate the runner producing a turn-end thin bundle. Mirrors
   * agent-claude-sdk-runner's commitTurnAndBundle shape from inside
   * the test (we can't import the runner package — it's not a preset
   * dep — but the on-the-wire shape is small enough to inline).
   */
  async function simulateRunnerTurn(args: {
    baselineFiles: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
    turnFiles: Record<string, string | null>;
    /** Optional working dir; created in tmp if not provided. */
    parentDir: string;
  }): Promise<{ bundleB64: string }> {
    const { baselineFiles, turnFiles, parentDir } = args;
    const baselineB64 = await buildBaselineBundle({
      paths: baselineFiles.map((f) => f.path),
      read: async (p) => {
        const f = baselineFiles.find((x) => x.path === p);
        return f === undefined ? null : Buffer.from(f.bytes);
      },
    });
    const root = await fs.mkdtemp(path.join(parentDir, 'sim-runner-'));
    try {
      const bundlePath = path.join(root, 'baseline.bundle');
      await fs.writeFile(bundlePath, Buffer.from(baselineB64, 'base64'));
      const wt = path.join(root, 'wt');
      const cl = await git(['clone', '--branch', 'main', bundlePath, wt]);
      if (cl.code !== 0) throw new Error(`clone failed: ${cl.stderr}`);
      await git(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);
      await git(['-C', wt, 'config', 'user.name', 'ax-runner']);
      await git(['-C', wt, 'config', 'user.email', 'ax-runner@example.com']);

      for (const [p, content] of Object.entries(turnFiles)) {
        const abs = path.join(wt, p);
        if (content === null) {
          await fs.unlink(abs);
        } else {
          const dir = path.dirname(abs);
          if (dir !== wt) await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(abs, content);
        }
      }
      await git(['-C', wt, 'add', '-A']);
      await git(['-C', wt, 'commit', '-m', 'turn']);

      const buf = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn('git', [
          '-C',
          wt,
          'bundle',
          'create',
          '-',
          'baseline..main',
          'main',
        ]);
        const chunks: Buffer[] = [];
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? resolve(Buffer.concat(chunks))
            : reject(new Error(`bundle exit=${code}: ${stderr}`)),
        );
      });
      return { bundleB64: buf.toString('base64') };
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  interface CanaryHarness {
    bus: HookBus;
    ctx: AgentContext;
    server: WorkspaceGitServer;
    serverRepoRoot: string;
    workspaceId: string;
    bareRepoPath: string;
    handle: Awaited<ReturnType<typeof bootstrap>>;
    teardown: () => Promise<void>;
  }

  async function bootCanaryHarness(
    sessionId: string,
  ): Promise<CanaryHarness> {
    // Mirrors the partial-init pattern used by the earlier git-protocol
    // canary above: every step that creates a tracked resource (server,
    // bus handle) is gated by a try, so a throw before the helper
    // returns doesn't leak a listener or temp repo into later tests.
    const serverToken = randomBytes(32).toString('hex');
    const serverRepoRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-phase3-canary-')),
    );
    let server: WorkspaceGitServer | null = null;
    let handle: Awaited<ReturnType<typeof bootstrap>> | null = null;
    try {
      server = await createWorkspaceGitServer({
        repoRoot: serverRepoRoot,
        host: '127.0.0.1',
        port: 0,
        token: serverToken,
      });
      const presetConfig: K8sPresetConfig = {
        database: { connectionString: 'postgres://stub:5432/stub' },
        eventbus: { connectionString: 'postgres://stub:5432/stub' },
        session: { connectionString: 'postgres://stub:5432/stub' },
        workspace: {
          backend: 'git-protocol',
          baseUrl: `http://127.0.0.1:${server.port}`,
          token: serverToken,
        },
        sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
        ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
        chat: { runnerBinary: stubRunnerPath, chatTimeoutMs: 60_000 },
        http: {
          host: '127.0.0.1',
          port: 0,
          cookieKey: '0'.repeat(64),
          allowedOrigins: [],
        },
        auth: { devBootstrap: { token: 'preset-test-bootstrap' } },
      };
      const presetPlugins = createK8sPlugins(presetConfig);
      const kept = presetPlugins.filter(
        (p) => !PLUGINS_TO_DROP.has(p.manifest.name),
      );
      const sqlitePath = path.join(tmp, `phase3-${sessionId}.sqlite`);
      const replacements: Plugin[] = [
        createStorageSqlitePlugin({ databasePath: sqlitePath }),
        createSessionInmemoryPlugin(),
        createSandboxSubprocessPlugin(),
        createIpcServerPlugin(),
        createTestProxyPlugin({
          script: { entries: [{ kind: 'finish', reason: 'end_turn' }] },
        }),
        createPermissiveAgentsStubPlugin(),
        createMcpClientPlugin(),
      ];
      const plugins: Plugin[] = [...kept, ...replacements];
      const bus = new HookBus();
      handle = await bootstrap({ bus, plugins, config: {} });
      const userId = `phase3-user-${sessionId}`;
      const agentId = `phase3-agent-${sessionId}`;
      const ctx = makeAgentContext({
        sessionId,
        agentId,
        userId,
        workspace: { rootPath: tmp },
      });
      const workspaceId = workspaceIdFor({ userId, agentId });
      const bareRepoPath = path.join(serverRepoRoot, `${workspaceId}.git`);
      // Capture for the closure — TS can't narrow handle/server inside
      // an async closure since they're outer let-bindings.
      const handleCaptured = handle;
      const serverCaptured = server;
      return {
        bus,
        ctx,
        server: serverCaptured,
        serverRepoRoot,
        workspaceId,
        bareRepoPath,
        handle: handleCaptured,
        teardown: async () => {
          await handleCaptured.shutdown();
          await serverCaptured.close();
          await fs.rm(serverRepoRoot, { recursive: true, force: true });
        },
      };
    } catch (err) {
      // Partial init — clean up whatever DID succeed before re-throwing.
      // Reverse order of construction (handle drains before server
      // closes; tempdir always cleaned).
      if (handle !== null) {
        await handle.shutdown().catch(() => {
          /* best-effort */
        });
      }
      if (server !== null) {
        await server.close().catch(() => {
          /* best-effort */
        });
      }
      await fs
        .rm(serverRepoRoot, { recursive: true, force: true })
        .catch(() => {
          /* best-effort */
        });
      throw err;
    }
  }

  it(
    'Phase 3 canary: workspace.commit-notify accepts a turn that adds a valid SKILL.md',
    { timeout: 30_000 },
    async () => {
      const h = await bootCanaryHarness('phase3-valid-skill');
      try {
        const validSkillMd =
          '---\nname: foo\ndescription: a thing the agent does\n---\n# Body\n';
        const { bundleB64 } = await simulateRunnerTurn({
          baselineFiles: [],
          turnFiles: { '.ax/skills/foo/SKILL.md': validSkillMd },
          parentDir: tmp,
        });
        const result = await workspaceCommitNotifyHandler(
          {
            parentVersion: null,
            reason: 'turn',
            bundleBytes: bundleB64,
          },
          h.ctx,
          h.bus,
        );
        expect(result.status).toBe(200);
        const body = result.body as {
          accepted: true;
          version: string;
          delta: null;
        };
        expect(body.accepted).toBe(true);
        expect(typeof body.version).toBe('string');
        // Storage tier has the SKILL.md commit. Bare repo exists; the
        // commit OID matches what the runner produced (auditability —
        // bare repo OID chain == runner's chain).
        expect(existsSync(h.bareRepoPath)).toBe(true);
        const head = await git(
          ['-C', h.bareRepoPath, 'rev-parse', 'refs/heads/main'],
        );
        expect(head.stdout.trim()).toBe(body.version);
        // The file is in the tree.
        const ls = await git(['-C', h.bareRepoPath, 'ls-tree', '-r', 'main']);
        expect(ls.stdout).toContain('.ax/skills/foo/SKILL.md');
      } finally {
        await h.teardown();
      }
    },
  );

  it(
    'Phase 3 canary: workspace.commit-notify rejects a turn that adds a SKILL.md with bad frontmatter',
    { timeout: 30_000 },
    async () => {
      const h = await bootCanaryHarness('phase3-bad-skill');
      try {
        const badSkillMd = '# no frontmatter at all\n';
        const { bundleB64 } = await simulateRunnerTurn({
          baselineFiles: [],
          turnFiles: { '.ax/skills/bar/SKILL.md': badSkillMd },
          parentDir: tmp,
        });
        const result = await workspaceCommitNotifyHandler(
          {
            parentVersion: null,
            reason: 'turn',
            bundleBytes: bundleB64,
          },
          h.ctx,
          h.bus,
        );
        expect(result.status).toBe(200);
        const body = result.body as { accepted: false; reason: string };
        expect(body.accepted).toBe(false);
        expect(body.reason).toContain('.ax/skills/bar/SKILL.md');
        // Storage tier was NOT updated. The bare repo may or may not
        // exist (depending on whether ensureRepoCreated ran before the
        // veto), but if it does, refs/heads/main should not exist
        // (no commits landed).
        if (existsSync(h.bareRepoPath)) {
          const head = await git(
            [
              '-C',
              h.bareRepoPath,
              'rev-parse',
              '--quiet',
              '--verify',
              'refs/heads/main',
            ],
          );
          // exit 0 = ref exists; non-zero = ref doesn't exist.
          expect(head.code).not.toBe(0);
        }
      } finally {
        await h.teardown();
      }
    },
  );

  it(
    'Phase 3 canary: workspace.commit-notify catches a Bash-deleted file (the gap that motivated Phase 3)',
    { timeout: 30_000 },
    async () => {
      const h = await bootCanaryHarness('phase3-bash-delete');
      try {
        // Turn 1: seed the workspace with a file via the bundle path
        // (so the storage tier has it to delete in turn 2).
        const seed = await simulateRunnerTurn({
          baselineFiles: [],
          turnFiles: { 'doomed.txt': 'will be deleted via Bash' },
          parentDir: tmp,
        });
        const turn1 = await workspaceCommitNotifyHandler(
          {
            parentVersion: null,
            reason: 'turn 1: seed',
            bundleBytes: seed.bundleB64,
          },
          h.ctx,
          h.bus,
        );
        expect(turn1.status).toBe(200);
        const turn1Body = turn1.body as { accepted: true; version: string };
        expect(turn1Body.accepted).toBe(true);

        // Turn 2: simulate the agent deleting the file via `Bash: rm`
        // (no SDK Write/Edit/MultiEdit involved). The legacy
        // PostToolUse observer would have missed this entirely; git
        // status sees it.
        //
        // For turn 2 we can't use simulateRunnerTurn (which rebuilds a
        // deterministic baseline) — the runner's actual baseline OID
        // after turn 1 accept is the NON-deterministic turn-1 commit
        // OID, which the simulator's deterministic build wouldn't
        // reproduce. Instead, clone the storage tier directly (which
        // has turn 1's commit at HEAD), make the delete commit, bundle
        // baseline..main. This mirrors what the real runner does in
        // production — its local repo persists across turns.
        const turn2Root = await fs.mkdtemp(path.join(tmp, 'turn2-'));
        let turn2BundleB64: string;
        try {
          const cl = await git(['clone', h.bareRepoPath, turn2Root]);
          if (cl.code !== 0) throw new Error(`turn2 clone: ${cl.stderr}`);
          // Pin baseline to current HEAD = turn 1's tip = runner's
          // local baseline after turn 1 accept.
          await git(['-C', turn2Root, 'update-ref', 'refs/heads/baseline', 'HEAD']);
          await git(['-C', turn2Root, 'config', 'user.name', 'ax-runner']);
          await git(['-C', turn2Root, 'config', 'user.email', 'ax-runner@example.com']);
          // Bash-style delete.
          await fs.unlink(path.join(turn2Root, 'doomed.txt'));
          await git(['-C', turn2Root, 'add', '-A']);
          await git(['-C', turn2Root, 'commit', '-m', 'turn 2: bash delete']);
          // Bundle thin: baseline..main + main ref.
          const buf = await new Promise<Buffer>((resolve, reject) => {
            const child = spawn('git', [
              '-C',
              turn2Root,
              'bundle',
              'create',
              '-',
              'baseline..main',
              'main',
            ]);
            const chunks: Buffer[] = [];
            let stderr = '';
            child.stdout.on('data', (c: Buffer) => chunks.push(c));
            child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
            child.once('error', reject);
            child.once('close', (code) =>
              code === 0
                ? resolve(Buffer.concat(chunks))
                : reject(new Error(`turn2 bundle: ${stderr}`)),
            );
          });
          turn2BundleB64 = buf.toString('base64');
        } finally {
          await fs.rm(turn2Root, { recursive: true, force: true });
        }

        const turn2Result = await workspaceCommitNotifyHandler(
          {
            parentVersion: turn1Body.version,
            reason: 'turn 2: bash delete',
            bundleBytes: turn2BundleB64,
          },
          h.ctx,
          h.bus,
        );
        expect(turn2Result.status).toBe(200);
        const turn2Body = turn2Result.body as {
          accepted: true;
          version: string;
        };
        // turn 2 accepted — git status caught the Bash-style delete
        // (the gap that motivated Phase 3). Pre-Phase-3, deletes via
        // Bash were invisible to the PostToolUse-based observer.
        expect(turn2Body.accepted).toBe(true);

        // The file is GONE from the storage tier.
        const ls = await git(['-C', h.bareRepoPath, 'ls-tree', '-r', 'main']);
        expect(ls.stdout).not.toContain('doomed.txt');
      } finally {
        await h.teardown();
      }
    },
  );
});
