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
  // auth-better is DB-driven — no providers config at boot. Leave the
  // auth field unset (or empty) and the preset hands an empty config to
  // createAuthBetterPlugin; the operator adds providers via the admin UI
  // after walking the onboarding wizard.
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

  // The two invariant checks above run with the default `stubConfig`, which
  // doesn't enable titles. The conditional title plugins introduce a new
  // `llm:call:anthropic` registrant + matching subscriber call, so they need
  // their own pair of invariant checks — a future refactor that drops
  // `createLlmAnthropicPlugin()` from the conditional block would otherwise
  // pass the default-config tests but break the kernel's topo-sort at boot.
  it('every required service hook has exactly one registrant (titles enabled)', () => {
    const plugins = createK8sPlugins({
      ...stubConfig,
      titles: { model: 'anthropic/claude-haiku-4-5-20251001' },
    });
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

  it('every "calls" entry is satisfied by some plugin\'s "registers" (titles enabled)', () => {
    const plugins = createK8sPlugins({
      ...stubConfig,
      titles: { model: 'anthropic/claude-haiku-4-5-20251001' },
    });
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
        '@ax/auth-better',
        '@ax/channel-web',
        '@ax/chat-orchestrator',
        '@ax/conversations',
        '@ax/credential-proxy',
        '@ax/credentials',
        '@ax/credentials-store-db',
        '@ax/database-postgres',
        '@ax/eventbus-postgres',
        '@ax/http-server',
        '@ax/ipc-http',
        '@ax/mcp-client',
        '@ax/onboarding',
        '@ax/sandbox-k8s',
        '@ax/session-postgres',
        '@ax/storage-postgres',
        '@ax/teams',
        '@ax/tool-dispatcher',
        '@ax/validator-skill',
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

describe('@ax/preset-k8s — onboarding wiring (I3: half-wired window closed)', () => {
  // Proves @ax/onboarding is present in the assembled plugin list and
  // that its service hooks are registered. This test closes Phase 2's
  // half-wired window — after this commit, `ax-next serve` in a k8s
  // deploy exposes the wizard at /setup.
  it('includes @ax/onboarding in the default plugin set', () => {
    const plugins = createK8sPlugins(stubConfig);
    const names = plugins.map((p) => p.manifest.name);
    expect(names).toContain('@ax/onboarding');
  });

  it('@ax/onboarding registers bootstrap:status and bootstrap:complete', () => {
    const plugins = createK8sPlugins(stubConfig);
    const onboarding = plugins.find((p) => p.manifest.name === '@ax/onboarding');
    expect(onboarding, '@ax/onboarding plugin').toBeDefined();
    expect(onboarding!.manifest.registers).toContain('bootstrap:status');
    expect(onboarding!.manifest.registers).toContain('bootstrap:complete');
  });

  it('@ax/onboarding calls are all satisfied by other plugins in the preset', () => {
    // The onboarding plugin calls database:get-instance, http:register-route,
    // auth:create-bootstrap-user, auth:complete-bootstrap-user,
    // auth:require-user, db:transact, credentials:set, agents:create,
    // bootstrap:complete, storage:set — all registered by the other
    // plugins already in the preset. This is the load-bearing assertion.
    const plugins = createK8sPlugins(stubConfig);
    const allRegistered = new Set<string>(
      plugins.flatMap((p) => p.manifest.registers),
    );
    const onboarding = plugins.find((p) => p.manifest.name === '@ax/onboarding');
    expect(onboarding, '@ax/onboarding plugin not found in preset').toBeDefined();
    if (!onboarding) return;
    const unsatisfied = onboarding.manifest.calls.filter(
      (c) => !allRegistered.has(c),
    );
    expect(unsatisfied, `@ax/onboarding calls with no registrant: ${unsatisfied.join(', ')}`).toEqual([]);
  });

  it('loadK8sConfigFromEnv reads AX_PUBLIC_BASE_URL into onboarding.publicBaseUrl', () => {
    const HEX_KEY = '0'.repeat(64);
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://u:p@db:5432/ax_next',
      AX_K8S_HOST_IPC_URL: 'http://ax-next-host.ax-next.svc:80',
      AX_WORKSPACE_BACKEND: 'git-protocol',
      AX_WORKSPACE_GIT_SERVER_URL: 'http://git-server:7780',
      AX_WORKSPACE_GIT_SERVER_TOKEN: 't',
      AX_HTTP_HOST: '0.0.0.0',
      AX_HTTP_PORT: '9090',
      AX_HTTP_COOKIE_KEY: HEX_KEY,
      AX_HTTP_ALLOWED_ORIGINS: '',
      AX_PUBLIC_BASE_URL: 'https://ax.example.com',
    };
    const cfg = loadK8sConfigFromEnv(env);
    expect(cfg.onboarding?.publicBaseUrl).toBe('https://ax.example.com');
  });

  it('loadK8sConfigFromEnv leaves onboarding.publicBaseUrl unset when AX_PUBLIC_BASE_URL is absent', () => {
    const HEX_KEY = '0'.repeat(64);
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://u:p@db:5432/ax_next',
      AX_K8S_HOST_IPC_URL: 'http://ax-next-host.ax-next.svc:80',
      AX_WORKSPACE_BACKEND: 'git-protocol',
      AX_WORKSPACE_GIT_SERVER_URL: 'http://git-server:7780',
      AX_WORKSPACE_GIT_SERVER_TOKEN: 't',
      AX_HTTP_HOST: '0.0.0.0',
      AX_HTTP_PORT: '9090',
      AX_HTTP_COOKIE_KEY: HEX_KEY,
      AX_HTTP_ALLOWED_ORIGINS: '',
    };
    const cfg = loadK8sConfigFromEnv(env);
    expect(cfg.onboarding).toBeUndefined();
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
    expect(names.has('@ax/workspace-git-server')).toBe(false);
  });

  it("backend: 'git-protocol' registers @ax/workspace-git-server", () => {
    const plugins = createK8sPlugins({
      ...stubConfig,
      workspace: {
        backend: 'git-protocol',
        baseUrl: 'http://git-server.ax-next.svc.cluster.local:7780',
        token: 'stub-token',
      },
    });
    const names = new Set(plugins.map((p) => p.manifest.name));
    expect(names.has('@ax/workspace-git-server')).toBe(true);
    expect(names.has('@ax/workspace-git')).toBe(false);
  });

  it("each backend registers the full bundle-aware workspace:* surface", () => {
    // Reflex check: every backend must register all six workspace:*
    // hooks (apply/read/list/diff + apply-bundle + export-baseline-bundle).
    // The earlier four-hook backend (@ax/workspace-git-http) was retired
    // 2026-05-04 because multi-turn writes silently failed without the
    // bundle hooks. If a refactor accidentally drops a hook, this fails
    // before bootstrap does.
    const expected = [
      'workspace:apply',
      'workspace:apply-bundle',
      'workspace:diff',
      'workspace:export-baseline-bundle',
      'workspace:list',
      'workspace:read',
    ];
    const localPlugins = createK8sPlugins({
      ...stubConfig,
      workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
    });
    const gitProtocolPlugins = createK8sPlugins({
      ...stubConfig,
      workspace: {
        backend: 'git-protocol',
        baseUrl: 'http://git-server:7780',
        token: 't',
      },
    });
    const wsHooksFor = (plugins: ReturnType<typeof createK8sPlugins>) =>
      plugins
        .flatMap((p) => p.manifest.registers)
        .filter((h) => h.startsWith('workspace:'))
        .sort();
    expect(wsHooksFor(localPlugins)).toEqual(expected);
    expect(wsHooksFor(gitProtocolPlugins)).toEqual(expected);
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

  // -------------------------------------------------------------------------
  // git-protocol backend. Talks to the sharded git-server storage tier via
  // @ax/workspace-git-server. URL + bearer token, distinct env-var names.
  // -------------------------------------------------------------------------

  it('reads git-protocol config from AX_WORKSPACE_GIT_SERVER_{URL,TOKEN}', () => {
    expect(
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'git-protocol',
        AX_WORKSPACE_GIT_SERVER_URL: 'http://example',
        AX_WORKSPACE_GIT_SERVER_TOKEN: 'secret-token',
      }),
    ).toEqual({
      backend: 'git-protocol',
      baseUrl: 'http://example',
      token: 'secret-token',
    });
  });

  it('throws when git-protocol backend is missing AX_WORKSPACE_GIT_SERVER_URL', () => {
    const token = 'secret-token-do-not-leak';
    let caught: unknown;
    try {
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'git-protocol',
        AX_WORKSPACE_GIT_SERVER_TOKEN: token,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/AX_WORKSPACE_GIT_SERVER_URL/);
    // Token leak check: the thrown error must NOT contain the token literal.
    expect((caught as Error).message).not.toContain(token);
  });

  it('throws when git-protocol backend is missing AX_WORKSPACE_GIT_SERVER_TOKEN', () => {
    const token = 'secret-token-do-not-leak';
    let caught: unknown;
    try {
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'git-protocol',
        AX_WORKSPACE_GIT_SERVER_URL: 'http://example',
        // intentionally NOT setting the TOKEN; the failure happens before any
        // token would be in scope, but we keep the literal handy for the
        // sanity assertion below.
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/AX_WORKSPACE_GIT_SERVER_TOKEN/);
    expect((caught as Error).message).not.toContain(token);
  });

  it('treats empty AX_WORKSPACE_GIT_SERVER_URL as missing (not as valid)', () => {
    expect(() =>
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'git-protocol',
        AX_WORKSPACE_GIT_SERVER_URL: '',
        AX_WORKSPACE_GIT_SERVER_TOKEN: 'shh',
      }),
    ).toThrowError(/AX_WORKSPACE_GIT_SERVER_URL/);
  });

  it('treats empty AX_WORKSPACE_GIT_SERVER_TOKEN as missing (not as valid)', () => {
    const token = '';
    expect(() =>
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'git-protocol',
        AX_WORKSPACE_GIT_SERVER_URL: 'http://example',
        AX_WORKSPACE_GIT_SERVER_TOKEN: token,
      }),
    ).toThrowError(/AX_WORKSPACE_GIT_SERVER_TOKEN/);
  });

  it('does not leak the token in any thrown error message', () => {
    // Belt-and-suspenders: even when both vars are set but the URL is
    // empty, the token literal must never appear in the error message.
    const token = 'super-secret-token-12345';
    let caught: unknown;
    try {
      workspaceConfigFromEnv({
        AX_WORKSPACE_BACKEND: 'git-protocol',
        AX_WORKSPACE_GIT_SERVER_URL: '',
        AX_WORKSPACE_GIT_SERVER_TOKEN: token,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(token);
  });

  it('throws on unknown backend value', () => {
    expect(() =>
      workspaceConfigFromEnv({ AX_WORKSPACE_BACKEND: 'sftp' }),
    ).toThrowError(/sftp/);
  });
});

describe('loadK8sConfigFromEnv', () => {
  // Required minimum env: DATABASE_URL, AX_K8S_HOST_IPC_URL, the workspace
  // vars (delegated to workspaceConfigFromEnv), and the public-facing http
  // listener vars. Auth providers are NOT env-driven — auth-better reads
  // from the auth_providers DB table at runtime, so no auth env is needed
  // at boot.
  const HEX_KEY = '0'.repeat(64);
  const minRequired = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    DATABASE_URL: 'postgres://u:p@db:5432/ax_next',
    AX_K8S_HOST_IPC_URL: 'http://ax-next-host.ax-next.svc:80',
    AX_WORKSPACE_BACKEND: 'git-protocol',
    AX_WORKSPACE_GIT_SERVER_URL: 'http://git-server:7780',
    AX_WORKSPACE_GIT_SERVER_TOKEN: 't',
    AX_HTTP_HOST: '0.0.0.0',
    AX_HTTP_PORT: '8080',
    AX_HTTP_COOKIE_KEY: HEX_KEY,
    AX_HTTP_ALLOWED_ORIGINS: 'https://admin.ax-next.example',
    ...extra,
  });

  it('builds a config from the minimum required env', () => {
    const cfg = loadK8sConfigFromEnv(minRequired());
    expect(cfg.database.connectionString).toBe('postgres://u:p@db:5432/ax_next');
    expect(cfg.eventbus.connectionString).toBe('postgres://u:p@db:5432/ax_next');
    expect(cfg.session.connectionString).toBe('postgres://u:p@db:5432/ax_next');
    expect(cfg.workspace).toEqual({
      backend: 'git-protocol',
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
    // auth-better needs nothing at boot — providers come from DB at runtime.
    expect(cfg.auth).toBeUndefined();
    expect(cfg.sandbox).toBeUndefined();
    expect(cfg.chat).toBeUndefined();
  });

  it('succeeds with no auth env at all (auth-better is DB-driven)', () => {
    // Regression guard: the prior shape (auth-oidc) required at least one
    // of AX_AUTH_GOOGLE_* or AX_DEV_BOOTSTRAP_TOKEN, and the loader threw
    // a `no-auth-providers`-shaped error otherwise. Auth-better reads
    // providers from the `auth_providers` table at runtime, so a fresh
    // boot must succeed without any auth env. The operator walks the
    // /setup wizard and adds providers from the admin UI afterward.
    const cfg = loadK8sConfigFromEnv(minRequired());
    expect(cfg.auth).toBeUndefined();
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

  // Regression: empty K8S_RUNTIME_CLASS must be passed through as the
  // empty string so sandbox-k8s/config.ts skips its `'gvisor'` default.
  // The kind-dev posture sets `sandbox.runtimeClassName: ""` explicitly
  // so runner pod creation doesn't 403 on a cluster without gVisor; if
  // the preset treats empty as "unset", that intent is silently dropped.
  it('honors an explicit empty K8S_RUNTIME_CLASS (kind-dev posture)', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({ K8S_RUNTIME_CLASS: '' }),
    );
    expect(cfg.sandbox?.runtimeClassName).toBe('');
  });

  // Regression: the credential-proxy cross-pod hostPath posture is opt-in
  // via K8S_PROXY_SOCKET_HOST_PATH. Without it the preset must NOT set
  // sandbox.proxySocketHostPath (which would 1) make the host stamp
  // proxy env on runner pods and 2) mount a non-existent hostPath).
  it('reads K8S_PROXY_SOCKET_HOST_PATH into sandbox.proxySocketHostPath', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({ K8S_PROXY_SOCKET_HOST_PATH: '/var/lib/ax-next-proxy' }),
    );
    expect(cfg.sandbox?.proxySocketHostPath).toBe('/var/lib/ax-next-proxy');
  });

  it('leaves proxySocketHostPath unset when K8S_PROXY_SOCKET_HOST_PATH is empty', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({ K8S_PROXY_SOCKET_HOST_PATH: '' }),
    );
    expect(cfg.sandbox?.proxySocketHostPath).toBeUndefined();
  });

  // Regression: AX_PROXY_CA_DIR must end up on credentialProxy.caDir so
  // the host writes its MITM root CA into the shared dir where the
  // runner expects to read it (`/var/run/ax/proxy-ca/ca.crt`).
  it('reads AX_PROXY_CA_DIR into credentialProxy.caDir', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({ AX_PROXY_CA_DIR: '/var/run/ax/proxy-ca' }),
    );
    expect(cfg.credentialProxy?.caDir).toBe('/var/run/ax/proxy-ca');
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

  it('reads chat overrides', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({
        AX_RUNNER_BINARY: '/opt/ax-next/runner.js',
        AX_CHAT_TIMEOUT_MS: '60000',
      }),
    );
    expect(cfg.chat).toEqual({
      runnerBinary: '/opt/ax-next/runner.js',
      chatTimeoutMs: 60000,
    });
  });

  it('rejects an invalid AX_CHAT_TIMEOUT_MS', () => {
    expect(() =>
      loadK8sConfigFromEnv(minRequired({ AX_CHAT_TIMEOUT_MS: '-1' })),
    ).toThrowError(/AX_CHAT_TIMEOUT_MS/);
  });

  it('propagates workspace errors from workspaceConfigFromEnv', () => {
    const env = minRequired();
    delete env.AX_WORKSPACE_GIT_SERVER_TOKEN;
    expect(() => loadK8sConfigFromEnv(env)).toThrowError(/AX_WORKSPACE_GIT_SERVER_TOKEN/);
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

  it('reads AX_AUTH_SESSION_LIFETIME_SECONDS', () => {
    const cfg = loadK8sConfigFromEnv(
      minRequired({ AX_AUTH_SESSION_LIFETIME_SECONDS: '3600' }),
    );
    expect(cfg.auth?.sessionLifetimeSeconds).toBe(3600);
  });

  it('rejects invalid AX_AUTH_SESSION_LIFETIME_SECONDS', () => {
    expect(() =>
      loadK8sConfigFromEnv(
        minRequired({ AX_AUTH_SESSION_LIFETIME_SECONDS: '-1' }),
      ),
    ).toThrowError(/AX_AUTH_SESSION_LIFETIME_SECONDS/);
  });

  describe('loadK8sConfigFromEnv — titles', () => {
    it('omits cfg.titles when ANTHROPIC_API_KEY is unset', () => {
      const cfg = loadK8sConfigFromEnv(minRequired());
      expect(cfg.titles).toBeUndefined();
    });

    it('sets cfg.titles with the default model when ANTHROPIC_API_KEY is set and AX_TITLE_MODEL is unset', () => {
      const cfg = loadK8sConfigFromEnv(minRequired({
        ANTHROPIC_API_KEY: 'sk-ant-stub',
      }));
      expect(cfg.titles).toEqual({ model: 'anthropic/claude-haiku-4-5-20251001' });
    });

    it('respects AX_TITLE_MODEL when set', () => {
      const cfg = loadK8sConfigFromEnv(minRequired({
        ANTHROPIC_API_KEY: 'sk-ant-stub',
        AX_TITLE_MODEL: 'anthropic/claude-sonnet-4-7',
      }));
      expect(cfg.titles).toEqual({ model: 'anthropic/claude-sonnet-4-7' });
    });

    it('treats empty AX_TITLE_MODEL as unset (defaults applied)', () => {
      const cfg = loadK8sConfigFromEnv(minRequired({
        ANTHROPIC_API_KEY: 'sk-ant-stub',
        AX_TITLE_MODEL: '',
      }));
      expect(cfg.titles).toEqual({ model: 'anthropic/claude-haiku-4-5-20251001' });
    });
  });
});

