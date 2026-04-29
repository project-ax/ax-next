#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentOutcome,
  type Plugin,
} from '@ax/core';
import { llmMockPlugin } from '@ax/llm-mock';
import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsAnthropicOauthPlugin } from '@ax/credentials-anthropic-oauth';
import { createCredentialProxyPlugin } from '@ax/credential-proxy';
import { auditLogPlugin } from '@ax/audit-log';
import { createSandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createLlmProxyAnthropicFormatPlugin } from '@ax/llm-proxy-anthropic-format';
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import { createToolBashPlugin } from '@ax/tool-bash';
import { createToolFileIoPlugin } from '@ax/tool-file-io';
import { createMcpClientPlugin } from '@ax/mcp-client';
import { createDevAgentsStubPlugin } from './dev-agents-stub.js';
import { AxConfigSchema, type AxConfig, type AxConfigInput } from './config/schema.js';
import { loadAxConfig } from './config/load.js';
import { runCredentialsCommand } from './commands/credentials.js';
import { runMcpCommand } from './commands/mcp.js';
import { runServeCommand } from './commands/serve.js';
import { runAdminCommand } from './commands/admin.js';

// `@ax/cli` is the ONE package permitted to import sibling plugins directly
// (eslint.config.mjs no-restricted-imports allowlist); this is also the one
// spot where we pin down the runner binary location (I8).
//
// Lazy-resolve the agent-native-runner binary inside main() rather than at
// module load. Library-mode consumers (tests, embedders using configOverride)
// that never invoke agent:invoke shouldn't fail to import @ax/cli just because
// the runner's dist/ hasn't been built yet. `createRequire` from the CLI's
// own URL is robust against pnpm hoisting and works identically in dev + prod.
//
// We resolve the package's `.` export (which is `dist/main.js`) rather than
// a subpath specifier: the runner's `exports` field only exposes `.` and
// `./turn-loop`, so a direct `./dist/main.js` subpath is blocked by Node's
// exports-map enforcement.
const requireFromCli = createRequire(import.meta.url);
export function resolveRunnerBinary(runner: AxConfig['runner']): string {
  // Exhaustive so a future `runner` variant in schema.ts fails typecheck
  // here instead of silently falling through to the native runner.
  switch (runner) {
    case 'claude-sdk':
      return requireFromCli.resolve('@ax/agent-claude-sdk-runner');
    case 'native':
      return requireFromCli.resolve('@ax/agent-native-runner');
    default: {
      const _exhaustive: never = runner;
      throw new Error(`unknown runner: ${String(_exhaustive)}`);
    }
  }
}
const DEFAULT_CHAT_TIMEOUT_MS = 10 * 60_000;

export interface MainOptions {
  message: string;
  /**
   * Library-mode config override. When set, we skip file discovery entirely
   * — the override is parsed (to apply defaults) and used as-is. This is the
   * seam tests and embedders use to avoid touching disk.
   */
  configOverride?: AxConfigInput;
  /** Directory to walk for `ax.config.*`. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Override the sqlite DB path from config. Exists to keep legacy `AX_DB`
   * env-var binary-mode working while we phase config-driven storage in.
   */
  sqlitePath?: string;
  /**
   * Override `AgentContext.workspace.rootPath`. Defaults to `cwd`, which in
   * turn defaults to `process.cwd()`. Tool sandboxes land inside this dir.
   */
  workspaceRoot?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Test-seam ONLY. When set and `cfg.llm === 'anthropic'`, replaces the real
   * SDK client with the factory result — same hatch the llm-anthropic plugin
   * already exposes, threaded through here for library-mode tests. Lives on
   * `MainOptions` (not in the JSON config schema) because functions aren't
   * JSON-serializable and this seam must not be reachable from file-based
   * config. Not used in binary-mode.
   */
  anthropicClientFactory?: (apiKey: string) => {
    messages: { create(req: Record<string, unknown>): Promise<unknown> };
  };
  /**
   * Test-seam ONLY. Extra plugins appended AFTER the config-driven plugin
   * set, before bootstrap. Lets library-mode tests inject observer plugins
   * (e.g. a `tool:post-call` subscriber that records events) and stub
   * service registrations (see `skipDefaultLlm`). Not reachable from
   * file-based config — plugins aren't JSON-serializable.
   */
  extraPlugins?: Plugin[];
  /**
   * Test-seam ONLY. When true, the default LLM plugin selected by
   * `cfg.llm` is NOT pushed — callers must supply an `llm:call` registrar
   * through `extraPlugins`. Exists because the hook bus enforces exactly
   * one registrar per service hook, so "override the default" means "don't
   * register the default". Not reachable from file-based config.
   */
  skipDefaultLlm?: boolean;
  /**
   * Test-seam ONLY. When true, the Phase 2 credential-proxy is NOT loaded
   * even on the `cfg.llm === 'anthropic'` branch. Lets library-mode tests
   * with stubbed Anthropic clients exercise the chat-orchestrator without
   * having to seed an `anthropic-api` credential — the stub never reaches
   * the wire, so the proxy adds no value in those tests. Not reachable
   * from file-based config.
   */
  skipCredentialProxy?: boolean;
}

