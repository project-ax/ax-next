import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type K8sPresetConfig } from '../index.js';

// TASK-360. The agent workspace is always on — there is no switch any more.
// `AX_AGENT_WORKSPACE` (and the older `AX_AGENT_WORKSPACE_PREVIEW`) are
// retired: existing deployments may still set them, including to `0`, and
// that must NOT fail boot. These tests pin the k8s preset's half of that: the
// loader ignores both names whatever their value, and createK8sPlugins hands
// @ax/channel-web no switch at all. (The one-time warning lives in the CLI's
// serve command — see serve-preset.test.ts.)
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

function stubConfig(): K8sPresetConfig {
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

describe('@ax/preset-k8s retired agent workspace switch (TASK-360)', () => {
  beforeEach(() => {
    captured.cfg = undefined;
  });

  it.each(['AX_AGENT_WORKSPACE', 'AX_AGENT_WORKSPACE_PREVIEW'])(
    'loads fine whatever %s is set to, and ignores it',
    (name) => {
      const baseline = loadK8sConfigFromEnv(minRequired());
      for (const raw of ['0', 'false', '1', 'true', '', 'garbage', ' 1']) {
        const cfg = loadK8sConfigFromEnv(minRequired({ [name]: raw }));
        // Identical to not setting it at all: the value reaches nothing.
        expect(cfg).toEqual(baseline);
        expect('agentWorkspace' in cfg).toBe(false);
      }
    },
  );

  it('hands @ax/channel-web no switch — the workspace simply mounts', () => {
    createK8sPlugins(stubConfig());
    expect(captured.cfg).toBeDefined();
    expect('agentWorkspace' in (captured.cfg ?? {})).toBe(false);
  });

  it('ignores process.env too — there is no ambient lookup to resurrect it', () => {
    const prev = process.env.AX_AGENT_WORKSPACE;
    process.env.AX_AGENT_WORKSPACE = '0';
    try {
      createK8sPlugins(stubConfig());
      expect('agentWorkspace' in (captured.cfg ?? {})).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AX_AGENT_WORKSPACE;
      else process.env.AX_AGENT_WORKSPACE = prev;
    }
  });
});
