import { createRequire } from 'node:module';
import { PluginError, type Plugin } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createEventbusPostgresPlugin } from '@ax/eventbus-postgres';
import { createSessionPostgresPlugin } from '@ax/session-postgres';
import { createWorkspaceGitPlugin } from '@ax/workspace-git';
import { createWorkspaceGitHttpPlugin } from '@ax/workspace-git-http';
import { createSandboxK8sPlugin } from '@ax/sandbox-k8s';
import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';
import { createLlmProxyAnthropicFormatPlugin } from '@ax/llm-proxy-anthropic-format';
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import { createToolBashPlugin } from '@ax/tool-bash';
import { createToolFileIoPlugin } from '@ax/tool-file-io';
import { auditLogPlugin } from '@ax/audit-log';
import { createMcpClientPlugin } from '@ax/mcp-client';
import { createCredentialProxyPlugin } from '@ax/credential-proxy';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsAnthropicOauthPlugin } from '@ax/credentials-anthropic-oauth';
import { createIpcHttpPlugin } from '@ax/ipc-http';
import { createAgentsPlugin } from '@ax/agents';
import { createHttpServerPlugin } from '@ax/http-server';
import { createAuthPlugin, type AuthConfig } from '@ax/auth-oidc';
import { createTeamsPlugin } from '@ax/teams';
import { createStaticFilesPlugin } from '@ax/static-files';

// ---------------------------------------------------------------------------
// @ax/preset-k8s — production assembly: postgres trio + workspace-git +
// sandbox-k8s + claude-sdk runner.
//
// Per architecture doc Section 9, a preset is a meta-package: bumping its
// version ships a coordinated release of "k8s mode is now this set of plugin
// versions." The runtime contribution is `createK8sPlugins(config)`, which
// returns the assembled plugin list ready for `bootstrap()`.
//
// Why this lives in a preset and not the CLI:
//   - The CLI assembles the LOCAL profile (sqlite + sandbox-subprocess +
//     session-inmemory). That set is fine for a single laptop and the canary
//     test, but it can't run multi-replica because session/storage/eventbus
//     are in-process.
//   - The k8s profile swaps in the postgres trio (cross-process state),
//     workspace-git (durable workspace versioning), and sandbox-k8s (pods
//     instead of subprocesses).
//   - The CLI is the one place permitted to import plugins directly
//     (eslint allowlist); presets/** is in the same allowlist for the same
//     reason — they exist to compose plugins.
//
// Order matters for plugin loading. The kernel tops-sorts on declared
// calls/registers, but pushing in a sensible order keeps the intent obvious
// to readers. We mirror the CLI's order for the equivalent plugins:
//   1. database / storage / credentials (stateful base layer)
//   2. eventbus / session (cross-process coordination)
//   3. workspace (versioned content)
//   4. audit-log (subscribes to chat:end; calls storage:set)
//   5. http-server / auth / teams (control plane access — Week 9.5)
//   6. sandbox / ipc-http / llm-proxy / chat-orchestrator (chat plane)
//   7. tool-dispatcher → tool descriptors → mcp-client (catalog assembly)
//   8. agents (admin endpoints + agents:resolve gate)
//   9. llm-anthropic (last; everything else is in place when init runs)
// ---------------------------------------------------------------------------

const requireFromPreset = createRequire(import.meta.url);

/**
 * Default location of the claude-sdk runner binary. Resolved against the
 * preset's own URL so pnpm hoisting and prod/dev installs both work.
 */
function defaultRunnerBinary(): string {
  return requireFromPreset.resolve('@ax/agent-claude-sdk-runner');
}

const DEFAULT_CHAT_TIMEOUT_MS = 10 * 60_000;

const COOKIE_KEY_BYTES = 32;

/**
 * Parse the http cookie signing key from the preset config's string form
 * (64 hex chars OR 44 base64 chars → 32 raw bytes). Mirrors the parser
 * inside @ax/http-server (which we can't import — Invariant I2 — even
 * though the preset itself is on the cross-plugin allowlist, copying the
 * three-line check keeps the contract here legible).
 */
function parseCookieKeyString(raw: string): Buffer {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new PluginError({
      code: 'invalid-cookie-key',
      plugin: '@ax/preset-k8s',
      message:
        'http.cookieKey is required (32 bytes; 64 hex chars or 44 base64 chars)',
    });
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === COOKIE_KEY_BYTES) return b64;
  throw new PluginError({
    code: 'invalid-cookie-key',
    plugin: '@ax/preset-k8s',
    message:
      'http.cookieKey must be 32 bytes (64 hex chars or 44 base64 chars)',
  });
}

/**
 * Discriminated union for the workspace backend. `local` keeps the
 * single-replica on-PVC bare repo path; `http` forwards every workspace op to
 * the shared git-server pod so multiple host replicas can share state.
 */
