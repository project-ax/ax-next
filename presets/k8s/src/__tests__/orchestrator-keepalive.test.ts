import { describe, it, expect, vi } from 'vitest';
import { type K8sPresetConfig } from '../index.js';

// Capture the config handed to createChatOrchestratorPlugin. vi.hoisted so the
// binding exists before vi.mock's hoisted factory runs. We never drive the real
// orchestrator here — we assert the preset wires it in keepalive mode (I3: the
// warm-sandbox path is actually reachable, not half-wired).
const { captured } = vi.hoisted(() => ({
  captured: {
    cfg: undefined as Record<string, unknown> | undefined,
    webCfg: undefined as Record<string, unknown> | undefined,
  },
}));

// Capture the config handed to channel-web (the stream-buffer sizing hint).
vi.mock('@ax/channel-web/server', async (importActual) => {
  const actual = await importActual<typeof import('@ax/channel-web/server')>();
  return {
    ...actual,
    createChannelWebServerPlugin: (cfg: Record<string, unknown>) => {
      captured.webCfg = cfg;
      return actual.createChannelWebServerPlugin(cfg);
    },
  };
});

vi.mock('@ax/chat-orchestrator', () => ({
  createChatOrchestratorPlugin: (cfg: Record<string, unknown>) => {
    captured.cfg = cfg;
    return {
      manifest: {
        name: '@ax/chat-orchestrator',
        version: '0.0.0',
        registers: [],
        calls: [],
      },
    };
  },
}));

// Import AFTER vi.mock so the SUT picks up the mock.
const { createK8sPlugins } = await import('../index.js');

// Same stub config preset.test.ts uses (static analysis — no real backends).
const stubConfig: K8sPresetConfig = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  blob: { backend: 'fs', root: '/tmp/preset-k8s-stub/blobs' },
  sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  chat: { runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' } },
  http: {
    host: '127.0.0.1',
    port: 0,
    cookieKey: '0'.repeat(64),
    allowedOrigins: [],
  },
};

describe('@ax/preset-k8s orchestrator keepalive', () => {
  it('wires the chat-orchestrator in keepalive mode (warm sandboxes for the chat UI)', () => {
    createK8sPlugins(stubConfig);
    expect(captured.cfg).toBeDefined();
    expect(captured.cfg?.keepAlive).toBe(true);
  });

  // §6.2 / §6.4(5) — the chart's caps clamp the agents' own settings, and the
  // pod ceiling decides when a warm sandbox is too old for a long turn.
  it('passes the turn and idle caps and the sandbox lifetime to the orchestrator', () => {
    createK8sPlugins({
      ...stubConfig,
      sandbox: { ...stubConfig.sandbox, activeDeadlineSeconds: 18_000 },
      chat: { ...stubConfig.chat, maxTurnMinutes: 90, maxIdleMinutes: 45 },
    });
    expect(captured.cfg).toMatchObject({
      maxTurnMinutes: 90, maxIdleMinutes: 45, sandboxMaxLifetimeMs: 18_000_000,
    });
  });

  it('without caps, the orchestrator keeps its own and the sandbox lifetime is the 6 h default', () => {
    createK8sPlugins(stubConfig);
    expect(captured.cfg).not.toHaveProperty('maxTurnMinutes');
    expect(captured.cfg).not.toHaveProperty('maxIdleMinutes');
    expect(captured.cfg?.sandboxMaxLifetimeMs).toBe(21_600_000);
  });

  it('hands channel-web the turn cap in ms, so the stream buffer outlives a long turn', () => {
    createK8sPlugins({ ...stubConfig, chat: { ...stubConfig.chat, maxTurnMinutes: 90 } });
    expect(captured.webCfg?.maxTurnMs).toBe(90 * 60_000);
  });

  it('without a turn cap, channel-web gets no maxTurnMs', () => {
    createK8sPlugins(stubConfig);
    expect(captured.webCfg).not.toHaveProperty('maxTurnMs');
  });
});
