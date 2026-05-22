import { createRequire } from 'node:module';
import { PluginError, type Plugin } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createEventbusPostgresPlugin } from '@ax/eventbus-postgres';
import { createSessionPostgresPlugin } from '@ax/session-postgres';
import { createWorkspaceGitPlugin } from '@ax/workspace-git';
import { createWorkspaceGitServerPlugin } from '@ax/workspace-git-server';
import { createSandboxK8sPlugin } from '@ax/sandbox-k8s';
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import { auditLogPlugin } from '@ax/audit-log';
import { createValidatorSkillPlugin } from '@ax/validator-skill';
import { createValidatorRoutinePlugin } from '@ax/validator-routine';
import { createRoutinesPlugin } from '@ax/routines';
import { createRoutinesAdminRoutesPlugin } from '@ax/routines-admin-routes';
import { createMcpClientPlugin, createToolDispatcherPlugin } from '@ax/mcp-client';
import { createCredentialProxyPlugin } from '@ax/credential-proxy';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsAdminRoutesPlugin } from '@ax/credentials-admin-routes';
import { createAdminSettingsRoutesPlugin } from '@ax/admin-settings-routes';
import { createIpcHttpPlugin } from '@ax/ipc-http';
import { createAgentsPlugin } from '@ax/agents';
import { createSkillsPlugin } from '@ax/skills';
import { createAttachmentsPlugin } from '@ax/attachments';
import { createToolArtifactPublishPlugin } from '@ax/tool-artifact-publish';
import { createHttpServerPlugin } from '@ax/http-server';
import { createAuthBetterPlugin, type AuthBetterConfig } from '@ax/auth-better';
import { createTeamsPlugin } from '@ax/teams';
import { createStaticFilesPlugin } from '@ax/static-files';
import { createConversationsPlugin } from '@ax/conversations';
import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';
import {
  createConversationTitlesPlugin,
  DEFAULT_TITLE_MODEL,
} from '@ax/conversation-titles';
import { createMemoryStrataPlugin } from '@ax/memory-strata';
import { createMemoryStrataIndexPostgresPlugin } from '@ax/memory-strata-index-postgres';
import { createWebToolsPlugin } from '@ax/web-tools';
import { createChannelWebServerPlugin } from '@ax/channel-web/server';
import { createOnboardingPlugin, type OnboardingConfig } from '@ax/onboarding';

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
//   4. audit-log (subscribes to event.http-egress; calls storage:set)
//   5. http-server / auth / teams (control plane access — Week 9.5)
//   6. sandbox / ipc-http / chat-orchestrator (chat plane)
//   7. mcp-client (catalog + tool descriptors + tool:register/tool:list)
//   8. agents (admin endpoints + agents:resolve gate)
//
// (Host-side LLM plugins were deleted in Phase 6 — the SDK runner reaches
// Anthropic via the credential-proxy, not through a host `llm:call` hook.)
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
 * single-replica on-PVC bare repo path; `git-protocol` talks to the
 * dedicated sharded git-server storage tier via
 * @ax/workspace-git-server (production multi-replica path).
 *
 * The earlier `http` backend (the all-in-one git-server pod served by
 * `@ax/workspace-git-http`) was retired 2026-05-04: it never grew bundle-
 * wire support, so multi-turn writes silently failed. Both surviving
 * backends register the Phase 3 bundle hooks.
 */