export type K8sWorkspaceConfig =
  | { backend: 'local'; repoRoot: string }
  | { backend: 'http'; baseUrl: string; token: string };

export interface K8sPresetConfig {
  /**
   * Postgres pool config used by @ax/database-postgres + @ax/storage-postgres.
   * (Storage doesn't take its own connection — it reaches the shared pool
   * via `database:get-instance`.)
   */
  database: {
    connectionString: string;
    poolMax?: number;
  };
  /**
   * Eventbus opens its OWN dedicated pg.Client for LISTEN/NOTIFY — pooled
   * connections can't hold a LISTEN binding through idle returns. So this
   * is intentionally a separate connectionString (typically the same DSN).
   */
  eventbus: {
    connectionString: string;
  };
  /**
   * Same deal: session-postgres opens its own pool + listen client because
   * inbox claim-work blocks on LISTEN. Configured separately.
   */
  session: {
    connectionString: string;
    poolMax?: number;
  };
  /**
   * Workspace backend selection. Two flavors:
   *
   *   - `local`: `@ax/workspace-git` writes a bare repo on the host pod's PVC.
   *     Single-replica deploys only — two hosts mounting the same RWO PVC
   *     would race. `repoRoot` is the directory hosting `<repoRoot>/repo.git`;
   *     the plugin idempotently `git init`s it on first use.
   *
   *   - `http`: `@ax/workspace-git-http` forwards every workspace op to the
   *     dedicated git-server pod over HTTP. Multi-replica capable. `baseUrl`
   *     points at the git-server's cluster Service; `token` is the shared
   *     bearer token (via Helm-managed Secret).
   *
   * The Helm chart drives this via `workspace.backend: local|http` and the
   * env vars `AX_WORKSPACE_BACKEND` / `AX_WORKSPACE_ROOT` /
   * `AX_WORKSPACE_GIT_HTTP_URL` / `AX_WORKSPACE_GIT_HTTP_TOKEN`. The host
   * entrypoint reads those and constructs this config.
   */
  workspace: K8sWorkspaceConfig;
  /**
   * Pod template + readiness/limits config for sandbox-k8s. All fields
   * optional; defaults live in @ax/sandbox-k8s/src/config.ts.
   */
  sandbox?: {
    namespace?: string;
    image?: string;
    runtimeClassName?: string;
    imagePullSecrets?: string[];
    cpuLimit?: string;
    memoryLimit?: string;
    cpuRequest?: string;
    memoryRequest?: string;
    activeDeadlineSeconds?: number;
    readinessPollMs?: number;
    readinessTimeoutMs?: number;
  };
  /**
   * IPC listener config — the host pod's @ax/ipc-http TCP listener that
   * runner pods connect to. `hostIpcUrl` is required (no useful default;
   * it depends on the chart's Service config). `host`/`port` default to
   * '0.0.0.0' / 8080 — the bind address inside the host pod.
   */
  ipc: {
    /** Host the @ax/ipc-http listener binds to. Default '0.0.0.0'. */
    host?: string;
    /** Port the @ax/ipc-http listener binds to. Default 8080. */
    port?: number;
    /**
     * Cluster-internal URL the runner pods use to reach the host's IPC
     * listener (e.g. `http://ax-next-host.ax-next.svc.cluster.local:80`).
     * Required — there is no useful default; the right value comes from
     * the chart's Service config (Task 12 wires the env-read).
     */
    hostIpcUrl: string;
  };
  /**
   * Anthropic LLM config. ANTHROPIC_API_KEY must be in env at plugin init
   * (the plugin throws otherwise — secrets stay out of the config).
   */
  anthropic?: {
    model?: string;
    maxTokens?: number;
  };
  /**
   * Chat orchestrator overrides. `runnerBinary` defaults to the resolved
   * @ax/agent-claude-sdk-runner; tests/embedders may override it.
   */
  chat?: {
    runnerBinary?: string;
    chatTimeoutMs?: number;
    oneShot?: boolean;
  };
  /**
   * @ax/http-server config. The host listener that serves /admin/*, /auth/*,
   * /admin/me, /admin/sign-out, and (Week 10-12) the admin UI. Distinct from
   * the @ax/ipc-http listener above — that one is the runner-pod ↔ host
   * back-channel and never faces public traffic.
   *
   * `cookieKey` accepts either 64 hex chars or 44 base64 chars (32-byte key).
   * It's parsed by the preset and handed to the plugin as a Buffer. We
   * deliberately keep the string form on the preset config so the type is
   * JSON-serializable for the chart's ConfigMap path.
   *
   * `allowedOrigins` is the exact-match CSRF allow-list for state-changing
   * methods. The admin UI's origin (Week 10-12) lands here; for now the
   * chart provides whatever the operator sets via env.
   */
  http: {
    /** Bind address. Default '0.0.0.0' for in-cluster; '127.0.0.1' for tests. */
    host: string;
    /** Bind port. Pass 0 for OS-assigned (tests). */
    port: number;
    /** 32-byte signing key as 64 hex chars or 44 base64 chars. */
    cookieKey: string;
    /** Exact-match CSRF allow-list. Empty allows only X-Requested-With callers. */
    allowedOrigins: string[];
  };
  /**
   * @ax/auth config. At least one of `google` (OIDC) or `devBootstrap`
   * MUST be set; the plugin throws `no-auth-providers` otherwise.
   *
   * Production deploys typically set `google` only. Dev / canary / kind
   * deploys set `devBootstrap` only. Both can coexist for staging-like
   * environments — the auth plugin won't refuse it.
   */
  auth: {
    google?: {
      clientId: string;
      clientSecret: string;
      issuer: string;
      redirectUri: string;
    };
    /**
     * If present, mints a single shared `is_admin` user from the pre-shared
     * token via `POST /auth/dev-bootstrap`. Refused outright when
     * `NODE_ENV=production` (the auth plugin throws at init).
     */
    devBootstrap?: { token: string };
    /** Session cookie lifetime. Default 7 days (in @ax/auth). */
    sessionLifetimeSeconds?: number;
  };
  /**
   * Phase 2 — credential-proxy socket override. Defaults to
   * `/var/run/ax/proxy.sock` (matches the helm chart's emptyDir mount
   * point on host pods). Tests pass a per-test tmpdir so unprivileged
   * users can bind. Production deploys leave this unset.
   *
   * `caDir` overrides where the MITM CA private key + cert PEM live;
   * defaults to `~/.ax/proxy-ca` inside the credential-proxy plugin.
   * Tests override to keep cruft out of the user's home; production
   * leaves this unset (or sets a chart-mounted persistent path).
   */
  credentialProxy?: {
    socketPath?: string;
    caDir?: string;
  };
  /**
   * Optional static-file serving (production single-binary mode). When
   * set, mounts `@ax/static-files` after the API routes so it serves
   * channel-web's bundle on otherwise-unmatched paths. SPA fallback
   * defaults to `true` (returns `index.html` for unknown paths so
   * client-side routing works). Leave unset for dev — Vite handles
   * static + proxy in dev.
   */
  staticFiles?: {
    /** Absolute path to the directory to serve (e.g., channel-web/dist). */
    dir: string;
    /** URL pattern, defaults to `/*`. */
    mountPath?: string;
    /**
     * SPA fallback (default `true` = serve `index.html` on miss).
     * Pass a string to use a different fallback file; pass `false`
     * to return 404 on miss.
     */
    spaFallback?: boolean | string;
  };
}

