import { describe, it, expect, vi } from 'vitest';
import { type K8sPresetConfig } from '../index.js';

// Capture the config handed to createChatOrchestratorPlugin. vi.hoisted so the
// binding exists before vi.mock's hoisted factory runs. Same pattern as
// orchestrator-keepalive.test.ts — we never drive the real orchestrator here,
// we assert the preset builds the runner id -> binary map correctly (PR 2,
// Task 6): defaults resolve @ax/agent-claude-sdk-runner under the
// 'claude-sdk' key, and a partial config.chat.runnerBinaries override MERGES
// with the defaults instead of replacing the whole map.
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
const { createK8sPlugins, loadK8sConfigFromEnv } = await import('../index.js');

// Same stub config preset.test.ts / orchestrator-keepalive.test.ts use
// (static analysis — no real backends).
function stubConfig(chat?: K8sPresetConfig['chat']): K8sPresetConfig {
  return {
    database: { connectionString: 'postgres://stub:5432/stub' },
    eventbus: { connectionString: 'postgres://stub:5432/stub' },
    session: { connectionString: 'postgres://stub:5432/stub' },
    workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
    sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
    ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
    ...(chat !== undefined ? { chat } : {}),
    http: {
      host: '127.0.0.1',
      port: 0,
      cookieKey: '0'.repeat(64),
      allowedOrigins: [],
    },
  };
}

const minRequired = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://u:p@db:5432/ax_next',
  AX_K8S_HOST_IPC_URL: 'http://ax-next-host.ax-next.svc:80',
  AX_WORKSPACE_BACKEND: 'git-protocol',
  AX_WORKSPACE_GIT_SERVER_URL: 'http://git-server:7780',
  AX_WORKSPACE_GIT_SERVER_TOKEN: 't',
  AX_HTTP_HOST: '0.0.0.0',
  AX_HTTP_PORT: '8080',
  AX_HTTP_COOKIE_KEY: '0'.repeat(64),
  AX_HTTP_ALLOWED_ORIGINS: 'https://admin.ax-next.example',
  ...extra,
});

describe('@ax/preset-k8s runner id -> binary map (PR 2 Task 6)', () => {
  it('defaults runnerBinaries to one entry per shipped runner, each resolving its own package', () => {
    createK8sPlugins(stubConfig());
    const runnerBinaries = captured.cfg?.runnerBinaries as Record<string, string> | undefined;
    expect(runnerBinaries).toBeDefined();
    // PR 3 added the second key. The key SET is asserted (not just presence)
    // because a key missing here is not a preset bug that shows up in the
    // preset — it surfaces as a session-open failure for an agent row whose
    // `runner` @ax/agents already accepted.
    expect(Object.keys(runnerBinaries!).sort()).toEqual(['aisdk', 'claude-sdk']);
    expect(runnerBinaries!['claude-sdk']).toContain('agent-claude-sdk-runner');
    expect(runnerBinaries!['aisdk']).toContain('agent-aisdk-runner');
    expect(runnerBinaries!['aisdk']).not.toBe(runnerBinaries!['claude-sdk']);
  });

  it('an explicit chat.runnerBinaries override replaces the claude-sdk entry and keeps the aisdk default', () => {
    createK8sPlugins(stubConfig({ runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' } }));
    const runnerBinaries = captured.cfg?.runnerBinaries as Record<string, string> | undefined;
    expect(runnerBinaries?.['claude-sdk']).toBe('/tmp/stub-runner.js');
    expect(runnerBinaries?.aisdk).toContain('agent-aisdk-runner');
  });

  it('a chat.runnerBinaries override for one key MERGES with (does not drop) the other default', () => {
    createK8sPlugins(stubConfig({ runnerBinaries: { aisdk: '/tmp/aisdk-runner.js' } }));
    const runnerBinaries = captured.cfg?.runnerBinaries as Record<string, string> | undefined;
    expect(runnerBinaries?.aisdk).toBe('/tmp/aisdk-runner.js');
    expect(runnerBinaries?.['claude-sdk']).toContain('agent-claude-sdk-runner');
  });

  // Deliberate as of PR 3: AX_RUNNER_BINARY is the legacy single-runner knob
  // (one path, no runner id in it). It stays claude-sdk-only rather than
  // sprouting a sibling env var per runner; the 'aisdk' default survives
  // because createK8sPlugins merges over the defaults key-by-key.
  it('loadK8sConfigFromEnv maps AX_RUNNER_BINARY onto the claude-sdk key only', () => {
    const cfg = loadK8sConfigFromEnv(minRequired({ AX_RUNNER_BINARY: '/opt/ax-next/runner.js' }));
    expect(cfg.chat?.runnerBinaries).toEqual({ 'claude-sdk': '/opt/ax-next/runner.js' });

    createK8sPlugins(stubConfig(cfg.chat));
    const merged = captured.cfg?.runnerBinaries as Record<string, string> | undefined;
    expect(merged?.['claude-sdk']).toBe('/opt/ax-next/runner.js');
    expect(merged?.aisdk).toContain('agent-aisdk-runner');
  });
});
