import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type K8sPresetConfig } from '../index.js';

// TASK-359. The workspace switch has ONE name: `AX_AGENT_WORKSPACE` in the
// environment, `agentWorkspace` everywhere else. These tests pin the k8s
// preset's half of that: the loader parses the env var (strictly), and
// createK8sPlugins hands the parsed value to @ax/channel-web — which is what
// decides whether `/api/workspace/*` is ever registered.
//
// The OFF cases are the load-bearing ones: a switch that reads ON when nobody
// turned it on is a capability nobody granted (invariant 5).
const { captured } = vi.hoisted(() => ({
  captured: { cfg: undefined as Record<string, unknown> | undefined },
}));

vi.mock('@ax/channel-web/server', () => ({
  createChannelWebServerPlugin: (cfg: Record<string, unknown>) => {
    captured.cfg = cfg;
    return {
      manifest: {
        name: '@ax/channel-web',
        version: '0.0.0',
        registers: [],
        calls: [],
      },
    };
  },
}));

// Import AFTER vi.mock so the SUT picks up the mock.
const { createK8sPlugins, loadK8sConfigFromEnv } = await import('../index.js');

function stubConfig(extra: Partial<K8sPresetConfig> = {}): K8sPresetConfig {
  return {
    database: { connectionString: 'postgres://stub:5432/stub' },
    eventbus: { connectionString: 'postgres://stub:5432/stub' },
    session: { connectionString: 'postgres://stub:5432/stub' },
    workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
    sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
    ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
    http: {
      host: '127.0.0.1',
      port: 0,
      cookieKey: '0'.repeat(64),
      allowedOrigins: [],
    },
    ...extra,
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

describe('@ax/preset-k8s agent workspace switch (TASK-359)', () => {
  beforeEach(() => {
    captured.cfg = undefined;
  });

  it.each([
    ['1', true],
    ['true', true],
    ['0', false],
    ['false', false],
  ])('AX_AGENT_WORKSPACE=%s parses to %s', (raw, want) => {
    expect(loadK8sConfigFromEnv(minRequired({ AX_AGENT_WORKSPACE: raw })).agentWorkspace).toBe(
      want,
    );
  });

  it('unset or empty leaves the field absent (the preset reads that as off)', () => {
    expect('agentWorkspace' in loadK8sConfigFromEnv(minRequired())).toBe(false);
    expect(
      'agentWorkspace' in loadK8sConfigFromEnv(minRequired({ AX_AGENT_WORKSPACE: '' })),
    ).toBe(false);
  });

  it.each(['yes', 'on', 'TRUE', ' 1'])('rejects AX_AGENT_WORKSPACE=%j loudly', (raw) => {
    expect(() => loadK8sConfigFromEnv(minRequired({ AX_AGENT_WORKSPACE: raw }))).toThrowError(
      /AX_AGENT_WORKSPACE/,
    );
  });

  it('the preset does NOT read the retired name — that compat read lives in serve.ts only', () => {
    // If the preset grew its own read of the old name, there would be two
    // live spellings again, which is how this ended up with three.
    const cfg = loadK8sConfigFromEnv(minRequired({ AX_AGENT_WORKSPACE_PREVIEW: '1' }));
    expect('agentWorkspace' in cfg).toBe(false);
  });

  it('hands agentWorkspace=true to @ax/channel-web when on', () => {
    createK8sPlugins(stubConfig({ agentWorkspace: true }));
    expect(captured.cfg?.agentWorkspace).toBe(true);
  });

  it.each([
    ['absent', {}],
    ['false', { agentWorkspace: false }],
  ])('hands agentWorkspace=false to @ax/channel-web when %s', (_label, extra) => {
    createK8sPlugins(stubConfig(extra));
    expect(captured.cfg?.agentWorkspace).toBe(false);
  });

  it('ignores process.env — the switch comes from config, not an ambient lookup', () => {
    // The pre-TASK-359 preset read process.env directly inside
    // createK8sPlugins, which neither the loader tests nor serve's env map
    // could reach.
    const prev = process.env.AX_AGENT_WORKSPACE;
    process.env.AX_AGENT_WORKSPACE = '1';
    try {
      createK8sPlugins(stubConfig());
      expect(captured.cfg?.agentWorkspace).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AX_AGENT_WORKSPACE;
      else process.env.AX_AGENT_WORKSPACE = prev;
    }
  });
});