/**
 * Build the production plugin list for k8s mode. Pass the result straight to
 * `bootstrap({ bus, plugins, config: {} })` from @ax/core.
 *
 * Note: the runner binary resolution and Anthropic API key both rely on
 * runtime environment (the binary lookup walks node_modules, the API key
 * comes from process.env). That's intentional — secrets and resolved paths
 * are not in the JSON config schema.
 */
export function createK8sPlugins(config: K8sPresetConfig): Plugin[] {
  const plugins: Plugin[] = [];

  // ----- 1. stateful base layer ------------------------------------------
  // database-postgres owns the shared pg.Pool. storage-postgres reaches it
  // via `database:get-instance` (not a direct import — invariant I2).
  plugins.push(
    createDatabasePostgresPlugin({
      connectionString: config.database.connectionString,
      ...(config.database.poolMax !== undefined
        ? { poolMax: config.database.poolMax }
        : {}),
    }),
  );
  plugins.push(createStoragePostgresPlugin());

  // Credentials: facade over the storage-blob seam. The default backend
  // (@ax/credentials-store-db) wraps storage:get/storage:set with the
  // `credential:` key prefix; the facade owns AES-256-GCM and the
  // consumer-facing credentials:get/set/delete contract. Init throws if
  // AX_CREDENTIALS_KEY isn't in env.
  plugins.push(createCredentialsStoreDbPlugin());
  plugins.push(createCredentialsPlugin());

  // Phase 3 — Anthropic OAuth per-kind sub-services. Same load reasoning
  // as the CLI preset: purely additive, only dispatches when an agent
  // actually carries a kind: 'anthropic-oauth' credential. Web-chat OAuth
  // routes (Phase 10–12) will register HTTP handlers from this plugin.
  plugins.push(createCredentialsAnthropicOauthPlugin());

  // Phase 2 — credential-proxy on a Unix socket. The host pod mounts an
  // emptyDir at /var/run/ax (helm template); the proxy listens on
  // <mount>/proxy.sock. Sandbox pods get the SAME emptyDir mounted via
  // the pod template, so they can dial the socket directly. The runner-
  // side @ax/credential-proxy-bridge converts that to a loopback TCP
  // port inside the sandbox before HTTP(S)_PROXY-aware libraries reach
  // it. (Off-the-shelf libraries can't dial a Unix socket directly.)
  //
  // Real Anthropic credentials are seeded by the admin via the standard
  // credentials store (POST /admin/credentials, Phase 9.5); the proxy
  // resolves them at proxy:open-session time and substitutes the
  // ax-cred:<hex> placeholder into outbound headers mid-flight.
  const credentialProxyCfg: Parameters<typeof createCredentialProxyPlugin>[0] = {
    listen: {
      kind: 'unix',
      path: config.credentialProxy?.socketPath ?? '/var/run/ax/proxy.sock',
    },
  };
  if (config.credentialProxy?.caDir !== undefined) {
    credentialProxyCfg.caDir = config.credentialProxy.caDir;
  }
  plugins.push(createCredentialProxyPlugin(credentialProxyCfg));

  // ----- 2. cross-process coordination ----------------------------------
  // Eventbus and session each own a dedicated LISTEN client.
  plugins.push(
    createEventbusPostgresPlugin({
      connectionString: config.eventbus.connectionString,
    }),
  );
  plugins.push(
    createSessionPostgresPlugin({
      connectionString: config.session.connectionString,
      ...(config.session.poolMax !== undefined
        ? { poolMax: config.session.poolMax }
        : {}),
    }),
  );

  // ----- 3. workspace ----------------------------------------------------
  // Discriminated on `backend`. The shape difference is intentional: `local`
  // wants a filesystem path, `http` wants a URL + bearer token. Both register
  // the same four `workspace:*` service hooks (Invariant I1 — the contract is
  // the same regardless of backend).
  if (config.workspace.backend === 'http') {
    plugins.push(
      createWorkspaceGitHttpPlugin({
        baseUrl: config.workspace.baseUrl,
        token: config.workspace.token,
      }),
    );
  } else {
    plugins.push(
      createWorkspaceGitPlugin({
        repoRoot: config.workspace.repoRoot,
      }),
    );
  }

  // ----- 4. audit log ----------------------------------------------------
  // Subscribes to chat:end and writes a record via storage:set. Pushed
  // before the chat-orchestrator so its subscription is in place when the
  // first chat:end fires.
  plugins.push(auditLogPlugin());

  // ----- 5. control-plane access (Week 9.5) -----------------------------
  // http-server provides the public-facing listener. auth registers the
  // /auth/* + /admin/{me,sign-out} routes and the auth:require-user gate
  // every admin endpoint depends on. teams owns /admin/teams* and the
  // teams:* hooks the agents-plugin's team-visibility ACL calls.
  //
  // Boot order: the kernel topologically sorts on `manifest.calls`
  // (http:register-route → @ax/http-server, auth:require-user → @ax/auth),
  // so even if we shuffled the array the kernel would init http-server
  // before auth before agents/teams. We push in the conceptual order to
  // keep the intent legible to readers.
  plugins.push(
    createHttpServerPlugin({
      host: config.http.host,
      port: config.http.port,
      cookieKey: parseCookieKeyString(config.http.cookieKey),
      allowedOrigins: config.http.allowedOrigins,
    }),
  );

  const authConfig: AuthConfig = { providers: {} };
  if (config.auth.google !== undefined) {
    authConfig.providers.google = {
      clientId: config.auth.google.clientId,
      clientSecret: config.auth.google.clientSecret,
      issuer: config.auth.google.issuer,
      redirectUri: config.auth.google.redirectUri,
    };
  }
  if (config.auth.devBootstrap !== undefined) {
    authConfig.devBootstrap = { token: config.auth.devBootstrap.token };
  }
  if (config.auth.sessionLifetimeSeconds !== undefined) {
    authConfig.sessionLifetimeSeconds = config.auth.sessionLifetimeSeconds;
  }
  plugins.push(createAuthPlugin(authConfig));

  // teams: mountAdminRoutes:true so /admin/teams* lands alongside the rest
  // of the admin surface. The plugin's manifest expands `calls` to include
  // http:register-route + auth:require-user when this flag is set, which
  // is exactly what the kernel's topo-sort needs to see.
  plugins.push(createTeamsPlugin({ mountAdminRoutes: true }));

  // static-files (optional): serves channel-web's bundle from the same
  // listener so cookies and CSRF stay same-origin in production. The
  // plugin registers a `/*` catchall LAST so every API route registered
  // earlier wins. When `staticFiles` is unset, no catchall is mounted
  // and unknown paths return 404 — the dev workflow uses Vite's proxy
  // instead. SPA fallback defaults on so client-side routing works.
  if (config.staticFiles !== undefined) {
    plugins.push(
      createStaticFilesPlugin({
        dir: config.staticFiles.dir,
        ...(config.staticFiles.mountPath !== undefined
          ? { mountPath: config.staticFiles.mountPath }
          : {}),
        spaFallback: config.staticFiles.spaFallback ?? true,
      }),
    );
  }

  // ----- 6. chat plane ---------------------------------------------------
  // sandbox-k8s registers `sandbox:open-session`. No subprocess fallback
  // here — this preset is k8s-only.
  const sandboxOpts = {
    hostIpcUrl: config.ipc.hostIpcUrl,
    ...(config.sandbox?.namespace !== undefined
      ? { namespace: config.sandbox.namespace }
      : {}),
    ...(config.sandbox?.image !== undefined
      ? { image: config.sandbox.image }
      : {}),
    ...(config.sandbox?.runtimeClassName !== undefined
      ? { runtimeClassName: config.sandbox.runtimeClassName }
      : {}),
    ...(config.sandbox?.imagePullSecrets !== undefined
      ? { imagePullSecrets: config.sandbox.imagePullSecrets }
      : {}),
    ...(config.sandbox?.cpuLimit !== undefined
      ? { cpuLimit: config.sandbox.cpuLimit }
      : {}),
    ...(config.sandbox?.memoryLimit !== undefined
      ? { memoryLimit: config.sandbox.memoryLimit }
      : {}),
    ...(config.sandbox?.cpuRequest !== undefined
      ? { cpuRequest: config.sandbox.cpuRequest }
      : {}),
    ...(config.sandbox?.memoryRequest !== undefined
      ? { memoryRequest: config.sandbox.memoryRequest }
      : {}),
    ...(config.sandbox?.activeDeadlineSeconds !== undefined
      ? { activeDeadlineSeconds: config.sandbox.activeDeadlineSeconds }
      : {}),
    ...(config.sandbox?.readinessPollMs !== undefined
      ? { readinessPollMs: config.sandbox.readinessPollMs }
      : {}),
    ...(config.sandbox?.readinessTimeoutMs !== undefined
      ? { readinessTimeoutMs: config.sandbox.readinessTimeoutMs }
      : {}),
  };
  plugins.push(createSandboxK8sPlugin(sandboxOpts));

  plugins.push(
    createIpcHttpPlugin({
      host: config.ipc.host ?? '0.0.0.0',
      port: config.ipc.port ?? 8080,
    }),
  );
  plugins.push(createLlmProxyAnthropicFormatPlugin());

  const orchestratorCfg: Parameters<typeof createChatOrchestratorPlugin>[0] = {
    runnerBinary: config.chat?.runnerBinary ?? defaultRunnerBinary(),
    chatTimeoutMs: config.chat?.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
  };
  if (config.chat?.oneShot !== undefined) {
    orchestratorCfg.oneShot = config.chat.oneShot;
  }
  plugins.push(createChatOrchestratorPlugin(orchestratorCfg));

  // ----- 7. tool catalog -------------------------------------------------
  // Dispatcher first — it registers `tool:register` / `tool:list`. The
  // descriptor-only tool plugins (bash, file-io) call `tool:register` from
  // their init. mcp-client also calls `tool:register` from init.
  //
  // mcp-client gets `mountAdminRoutes: true` so /admin/mcp-servers* lands
  // alongside the rest of the admin surface. The flag expands the plugin's
  // manifest `calls` to include http:register-route + auth:require-user;
  // the kernel's topo-sort picks up the new edges automatically.
  plugins.push(createToolDispatcherPlugin());
  plugins.push(createToolBashPlugin());
  plugins.push(createToolFileIoPlugin());
  plugins.push(createMcpClientPlugin({ mountAdminRoutes: true }));

  // ----- 8. agents -------------------------------------------------------
  // Registers `agents:resolve` (the ACL gate the chat-orchestrator hard-
  // depends on as of Week 9.5) AND mounts /admin/agents* routes. The
  // plugin's manifest `calls` already declares http:register-route +
  // auth:require-user as hard deps — the kernel's topo-sort blocks init
  // until both upstream plugins have registered. Reuses the shared
  // postgres pool via `database:get-instance` (no second pool).
  plugins.push(createAgentsPlugin());

  // ----- 9. LLM ----------------------------------------------------------
  // Throws at init if ANTHROPIC_API_KEY is missing.
  const anthropicCfg: Parameters<typeof createLlmAnthropicPlugin>[0] = {};
  if (config.anthropic?.model !== undefined) {
    anthropicCfg.model = config.anthropic.model;
  }
  if (config.anthropic?.maxTokens !== undefined) {
    anthropicCfg.maxTokens = config.anthropic.maxTokens;
  }
  plugins.push(createLlmAnthropicPlugin(anthropicCfg));

  return plugins;
}

