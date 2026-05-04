import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import {
  HookBus,
  PluginError,
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
import { encodeScript, stubRunnerPath, type StubRunnerScript } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// Phase 6.6 Task 10 — multi-tenant ACL canary (Invariant I_R5).
//
// Sibling of acceptance.test.ts (Task 9). Same plugin-assembly pattern
// (filter-from-createK8sPlugins + sqlite/in-memory substitutes) but the
// `agents:resolve` and `proxy:open-session` mocks discriminate by agentId/
// userId so we can verify the orchestrator's ACL gate end-to-end:
//
//   * agent A + user-A → resolves; chat completes; assistant emits 'from-A'.
//   * agent B + user-B → resolves; chat completes; assistant emits 'from-B'.
//   * agent A + user-B → agents:resolve throws PluginError('forbidden');
//     orchestrator returns AgentOutcome { kind: 'terminated',
//     reason: 'agent-resolve:forbidden' }.
//
// The 'forbidden' code mirrors what production @ax/agents emits (see
// packages/agents/src/plugin.ts: code: 'forbidden' on every resolve-time
// access denial). Diverging here would let the canary pass against a
// reason production never produces.
//
// I2 note: AgentRecord shape is duplicated structurally (also done in
// acceptance.test.ts and dev-agents-stub) — no import from chat-orchestrator.
// ---------------------------------------------------------------------------

// AgentRecord shape — minimum the orchestrator USES is { id, ownerId,
// systemPrompt, allowedTools, mcpConfigIds, model, workspaceRef }. We
// include the broader optional fields because dev-agents-stub does and
// the type-level `agent.allowedHosts ?? []` reads through them.
interface TestAgentRecord {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
  allowedHosts: string[];
  requiredCredentials: Record<string, { ref: string; kind: string }>;
  createdAt: Date;
  updatedAt: Date;
}

const AGENT_A: TestAgentRecord = {
  id: 'agent-A',
  ownerId: 'user-A',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'Agent A',
  systemPrompt: 'you are agent A',
  allowedTools: [],
  mcpConfigIds: [],
  model: 'stub-model',
  workspaceRef: null,
  allowedHosts: [],
  requiredCredentials: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const AGENT_B: TestAgentRecord = {
  id: 'agent-B',
  ownerId: 'user-B',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'Agent B',
  systemPrompt: 'you are agent B',
  allowedTools: [],
  mcpConfigIds: [],
  model: 'stub-model',
  workspaceRef: null,
  allowedHosts: [],
  requiredCredentials: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

// Plugin filter shared with Task 9's acceptance.test.ts. Same compromise:
// drop the postgres/k8s/http/oauth/workspace-git plugins that need real
// infrastructure; keep the chat-path plugins so the orchestrator wiring
// is exercised end-to-end.
const PLUGINS_TO_DROP = new Set<string>([
  '@ax/database-postgres',
  '@ax/storage-postgres',
  '@ax/eventbus-postgres',
  '@ax/session-postgres',
  '@ax/sandbox-k8s',
  '@ax/credential-proxy',
  '@ax/http-server',
  '@ax/auth-oidc',
  '@ax/teams',
  '@ax/static-files',
  // channel-web's REST surface depends on the http-server we just dropped;
  // this canary drives `agent:invoke` directly via bus.call.
  '@ax/channel-web',
  // Conversations is postgres-backed; not exercised by the multi-tenant
  // ACL canary (we go straight through the chat-orchestrator's agents:resolve
  // gate without touching conversation rows).
  '@ax/conversations',
  '@ax/agents',
  '@ax/workspace-git',
  '@ax/credentials-anthropic-oauth',
  '@ax/ipc-http',
  '@ax/mcp-client',
]);

const AGENTS_RESOLVE_PLUGIN_NAME = '@ax/preset-k8s/test/discriminating-agents-resolve';

function createDiscriminatingAgentsResolvePlugin(): Plugin {
  return {
    manifest: {
      name: AGENTS_RESOLVE_PLUGIN_NAME,
      version: '0.0.0',
      registers: ['agents:resolve'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<
        { agentId: string; userId: string },
        { agent: TestAgentRecord }
      >(
        'agents:resolve',
        AGENTS_RESOLVE_PLUGIN_NAME,
        async (_ctx: AgentContext, input) => {
          if (input.agentId === 'agent-A' && input.userId === 'user-A') {
            return { agent: AGENT_A };
          }
          if (input.agentId === 'agent-B' && input.userId === 'user-B') {
            return { agent: AGENT_B };
          }
          throw new PluginError({
            code: 'forbidden',
            plugin: AGENTS_RESOLVE_PLUGIN_NAME,
            message: `user '${input.userId}' cannot access agent '${input.agentId}'`,
          });
        },
      );
    },
  };
}

// Per-agent stub-runner script proxy. createTestProxyPlugin only carries
// ONE script — we can't install it twice (the bus's "one source of truth"
// check rejects duplicate registrants for proxy:open-session). So we
// inline a per-agent dispatcher that picks the right encoded script from
// `input.agentId` at handler time.
const MULTI_TENANT_PROXY_PLUGIN_NAME = '@ax/preset-k8s/test/multi-tenant-proxy';

// Same syntactically-shaped never-validated PEM the test-proxy plugin uses;
// inlined to avoid an extra export from @ax/test-harness for one constant.
const DUMMY_CA_PEM =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBkTCB+wIJAJtest-only-never-validated\n' +
  '-----END CERTIFICATE-----\n';

interface OpenSessionOutput {
  proxyEndpoint: string;
  caCertPem: string;
  envMap: Record<string, string>;
}

function createMultiTenantProxyPlugin(opts: {
  scriptByAgentId: Map<string, StubRunnerScript>;
}): Plugin {
  // Pre-encode each script once; encodeScript is pure JSON-stringify under
  // the hood, but we don't want to re-encode on every open-session call.
  const encodedByAgentId = new Map<string, string>();
  for (const [agentId, script] of opts.scriptByAgentId) {
    encodedByAgentId.set(agentId, encodeScript(script));
  }

  return {
    manifest: {
      name: MULTI_TENANT_PROXY_PLUGIN_NAME,
      version: '0.0.0',
      registers: ['proxy:open-session', 'proxy:close-session'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<
        {
          sessionId: string;
          userId: string;
          agentId: string;
          allowlist: string[];
          credentials: Record<string, { ref: string; kind: string }>;
        },
        OpenSessionOutput
      >(
        'proxy:open-session',
        MULTI_TENANT_PROXY_PLUGIN_NAME,
        async (_ctx: AgentContext, input) => {
          const encoded = encodedByAgentId.get(input.agentId);
          if (encoded === undefined) {
            throw new PluginError({
              code: 'no-script-for-agent',
              plugin: MULTI_TENANT_PROXY_PLUGIN_NAME,
              message: `no stub script registered for agentId '${input.agentId}'`,
            });
          }
          return {
            proxyEndpoint: 'tcp://127.0.0.1:1',
            caCertPem: DUMMY_CA_PEM,
            envMap: { AX_TEST_STUB_SCRIPT: encoded },
          };
        },
      );
      bus.registerService<{ sessionId: string }, Record<string, never>>(
        'proxy:close-session',
        MULTI_TENANT_PROXY_PLUGIN_NAME,
        async () => ({}),
      );
    },
  };
}

describe('@ax/preset-k8s multi-tenant ACL gate (stub runner)', () => {
  let tmp: string;
  let originalCredKey: string | undefined;

  beforeEach(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-preset-k8s-mt-')),
    );
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });

  afterEach(async () => {
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it(
    'admits agent A for user-A and agent B for user-B; rejects cross-tenant access',
    { timeout: 30_000 },
    async () => {
      const scriptA: StubRunnerScript = {
        entries: [
          { kind: 'assistant-text', content: 'from-A' },
          { kind: 'finish', reason: 'end_turn' },
        ],
      };
      const scriptB: StubRunnerScript = {
        entries: [
          { kind: 'assistant-text', content: 'from-B' },
          { kind: 'finish', reason: 'end_turn' },
        ],
      };

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
        auth: { devBootstrap: { token: 'preset-mt-test-bootstrap' } },
      };

      const presetPlugins = createK8sPlugins(presetConfig);
      const kept = presetPlugins.filter(
        (p) => !PLUGINS_TO_DROP.has(p.manifest.name),
      );

      // Recorder so we can sanity-check chat:end fires once per invocation.
      const observedChatEnds: Array<{
        sessionId: string | undefined;
        outcome: AgentOutcome;
      }> = [];
      const chatEndRecorder: Plugin = {
        manifest: {
          name: '@ax/preset-k8s/test/mt-chat-end-recorder',
          version: '0.0.0',
          registers: [],
          calls: [],
          subscribes: ['chat:end'],
        },
        init({ bus }) {
          bus.subscribe(
            'chat:end',
            '@ax/preset-k8s/test/mt-chat-end-recorder',
            async (recCtx: AgentContext, payload) => {
              const p = payload as { outcome: AgentOutcome };
              observedChatEnds.push({
                sessionId: recCtx.sessionId,
                outcome: p.outcome,
              });
              return undefined;
            },
          );
        },
      };

      const sqlitePath = path.join(tmp, 'preset-k8s-mt-acceptance.sqlite');
      const replacements: Plugin[] = [
        createStorageSqlitePlugin({ databasePath: sqlitePath }),
        createSessionInmemoryPlugin(),
        createSandboxSubprocessPlugin(),
        createIpcServerPlugin(),
        createMultiTenantProxyPlugin({
          scriptByAgentId: new Map([
            ['agent-A', scriptA],
            ['agent-B', scriptB],
          ]),
        }),
        createDiscriminatingAgentsResolvePlugin(),
        createMcpClientPlugin(),
        chatEndRecorder,
      ];

      const plugins: Plugin[] = [...kept, ...replacements];

      const bus = new HookBus();
      const handle = await bootstrap({ bus, plugins, config: {} });

      try {
        // ---- Invocation 1: agent A + user-A → completes with 'from-A'. ----
        const ctxA = makeAgentContext({
          sessionId: 'mt-session-1',
          agentId: 'agent-A',
          userId: 'user-A',
          workspace: { rootPath: tmp },
        });
        const outcomeA: AgentOutcome = await bus.call('agent:invoke', ctxA, {
          message: { role: 'user', content: 'hello from user-A' },
        });
        expect(outcomeA.kind).toBe('complete');
        if (outcomeA.kind !== 'complete') {
          throw new Error(
            `invocation A: expected complete, got ${outcomeA.kind}: ${JSON.stringify(outcomeA)}`,
          );
        }
        const lastA = [...outcomeA.messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        expect(lastA?.content).toContain('from-A');

        // ---- Invocation 2: agent B + user-B → completes with 'from-B'. ----
        const ctxB = makeAgentContext({
          sessionId: 'mt-session-2',
          agentId: 'agent-B',
          userId: 'user-B',
          workspace: { rootPath: tmp },
        });
        const outcomeB: AgentOutcome = await bus.call('agent:invoke', ctxB, {
          message: { role: 'user', content: 'hello from user-B' },
        });
        expect(outcomeB.kind).toBe('complete');
        if (outcomeB.kind !== 'complete') {
          throw new Error(
            `invocation B: expected complete, got ${outcomeB.kind}: ${JSON.stringify(outcomeB)}`,
          );
        }
        const lastB = [...outcomeB.messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        expect(lastB?.content).toContain('from-B');

        // ---- Invocation 3: agent A + user-B → ACL gate rejects. ----
        // The discriminating agents:resolve mock throws
        // PluginError('forbidden') (mirroring production @ax/agents);
        // orchestrator catches and returns terminated/agent-resolve:forbidden.
        const ctxX = makeAgentContext({
          sessionId: 'mt-session-3',
          agentId: 'agent-A',
          userId: 'user-B',
          workspace: { rootPath: tmp },
        });
        const outcomeX: AgentOutcome = await bus.call('agent:invoke', ctxX, {
          message: { role: 'user', content: 'cross-tenant attempt' },
        });
        expect(outcomeX.kind).toBe('terminated');
        if (outcomeX.kind !== 'terminated') {
          throw new Error(
            `invocation X: expected terminated, got ${outcomeX.kind}: ${JSON.stringify(outcomeX)}`,
          );
        }
        // Reason format is `agent-resolve:<PluginError.code>` — we threw
        // code 'forbidden', so the full string is exact.
        expect(outcomeX.reason).toMatch(/^agent-resolve:forbidden/);

        // ---- chat:end fired once per invocation, in order. ----
        // The recorder picks up ctx.sessionId on the receiving side; the
        // cross-tenant invocation reaches chat:end with the original ctx
        // (agents:resolve runs after chat:start but before any sandbox
        // open), so all three sessionIds should be visible here.
        expect(observedChatEnds.length).toBe(3);
        expect(observedChatEnds[0]?.sessionId).toBe('mt-session-1');
        expect(observedChatEnds[0]?.outcome.kind).toBe('complete');
        expect(observedChatEnds[1]?.sessionId).toBe('mt-session-2');
        expect(observedChatEnds[1]?.outcome.kind).toBe('complete');
        expect(observedChatEnds[2]?.sessionId).toBe('mt-session-3');
        expect(observedChatEnds[2]?.outcome.kind).toBe('terminated');
      } finally {
        await handle.shutdown();
      }
    },
  );
});
