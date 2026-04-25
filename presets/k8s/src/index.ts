import { createRequire } from 'node:module';
import type { Plugin } from '@ax/core';
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
import { createCredentialsPlugin } from '@ax/credentials';
import { createIpcHttpPlugin } from '@ax/ipc-http';

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
//   5. sandbox / ipc-http / llm-proxy / chat-orchestrator (control plane)
//   6. tool-dispatcher → tool descriptors → mcp-client (catalog assembly)
//   7. llm-anthropic (last; everything else is in place when init runs)
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

  // Credentials sits immediately after storage (it calls storage:get/set).
  // Init throws if AX_CREDENTIALS_KEY isn't in env.
  plugins.push(createCredentialsPlugin());

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

  // ----- 5. control plane ------------------------------------------------
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

  // ----- 6. tool catalog -------------------------------------------------
  // Dispatcher first — it registers `tool:register` / `tool:list`. The
  // descriptor-only tool plugins (bash, file-io) call `tool:register` from
  // their init. mcp-client also calls `tool:register` from init.
  plugins.push(createToolDispatcherPlugin());
  plugins.push(createToolBashPlugin());
  plugins.push(createToolFileIoPlugin());
  plugins.push(createMcpClientPlugin());

  // ----- 7. LLM ----------------------------------------------------------
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
  const backend = env.AX_WORKSPACE_BACKEND ?? 'local';

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