// ---------------------------------------------------------------------------
// Env → workspace-config helper.
//
// The Helm chart writes these env vars onto the host pod (see
// deploy/charts/ax-next/templates/host/deployment.yaml). The host entrypoint
// reads them via this helper to build the discriminated `workspace` config
// before calling `createK8sPlugins`.
//
//   AX_WORKSPACE_BACKEND        local | http   (default: local)
//   AX_WORKSPACE_ROOT           required when backend === 'local'
//   AX_WORKSPACE_GIT_HTTP_URL   required when backend === 'http'
//   AX_WORKSPACE_GIT_HTTP_TOKEN required when backend === 'http'
//
// We throw loudly on missing/unknown values rather than silently defaulting
// — a misconfigured workspace backend is a deploy-time bug, not a runtime
// surprise we want to paper over.
// ---------------------------------------------------------------------------

/**
 * Read the `AX_WORKSPACE_*` env vars and return a `K8sWorkspaceConfig`.
 *
 * Defaults to `local` when `AX_WORKSPACE_BACKEND` is unset (matches the
 * chart's default). Throws when the chosen backend's required vars are
 * missing or when the backend value is unknown.
 *
 * @param env - the env map to read from. Defaults to `process.env`. Pass an
 *   explicit object to keep tests deterministic (don't rely on the real
 *   `process.env` leaking between cases).
 */
