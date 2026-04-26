import { describe, expect, it } from 'vitest';
import {
  createK8sPlugins,
  loadK8sConfigFromEnv,
  workspaceConfigFromEnv,
  type K8sPresetConfig,
} from '../index.js';

// ---------------------------------------------------------------------------
// Wiring smoke test for @ax/preset-k8s.
//
// This is a STATIC analysis of the plugin manifests — we never call init()
// on any of the plugins, so postgres / k8s / Anthropic don't have to exist.
// What we're catching:
//
//   1. The preset returns a non-empty plugin list.
//   2. Every service hook is registered by EXACTLY one plugin (Invariant 4:
//      one source of truth — duplicate registrants would throw at bootstrap
//      anyway, but failing fast in a unit test is cheaper).
//   3. Every `calls` entry is satisfied by some plugin's `registers` (no
//      `no-service` errors at boot).
//
// What this DOESN'T catch:
//   - Subscriber-side wiring issues.
//   - Real connectivity (pg, k8s, anthropic).
//   - Hook payload shape mismatches.
//
// Real end-to-end exercise lives in Task 20's CI acceptance test (postgres
// testcontainer + mocked k8s).
//
// Dynamic-hook caveat: a few plugins (mcp-client, ipc-http, tool-
// dispatcher) register hooks dynamically at runtime — `tool:execute:${name}`
// service hooks aren't enumerable until MCP servers connect or tool
// descriptors get registered. That's why those hooks are NOT in any
// manifest's `calls` list either: callers look them up via
// `bus.hasService()` rather than declaring them statically. So the
// "calls satisfied by registers" check is bounded to the static surface,
// which is the right scope for this test.
// ---------------------------------------------------------------------------

const stubConfig: K8sPresetConfig = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
  sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  anthropic: { model: 'claude-sonnet-4-6' },
  // Override the runner binary so resolution doesn't depend on whether
  // @ax/agent-claude-sdk-runner has been built. The chat-orchestrator
  // plugin doesn't validate this string at factory time — only at first
  // sandbox:open-session call — so any non-empty string is fine here.
  chat: { runnerBinary: '/tmp/stub-runner.js' },
  http: {
    host: '127.0.0.1',
    // Static-analysis only: createK8sPlugins doesn't actually call .listen()
    // here, so port 0 is fine — but the assembled plugin's manifest is what
    // these tests scan, not its bound port.
    port: 0,
    // 32-byte hex-encoded zero key — only the length matters for the
    // factory; nothing tries to verify a signature in these tests.
    cookieKey: '0'.repeat(64),
    allowedOrigins: [],
  },
  auth: {
    devBootstrap: { token: 'stub-bootstrap-token' },
  },
};