describe('createK8sPlugins — conditional title plugins', () => {
  it('omits @ax/llm-anthropic and @ax/conversation-titles when cfg.titles is undefined', () => {
    const plugins = createK8sPlugins(stubConfig);
    const names = plugins.map((p) => p.manifest.name);
    expect(names).not.toContain('@ax/llm-anthropic');
    expect(names).not.toContain('@ax/conversation-titles');
  });

  it('includes both plugins when cfg.titles is set', () => {
    const plugins = createK8sPlugins({
      ...stubConfig,
      titles: { model: 'anthropic/claude-haiku-4-5-20251001' },
    });
    const names = plugins.map((p) => p.manifest.name);
    expect(names).toContain('@ax/llm-anthropic');
    expect(names).toContain('@ax/conversation-titles');
  });

  it('passes cfg.titles.model into the conversation-titles plugin manifest', () => {
    const plugins = createK8sPlugins({
      ...stubConfig,
      titles: { model: 'anthropic/claude-sonnet-4-7' },
    });
    const titlesPlugin = plugins.find(
      (p) => p.manifest.name === '@ax/conversation-titles',
    );
    expect(titlesPlugin).toBeDefined();
    expect(titlesPlugin!.manifest.calls).toContain('llm:call:anthropic');
  });

  it('throws invalid-config when titles.model uses a non-anthropic provider', () => {
    // The preset only ships @ax/llm-anthropic. A non-anthropic provider
    // would leave `llm:call:<provider>` unregistered and the kernel's
    // topo-sort would fail at bootstrap with an opaque error. We catch
    // it here at construction time with a message that names the
    // offending value.
    expect(() =>
      createK8sPlugins({
        ...stubConfig,
        titles: { model: 'openai/gpt-4' },
      }),
    ).toThrowError(/openai\/gpt-4/);
  });
});