export function workspaceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): K8sWorkspaceConfig {
  // Treat empty string as unset. Helm templates frequently render
  // `value: "{{ .Values.workspace.backend }}"` with an empty value when
  // the user hasn't overridden it; we want that case to default to local
  // rather than fall through to the unknown-backend branch.
  const rawBackend = env.AX_WORKSPACE_BACKEND;
  const backend = rawBackend === undefined || rawBackend === '' ? 'local' : rawBackend;

  if (backend === 'local') {
    const repoRoot = env.AX_WORKSPACE_ROOT;
    if (repoRoot === undefined || repoRoot === '') {
      throw new Error(
        'AX_WORKSPACE_BACKEND=local requires AX_WORKSPACE_ROOT to be set',
      );
    }
    return { backend: 'local', repoRoot };
  }

  if (backend === 'http') {
    const baseUrl = env.AX_WORKSPACE_GIT_HTTP_URL;
    const token = env.AX_WORKSPACE_GIT_HTTP_TOKEN;
    if (baseUrl === undefined || baseUrl === '') {
      throw new Error(
        'AX_WORKSPACE_BACKEND=http requires AX_WORKSPACE_GIT_HTTP_URL to be set',
      );
    }
    if (token === undefined || token === '') {
      throw new Error(
        'AX_WORKSPACE_BACKEND=http requires AX_WORKSPACE_GIT_HTTP_TOKEN to be set',
      );
    }
    return { backend: 'http', baseUrl, token };
  }

  throw new Error(
    `unknown AX_WORKSPACE_BACKEND=${backend}; expected 'local' or 'http'`,
  );
}

