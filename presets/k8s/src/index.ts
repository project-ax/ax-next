import { createRequire } from 'node:module';
import type { Plugin } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createEventbusPostgresPlugin } from '@ax/eventbus-postgres';
import { createSessionPostgresPlugin } from '@ax/session-postgres';
import { createWorkspaceGitPlugin } from '@ax/workspace-git';
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
import { createIpcServerPlugin } from '@ax/ipc-server';

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
//   5. sandbox / ipc-server / llm-proxy / chat-orchestrator (control plane)
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
   * Absolute path to the directory hosting `<repoRoot>/repo.git`. The
   * workspace-git plugin idempotently `git init`s it on first use.
   */
  workspace: {
    repoRoot: string;
  };
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
  plugins.push(
    createWorkspaceGitPlugin({
      repoRoot: config.workspace.repoRoot,
    }),
  );

  // ----- 4. audit log ----------------------------------------------------
  // Subscribes to chat:end and writes a record via storage:set. Pushed
  // before the chat-orchestrator so its subscription is in place when the
  // first chat:end fires.
  plugins.push(auditLogPlugin());

  // ----- 5. control plane ------------------------------------------------
  // sandbox-k8s registers `sandbox:open-session`. No subprocess fallback
  // here — this preset is k8s-only.
  const sandboxOpts = {
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

  plugins.push(createIpcServerPlugin());
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