const DEFAULT_SQLITE_PATH = './ax-next-chat.sqlite';

export async function main(opts: MainOptions): Promise<number> {
  const out = opts.stdout ?? ((line) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line) => process.stderr.write(line + '\n'));

  const cwd = opts.cwd ?? process.cwd();
  const cfg: AxConfig =
    opts.configOverride !== undefined
      ? AxConfigSchema.parse(opts.configOverride)
      : await loadAxConfig({ cwd });

  const bus = new HookBus();

  const plugins: Plugin[] = [];

  // Storage (always sqlite for now; schema gates this).
  plugins.push(
    createStorageSqlitePlugin({
      databasePath: opts.sqlitePath ?? DEFAULT_SQLITE_PATH,
    }),
  );

  // Credentials sits immediately after storage. Phase 1b split: the facade
  // (@ax/credentials) calls credentials:store-blob:* on the default backend
  // (@ax/credentials-store-db), which in turn calls storage:get / storage:set.
  // Future vault / KMS backends register credentials:store-blob:* against a
  // different store; the facade and its consumers don't change. Bootstrap is
  // topologically ordered by declared calls/registers, but pushing in-order
  // keeps the intent obvious to readers. Init requires AX_CREDENTIALS_KEY in env.
  plugins.push(createCredentialsStoreDbPlugin());
  plugins.push(createCredentialsPlugin());

  // Phase 3 — Anthropic OAuth (per-kind credentials sub-services). Loaded
  // unconditionally because it's purely additive: it registers
  // `credentials:resolve:anthropic-oauth` etc. without forcing any agent
  // to use OAuth. An agent whose requiredCredentials are all `kind: 'api-key'`
  // gets the Phase 2 fast path; only OAuth-keyed credentials dispatch into
  // this plugin. Loading it everywhere also enables `ax-next credentials
  // login anthropic` to work without a separate "are we using OAuth?"
  // config flag.
  plugins.push(createCredentialsAnthropicOauthPlugin());

  // Phase 2 — credential-proxy. Loaded ONLY when llm = anthropic. The
  // proxy substitutes a real Anthropic key into outbound api.anthropic.com
  // calls; mock-LLM mode never reaches the wire (the runner's
  // ANTHROPIC_BASE_URL points at the in-sandbox llm-proxy, which routes
  // back to the host's mocked `llm:call`). Loading the proxy in mock mode
  // would force the SDK runner onto the direct-egress path and turn every
  // canary into a real network call against an untrusted upstream — bad.
  //
  // Subprocess sandbox uses TCP loopback (port 0 = OS-assigned); the
  // runner-side bridge is NOT used on this path because the runner
  // reaches the proxy directly via HTTPS_PROXY in its child env.
  if (cfg.llm === 'anthropic' && opts.skipCredentialProxy !== true) {
    plugins.push(
      createCredentialProxyPlugin({
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      }),
    );
  }

  // Audit log is part of the canary loop.
  plugins.push(auditLogPlugin());

  // Sandbox. Config only admits 'subprocess' today; the switch is future-
  // proofing for when alternate sandbox providers land.
  if (cfg.sandbox === 'subprocess') {
    plugins.push(createSandboxSubprocessPlugin());
  }

  // Session + IPC + chat orchestration. `agent:invoke` is registered by
  // @ax/chat-orchestrator, which drives the per-chat lifecycle through
  // sandbox:open-session + session:queue-work and awaits chat:end from
  // the runner (delivered by @ax/ipc-server).
  plugins.push(createSessionInmemoryPlugin());
  plugins.push(createIpcServerPlugin());
  plugins.push(createLlmProxyAnthropicFormatPlugin());
  plugins.push(
    createChatOrchestratorPlugin({
      runnerBinary: resolveRunnerBinary(cfg.runner),
      chatTimeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    }),
  );

  // Week 9.5: chat-orchestrator hard-depends on `agents:resolve`. The CLI
  // is the single-tenant dev loop — there's no admin endpoint, no team
  // ACL, no postgres-backed agent rows. We register a permissive stub
  // that returns the same agent for every (agentId, userId) pair so the
  // orchestrator's resolve gate is satisfied without standing up the
  // multi-tenant preset. Production presets register the real @ax/agents
  // plugin instead; the kernel's "exactly one impl per service hook" rule
  // catches accidental dual-loading. See dev-agents-stub.ts.
  plugins.push(createDevAgentsStubPlugin());

  // Tool dispatcher is the single entry point for `tool:execute`, fanning
  // out to whatever tool plugins register descriptors. Always present when
  // we might have tools. (After Task 7, bash/file-io here are descriptor-
  // only — actual execution runs in the sandbox via the impl packages.)
  plugins.push(createToolDispatcherPlugin());
  if (cfg.tools.includes('bash')) {
    plugins.push(createToolBashPlugin());
  }
  if (cfg.tools.includes('file-io')) {
    plugins.push(createToolFileIoPlugin());
  }

  // MCP-sourced tools register through the same `tool:register` surface as
  // bash/file-io. Push unconditionally: when no MCP configs are stored,
  // `loadConfigs` returns an empty array and init is a no-op. Ordering
  // note: must come AFTER tool-dispatcher (which registers `tool:register`)
  // and AFTER credentials + storage-sqlite (which it calls during init).
  // Bootstrap's topological sort handles this either way, but keeping the
  // push order aligned with the call graph keeps readers grounded.
  plugins.push(createMcpClientPlugin());

  // LLM selection. `exactOptionalPropertyTypes` on the Anthropic plugin
  // config means we can't just splat through fields whose type is
  // `string | undefined` — we strip undefined keys first.
  //
  // `skipDefaultLlm` is a test-only seam: callers that want to supply their
  // own `llm:call` registrar via `extraPlugins` set it so we don't emit a
  // default (duplicate-service would throw at bootstrap).
  if (opts.skipDefaultLlm !== true) {
    if (cfg.llm === 'anthropic') {
      const a = cfg.anthropic ?? {};
      const anthropicCfg: {
        model?: string;
        maxTokens?: number;
        clientFactory?: (apiKey: string) => {
          messages: { create(req: Record<string, unknown>): Promise<unknown> };
        };
      } = {};
      if (a.model !== undefined) anthropicCfg.model = a.model;
      if (a.maxTokens !== undefined) anthropicCfg.maxTokens = a.maxTokens;
      // `anthropicClientFactory` is MainOptions-only (not in AxConfig), so we
      // thread it through here for the library-mode e2e test seam.
      if (opts.anthropicClientFactory !== undefined) {
        anthropicCfg.clientFactory = opts.anthropicClientFactory;
      }
      plugins.push(createLlmAnthropicPlugin(anthropicCfg));
    } else {
      plugins.push(llmMockPlugin());
    }
  }

  // Library-mode test-only: extra plugins appended last so they can add
  // subscribers that observe the full plugin set and (in combination with
  // `skipDefaultLlm`) supply an alternative `llm:call` registrar.
  if (opts.extraPlugins !== undefined) {
    plugins.push(...opts.extraPlugins);
  }

  const handle = await bootstrap({ bus, plugins, config: {} });

  const ctx = makeAgentContext({
    sessionId: 'cli-session',
    agentId: 'cli-agent',
    userId: 'cli-user',
    workspace: { rootPath: opts.workspaceRoot ?? cwd },
  });

  try {
    const outcome: AgentOutcome = await bus.call('agent:invoke', ctx, {
      message: { role: 'user', content: opts.message },
    });

    if (outcome.kind === 'complete') {
      const last = outcome.messages[outcome.messages.length - 1];
      out(last?.content ?? '');
      return 0;
    }
    err(`chat terminated: ${outcome.reason}`);
    return 1;
  } finally {
    await handle.shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sqlitePath = process.env.AX_DB ?? DEFAULT_SQLITE_PATH;
  const argv = process.argv.slice(2);

  // Subcommand dispatch. Intercept BEFORE the chat path so we don't bootstrap
  // the full LLM/sandbox/orchestrator plugin set for what's essentially a
  // "write a row to sqlite" operation — and so we don't race the chat path's
  // DB init.
  if (argv[0] === 'credentials') {
    runCredentialsCommand({
      argv: argv.slice(1),
      stdin: process.stdin,
      sqlitePath,
    })
      .then((code) => process.exit(code))
      .catch((e) => {
        // The command itself turns PluginError into stderr+exit-1. Anything
        // reaching here is truly unexpected — be boring so we don't echo
        // something we shouldn't.
        process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
      });
  } else if (argv[0] === 'mcp') {
    runMcpCommand({
      argv: argv.slice(1),
      stdin: process.stdin,
      sqlitePath,
    })
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
      });
  } else if (argv[0] === 'admin') {
    // One-shot admin tooling. Today: `bootstrap` (first-admin against
    // /auth/dev-bootstrap). Like credentials/mcp this intercepts BEFORE
    // the chat path so we don't bootstrap the LLM/sandbox/orchestrator
    // plugin set for what's a thin HTTP client.
    runAdminCommand({ argv: argv.slice(1) })
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
      });
  } else if (argv[0] === 'serve') {
    // Long-running k8s-mode entrypoint. The chart's host pod runs this.
    // Local-dev users running `node dist/cli/index.js serve` will boot the
    // full k8s preset — they need DATABASE_URL + AX_K8S_HOST_IPC_URL +
    // AX_WORKSPACE_BACKEND set, otherwise we exit 2 with a clear message.
    runServeCommand({ argv: argv.slice(1) })
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
      });
  } else {
    const message = argv.join(' ') || 'hi';
    // Note: SIGINT/SIGTERM during agent:invoke is NOT gracefully handled here.
    // The CLI is one-shot — for a clean shutdown we'd need to thread cancel
    // signals into the agent:invoke hook, which is its own slice. The try/finally
    // around agent:invoke inside main() handles the normal completion path
    // (incl. errors that bubble up) for storage-sqlite WAL flush etc.
    main({ message, sqlitePath })
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
      });
  }
}
