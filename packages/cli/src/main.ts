#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  HookBus,
  bootstrap,
  makeChatContext,
  type ChatOutcome,
  type Plugin,
} from '@ax/core';
import { llmMockPlugin } from '@ax/llm-mock';
import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { auditLogPlugin } from '@ax/audit-log';
import { createSandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createLlmProxyAnthropicFormatPlugin } from '@ax/llm-proxy-anthropic-format';
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import { createToolBashPlugin } from '@ax/tool-bash';
import { createToolFileIoPlugin } from '@ax/tool-file-io';
import { AxConfigSchema, type AxConfig, type AxConfigInput } from './config/schema.js';
import { loadAxConfig } from './config/load.js';

// `@ax/cli` is the ONE package permitted to import sibling plugins directly
// (eslint.config.mjs no-restricted-imports allowlist); this is also the one
// spot where we pin down the runner binary location (I8).
//
// Lazy-resolve the agent-native-runner binary inside main() rather than at
// module load. Library-mode consumers (tests, embedders using configOverride)
// that never invoke chat:run shouldn't fail to import @ax/cli just because
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
   * Override `ChatContext.workspace.rootPath`. Defaults to `cwd`, which in
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

  // Audit log is part of the canary loop.
  plugins.push(auditLogPlugin());

  // Sandbox. Config only admits 'subprocess' today; the switch is future-
  // proofing for when alternate sandbox providers land.
  if (cfg.sandbox === 'subprocess') {
    plugins.push(createSandboxSubprocessPlugin());
  }

  // Session + IPC + chat orchestration. Together these replace the old
  // in-process `registerChatLoop` — `chat:run` is now registered by
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

  await bootstrap({ bus, plugins, config: {} });

  const ctx = makeChatContext({
    sessionId: 'cli-session',
    agentId: 'cli-agent',
    userId: 'cli-user',
    workspace: { rootPath: opts.workspaceRoot ?? cwd },
  });

  const outcome: ChatOutcome = await bus.call('chat:run', ctx, {
    message: { role: 'user', content: opts.message },
  });

  if (outcome.kind === 'complete') {
    const last = outcome.messages[outcome.messages.length - 1];
    out(last?.content ?? '');
    return 0;
  }
  err(`chat terminated: ${outcome.reason}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sqlitePath = process.env.AX_DB ?? DEFAULT_SQLITE_PATH;
  const message = process.argv.slice(2).join(' ') || 'hi';
  main({ message, sqlitePath })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    });
}
