import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type AgentOutcome,
  type Plugin,
} from '@ax/core';
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
//   * The audit-log subscription firing on chat:end and writing a row
//     through whatever storage plugin we substituted in.
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

      // The IPC server reconstructs an AgentContext from session-token auth
      // when the runner POSTs /event.chat-end, generating a fresh reqId
      // there (see packages/ipc-server/src/listener.ts). That means
      // audit-log writes its `chat:<reqId>` row keyed by the IPC-side
      // reqId, NOT the original `bus.call('agent:invoke', ctx, ...)`
      // reqId. We tap chat:end with a recorder subscriber so the assertion
      // can look up the row regardless of which reqId path got the chat
      // through.
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
        // storage:get/set — backed by sqlite so audit-log's chat:end row
        // is independently observable (vs. an in-memory mock that keeps
        // its writes private to the test file).
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
        // Records the reqId chat:end fires with so the audit-log assertion
        // can look up the right `chat:<reqId>` row.
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

        // Audit-log row assertion — the second-half of the canary contract.
        // audit-log subscribes to chat:end and writes via storage:set with
        // key `chat:<reqId>` (see packages/audit-log/src/plugin.ts). We
        // round-trip through storage:get rather than poking sqlite directly
        // so the assertion stays storage-backend-agnostic.
        //
        // Use the reqId observed by the chatEndRecorder above — the IPC
        // server's reconstructed ctx carries a different reqId than the
        // original agent:invoke ctx, and audit-log keys by whichever ctx
        // delivered chat:end.
        expect(observedChatEndReqIds.length).toBeGreaterThanOrEqual(1);
        const auditReqId = observedChatEndReqIds[observedChatEndReqIds.length - 1]!;
        const stored = await bus.call<
          { key: string },
          { value: Uint8Array | undefined }
        >('storage:get', ctx, { key: `chat:${auditReqId}` });
        expect(stored.value).toBeDefined();
        const decoded = JSON.parse(
          new TextDecoder().decode(stored.value!),
        ) as {
          reqId: string;
          sessionId: string;
          outcome: AgentOutcome;
        };
        expect(decoded.reqId).toBe(auditReqId);
        expect(decoded.sessionId).toBe('preset-acceptance-session');
        expect(decoded.outcome.kind).toBe('complete');
      } finally {
        await handle.shutdown();
      }
    },
  );
});
