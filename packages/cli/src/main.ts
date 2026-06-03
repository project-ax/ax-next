#!/usr/bin/env node
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HookBus,
  bootstrap,
  createLogger,
  makeAgentContext,
  makeReqId,
  type AgentOutcome,
  type Plugin,
} from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialProxyPlugin } from '@ax/credential-proxy';
import { auditLogPlugin } from '@ax/audit-log';
import { createValidatorSkillPlugin } from '@ax/validator-skill';
import { createValidatorRoutinePlugin } from '@ax/validator-routine';
import { createValidatorIdentityPlugin } from '@ax/validator-identity';
import { createValidatorServicePlugin } from '@ax/validator-service';
import { createSandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { createWorkspaceGitPlugin } from '@ax/workspace-git';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import { createToolDispatcherPlugin, createMcpClientPlugin } from '@ax/mcp-client';
import { createToolArtifactPublishPlugin } from '@ax/tool-artifact-publish';
import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';
import { createMemoryStrataPlugin } from '@ax/memory-strata';
import { createMemoryStrataIndexSqlitePlugin } from '@ax/memory-strata-index-sqlite';
import { createWebToolsPlugin } from '@ax/web-tools';
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
// Lazy-resolve the runner binary inside main() rather than at module load.
// Library-mode consumers (tests, embedders using configOverride) that never
// invoke agent:invoke shouldn't fail to import @ax/cli just because the
// runner's dist/ hasn't been built yet. `createRequire` from the CLI's own
// URL is robust against pnpm hoisting and works identically in dev + prod.
//
// We resolve the package's `.` export (which is `dist/main.js`) rather than
// a subpath specifier: the runner's `exports` field only exposes `.` and
// `./turn-loop`, so a direct `./dist/main.js` subpath is blocked by Node's
// exports-map enforcement.
const requireFromCli = createRequire(import.meta.url);
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
   * Test-seam ONLY. Extra plugins appended AFTER the config-driven plugin
   * set, before bootstrap. Lets library-mode tests inject observer plugins
   * (e.g. a `tool:post-call` subscriber that records events) and stub
   * service registrations. Not reachable from file-based config — plugins
   * aren't JSON-serializable.
   */
  extraPlugins?: Plugin[];
  /**
   * Test-seam ONLY. When true, the Phase 2 credential-proxy is NOT loaded.
   * Lets library-mode tests with stubbed runtimes exercise the
   * chat-orchestrator without having to seed a `provider:anthropic` credential.
   * Not reachable from file-based config.
   */
  skipCredentialProxy?: boolean;
  /**
   * Test-only seam: override the runner binary path. When set, the chat
   * orchestrator spawns this instead of @ax/agent-claude-sdk-runner.
   *
   * Also accepts the AX_TEST_RUNNER_BINARY_OVERRIDE env var so the CLI's
   * binary entrypoint (which can't pass MainOptions through argv) can still
   * substitute via env. Resolution order: opts > env > default.
   */
  runnerBinaryOverride?: string;
}

/**
 * Resolve the runner binary path. Production resolves @ax/agent-claude-sdk-runner;
 * tests override via opts.runnerBinaryOverride (library-mode) or via
 * AX_TEST_RUNNER_BINARY_OVERRIDE env var (binary-mode where the CLI is spawned
 * from a test as a subprocess and MainOptions can't be threaded through).
 */
export function resolveRunnerBinary(opts: Pick<MainOptions, 'runnerBinaryOverride'>): string {
  return (
    opts.runnerBinaryOverride ??
    process.env.AX_TEST_RUNNER_BINARY_OVERRIDE ??
    requireFromCli.resolve('@ax/agent-claude-sdk-runner')
  );
}

const DEFAULT_SQLITE_PATH = './ax-next-chat.sqlite';

/**
 * Default location for the bare workspace repo `@ax/workspace-git`
 * initializes. Derived from the sqlite path so both pieces of host
 * state live in the same parent directory. The bare repo MUST live
 * outside the agent's working tree (the runner's `git clone` refuses
 * a non-empty target); placing it next to the sqlite file naturally
 * satisfies that as long as the user's `cwd` for chat is a different
 * directory.
 */