// ---------------------------------------------------------------------------
// Full env loader. Builds a `K8sPresetConfig` from the env vars the Helm chart
// stamps onto the host pod. Mirrors `workspaceConfigFromEnv`'s posture: throw
// loudly on missing required values rather than silently default.
//
// Required env (per the chart):
//   - DATABASE_URL                — postgres DSN (database/eventbus/session)
//   - AX_K8S_HOST_IPC_URL          — cluster URL runners use to reach @ax/ipc-http
//   - AX_WORKSPACE_BACKEND + the per-backend vars (delegated to workspaceConfigFromEnv)
//   - AX_HTTP_HOST / AX_HTTP_PORT  — public-facing http listener
//   - AX_HTTP_COOKIE_KEY           — 32-byte signing key (hex / base64)
//   - AX_HTTP_ALLOWED_ORIGINS      — CSRF allow-list (comma-separated)
//   - At least one of:
//       AX_AUTH_GOOGLE_{CLIENT_ID,CLIENT_SECRET,REDIRECT_URI,ISSUER}
//       AX_DEV_BOOTSTRAP_TOKEN
//
// Optional env:
//   - K8S_NAMESPACE / K8S_POD_IMAGE / K8S_RUNTIME_CLASS / K8S_IMAGE_PULL_SECRETS
//                                  — sandbox-k8s overrides
//   - BIND_HOST / PORT             — @ax/ipc-http listen address (defaults
//                                    '0.0.0.0' / 8080)
//   - AX_LLM_MODEL / AX_LLM_MAX_TOKENS — anthropic config
//   - AX_RUNNER_BINARY             — chat orchestrator override (tests)
//   - AX_CHAT_TIMEOUT_MS           — chat orchestrator override
//   - AX_AUTH_SESSION_LIFETIME_SECONDS — auth session cookie lifetime
//
// `ANTHROPIC_API_KEY` and `AX_CREDENTIALS_KEY` are read by the respective
// plugins themselves at init() time — they don't appear in K8sPresetConfig.
// ---------------------------------------------------------------------------

