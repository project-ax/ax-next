import { describe, it, expect, vi } from 'vitest';
import { type K8sPresetConfig } from '../index.js';

// Capture the config handed to createChatOrchestratorPlugin. vi.hoisted so the
// binding exists before vi.mock's hoisted factory runs. We never drive the real
// orchestrator here — we assert the preset wires it in keepalive mode (I3: the
// warm-sandbox path is actually reachable, not half-wired).
const { captured } = vi.hoisted(() => ({
  captured: { cfg: undefined as Record<string, unknown> | undefined },
}));

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
  workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
  sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  chat: { runnerBinary: '/tmp/stub-runner.js' },
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
});