describe('@ax/preset-k8s wiring', () => {
  it('returns a non-empty plugin array', () => {
    const plugins = createK8sPlugins(stubConfig);
    expect(plugins.length).toBeGreaterThan(0);
  });

  it('every required service hook has exactly one registrant', () => {
    const plugins = createK8sPlugins(stubConfig);
    const registrations = new Map<string, string[]>();
    for (const p of plugins) {
      for (const hook of p.manifest.registers) {
        const owners = registrations.get(hook) ?? [];
        owners.push(p.manifest.name);
        registrations.set(hook, owners);
      }
    }
    const duplicates = [...registrations.entries()].filter(
      ([, owners]) => owners.length > 1,
    );
    expect(duplicates).toEqual([]);
  });

  it('every "calls" entry is satisfied by some plugin\'s "registers"', () => {
    const plugins = createK8sPlugins(stubConfig);
    const allRegistered = new Set<string>(
      plugins.flatMap((p) => p.manifest.registers),
    );
    const allCalls = new Set<string>(plugins.flatMap((p) => p.manifest.calls));
    const unsatisfied = [...allCalls].filter((c) => !allRegistered.has(c));
    expect(unsatisfied).toEqual([]);
  });

  it('contains the expected production plugin set', () => {
    // Sanity check the preset hasn't silently dropped a plugin during a
    // refactor — this is the canary that says "k8s mode means THIS list."
    // If we add or remove a plugin from the preset, this list updates and
    // a reviewer sees the diff in PR.
    const plugins = createK8sPlugins(stubConfig);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(
      [
        '@ax/agents',
        '@ax/audit-log',
        '@ax/auth-oidc',
        '@ax/chat-orchestrator',
        '@ax/credentials',
        '@ax/database-postgres',
        '@ax/eventbus-postgres',
        '@ax/http-server',
        '@ax/ipc-http',
        '@ax/llm-anthropic',
        '@ax/llm-proxy-anthropic-format',
        '@ax/mcp-client',
        '@ax/sandbox-k8s',
        '@ax/session-postgres',
        '@ax/storage-postgres',
        '@ax/teams',
        '@ax/tool-bash',
        '@ax/tool-dispatcher',
        '@ax/tool-file-io',
        '@ax/workspace-git',
      ].sort(),
    );
  });

  it('does NOT include local-mode-only plugins', () => {
    // Belt-and-suspenders: sandbox-subprocess, storage-sqlite, session-
    // inmemory, eventbus-inprocess and llm-mock are for the local profile.
    // If they sneak into the k8s preset, two plugins would register the
    // same service hook and bootstrap would throw — but better to fail
    // here with a clear message than at runtime.
    const plugins = createK8sPlugins(stubConfig);
    const names = new Set(plugins.map((p) => p.manifest.name));
    for (const forbidden of [
      '@ax/sandbox-subprocess',
      '@ax/storage-sqlite',
      '@ax/session-inmemory',
      '@ax/eventbus-inprocess',
      '@ax/llm-mock',
    ]) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});

describe('@ax/preset-k8s workspace backend selection', () => {
  // Catches the wiring gap that motivated Task 19. Before this slice, the
  // preset always pushed @ax/workspace-git regardless of config; the http
  // backend was unreachable from production. These tests pin the
  // discriminated-union → plugin-name mapping.
  it("backend: 'local' registers @ax/workspace-git", () => {
    const plugins = createK8sPlugins({
      ...stubConfig,
      workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
    });
    const names = new Set(plugins.map((p) => p.manifest.name));
    expect(names.has('@ax/workspace-git')).toBe(true);
    expect(names.has('@ax/workspace-git-http')).toBe(false);
  });

  it("backend: 'http' registers @ax/workspace-git-http", () => {
    const plugins = createK8sPlugins({
      ...stubConfig,
      workspace: {
        backend: 'http',
        baseUrl: 'http://git-server.ax-next.svc.cluster.local:7780',
        token: 'stub-token',
      },
    });
    const names = new Set(plugins.map((p) => p.manifest.name));
    expect(names.has('@ax/workspace-git-http')).toBe(true);
    expect(names.has('@ax/workspace-git')).toBe(false);
  });

  it("both backends register the same workspace:* service hooks", () => {
    // Invariant I1 reflex check: regardless of backend the kernel must see
    // the same four service hooks. If a future refactor accidentally drops
    // one from either plugin, this fails before bootstrap does.
    const localPlugins = createK8sPlugins({
      ...stubConfig,
      workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
    });
    const httpPlugins = createK8sPlugins({
      ...stubConfig,
      workspace: {
        backend: 'http',
        baseUrl: 'http://git-server:7780',
        token: 't',
      },
    });
    const wsHooksFor = (plugins: ReturnType<typeof createK8sPlugins>) =>
      plugins
        .flatMap((p) => p.manifest.registers)
        .filter((h) => h.startsWith('workspace:'))
        .sort();
    expect(wsHooksFor(localPlugins)).toEqual([
      'workspace:apply',
      'workspace:diff',
      'workspace:list',
      'workspace:read',
    ]);
    expect(wsHooksFor(httpPlugins)).toEqual([
      'workspace:apply',
      'workspace:diff',
      'workspace:list',
      'workspace:read',
    ]);
  });
});

describe('workspaceConfigFromEnv', () => {
  // The chart writes AX_WORKSPACE_* onto the host pod; the entrypoint reads
  // them via this helper. These tests pin the env → config translation so a
  // typo in either place is a unit-test failure, not a runtime "no workspace
  // plugin" surprise in production.
  it('defaults to local when AX_WORKSPACE_BACKEND is unset', () => {
    expect(
      workspaceConfigFromEnv({ AX_WORKSPACE_ROOT: '/var/lib/ax-next/ws' }),
    ).toEqual({ backend: 'local', repoRoot: '/var/lib/ax-next/ws' });
  });

  it('reads local config from AX_WORKSPACE_ROOT', () => {
    expect(
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'local',
        AX_WORKSPACE_ROOT: '/var/lib/ax-next/ws',
      }),
    ).toEqual({ backend: 'local', repoRoot: '/var/lib/ax-next/ws' });
  });

  it('throws when local backend is missing AX_WORKSPACE_ROOT', () => {
    expect(() =>
      workspaceConfigFromEnv({ AX_WORKSPACE_BACKEND: 'local' }),
    ).toThrowError(/AX_WORKSPACE_ROOT/);
  });

  it('reads http config from AX_WORKSPACE_GIT_HTTP_{URL,TOKEN}', () => {
    expect(
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'http',
        AX_WORKSPACE_GIT_HTTP_URL: 'http://git-server:7780',
        AX_WORKSPACE_GIT_HTTP_TOKEN: 'shh',
      }),
    ).toEqual({
      backend: 'http',
      baseUrl: 'http://git-server:7780',
      token: 'shh',
    });
  });

  it('throws when http backend is missing AX_WORKSPACE_GIT_HTTP_URL', () => {
    expect(() =>
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'http',
        AX_WORKSPACE_GIT_HTTP_TOKEN: 'shh',
      }),
    ).toThrowError(/AX_WORKSPACE_GIT_HTTP_URL/);
  });

  it('throws when http backend is missing AX_WORKSPACE_GIT_HTTP_TOKEN', () => {
    expect(() =>
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'http',
        AX_WORKSPACE_GIT_HTTP_URL: 'http://git-server:7780',
      }),
    ).toThrowError(/AX_WORKSPACE_GIT_HTTP_TOKEN/);
  });

  it('treats empty-string env values as missing (not as valid)', () => {
    // K8s downward-API and missing-secret edges sometimes inject "" rather
    // than unsetting the var. We don't want an empty URL/token to silently
    // pass — it would 401 or DNS-fail at first request and confuse the
    // operator.
    expect(() =>
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'http',
        AX_WORKSPACE_GIT_HTTP_URL: '',
        AX_WORKSPACE_GIT_HTTP_TOKEN: 'shh',
      }),
    ).toThrowError(/AX_WORKSPACE_GIT_HTTP_URL/);
  });

  it('throws on unknown backend value', () => {
    expect(() =>
      workspaceConfigFromEnv({ AX_WORKSPACE_BACKEND: 'sftp' }),
    ).toThrowError(/sftp/);
  });
});