/**
 * Build a full `K8sPresetConfig` from the env vars the Helm chart sets on the
 * host pod. Throws on missing required values.
 *
 * @param env - the env map to read from. Defaults to `process.env`. Pass an
 *   explicit object to keep tests deterministic.
 */
export function loadK8sConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): K8sPresetConfig {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required');
  }
  const hostIpcUrl = env.AX_K8S_HOST_IPC_URL;
  if (hostIpcUrl === undefined || hostIpcUrl === '') {
    throw new Error('AX_K8S_HOST_IPC_URL is required');
  }

  const sandbox: NonNullable<K8sPresetConfig['sandbox']> = {};
  if (env.K8S_NAMESPACE !== undefined && env.K8S_NAMESPACE !== '') {
    sandbox.namespace = env.K8S_NAMESPACE;
  }
  if (env.K8S_POD_IMAGE !== undefined && env.K8S_POD_IMAGE !== '') {
    sandbox.image = env.K8S_POD_IMAGE;
  }
  if (env.K8S_RUNTIME_CLASS !== undefined && env.K8S_RUNTIME_CLASS !== '') {
    sandbox.runtimeClassName = env.K8S_RUNTIME_CLASS;
  }
  if (env.K8S_IMAGE_PULL_SECRETS !== undefined && env.K8S_IMAGE_PULL_SECRETS !== '') {
    sandbox.imagePullSecrets = env.K8S_IMAGE_PULL_SECRETS.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  const ipc: K8sPresetConfig['ipc'] = { hostIpcUrl };
  if (env.BIND_HOST !== undefined && env.BIND_HOST !== '') {
    ipc.host = env.BIND_HOST;
  }
  if (env.PORT !== undefined && env.PORT !== '') {
    const portNum = Number(env.PORT);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
      throw new Error(`invalid PORT=${env.PORT}; expected a positive integer`);
    }
    ipc.port = portNum;
  }

  const anthropic: NonNullable<K8sPresetConfig['anthropic']> = {};
  if (env.AX_LLM_MODEL !== undefined && env.AX_LLM_MODEL !== '') {
    anthropic.model = env.AX_LLM_MODEL;
  }
  if (env.AX_LLM_MAX_TOKENS !== undefined && env.AX_LLM_MAX_TOKENS !== '') {
    const n = Number(env.AX_LLM_MAX_TOKENS);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`invalid AX_LLM_MAX_TOKENS=${env.AX_LLM_MAX_TOKENS}; expected a positive integer`);
    }
    anthropic.maxTokens = n;
  }

  const chat: NonNullable<K8sPresetConfig['chat']> = {};
  if (env.AX_RUNNER_BINARY !== undefined && env.AX_RUNNER_BINARY !== '') {
    chat.runnerBinary = env.AX_RUNNER_BINARY;
  }
  if (env.AX_CHAT_TIMEOUT_MS !== undefined && env.AX_CHAT_TIMEOUT_MS !== '') {
    const n = Number(env.AX_CHAT_TIMEOUT_MS);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`invalid AX_CHAT_TIMEOUT_MS=${env.AX_CHAT_TIMEOUT_MS}; expected a positive integer`);
    }
    chat.chatTimeoutMs = n;
  }

  // ---- http listener (public-facing /admin + /auth surface) -----------
  const httpHost = env.AX_HTTP_HOST;
  if (httpHost === undefined || httpHost === '') {
    throw new Error('AX_HTTP_HOST is required');
  }
  const httpPortRaw = env.AX_HTTP_PORT;
  if (httpPortRaw === undefined || httpPortRaw === '') {
    throw new Error('AX_HTTP_PORT is required');
  }
  const httpPort = Number(httpPortRaw);
  // Allow 0 (OS-assigned) — tests rely on it. Reject negatives, non-finite,
  // and >65535. (The k8s chart never sets 0; the ax-next test suite does.)
  if (!Number.isFinite(httpPort) || !Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
    throw new Error(`invalid AX_HTTP_PORT=${httpPortRaw}; expected 0..65535`);
  }
  const cookieKey = env.AX_HTTP_COOKIE_KEY;
  if (cookieKey === undefined || cookieKey === '') {
    throw new Error('AX_HTTP_COOKIE_KEY is required (32 bytes; 64 hex chars or 44 base64 chars)');
  }
  const allowedOriginsRaw = env.AX_HTTP_ALLOWED_ORIGINS;
  // Treat unset OR empty as "no allow-list" — http-server then prints its
  // loud warn unless AX_HTTP_ALLOW_NO_ORIGINS=1 silences it. We don't try
  // to be opinionated here; the chart is where the operator-visible warning
  // really belongs.
  const allowedOrigins =
    allowedOriginsRaw === undefined || allowedOriginsRaw === ''
      ? []
      : allowedOriginsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

  // ---- auth providers --------------------------------------------------
  // At least one of `google` or `devBootstrap` must be present; the auth
  // plugin throws `no-auth-providers` at init otherwise. We re-validate
  // here so the operator gets a startup error pointing at the env vars
  // they actually set, not at the auth plugin's internal config name.
  const auth: K8sPresetConfig['auth'] = {};
  const gClientId = env.AX_AUTH_GOOGLE_CLIENT_ID;
  const gClientSecret = env.AX_AUTH_GOOGLE_CLIENT_SECRET;
  const gRedirectUri = env.AX_AUTH_GOOGLE_REDIRECT_URI;
  const gIssuer = env.AX_AUTH_GOOGLE_ISSUER;
  const anyGoogle =
    (gClientId !== undefined && gClientId !== '') ||
    (gClientSecret !== undefined && gClientSecret !== '') ||
    (gRedirectUri !== undefined && gRedirectUri !== '') ||
    (gIssuer !== undefined && gIssuer !== '');
  if (anyGoogle) {
    // Partial google config is a deploy-time bug; fail loudly. The auth
    // plugin would also catch this (Issuer.discover throws on a bogus
    // issuer URL), but a clear startup error beats a network-shaped
    // failure deep inside init.
    if (gClientId === undefined || gClientId === '') {
      throw new Error('AX_AUTH_GOOGLE_CLIENT_ID is required when any AX_AUTH_GOOGLE_* var is set');
    }
    if (gClientSecret === undefined || gClientSecret === '') {
      throw new Error('AX_AUTH_GOOGLE_CLIENT_SECRET is required when any AX_AUTH_GOOGLE_* var is set');
    }
    if (gRedirectUri === undefined || gRedirectUri === '') {
      throw new Error('AX_AUTH_GOOGLE_REDIRECT_URI is required when any AX_AUTH_GOOGLE_* var is set');
    }
    if (gIssuer === undefined || gIssuer === '') {
      throw new Error('AX_AUTH_GOOGLE_ISSUER is required when any AX_AUTH_GOOGLE_* var is set');
    }
    auth.google = {
      clientId: gClientId,
      clientSecret: gClientSecret,
      redirectUri: gRedirectUri,
      issuer: gIssuer,
    };
  }
  const devToken = env.AX_DEV_BOOTSTRAP_TOKEN;
  if (devToken !== undefined && devToken !== '') {
    auth.devBootstrap = { token: devToken };
  }
  if (auth.google === undefined && auth.devBootstrap === undefined) {
    throw new Error(
      'auth requires at least one of AX_AUTH_GOOGLE_* (clientId/clientSecret/redirectUri/issuer) or AX_DEV_BOOTSTRAP_TOKEN',
    );
  }
  if (env.AX_AUTH_SESSION_LIFETIME_SECONDS !== undefined && env.AX_AUTH_SESSION_LIFETIME_SECONDS !== '') {
    const n = Number(env.AX_AUTH_SESSION_LIFETIME_SECONDS);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`invalid AX_AUTH_SESSION_LIFETIME_SECONDS=${env.AX_AUTH_SESSION_LIFETIME_SECONDS}; expected a positive integer`);
    }
    auth.sessionLifetimeSeconds = n;
  }

  const config: K8sPresetConfig = {
    database: { connectionString: databaseUrl },
    eventbus: { connectionString: databaseUrl },
    session: { connectionString: databaseUrl },
    workspace: workspaceConfigFromEnv(env),
    ipc,
    http: {
      host: httpHost,
      port: httpPort,
      cookieKey,
      allowedOrigins,
    },
    auth,
  };
  if (Object.keys(sandbox).length > 0) config.sandbox = sandbox;
  if (Object.keys(anthropic).length > 0) config.anthropic = anthropic;
  if (Object.keys(chat).length > 0) config.chat = chat;
  if (env.AX_PROXY_SOCKET_PATH !== undefined && env.AX_PROXY_SOCKET_PATH !== '') {
    config.credentialProxy = { socketPath: env.AX_PROXY_SOCKET_PATH };
  }
  return config;
}