export type K8sWorkspaceConfig =
  | { backend: 'local'; repoRoot: string }
  | { backend: 'git-protocol'; baseUrl: string; token: string };

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
   *   - `git-protocol`: `@ax/workspace-git-server` talks to the dedicated
   *     git-server storage tier (the chart's StatefulSet, or any external
   *     server speaking the same wire — Gitea, etc.). Multi-replica capable.
   *     `baseUrl` + `token` point at the storage tier.
   *
   * The Helm chart drives this via `workspace.backend: local|git-protocol`
   * and the env vars `AX_WORKSPACE_BACKEND` / `AX_WORKSPACE_ROOT` /
   * `AX_WORKSPACE_GIT_SERVER_URL` / `AX_WORKSPACE_GIT_SERVER_TOKEN`. The host
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
    /**
     * Node-filesystem path that backs `/var/run/ax` in BOTH the host
     * pod and every runner pod, so the credential-proxy's Unix socket
     * + CA cert are reachable cross-pod. See sandbox-k8s/config.ts for
     * the full security caveat. Empty / unset = no shared mount; the
     * runner crashes at boot with `missing AX_PROXY_*`.
     */
    proxySocketHostPath?: string;
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
   * Chat orchestrator overrides. `runnerBinary` defaults to the resolved
   * @ax/agent-claude-sdk-runner; tests/embedders may override it.
   */
  chat?: {
    runnerBinary?: string;
    chatTimeoutMs?: number;
    oneShot?: boolean;
  };
  /**
   * Auto-titling config. When present, the preset loads @ax/llm-anthropic
   * and @ax/conversation-titles; conversations get a one-line title written
   * after the first assistant turn (`ifNull: true`, never clobbers a user
   * rename). When absent, titles stay null — same as today's behavior.
   *
   * `model` uses the `<provider>/<model-id>` convention; the titles plugin
   * splits on the first `/` and dispatches `llm:call:${provider}`. Default:
   * `'anthropic/claude-haiku-4-5-20251001'`.
   *
   * `loadK8sConfigFromEnv` populates this field iff `ANTHROPIC_API_KEY` is
   * present in the env; otherwise it leaves the field undefined (multi-
   * tenant deploys without a shared host key opt out cleanly).
   */
  titles?: {
    model?: string;
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
   * @ax/auth-better config. Auth-better is config-light by design — providers
   * (google / github / generic OIDC) live exclusively in the `auth_providers`
   * DB table managed by Phase 1's `/admin/auth/providers/*` CRUD. There is no
   * env-driven provider config; the operator walks the onboarding wizard at
   * `/setup/*` (Phase 2) and adds providers from the admin UI (Phase 3.5).
   *
   * `sessionLifetimeSeconds` is the only field worth surfacing here — it
   * controls the Set-Cookie `max-age` on completed bootstrap sessions.
   *
   * `trustedOrigins` bounds which origins better-auth will honor for
   * sign-in / OAuth callback / CSRF-token-bearing forms. Default is
   * `['*']` (test-friendly); production should pin to the canonical
   * public base URL. When `loadK8sConfigFromEnv` sees `AX_PUBLIC_BASE_URL`
   * set, it defaults `trustedOrigins` to `[AX_PUBLIC_BASE_URL]`.
   */
  auth?: {
    /** Session cookie lifetime. Default 7 days (auth-better default). */
    sessionLifetimeSeconds?: number;
    /**
     * Origins better-auth treats as trusted for CSRF/OAuth callback
     * gating. Default `['*']` — production hosts SHOULD pin (the env
     * loader does this automatically when AX_PUBLIC_BASE_URL is set).
     */
    trustedOrigins?: string[];
    /**
     * Canonical public origin better-auth uses to build OAuth redirect
     * URIs and validate callbacks. The env loader sets this to the
     * AX_PUBLIC_BASE_URL origin when set, pinning `redirect_uri` to the
     * canonical host (so Google's configured callback matches) and
     * silencing better-auth's "Base URL could not be determined" warning.
     */
    baseURL?: string;
    /**
     * Stable secret for better-auth (OAuth state + at-rest OAuth-token
     * encryption). MUST be stable across restarts — rotating it makes
     * existing encrypted OAuth tokens undecryptable.
     */
    secret?: string;
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
   * When true, load @ax/credentials-admin-routes — mounts
   * /admin/credentials* (admin-only CRUD over the full scope axis) and
   * /settings/credentials* (per-user CRUD restricted to scope='user').
   * Off by default; the chart flips it via
   * `--set credentials.admin.enabled=true` which in turn sets
   * `AX_CREDENTIALS_ADMIN_ENABLED=true` on the host pod.
   *
   * Requires `AX_CREDENTIALS_KEY` (already required by @ax/credentials,
   * so this flag inherits the same precondition).
   *
   * OAuth start/finish routes do NOT live in this plugin — Phase 3 adds
   * them on top of an in-memory pending-state holder. This is CRUD-only.
   */
  credentialsAdmin?: boolean;
  /**
   * @ax/onboarding — first-run wizard. When set, the plugin loads and
   * serves the bootstrap wizard at /setup/*. The plugin reads
   * AX_BOOTSTRAP_TOKEN from process.env automatically; set `publicBaseUrl`
   * to override the URL printed in the boot banner (defaults to
   * `http://<http.host>:<http.port>`, which is the bind address and
   * usually wrong for external traffic).
   *
   * The field is populated by `loadK8sConfigFromEnv` from
   * `AX_PUBLIC_BASE_URL`. Always loaded — the field controls the config
   * passed to the plugin, not whether it loads.
   */
  onboarding?: {
    /** Operator-facing URL printed in the stdout banner and link. */
    publicBaseUrl?: string;
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
 * Note: the runner binary resolution relies on runtime environment (the
 * lookup walks node_modules). That's intentional — resolved paths are not
 * in the JSON config schema. Anthropic credentials live in the credentials
 * store (admin-seeded via /admin/credentials, Phase 9.5) and are resolved
 * by the credential-proxy at proxy:open-session time, not at plugin init.
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
  // envFallback: the chart already plumbs ANTHROPIC_API_KEY into the
  // host pod's env (from the operator-supplied Secret). Wire it as the
  // universal fallback for the canonical `anthropic-api` ref so the
  // kind goldenpath works without an extra "now go seed credentials"
  // step. Multi-tenant deployments should leave this empty and seed
  // per-user via the credentials admin surface (see SECURITY.md).
  plugins.push(
    createCredentialsPlugin({
      envFallback: { 'anthropic-api': 'ANTHROPIC_API_KEY' },
    }),
  );

  // I12 — provider credentials are API-key-only across the default UI/preset.
  // The default k8s preset advertises only `kind: api-key` via
  // /admin/credentials/kinds. Adding a new credential kind means a new
  // plugin that registers `credentials:resolve:<kind>` (and the matching
  // login/exchange surface, if it's an OAuth flow) pushed before
  // createCredentialsPlugin.

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
  // Discriminated on `backend`. `local` wants a filesystem path;
  // `git-protocol` wants a URL + bearer token. Both register the full
  // six-hook bundle-aware contract (the four base hooks +
  // workspace:apply-bundle + workspace:export-baseline-bundle).
  if (config.workspace.backend === 'git-protocol') {
    plugins.push(
      createWorkspaceGitServerPlugin({
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
  // Subscribes to event.http-egress and writes one row per egress via
  // storage:set. Push order isn't load-bearing — the kernel finishes init
  // (and therefore wires every subscriber) before any hook fires — but we
  // keep audit-log near the storage layer because that's its only call.
  plugins.push(auditLogPlugin());

  // Phase 3: validator-skill subscribes to workspace:pre-apply and
  // vetoes SKILL.md changes with malformed YAML frontmatter. Push
  // order isn't load-bearing (kernel sequences subscribers via
  // manifest), but we keep it adjacent to audit-log because both are
  // observe-only hook subscribers with no dependencies of their own.
  plugins.push(createValidatorSkillPlugin());
  plugins.push(createValidatorRoutinePlugin());
  plugins.push(createRoutinesPlugin());

  // Phase D: admin routes for the Routines modal. Mounts /settings/routines/*
  // against the same http listener. Loaded unconditionally alongside @ax/routines
  // — there's no separate opt-in flag because the modal is the primary
  // observability surface for routine fires, and the routines plugin itself
  // is already unconditional in this preset.
  plugins.push(createRoutinesAdminRoutesPlugin());

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

  // @ax/auth-better — DB-driven providers, no env config. The admin walks
  // the onboarding wizard once (Phase 2 → /setup/*) to mint the bootstrap
  // user, then adds providers via the admin UI (Phase 3.5 → /admin/auth/*).
  // The `auth_providers` table is hot-reloaded — adds / edits / disables
  // are live within a request without a kernel restart.
  const authBetterCfg: AuthBetterConfig = {};
  if (config.auth?.sessionLifetimeSeconds !== undefined) {
    authBetterCfg.sessionLifetimeSeconds = config.auth.sessionLifetimeSeconds;
  }
  if (config.auth?.trustedOrigins !== undefined) {
    authBetterCfg.trustedOrigins = config.auth.trustedOrigins;
  }
  if (config.auth?.baseURL !== undefined) {
    authBetterCfg.baseURL = config.auth.baseURL;
  }
  if (config.auth?.secret !== undefined) {
    authBetterCfg.secret = config.auth.secret;
  }
  plugins.push(createAuthBetterPlugin(authBetterCfg));

  // ----- 5b. first-run wizard -------------------------------------------
  // @ax/onboarding mounts the bootstrap wizard at /setup/*. It runs the
  // migration on init and initializes the bootstrap token from
  // AX_BOOTSTRAP_TOKEN (env) or generates one fresh. The plugin needs
  // http:register-route (loaded above) + auth:create-bootstrap-user /
  // auth:complete-bootstrap-user (provided by auth-better, loaded just
  // above) + db:transact + credentials:set + agents:create (all loaded).
  //
  // `baseUrl` is the operator-facing URL stamped into the boot banner so
  // the operator knows where to point their browser. Defaults to
  // `http://<bind-host>:<port>` which is the internal bind address and
  // usually wrong for external traffic; operators set AX_PUBLIC_BASE_URL
  // to override.
  //
  // I3 — half-wired window CLOSES here: after this push, `ax-next serve`
  // in a k8s deploy exposes the wizard at /setup.
  const onboardingCfg: OnboardingConfig = {
    baseUrl: config.onboarding?.publicBaseUrl ?? `http://${config.http.host}:${config.http.port}`,
  };
  plugins.push(createOnboardingPlugin(onboardingCfg));

  // teams: mountAdminRoutes:true so /admin/teams* lands alongside the rest
  // of the admin surface. The plugin's manifest expands `calls` to include
  // http:register-route + auth:require-user when this flag is set, which
  // is exactly what the kernel's topo-sort needs to see.
  plugins.push(createTeamsPlugin({ mountAdminRoutes: true }));

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
    ...(config.sandbox?.proxySocketHostPath !== undefined
      ? { proxySocketHostPath: config.sandbox.proxySocketHostPath }
      : {}),
  };
  plugins.push(createSandboxK8sPlugin(sandboxOpts));

  plugins.push(
    createIpcHttpPlugin({
      host: config.ipc.host ?? '0.0.0.0',
      port: config.ipc.port ?? 8080,
    }),
  );

  const orchestratorCfg: Parameters<typeof createChatOrchestratorPlugin>[0] = {
    runnerBinary: config.chat?.runnerBinary ?? defaultRunnerBinary(),
    chatTimeoutMs: config.chat?.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
  };
  if (config.chat?.oneShot !== undefined) {
    orchestratorCfg.oneShot = config.chat.oneShot;
  }
  plugins.push(createChatOrchestratorPlugin(orchestratorCfg));

  // ----- 7. tool catalog -------------------------------------------------
  // The catalog plugin (factory still named `createToolDispatcherPlugin`)
  // registers `tool:register` / `tool:list`. The tool surface is populated
  // entirely by MCP-registered host tools today; built-in bash/file-io
  // descriptors are gone (Phase 6 Task 6 removed their host-side packages
  // — the SDK runner's sandboxed Bash/Read/Write replace them).
  //
  // Both plugins live in @ax/mcp-client now (Slice 2 absorbed the former
  // @ax/tool-dispatcher package). mcp-client gets `mountAdminRoutes: true`
  // so /admin/mcp-servers* lands alongside the rest of the admin surface.
  // The flag expands the plugin's manifest `calls` to include
  // http:register-route + auth:require-user; the kernel's topo-sort picks
  // up the new edges automatically.
  plugins.push(createToolDispatcherPlugin());
  plugins.push(createMcpClientPlugin({ mountAdminRoutes: true }));

  // ----- 8. agents -------------------------------------------------------
  // Registers `agents:resolve` (the ACL gate the chat-orchestrator hard-
  // depends on as of Week 9.5) AND mounts /admin/agents* routes. The
  // plugin's manifest `calls` already declares http:register-route +
  // auth:require-user as hard deps — the kernel's topo-sort blocks init
  // until both upstream plugins have registered. Reuses the shared
  // postgres pool via `database:get-instance` (no second pool).
  plugins.push(createAgentsPlugin());

  // ----- 8a. skills ------------------------------------------------------
  // @ax/skills registers skills:* service hooks (list/get/upsert/delete/
  // resolve) backed by the skills_v1_skills table + mounts /admin/skills*
  // HTTP CRUD. The chat-orchestrator (loaded above) soft-couples via
  // bus.hasService('skills:resolve') so an admin can install skills and
  // attach them to agents; session-open will then union the skill's
  // allowedHosts + merge credentialBindings into proxy:open-session, and
  // the sandbox plugin will materialize SKILL.md files under
  // $CLAUDE_CONFIG_DIR/skills/<id>/ before the runner spawns.
  //
  // skills:delete soft-couples to agents:any-attached-to-skill (registered
  // by @ax/agents above) so a delete that would orphan an attachment 409s.
  plugins.push(createSkillsPlugin());

  // ----- 8b. credentials admin routes (optional) -------------------------
  // Mounts /admin/credentials* (admin-only CRUD, new destination-based
  // write surface) on the existing http listener. Loaded only when the
  // operator opts in — the chart's `credentials.admin.enabled=true` flag
  // sets AX_CREDENTIALS_ADMIN_ENABLED which loadK8sConfigFromEnv
  // translates into cfg.credentialsAdmin.
  if (config.credentialsAdmin === true) {
    plugins.push(createCredentialsAdminRoutesPlugin());
  }

  // ----- 8c. admin settings routes ---------------------------------------
  // Mounts /admin/settings/:key (GET + PUT) for the small allowlisted set
  // of admin-managed non-credential settings. Today the only entry is
  // `fast-model`, which the admin "Model config" tab writes and the
  // @ax/conversation-titles plugin reads at runtime. Always loaded — it's
  // tiny, gated by admin-only auth, and the in-memory route registration
  // has no postgres cost.
  plugins.push(createAdminSettingsRoutesPlugin());

  // ----- 9. conversations ------------------------------------------------
  // Registers `conversations:*` (create/get/list/delete/get-by-req-id +
  // bind-session/unbind-session + Phase B/F additions). Calls
  // `agents:resolve`, `database:get-instance`, `workspace:list/read`
  // — all already loaded above; topo-sort handles the ordering.
  //
  // Defaults `defaultRunnerType: 'claude-sdk'` (the only runner shipped
  // today). Auto-titling (@ax/conversation-titles) loads conditionally
  // on `cfg.titles` being defined — `loadK8sConfigFromEnv` populates it
  // iff ANTHROPIC_API_KEY is in env. Multi-tenant deploys without a
  // shared host key opt out cleanly (cfg.titles undefined → both
  // plugins skipped → conversations stay `title: null`, same as today).
  plugins.push(createConversationsPlugin());

  // ----- 9a. attachments ----------------------------------------------------
  // Phase 1 of the attachments & artifacts subsystem (2026-05-15). Three
  // service hooks (attachments:store-temp / commit / download) with a
  // Postgres-backed temp store and the path-scope ACL inside the download
  // hook. Half-wired window OPEN through Phase 3 — no caller in Phase 1
  // invokes these hooks. Phase 2 wires up the agent-side artifact_publish
  // tool; Phase 3 wires up channel-web's upload + download routes + UI.
  plugins.push(createAttachmentsPlugin());
  // Phase 2: registers the `artifact_publish` tool descriptor so the canary
  // smoke flow includes it in tool.list. The sandbox-MCP bridge dispatches
  // calls once the runner's allowedTools includes `artifact_publish`.
  plugins.push(createToolArtifactPublishPlugin());

  // Auto-titling: @ax/llm-anthropic registers `llm:call:anthropic`,
  // @ax/conversation-titles subscribes to `chat:turn-end` and dispatches
  // `llm:call:${provider}` after the first assistant turn lands.
  // Conditional on cfg.titles (driven by ANTHROPIC_API_KEY presence in
  // loadK8sConfigFromEnv) so multi-tenant deploys opt out cleanly.
  if (config.titles !== undefined) {
    // This preset only ships @ax/llm-anthropic. A non-anthropic provider
    // would leave `llm:call:<provider>` unregistered, which the kernel's
    // topo-sort would catch at bootstrap with a less-readable error than
    // this one. Future providers slot in by adding sibling plugins here
    // and lifting this guard.
    const titleModel = config.titles.model ?? DEFAULT_TITLE_MODEL;
    if (!titleModel.startsWith('anthropic/')) {
      throw new PluginError({
        code: 'invalid-config',
        plugin: '@ax/preset-k8s',
        message: `titles.model='${titleModel}' — this preset only supports 'anthropic/<model-id>' (no other provider plugins are loaded)`,
      });
    }
    plugins.push(createLlmAnthropicPlugin());
    // @ax/web-tools — host-executed web_search + web_extract backed by
    // Anthropic's server-side web tools. Piggybacks on the same env gate
    // (config.titles is set iff ANTHROPIC_API_KEY is present) because it
    // constructs its own Anthropic client from that key. Available to all
    // agents; the plugin's own `enabled` flag is the operator kill-switch.
    plugins.push(createWebToolsPlugin());
    plugins.push(createConversationTitlesPlugin({ model: titleModel }));
    // @ax/memory-strata Phase 1: hot-tier markdown + Observer extracting
    // facts to permanent/memory/inbox/. Piggybacks on the same env gate
    // because the Observer needs `llm:call:anthropic` (registered above).
    // Splitting the gate into separate config knobs is a Phase 2 concern.
    plugins.push(createMemoryStrataPlugin());
    // I24 — indexer loads as a pair with memory-strata (same gate). The
    // postgres indexer resolves the shared Kysely pool via database:get-instance
    // (registered above by createDatabasePostgresPlugin). No separate DSN needed.
    plugins.push(createMemoryStrataIndexPostgresPlugin());
  }

  // ----- 10. channel-web HTTP surface -----------------------------------
  // Mounts /api/chat/messages, /api/chat/conversations[/:id],
  // /api/chat/agents, /api/chat/stream/:reqId. Hard-depends on
  // http-server, auth-better, agents, conversations, chat-orchestrator
  // (agent:invoke). All registrants are loaded above; the kernel's
  // topo-sort blocks init until each call has a registrant.
  //
  // J8: single-replica only. The chunk-buffer behind /api/chat/stream
  // is in-process; multi-replica fan-out is a future slice that swaps
  // it for redis / pg-logical without changing the SSE handler shape.
  plugins.push(createChannelWebServerPlugin());

  // ----- 11. static-files (optional, MUST be last) ----------------------
  // Serves channel-web's bundle from the same listener so cookies and
  // CSRF stay same-origin in production. The plugin registers a `/*`
  // splat catchall — the http-server router does SPECIFICITY-based
  // matching (exact > non-splat patterns > splats; see
  // packages/http-server/src/router.ts:137-163), so /api/chat/* and
  // /admin/* always win over /* regardless of registration order. We
  // still push static-files LAST so the visual order matches the intent
  // and a future reader doesn't read this as a shadowing bug.
  //
  // When `staticFiles` is unset, no catchall is mounted and unknown
  // paths return 404 — the dev workflow uses Vite's proxy instead.
  // SPA fallback defaults on so client-side routing works.
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
//   AX_WORKSPACE_BACKEND          local | git-protocol  (default: local)
//   AX_WORKSPACE_ROOT             required when backend === 'local'
//   AX_WORKSPACE_GIT_SERVER_URL   required when backend === 'git-protocol'
//   AX_WORKSPACE_GIT_SERVER_TOKEN required when backend === 'git-protocol'
//
// We throw loudly on missing/unknown values rather than silently defaulting
// — a misconfigured workspace backend is a deploy-time bug, not a runtime
// surprise we want to paper over. Error messages never echo the token (an
// errant log line carrying the bearer token through the kernel's logger is
// the supply-chain failure we're trying NOT to ship).
// ---------------------------------------------------------------------------

/**
 * Read the `AX_WORKSPACE_*` env vars and return a `K8sWorkspaceConfig`.
 *
 * Defaults to `local` when `AX_WORKSPACE_BACKEND` is unset (matches the
 * chart's default). Throws when the chosen backend's required vars are
 * missing or when the backend value is unknown. Thrown messages never
 * contain the bearer token literal.
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

  if (backend === 'git-protocol') {
    const baseUrl = env.AX_WORKSPACE_GIT_SERVER_URL;
    const token = env.AX_WORKSPACE_GIT_SERVER_TOKEN;
    if (baseUrl === undefined || baseUrl === '') {
      throw new Error(
        'AX_WORKSPACE_BACKEND=git-protocol requires AX_WORKSPACE_GIT_SERVER_URL to be set',
      );
    }
    if (token === undefined || token === '') {
      throw new Error(
        'AX_WORKSPACE_BACKEND=git-protocol requires AX_WORKSPACE_GIT_SERVER_TOKEN to be set',
      );
    }
    return { backend: 'git-protocol', baseUrl, token };
  }

  throw new Error(
    `unknown AX_WORKSPACE_BACKEND=${backend}; expected 'local' or 'git-protocol'`,
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
//   - AX_WORKSPACE_BACKEND        — local | git-protocol (default: local)
//       and the per-backend vars (delegated to workspaceConfigFromEnv):
//         - local:        AX_WORKSPACE_ROOT
//         - git-protocol: AX_WORKSPACE_GIT_SERVER_URL / AX_WORKSPACE_GIT_SERVER_TOKEN
//   - AX_HTTP_HOST / AX_HTTP_PORT  — public-facing http listener
//   - AX_HTTP_COOKIE_KEY           — 32-byte signing key (hex / base64)
//   - AX_HTTP_ALLOWED_ORIGINS      — CSRF allow-list (comma-separated)
//
// Auth providers are NOT env-driven anymore: @ax/auth-better reads from
// the `auth_providers` DB table, populated by `/admin/auth/providers/*`
// at runtime. The first-run flow is the onboarding wizard (Phase 2):
// operator sets AX_BOOTSTRAP_TOKEN, walks /setup/*, and adds providers
// from the admin UI afterward.
//
// Optional env:
//   - K8S_NAMESPACE / K8S_POD_IMAGE / K8S_RUNTIME_CLASS / K8S_IMAGE_PULL_SECRETS
//                                  — sandbox-k8s overrides
//   - BIND_HOST / PORT             — @ax/ipc-http listen address (defaults
//                                    '0.0.0.0' / 8080)
//   - AX_RUNNER_BINARY             — chat orchestrator override (tests)
//   - AX_CHAT_TIMEOUT_MS           — chat orchestrator override
//   - AX_AUTH_SESSION_LIFETIME_SECONDS — auth session cookie lifetime
//
// `AX_CREDENTIALS_KEY` is read by @ax/credentials at init() time — it
// doesn't appear in K8sPresetConfig.
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
  if (env.K8S_RUNTIME_CLASS !== undefined) {
    // Empty string is meaningful: it means "no runtimeClassName in the
    // pod spec" (the kind-dev posture). Skipping the assignment when
    // empty would let sandbox-k8s/config.ts apply its `'gvisor'` default,
    // which then 403s on a kind cluster without that RuntimeClass
    // installed. The chart's `kind-dev-values.yaml` sets
    // `sandbox.runtimeClassName: ""` precisely so this branch fires.
    sandbox.runtimeClassName = env.K8S_RUNTIME_CLASS;
  }
  if (
    env.K8S_PROXY_SOCKET_HOST_PATH !== undefined &&
    env.K8S_PROXY_SOCKET_HOST_PATH !== ''
  ) {
    // Node-filesystem path that the host pod also mounts at
    // `/var/run/ax`. When set, runner pods get the same hostPath at the
    // same in-pod mountpoint so the credential-proxy socket + CA cert
    // are reachable cross-pod. Kind-only / single-node posture; see
    // sandbox-k8s/config.ts for the SECURITY trade-off.
    sandbox.proxySocketHostPath = env.K8S_PROXY_SOCKET_HOST_PATH;
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

  // ---- auth (auth-better is DB-driven) --------------------------------
  // Providers (google / github / generic OIDC) come from the
  // `auth_providers` table managed by Phase 1's /admin/auth/providers/*
  // CRUD. First boot is the onboarding wizard (Phase 2): operator sets
  // AX_BOOTSTRAP_TOKEN (read directly by @ax/onboarding from process.env),
  // walks /setup/*, then adds providers from the admin UI.
  //
  // Knobs surfaced here:
  //   - session-cookie lifetime (AX_AUTH_SESSION_LIFETIME_SECONDS)
  //   - trustedOrigins — defaults to [AX_PUBLIC_BASE_URL] when set; no
  //     separate env var. The public base URL is already the source of
  //     truth for "where users hit this server", so trustedOrigins
  //     inherits from it. If an operator legitimately needs multiple
  //     origins (canonical URL + localhost for debugging), they can
  //     construct config in code or set a future AX_AUTH_TRUSTED_ORIGINS
  //     env var when the need actually arises (YAGNI for now).
  //   - baseURL — also inherits the AX_PUBLIC_BASE_URL origin. Pins the
  //     origin better-auth uses for OAuth redirect_uri / callback
  //     validation, so a non-canonical inbound Host can't produce a
  //     redirect_uri that mismatches Google's allow-list, and silences
  //     better-auth's startup "Base URL could not be determined" warning.
  //
  // Empty cfg is fine — auth-better falls through to its defaults
  // (7-day session, ['*'] trustedOrigins).
  const auth: NonNullable<K8sPresetConfig['auth']> = {};
  if (
    env.AX_AUTH_SESSION_LIFETIME_SECONDS !== undefined &&
    env.AX_AUTH_SESSION_LIFETIME_SECONDS !== ''
  ) {
    const n = Number(env.AX_AUTH_SESSION_LIFETIME_SECONDS);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        `invalid AX_AUTH_SESSION_LIFETIME_SECONDS=${env.AX_AUTH_SESSION_LIFETIME_SECONDS}; expected a positive integer`,
      );
    }
    auth.sessionLifetimeSeconds = n;
  }
  // AX_PUBLIC_BASE_URL is consumed by both auth.trustedOrigins (here) and
  // onboarding.publicBaseUrl (further down). Parse once, fail fast on
  // garbage, and feed the normalized value to both — better-auth wants a
  // bare origin (scheme://host[:port]) for trustedOrigins, NOT a URL with
  // path/query/hash, so we strip those via `.origin`.
  const rawPublicBaseUrl = env.AX_PUBLIC_BASE_URL?.trim();
  let parsedPublicBaseUrl: URL | undefined;
  if (rawPublicBaseUrl !== undefined && rawPublicBaseUrl !== '') {
    try {
      parsedPublicBaseUrl = new URL(rawPublicBaseUrl);
    } catch {
      throw new Error(
        `invalid AX_PUBLIC_BASE_URL=${rawPublicBaseUrl}; expected an absolute URL like https://ax.example.com`,
      );
    }
    if (
      parsedPublicBaseUrl.protocol !== 'http:' &&
      parsedPublicBaseUrl.protocol !== 'https:'
    ) {
      throw new Error(
        `invalid AX_PUBLIC_BASE_URL=${rawPublicBaseUrl}; expected http:// or https:// scheme`,
      );
    }
    auth.trustedOrigins = [parsedPublicBaseUrl.origin];
    // Same origin pins better-auth's baseURL so OAuth redirect_uri is the
    // canonical public host (not whatever Host header arrives) and the
    // construction-time "Base URL could not be determined" warning is
    // silenced. better-auth wants a bare origin, so reuse `.origin`.
    auth.baseURL = parsedPublicBaseUrl.origin;
  }
  // AX_AUTH_SECRET — stable secret for better-auth (OAuth state + at-rest
  // OAuth-token encryption). MUST be stable across restarts; a rotation
  // makes all existing encrypted OAuth tokens undecryptable.
  const authSecret = env.AX_AUTH_SECRET?.trim();
  if (authSecret) {
    auth.secret = authSecret;
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
  };
  // Only attach `auth` when something was set. Empty `auth: {}` is harmless,
  // but the loader's "optional unless populated" pattern keeps the rendered
  // shape minimal and matches the rest of the file (sandbox, chat, etc).
  if (Object.keys(auth).length > 0) {
    config.auth = auth;
  }
  if (Object.keys(sandbox).length > 0) config.sandbox = sandbox;
  if (Object.keys(chat).length > 0) config.chat = chat;
  if (env.AX_PROXY_SOCKET_PATH !== undefined && env.AX_PROXY_SOCKET_PATH !== '') {
    config.credentialProxy = { socketPath: env.AX_PROXY_SOCKET_PATH };
  }
  if (env.AX_PROXY_CA_DIR !== undefined && env.AX_PROXY_CA_DIR !== '') {
    // Where the credential-proxy stores its MITM root CA (`ca.crt` +
    // `ca.key`). When the chart routes runner pods through the
    // host-pod proxy via a shared hostPath, this MUST live inside that
    // shared dir so runner pods can read `ca.crt` (read-only). See
    // sandbox-k8s/pod-spec.ts for the matching mount + the
    // `NODE_EXTRA_CA_CERTS=/var/run/ax/proxy-ca/ca.crt` env stamp.
    config.credentialProxy = {
      ...(config.credentialProxy ?? {}),
      caDir: env.AX_PROXY_CA_DIR,
    };
  }
  // Static-file serving for channel-web's SPA bundle. The chart's default
  // points this at `/opt/ax-next/host/web` — a stable path the agent
  // Dockerfile populates by COPY-ing channel-web/dist-web there directly,
  // avoiding the pnpm-internal `node_modules/.pnpm/...` layout. When unset,
  // the host pod boots without the static-files plugin and the public
  // listener returns 404 on `/` — which is the dev posture (Vite serves
  // the bundle at :5173 with /api/* proxied to the host).
  if (env.AX_STATIC_FILES_DIR !== undefined && env.AX_STATIC_FILES_DIR !== '') {
    config.staticFiles = { dir: env.AX_STATIC_FILES_DIR };
  }
  // ---- credentials admin routes (optional) -------------------------------
  // Translates the chart's `credentials.admin.enabled=true` (which lands
  // as AX_CREDENTIALS_ADMIN_ENABLED on the host pod) into the config
  // flag. Only the literal string 'true' (case-insensitive) flips it on
  // — anything else (unset, '', '0', 'false') leaves it undefined so
  // createK8sPlugins skips the plugin.
  if ((env.AX_CREDENTIALS_ADMIN_ENABLED ?? '').toLowerCase() === 'true') {
    config.credentialsAdmin = true;
  }

  // ---- titles (auto-titling subscriber) -----------------------------------
  // Gated on ANTHROPIC_API_KEY presence: multi-tenant deploys without a
  // shared host key get no auto-titling, same as today. When the key IS
  // set, the preset loads @ax/llm-anthropic + @ax/conversation-titles and
  // titles get a one-line summary after the first assistant turn.
  //
  // The default falls through to DEFAULT_TITLE_MODEL exported from
  // @ax/conversation-titles — one source of truth (CLAUDE.md invariant I4).
  // Presets are exempt from I2's no-cross-plugin-imports rule (they wire
  // plugins together by definition); the chart's `values.yaml` literal is
  // the only remaining duplicate, and it must stay in lockstep with this
  // export by hand (helm can't import TS).
  if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== '') {
    const titleModelRaw = env.AX_TITLE_MODEL;
    const titleModel =
      titleModelRaw === undefined || titleModelRaw === ''
        ? DEFAULT_TITLE_MODEL
        : titleModelRaw;
    config.titles = { model: titleModel };
  }

  // ---- onboarding (first-run wizard) ------------------------------------
  // AX_PUBLIC_BASE_URL (optional): URL printed in the stdout banner so the
  // operator knows where to point their browser. When unset, the plugin
  // defaults to `http://<http.host>:<http.port>` (the bind address), which
  // is the internal bind addr and rarely the externally-visible URL.
  // AX_BOOTSTRAP_TOKEN is read directly by the plugin from process.env at
  // init — the preset loader surfaces the read here so the env-shape test's
  // scanner registers the var as known.
  const _axBootstrapToken = env.AX_BOOTSTRAP_TOKEN; // consumed by @ax/onboarding init
  if (parsedPublicBaseUrl !== undefined && rawPublicBaseUrl !== undefined) {
    // Use the validated raw string here (already trimmed). We deliberately
    // don't round-trip through URL.toString() because that would append a
    // trailing slash to a bare-host URL, and the onboarding banner does
    // `${baseUrl}/setup?token=...` — a trailing slash would yield `//setup`.
    // trustedOrigins above stripped to `.origin` because better-auth wants
    // a bare origin; the banner is happier with the operator's literal.
    config.onboarding = { publicBaseUrl: rawPublicBaseUrl };
  }
  return config;
}
