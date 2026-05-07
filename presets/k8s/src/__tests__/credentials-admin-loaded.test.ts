import { describe, it, expect } from 'vitest';
import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// @ax/credentials-admin-routes loads conditionally on cfg.credentialsAdmin.
//
// Phase 2 closes its own half-wired window: the plugin is only loaded
// when the operator opts in (matching the chart's
// `credentials.admin.enabled` flag). The wiring smoke test in
// preset.test.ts covers the disabled posture (default config); this file
// pins the flag-to-plugin mapping.
// ---------------------------------------------------------------------------

const baseCfg: K8sPresetConfig = {
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
  auth: {
    devBootstrap: { token: 'stub-bootstrap-token' },
  },
};

describe('credentials-admin-routes loaded conditionally', () => {
  it('loads when cfg.credentialsAdmin === true', () => {
    const plugins = createK8sPlugins({ ...baseCfg, credentialsAdmin: true });
    expect(
      plugins.find((p) => p.manifest.name === '@ax/credentials-admin-routes'),
    ).toBeDefined();
  });

  it('loads @ax/credentials-oauth-pending alongside when credentialsAdmin === true', () => {
    // The OAuth web-paste flow needs an in-memory state holder for the
    // ~5 minute window between /oauth/start and /oauth/finish. The
    // plugin is single-replica only — see its manifest comment. The
    // credentials-admin-routes plugin's manifest declares calls into
    // `credentials:oauth:stash-pending` / `:claim-pending`, so the
    // wiring-invariants check below would fail without this co-load.
    const plugins = createK8sPlugins({ ...baseCfg, credentialsAdmin: true });
    expect(
      plugins.find((p) => p.manifest.name === '@ax/credentials-oauth-pending'),
    ).toBeDefined();
  });

  it('does NOT load when credentialsAdmin is undefined', () => {
    const plugins = createK8sPlugins(baseCfg);
    expect(
      plugins.find((p) => p.manifest.name === '@ax/credentials-admin-routes'),
    ).toBeUndefined();
    expect(
      plugins.find((p) => p.manifest.name === '@ax/credentials-oauth-pending'),
    ).toBeUndefined();
  });

  it('does NOT load when credentialsAdmin === false', () => {
    const plugins = createK8sPlugins({ ...baseCfg, credentialsAdmin: false });
    expect(
      plugins.find((p) => p.manifest.name === '@ax/credentials-admin-routes'),
    ).toBeUndefined();
    expect(
      plugins.find((p) => p.manifest.name === '@ax/credentials-oauth-pending'),
    ).toBeUndefined();
  });

  it('preset wiring invariants hold with credentialsAdmin enabled', () => {
    // When the plugin loads, every `calls` it declares must still resolve
    // to a registrant somewhere in the assembled set. The wiring check in
    // preset.test.ts guards the default posture; this re-runs it against
    // the conditional-on shape so a hook-name typo here surfaces as a
    // unit-test failure, not at bootstrap time.
    const plugins = createK8sPlugins({ ...baseCfg, credentialsAdmin: true });
    const allRegistered = new Set<string>(
      plugins.flatMap((p) => p.manifest.registers),
    );
    const allCalls = new Set<string>(plugins.flatMap((p) => p.manifest.calls));
    const unsatisfied = [...allCalls].filter((c) => !allRegistered.has(c));
    expect(unsatisfied).toEqual([]);
  });
});

describe('AX_CREDENTIALS_ADMIN_ENABLED env var', () => {
  // Pinned via a separate import to keep this file's surface area tight.
  // The env-driven loader must translate the flag exactly so the chart's
  // `--set credentials.admin.enabled=true` actually flips the bit.
  it('AX_CREDENTIALS_ADMIN_ENABLED=true sets credentialsAdmin', async () => {
    const { loadK8sConfigFromEnv } = await import('../index.js');
    const cfg = loadK8sConfigFromEnv({
      DATABASE_URL: 'postgres://stub:5432/stub',
      AX_K8S_HOST_IPC_URL: 'http://stub',
      AX_HTTP_HOST: '0.0.0.0',
      AX_HTTP_PORT: '8080',
      AX_HTTP_COOKIE_KEY: '0'.repeat(64),
      AX_DEV_BOOTSTRAP_TOKEN: 'tok',
      AX_WORKSPACE_BACKEND: 'local',
      AX_WORKSPACE_ROOT: '/tmp/ws',
      AX_CREDENTIALS_ADMIN_ENABLED: 'true',
    });
    expect(cfg.credentialsAdmin).toBe(true);
  });

  it('AX_CREDENTIALS_ADMIN_ENABLED unset leaves credentialsAdmin undefined', async () => {
    const { loadK8sConfigFromEnv } = await import('../index.js');
    const cfg = loadK8sConfigFromEnv({
      DATABASE_URL: 'postgres://stub:5432/stub',
      AX_K8S_HOST_IPC_URL: 'http://stub',
      AX_HTTP_HOST: '0.0.0.0',
      AX_HTTP_PORT: '8080',
      AX_HTTP_COOKIE_KEY: '0'.repeat(64),
      AX_DEV_BOOTSTRAP_TOKEN: 'tok',
      AX_WORKSPACE_BACKEND: 'local',
      AX_WORKSPACE_ROOT: '/tmp/ws',
    });
    expect(cfg.credentialsAdmin).toBeUndefined();
  });
});