describe('loadK8sConfigFromEnv', () => {
  // Required minimum env: DATABASE_URL, AX_K8S_HOST_IPC_URL, the workspace
  // vars (delegated to workspaceConfigFromEnv), the public-facing http
  // listener vars, and at least one auth provider.
  const HEX_KEY = '0'.repeat(64);
  const minRequired = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    DATABASE_URL: 'postgres://u:p@db:5432/ax_next',
    AX_K8S_HOST_IPC_URL: 'http://ax-next-host.ax-next.svc:80',
    AX_WORKSPACE_BACKEND: 'http',
    AX_WORKSPACE_GIT_HTTP_URL: 'http://git-server:7780',
    AX_WORKSPACE_GIT_HTTP_TOKEN: 't',
    AX_HTTP_HOST: '0.0.0.0',
    AX_HTTP_PORT: '8080',
    AX_HTTP_COOKIE_KEY: HEX_KEY,
    AX_HTTP_ALLOWED_ORIGINS: 'https://admin.ax-next.example',
    AX_DEV_BOOTSTRAP_TOKEN: 'bootstrap-secret',
    ...extra,
  });

  it('builds a config from the minimum required env', () => {
    const cfg = loadK8sConfigFromEnv(minRequired());
    expect(cfg.database.connectionString).toBe('postgres://u:p@db:5432/ax_next');
    expect(cfg.eventbus.connectionString).toBe('postgres://u:p@db:5432/ax_next');
    expect(cfg.session.connectionString).toBe('postgres://u:p@db:5432/ax_next');
    expect(cfg.workspace).toEqual({
      backend: 'http',
      baseUrl: 'http://git-server:7780',
      token: 't',
    });
    expect(cfg.ipc.hostIpcUrl).toBe('http://ax-next-host.ax-next.svc:80');
    expect(cfg.ipc.host).toBeUndefined();
    expect(cfg.ipc.port).toBeUndefined();
    expect(cfg.http).toEqual({
      host: '0.0.0.0',
      port: 8080,
      cookieKey: HEX_KEY,
      allowedOrigins: ['https://admin.ax-next.example'],
    });
    expect(cfg.auth).toEqual({
      devBootstrap: { token: 'bootstrap-secret' },
    });
    expect(cfg.sandbox).toBeUndefined();
    expect(cfg.anthropic).toBeUndefined();
    expect(cfg.chat).toBeUndefined();
  });

  it('throws when DATABASE_URL is missing', () => {
    const env = minRequired();
    delete env.DATABASE_URL;
    expect(() => loadK8sConfigFromEnv(env)).toThrowError(/DATABASE_URL/);
  });

  it('throws when AX_K8S_HOST_IPC_URL is missing', () => {
    const env = minRequired();
    delete env.AX_K8S_HOST_IPC_URL;
    expect(() => loadK8sConfigFromEnv(env)).toThrowError(/AX_K8S_HOST_IPC_URL/);
  });

  it('treats empty-string DATABASE_URL as missing', () => {
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ DATABASE_URL: '' })),
    ).toThrowError(/DATABASE_URL/);
  });

  it('reads sandbox overrides from K8S_* env', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({
        K8S_NAMESPACE: 'ax-next-runners',
        K8S_POD_IMAGE: 'ax-next/agent:1.0.0',
        K8S_RUNTIME_CLASS: 'gvisor',
        K8S_IMAGE_PULL_SECRETS: 'a, b ,c',
      }),
    );
    expect(cfg.sandbox).toEqual({
      namespace: 'ax-next-runners',
      image: 'ax-next/agent:1.0.0',
      runtimeClassName: 'gvisor',
      imagePullSecrets: ['a', 'b', 'c'],
    });
  });

  it('reads BIND_HOST and PORT into ipc.host/port', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({ BIND_HOST: '127.0.0.1', PORT: '9090' }),
    );
    expect(cfg.ipc.host).toBe('127.0.0.1');
    expect(cfg.ipc.port).toBe(9090);
  });

  it('rejects an invalid PORT', () => {
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ PORT: 'not-a-number' })),
    ).toThrowError(/PORT/);
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ PORT: '0' })),
    ).toThrowError(/PORT/);
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ PORT: '99999' })),
    ).toThrowError(/PORT/);
  });

  it('reads anthropic + chat overrides', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({
        AX_LLM_MODEL: 'claude-sonnet-4-6',
        AX_LLM_MAX_TOKENS: '4096',
        AX_RUNNER_BINARY: '/opt/ax-next/runner.js',
        AX_CHAT_TIMEOUT_MS: '60000',
      }),
    );
    expect(cfg.anthropic).toEqual({
      model: 'claude-sonnet-4-6',
      maxTokens: 4096,
    });
    expect(cfg.chat).toEqual({
      runnerBinary: '/opt/ax-next/runner.js',
      chatTimeoutMs: 60000,
    });
  });

  it('rejects an invalid AX_LLM_MAX_TOKENS', () => {
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ AX_LLM_MAX_TOKENS: 'lots' })),
    ).toThrowError(/AX_LLM_MAX_TOKENS/);
  });

  it('rejects an invalid AX_CHAT_TIMEOUT_MS', () => {
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ AX_CHAT_TIMEOUT_MS: '-1' })),
    ).toThrowError(/AX_CHAT_TIMEOUT_MS/);
  });

  it('propagates workspace errors from workspaceConfigFromEnv', () => {
    const env = minRequired();
    delete env.AX_WORKSPACE_GIT_HTTP_TOKEN;
    expect(() => loadK8sConfigFromEnv(env)).toThrowError(/AX_WORKSPACE_GIT_HTTP_TOKEN/);
  });

  it('throws when AX_HTTP_HOST is missing', () => {
    const env = minRequired();
    delete env.AX_HTTP_HOST;
    expect(() => loadK8sConfigFromEnv(env)).toThrowError(/AX_HTTP_HOST/);
  });

  it('throws when AX_HTTP_PORT is missing', () => {
    const env = minRequired();
    delete env.AX_HTTP_PORT;
    expect(() => loadK8sConfigFromEnv(env)).toThrowError(/AX_HTTP_PORT/);
  });

  it('throws when AX_HTTP_PORT is non-numeric', () => {
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ AX_HTTP_PORT: 'http' })),
    ).toThrowError(/AX_HTTP_PORT/);
  });

  it('throws when AX_HTTP_COOKIE_KEY is missing', () => {
    const env = minRequired();
    delete env.AX_HTTP_COOKIE_KEY;
    expect(() => loadK8sConfigFromEnv(env)).toThrowError(/AX_HTTP_COOKIE_KEY/);
  });

  it('treats empty AX_HTTP_ALLOWED_ORIGINS as no allow-list', () => {
    const cfg = loadK8sConfigFromEnv(minRequired({ AX_HTTP_ALLOWED_ORIGINS: '' }));
    expect(cfg.http.allowedOrigins).toEqual([]);
  });

  it('parses comma-separated AX_HTTP_ALLOWED_ORIGINS, trimming whitespace', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({ AX_HTTP_ALLOWED_ORIGINS: ' a , b ,c' }),
    );
    expect(cfg.http.allowedOrigins).toEqual(['a', 'b', 'c']);
  });

  it('throws when no auth provider env is configured', () => {
    const env = minRequired();
    delete env.AX_DEV_BOOTSTRAP_TOKEN;
    expect(() => loadK8sConfigFromEnv(env)).toThrowError(
      /AX_AUTH_GOOGLE_.*AX_DEV_BOOTSTRAP_TOKEN/,
    );
  });

  it('reads google OIDC config when all four AX_AUTH_GOOGLE_* are set', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({
        AX_AUTH_GOOGLE_CLIENT_ID: 'gid',
        AX_AUTH_GOOGLE_CLIENT_SECRET: 'gsec',
        AX_AUTH_GOOGLE_REDIRECT_URI: 'https://h/callback',
        AX_AUTH_GOOGLE_ISSUER: 'https://accounts.google.com',
      }),
    );
    expect(cfg.auth.google).toEqual({
      clientId: 'gid',
      clientSecret: 'gsec',
      redirectUri: 'https://h/callback',
      issuer: 'https://accounts.google.com',
    });
  });

  it('rejects partial google OIDC config', () => {
    // Setting only CLIENT_ID without the other three is a deploy-time bug
    // that the loader catches before the auth plugin's network discovery.
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ AX_AUTH_GOOGLE_CLIENT_ID: 'gid' })),
    ).toThrowError(/AX_AUTH_GOOGLE_CLIENT_SECRET/);
  });

  it('reads AX_AUTH_SESSION_LIFETIME_SECONDS', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({ AX_AUTH_SESSION_LIFETIME_SECONDS: '3600' }),
    );
    expect(cfg.auth.sessionLifetimeSeconds).toBe(3600);
  });

  it('rejects invalid AX_AUTH_SESSION_LIFETIME_SECONDS', () => {
    expect(() =>
      loadK8sConfigFromEnv(
        minRequired({ AX_AUTH_SESSION_LIFETIME_SECONDS: '-1' }),
      ),
    ).toThrowError(/AX_AUTH_SESSION_LIFETIME_SECONDS/);
  });
});