function defaultWorkspaceRepoRoot(sqlitePath: string): string {
  const dir = path.dirname(path.resolve(sqlitePath));
  return path.join(dir, 'ax-next-workspace.git');
}

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

  // I12 — provider credentials are API-key-only across the default UI/preset.
  // Default-preset hosts (CLI + k8s chart) advertise only `kind: api-key`
  // via /admin/credentials/kinds.

  // Phase 2 — credential-proxy. The SDK runner is the only runtime now, and
  // it always reaches Anthropic via HTTPS_PROXY into this plugin (which
  // substitutes a real credential into the outbound api.anthropic.com call).
  // Loaded unconditionally; the `skipCredentialProxy` seam exists only for
  // library-mode tests with stubbed runtimes that never reach the wire.
  //
  // Subprocess sandbox uses TCP loopback (port 0 = OS-assigned); the
  // runner-side bridge is NOT used on this path because the runner
  // reaches the proxy directly via HTTPS_PROXY in its child env.
  //
  // Phase 6.6 test seam: AX_TEST_STUB_PROXY=1 substitutes a test-only proxy
  // plugin (from @ax/test-harness) that satisfies the chat-orchestrator's
  // proxy:open-session/close-session gate without seeding credentials.
  // The dynamic import keeps production startup cost zero — the test-harness
  // module is never resolved unless the env var is set. Tests using this
  // path drive the runner via AX_TEST_RUNNER_BINARY_OVERRIDE (see resolveRunnerBinary).
  if (process.env.AX_TEST_STUB_PROXY === '1') {
    const encoded = process.env.AX_TEST_STUB_SCRIPT_BASE64;
    if (encoded === undefined || encoded === '') {
      throw new Error(
        'AX_TEST_STUB_PROXY=1 requires AX_TEST_STUB_SCRIPT_BASE64 to be set',
      );
    }
    const { createTestProxyPlugin, decodeScript } = await import('@ax/test-harness');
    plugins.push(createTestProxyPlugin({ script: decodeScript(encoded) }));
  } else if (opts.skipCredentialProxy !== true) {
    plugins.push(
      createCredentialProxyPlugin({
        listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      }),
    );
  }

  // Audit log is part of the canary loop.
  plugins.push(auditLogPlugin());

  // Phase 3: validator-skill subscribes to workspace:pre-apply and
  // vetoes SKILL.md changes with malformed YAML frontmatter. CLI/k8s
  // parity — same plugin set so dev runs catch the same SKILL.md
  // shape failures production would.
  plugins.push(createValidatorSkillPlugin());

  // Phase B (2026-05-14). validator-routine is a pure subscriber and works
  // anywhere workspace:pre-apply fires — load in local CLI dev too so
  // routine-file authors get the same veto feedback as production.
  //
  // @ax/routines itself is NOT loaded here: its init() calls
  // `database:get-instance`, which only `@ax/database-postgres` registers.
  // The local CLI uses `@ax/storage-sqlite` (different mechanism) and
  // doesn't load the conversations / agents / chat-orchestrator plugins
  // routines depends on. Loading it would crash bootstrap with
  // "no plugin registered for service hook 'database:get-instance'."
  // The k8s preset loads it (postgres is present there); see
  // presets/k8s/src/index.ts and the Phase B canary describe block in
  // preset.test.ts.
  plugins.push(createValidatorRoutinePlugin());

  // Phase 3 (conversational-agent-identity): validator-identity subscribes to
  // workspace:pre-apply and gates the agent's writes to its own identity files
  // (.ax/IDENTITY.md / .ax/SOUL.md / .ax/AGENTS.md / .ax/BOOTSTRAP.md) under the
  // bootstrap-window policy. A pure subscriber that works anywhere
  // workspace:pre-apply fires (its workspace:read dep is an optionalCall that
  // degrades to the post-bootstrap policy) — load in local CLI dev too so an
  // identity self-edit gets the same injection veto + bootstrap gate as prod.
  plugins.push(createValidatorIdentityPlugin());

  // TASK-150: validator-service registers `services:validate` — the neutral
  // dev-SERVICE descriptor validator (digest-pin I8, descriptor caps, and a
  // named rejection of smuggled backend vocab I2). A pure, no-dep service hook
  // (NO spawn / file I/O / DB / network), so it loads in the Postgres-free CLI
  // preset exactly like validator-skill's `skills:scan` does. This OPENS the
  // half-wired window: the validator + the `services` schema field exist, but
  // nothing folds a service descriptor onto a session yet.
  plugins.push(createValidatorServicePlugin());

  // Sandbox. Config only admits 'subprocess' today; the switch is future-
  // proofing for when alternate sandbox providers land.
  if (cfg.sandbox === 'subprocess') {
    plugins.push(createSandboxSubprocessPlugin());
  }

  // Single-replica workspace plugin — registers workspace:list /
  // workspace:read / workspace:apply / workspace:apply-bundle /
  // workspace:export-baseline-bundle. The runner's `workspace.materialize`
  // IPC delegates to `workspace:export-baseline-bundle` (bundle-aware
  // path); without this plugin the runner can't materialize and chat
  // can't start. Default `repoRoot` lives next to the sqlite file so
  // both host-side state files end up in the same parent dir; override
  // with AX_WORKSPACE_REPO_ROOT for ops that want it elsewhere.
  const sqlitePath = opts.sqlitePath ?? DEFAULT_SQLITE_PATH;
  const workspaceRepoRoot =
    process.env.AX_WORKSPACE_REPO_ROOT ?? defaultWorkspaceRepoRoot(sqlitePath);
  plugins.push(createWorkspaceGitPlugin({ repoRoot: workspaceRepoRoot }));

  // Session + IPC + chat orchestration. `agent:invoke` is registered by
  // @ax/chat-orchestrator, which drives the per-chat lifecycle through
  // sandbox:open-session + session:queue-work and awaits chat:end from
  // the runner (delivered by @ax/ipc-server).
  plugins.push(createSessionInmemoryPlugin());
  plugins.push(createIpcServerPlugin());
  plugins.push(
    createChatOrchestratorPlugin({
      runnerBinary: resolveRunnerBinary(opts),
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
  // out to whatever tool plugins register descriptors. The dispatcher's
  // tool surface is populated entirely by MCP-registered host tools (see
  // the `createMcpClientPlugin()` push below); built-in bash/file-io
  // descriptors are gone (Phase 6 Task 6 deleted their host-side packages
  // — the SDK runner's sandboxed Bash/Read/Write replace them).
  plugins.push(createToolDispatcherPlugin());

  // artifact_publish tool — registers its descriptor via tool:register (same
  // surface the dispatcher exposes). Must come AFTER createToolDispatcherPlugin().
  plugins.push(createToolArtifactPublishPlugin());

  // MCP-sourced tools register through the same `tool:register` surface
  // the dispatcher exposes. Push unconditionally: when no MCP configs are
  // stored, `loadConfigs` returns an empty array and init is a no-op. Ordering
  // note: must come AFTER tool-dispatcher (which registers `tool:register`)
  // and AFTER credentials + storage-sqlite (which it calls during init).
  // Bootstrap's topological sort handles this either way, but keeping the
  // push order aligned with the call graph keeps readers grounded.
  plugins.push(createMcpClientPlugin());

  // Memory-strata (@ax/memory-strata) — Phase 1: hot-tier markdown +
  // Observer extracting facts to permanent/memory/inbox/. The Observer
  // calls llm:call:anthropic, so we load both as a set behind the
  // ANTHROPIC_API_KEY env gate. CLI users without the env var get the
  // pre-Phase-1 behavior (no host-side LLM, no memory writes); users
  // with it get auto-extraction. This mirrors the k8s preset's pattern
  // for @ax/conversation-titles + @ax/llm-anthropic — both load behind
  // the same env condition or neither does.
  //
  // The runner still reaches Anthropic via the credential-proxy for
  // chat itself; this env-driven LLM plugin is a SEPARATE host-side
  // capability used only by host plugins (titles, memory observer).
  if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY.length > 0) {
    plugins.push(createLlmAnthropicPlugin());
    // @ax/web-tools — host-executed web_search + web_extract backed by
    // Anthropic's server-side web tools. Gated on the same global key as
    // the other host-side LLM capabilities (it constructs its own
    // Anthropic client from ANTHROPIC_API_KEY). Available to all agents.
    plugins.push(createWebToolsPlugin());
    plugins.push(createMemoryStrataPlugin());
    // I24 — indexer loads as a pair with memory-strata (same gate). The sqlite
    // indexer shares the same DB file as storage-sqlite; each plugin owns its
    // own table (kv vs memory_strata_index_v1_docs) — no collision.
    plugins.push(createMemoryStrataIndexSqlitePlugin({ databasePath: opts.sqlitePath ?? DEFAULT_SQLITE_PATH }));
  }

  // Library-mode test-only: extra plugins appended last so they can add
  // subscribers that observe the full plugin set.
  if (opts.extraPlugins !== undefined) {
    plugins.push(...opts.extraPlugins);
  }

  const handle = await bootstrap({ bus, plugins, config: {} });

  // CLI hygiene: structured logs (debug/info/warn/error) go to stderr, so
  // stdout stays clean for the chat outcome the binary writes via `out`.
  // Without this, debug lines like sandbox-subprocess's `runner_stderr`
  // intermix with the chat result and break callers that pipe stdout.
  // Route through `err` (the library-mode stderr sink) so library-mode
  // callers passing `opts.stderr` capture these logs alongside their
  // direct `err(...)` lines, instead of bypassing into raw `process.stderr`.
  const reqId = makeReqId();
  const logger = createLogger({
    reqId,
    writer: err,
  });
  const ctx = makeAgentContext({
    reqId,
    logger,
    sessionId: 'cli-session',
    agentId: 'cli-agent',
    // `cli` matches what every other CLI subcommand (credentials, mcp,
    // admin) writes against — without alignment, `credentials set
    // provider:anthropic` stores under userId=`cli` and the chat path's
    // `credentials:get` looks under `cli-user`, finds nothing, and
    // `proxy:open-session` terminates the chat with `proxy-open-failed`.
    userId: 'cli',
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
    // One-shot admin tooling. Today: `reset-bootstrap` (operator escape
    // hatch — re-mints the bootstrap token used by the @ax/onboarding
    // wizard). Like credentials/mcp this intercepts BEFORE the chat path
    // so we don't bootstrap the LLM/sandbox/orchestrator plugin set.
    runAdminCommand({ argv: argv.slice(1) })
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
      });
  } else if (argv[0] === 'serve') {
    // Long-running k8s-mode entrypoint. The chart's host pod runs this.
    // Local-dev users running `node packages/cli/dist/main.js serve` will
    // boot the full k8s preset — they need DATABASE_URL + AX_K8S_HOST_IPC_URL
    // + AX_WORKSPACE_BACKEND set, otherwise we exit 2 with a clear message.
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
