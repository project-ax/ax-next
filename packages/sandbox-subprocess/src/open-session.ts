import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import {
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
// Shared `sandbox:open-session` contract — single source of truth for the
// payload schemas (formerly duplicated, and drifting, between the two sandbox
// backends + the orchestrator). See @ax/sandbox-protocol. Re-exported below so
// existing consumers of this module's `OpenSessionInputSchema` keep working.
import {
  OpenSessionInputSchema,
  type OpenSessionInput,
  type OpenSessionParsed,
} from '@ax/sandbox-protocol';
import { allowlistFromParent } from './env.js';

// ---------------------------------------------------------------------------
// sandbox:open-session
//
// Spawns a per-session runner subprocess. The runner connects back over a unix
// socket whose path we create in a mode-0700 tempdir (I10). Auth token is
// minted via `session:create` and passed to the runner only via env — never
// logged at info+, never returned to the hook's caller (I9). The runner
// binary path must be absolute (I8); no env-var fallback, no exec-path magic.
//
// Trust boundary (I5): every tunable at this surface is either validated or
// drawn from the same allowlist as `sandbox:spawn`. A caller cannot inject
// env, argv, or cwd — argv is fixed to `node <runnerBinary>`, cwd is
// `workspaceRoot`, and env is the session-scoped quadruple plus the allowlist.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/sandbox-subprocess';
const HOOK_NAME = 'sandbox:open-session';
const SIGKILL_DELAY_MS = 5_000;

// Reset installedSkillsDir permissions to 0755 before deleting the
// socketDir tree. Phase 1 chmods it to 0555 after writing skills —
// fs.rm({ recursive: true }) cannot remove subdirectories from within a
// 0555-mode directory (EACCES on non-Linux, possibly on Linux too).
// Best-effort: if the dir doesn't exist or chmod fails, log nothing —
// the caller's best-effort rm will cover ENOENT.
async function unlockInstalledSkillsDir(installedSkillsDir: string): Promise<void> {
  try {
    await fs.chmod(installedSkillsDir, 0o755);
  } catch {
    // ENOENT (never created) or other — swallow; caller's rm is best-effort.
  }
}

// Translate an McpServerSpec into the Anthropic SDK's `.mcp.json` shape.
// stdio: { command, args, env }. http: { url, type: 'http' }. The SDK accepts
// either at top level under the `mcpServers` map; the per-skill dir's
// `.mcp.json` is auto-loaded by the SDK's `'project'` setting source.
function toMcpJsonShape(s: {
  transport: 'stdio' | 'http';
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
}): unknown {
  if (s.transport === 'stdio') {
    return { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  }
  return { url: s.url, type: 'http' };
}

// OpenSessionInputSchema + its OpenSessionInput / OpenSessionParsed types now
// live in @ax/sandbox-protocol (imported above) — re-exported here so existing
// importers of this module keep resolving. The schema is the same shape this
// plugin authored; the k8s backend converged onto it.
export {
  OpenSessionInputSchema,
  type OpenSessionInput,
  type OpenSessionParsed,
};

export interface OpenSessionHandle {
  kill(): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  // Test/inspection only: the raw child handle. NOT part of the prod
  // contract — callers relying on this break on any future refactor.
  // Present so tests can read stdout without changing the production return
  // shape or polluting the workspace with marker files.
  readonly child?: ChildProcessByStdio<null, Readable, Readable>;
}

export interface OpenSessionResult {
  /**
   * Opaque URI describing how the runner reaches the host. The provider
   * picks the scheme:
   *   - `unix:///abs/path/ipc.sock` for the in-host subprocess sandbox.
   *   - `http://podip:7777`        for the k8s pod sandbox (Task 14/15).
   *
   * The orchestrator and the runner's IPC client treat this as opaque —
   * they switch on `new URL(runnerEndpoint).protocol` to dispatch
   * transport. I1: no transport-specific field name leaks across the
   * `sandbox:open-session` boundary.
   */
  runnerEndpoint: string;
  handle: OpenSessionHandle;
}

// Shapes of the hooks we bus.call out to. These intentionally mirror the
// exported types from @ax/session-inmemory and @ax/ipc-server — but we do
// NOT import from those sibling plugins (I2). Structural duplication is the
// boundary cost; a drift would surface as a runtime shape error at call time.
interface SessionCreateInput {
  sessionId: string;
  workspaceRoot: string;
  owner?: {
    userId: string;
    agentId: string;
    agentConfig: {
      systemPrompt: string;
      allowedTools: string[];
      mcpConfigIds: string[];
      model: string;
    };
    conversationId?: string;
  };
}
interface SessionCreateOutput {
  sessionId: string;
  token: string;
}
interface IpcStartInput {
  socketPath: string;
  sessionId: string;
}
interface IpcStartOutput {
  running: true;
}
interface SessionTerminateInput {
  sessionId: string;
}
interface IpcStopInput {
  sessionId: string;
}

export async function openSessionImpl(
  ctx: AgentContext,
  rawInput: unknown,
  bus: HookBus,
): Promise<OpenSessionResult> {
  // 1. Validate input — Zod errors surface as PluginError('invalid-payload').
  const parseResult = OpenSessionInputSchema.safeParse(rawInput);
  if (!parseResult.success) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: `invalid input: ${parseResult.error.message}`,
      cause: parseResult.error,
    });
  }
  const input: OpenSessionParsed = parseResult.data;

  // 2. Pre-check: runner binary exists and is readable. I8 says a caller that
  //    forgot to configure this gets a LOUD error — don't wait for spawn()'s
  //    ENOENT which arrives asynchronously via 'error' event.
  try {
    await fs.access(input.runnerBinary, fsConstants.R_OK);
  } catch (cause) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: `runner binary not found or not readable: ${input.runnerBinary}`,
      cause,
    });
  }

  // 3. Per-session tempdir — mkdtemp is mode 0700 on POSIX by default (I10).
  //    Socket file goes inside; only the host uid can connect.
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-'));
  const socketPath = path.join(socketDir, 'ipc.sock');

  // I-P0-3: per-session HOME, isolated from the host user's home so the
  //    Claude Agent SDK's `'user'` setting source — which walks
  //    `$CLAUDE_CONFIG_DIR` (falling back to `$HOME/.claude`) — can't
  //    read the developer's personal `~/.claude/skills/` and load
  //    arbitrary host-side content into the sandbox.
  //
  //    The home root piggybacks on the same per-session tempdir as the
  //    IPC socket — cleanup is already handled by the existing
  //    `fs.rm(socketDir, { recursive: true })` in the close handler.
  //
  //    CLAUDE_CONFIG_DIR points at `$HOME/.ax/session` — the "session"
  //    name matches the rest of the codebase's vocabulary (sessionId,
  //    session-postgres, etc.). The empty `skills/` subdirectory must
  //    exist on disk BEFORE the runner spawns: the SDK walks it during
  //    skill discovery and an ENOENT would surface as a startup error.
  //    Phase 0 leaves it empty (the SDK simply finds no installed skills);
  //    Phase 1 will materialize approved skill bodies here, then chmod
  //    to 0555 to lock against agent writes. For Phase 0 the dir stays
  //    0755 — there is nothing to lock yet.
  const homeDir = path.join(socketDir, 'home');
  const claudeConfigDir = path.join(homeDir, '.ax', 'session');
  const installedSkillsDir = path.join(claudeConfigDir, 'skills');
  // Session-scoped scratch root — the subprocess analogue of k8s's
  // `/ephemeral` emptyDir. Nested inside the 0700 per-session tempdir so
  // (a) it's writable by the runner uid, (b) it's isolated from other
  // sessions, and (c) the existing `fs.rm(socketDir, { recursive: true })`
  // cleanup reaps it — no separate teardown. Stamped onto the runner env as
  // AX_EPHEMERAL_ROOT below; the runner wires it into the SDK's
  // additionalDirectories + system prompt.
  const ephemeralDir = path.join(socketDir, 'ephemeral');
  try {
    await fs.mkdir(installedSkillsDir, { recursive: true, mode: 0o755 });
    await fs.mkdir(ephemeralDir, { recursive: true, mode: 0o700 });

    // I-P0-4: the `.claude/skills → ../.ax/skills` symlink that the SDK's
    //    `'project'` setting source walks now lives on the RUNNER side
    //    (see @ax/agent-claude-sdk-runner/git-workspace.ts's
    //    `scaffoldWorkspaceSkillSurface`, called after
    //    `materializeWorkspace`). Doing it here pre-spawn was the bug PR
    //    #99 fixed for k8s: the runner's `git clone` of the materialized
    //    workspace bundle refuses a non-empty target with
    //    `fatal: destination path '<workspace>' already exists and is not
    //    an empty directory`. Subprocess uses the same runner main and
    //    the same always-bundle materialize contract, so it has the same
    //    failure mode — even though the existing test stubs (echo-stub
    //    short-circuits before materialize) don't surface it.

    // Phase 1 (skill-install): materialize installed-skill SKILL.md bodies
    // into $CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md. The SDK's 'user' source
    // (Phase 0 set settingSources + CLAUDE_CONFIG_DIR) discovers these at
    // runner startup; Phase 1 fills the directory.
    //
    // chmod 0555 the parent skills dir AFTER all writes so the runner's own
    // tool calls (echo > path, mkdir, etc.) can't extend or overwrite the
    // directory. Workspace:apply has no path to HOME, so the workspace side
    // defense is automatic; chmod is the belt against tool-bash. We chmod
    // LAST because mkdir + writeFile both need write permission.
    if (input.installedSkills !== undefined && input.installedSkills.length > 0) {
      for (const skill of input.installedSkills) {
        // The zod schema already validates id shape, but double-check at the
        // trust boundary — the validation cost is trivial vs. a potential
        // path-traversal regression. Skill id reaches the path via path.join,
        // so a leading slash or `..` segment is the relevant attack shape.
        const skillDir = path.join(installedSkillsDir, skill.id);
        await fs.mkdir(skillDir, { recursive: true, mode: 0o755 });
        await fs.writeFile(
          path.join(skillDir, 'SKILL.md'),
          skill.skillMd,
          { mode: 0o444, encoding: 'utf-8' },
        );
        // Phase B — write `.mcp.json` alongside SKILL.md when the skill
        // bundles MCP servers. The SDK auto-discovers it via its `'project'`
        // setting source; the file lives in the per-skill dir so each
        // skill's MCP scope stays isolated. Defaulted-empty arrays from the
        // schema mean we always have a real array here.
        if (skill.mcpServers.length > 0) {
          const mcpJsonContent = JSON.stringify(
            {
              mcpServers: Object.fromEntries(
                skill.mcpServers.map((s) => [s.name, toMcpJsonShape(s)]),
              ),
            },
            null,
            2,
          );
          await fs.writeFile(
            path.join(skillDir, '.mcp.json'),
            mcpJsonContent,
            { mode: 0o444, encoding: 'utf-8' },
          );
        }
      }
      await fs.chmod(installedSkillsDir, 0o555);
    }
  } catch (cause) {
    // Best-effort cleanup so a setup failure doesn't leak the tempdir.
    await unlockInstalledSkillsDir(installedSkillsDir);
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    throw new PluginError({
      code: 'sandbox-prep-failed',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: `failed to prepare per-session HOME / skills layout`,
      cause,
    });
  }

  // 4. Mint session + token. The token flows to the runner as env — it is
  //    never returned from this hook (I9). We do NOT log the token here; if
  //    we need to correlate failures, we log `sessionId` instead.
  //
  //    Owner triple is forwarded into the session backend so the v2 row
  //    can be written atomically with v1 (Task 6b). The runner reads it
  //    back via session:get-config (Task 6d).
  let created: SessionCreateOutput;
  try {
    const sessionCreateInput: SessionCreateInput = {
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
    };
    if (input.owner !== undefined) {
      sessionCreateInput.owner = {
        userId: input.owner.userId,
        agentId: input.owner.agentId,
        agentConfig: input.owner.agentConfig,
        ...(input.owner.conversationId !== undefined
          ? { conversationId: input.owner.conversationId }
          : {}),
      };
    }
    created = await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      sessionCreateInput,
    );
  } catch (err) {
    // Clean up tempdir so a session:create failure doesn't leak dirs.
    await unlockInstalledSkillsDir(installedSkillsDir);
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // 5. Start the listener BEFORE spawning the runner so the runner's first
  //    connect can't race the server bind.
  try {
    await bus.call<IpcStartInput, IpcStartOutput>('ipc:start', ctx, {
      socketPath,
      sessionId: created.sessionId,
    });
  } catch (err) {
    // Tear down the session we just minted — otherwise a partially-open
    // session lingers with a live token and no listener.
    await bus
      .call<SessionTerminateInput, Record<string, never>>('session:terminate', ctx, {
        sessionId: created.sessionId,
      })
      .catch(() => undefined);
    await unlockInstalledSkillsDir(installedSkillsDir);
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // 6. Build child env. I5: caller-side env NEVER flows in — this hook's
  //    input doesn't accept env, so the only sources are
  //      (a) our session-scoped injects, and
  //      (b) the allowlist from the parent process.
  //    Allowlist merges FIRST so sessionEnv keys win on collision —
  //    a session-scoped value (HOME, CLAUDE_CONFIG_DIR, an env-injected
  //    placeholder) MUST take precedence over the parent's same-named
  //    var. See the longer comment at the actual merge site below.
  //
  //    AX_RUNNER_ENDPOINT carries the opaque URI the runner uses to reach
  //    the host. For this provider it's always `unix://<socketPath>`. The
  //    k8s provider (Task 14) injects `http://podip:7777`. The runner
  //    parses the URI; transport selection is its problem, not ours.
  const runnerEndpoint = `unix://${socketPath}`;
  const sessionEnv: Record<string, string> = {
    AX_RUNNER_ENDPOINT: runnerEndpoint,
    AX_SESSION_ID: created.sessionId,
    AX_AUTH_TOKEN: created.token,
    AX_WORKSPACE_ROOT: input.workspaceRoot,
    // Session-scoped scratch root (mkdir'd above, inside the 0700 tempdir).
    // The runner reads this as the SDK's extra writable directory; absent
    // it, the runner wouldn't grant any scratch dir. Diverges from k8s
    // (which uses the fixed `/ephemeral` mount) the same way HOME does —
    // each provider picks a path that exists and is writable for it.
    AX_EPHEMERAL_ROOT: ephemeralDir,
    // I-P0-3: override HOME (which is in the allowlist; sessionEnv merges
    // LAST so this wins) and set CLAUDE_CONFIG_DIR so the SDK's `'user'`
    // skill-discovery walks the host-controlled per-session dir, not the
    // developer's `~/.claude/`. The runner pairs this with a symlink
    // scaffold (scaffoldSdkProjectsSymlink in @ax/agent-claude-sdk-runner)
    // so the SDK's transcript jsonl writes still land inside the workspace.
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    // Git author/committer identity for the runner's turn-end commits.
    // Mirrors the k8s side's gitParanoidEnv (sandbox-k8s/pod-spec.ts) so the
    // host's `verifyBundleAuthor` accepts the bundle regardless of which
    // sandbox provider produced it — without this, git falls through to the
    // host operator's ~/.gitconfig and every subprocess chat fails at the
    // turn boundary with `expected ax-runner <ax-runner@example.com>`.
    //
    // HOME deliberately diverges between providers: subprocess uses the
    // per-session tempdir set above; k8s pins `/home/runner` (a tmpfs
    // mount). Don't unify them — the path only has to exist and be writable
    // by the runner, and the provider already picked the right one.
    //
    // safe.directory=* is defense-in-depth here. Subprocess's workspaceRoot
    // is usually owned by the same uid running the runner so git's
    // "dubious ownership" guard wouldn't fire today; the env stamp keeps
    // parity with k8s and hardens against future bind-mount / permission
    // scenarios.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'ax-runner',
    GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
    GIT_COMMITTER_NAME: 'ax-runner',
    GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };

  // credential-proxy env. When the orchestrator handed us a `proxyConfig`,
  // write the MITM CA PEM to the per-session tempdir (the same one we
  // built for the IPC socket — its 0700 mode keeps it host-uid-only) and
  // inject the matching env vars. The CA cleanup piggybacks on the
  // existing tempdir cleanup in the close handler — no new code.
  //
  // I1: the CA cert is a public key, safe inside the sandbox; the CA
  // PRIVATE key is held only by the host-side credential-proxy plugin.
  // I3: AX_PROXY_ENDPOINT (TCP) and AX_PROXY_UNIX_SOCKET (Unix socket)
  //     are the only proxy-related env vars the runner reads; the SDK's
  //     standard HTTPS_PROXY / NODE_EXTRA_CA_CERTS / SSL_CERT_FILE are
  //     populated for off-the-shelf libraries that won't know about the
  //     ax-prefixed ones.
  //
  // When `proxyConfig` is undefined, no proxy env is injected. The runner
  // will read neither AX_PROXY_ENDPOINT nor AX_PROXY_UNIX_SOCKET and fail
  // at boot — that's the intended Phase 5 behavior; presets that want a
  // working runner load @ax/credential-proxy.
  if (input.proxyConfig !== undefined) {
    const caPath = path.join(socketDir, 'ax-mitm-ca.pem');
    try {
      await fs.writeFile(caPath, input.proxyConfig.caCertPem, { mode: 0o600 });
    } catch (err) {
      await bus
        .call('ipc:stop', ctx, { sessionId: created.sessionId })
        .catch(() => undefined);
      await bus
        .call('session:terminate', ctx, { sessionId: created.sessionId })
        .catch(() => undefined);
      await unlockInstalledSkillsDir(installedSkillsDir);
      await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
      throw new PluginError({
        code: 'ca-write-failed',
        plugin: PLUGIN_NAME,
        hookName: HOOK_NAME,
        message: `failed to write MITM CA cert to ${caPath}`,
        cause: err,
      });
    }
    sessionEnv.NODE_EXTRA_CA_CERTS = caPath;
    sessionEnv.SSL_CERT_FILE = caPath;
    // TASK-12: the `git` binary the Bash tool spawns is libcurl/OpenSSL-
    // backed and reads NEITHER NODE_EXTRA_CA_CERTS nor SSL_CERT_FILE — it
    // verifies the proxy MITM cert against GIT_SSL_CAINFO. Point it at the
    // same per-session CA file, or `git clone` over the proxy fails with
    // `SSL certificate problem: unable to get local issuer certificate`.
    // Mirrors the k8s side (pod-spec.ts stamps the fixed /var/run/ax path).
    sessionEnv.GIT_SSL_CAINFO = caPath;
    if (input.proxyConfig.endpoint !== undefined) {
      sessionEnv.HTTPS_PROXY = input.proxyConfig.endpoint;
      sessionEnv.HTTP_PROXY = input.proxyConfig.endpoint;
      sessionEnv.AX_PROXY_ENDPOINT = input.proxyConfig.endpoint;
    }
    if (input.proxyConfig.unixSocketPath !== undefined) {
      // Subprocess sandbox passes through; the runner-side bridge converts
      // this to a local TCP port and rewrites HTTP(S)_PROXY in-process.
      sessionEnv.AX_PROXY_UNIX_SOCKET = input.proxyConfig.unixSocketPath;
    }
    // Merge envMap LAST so per-session credential placeholders win over
    // anything we set above. (They shouldn't collide with HTTPS_PROXY etc.,
    // but be explicit so a future field collision doesn't silently do the
    // wrong thing.)
    Object.assign(sessionEnv, input.proxyConfig.envMap);
  }

  // Allowlist FIRST, sessionEnv LAST: the parent's PATH/HOME/TZ etc. are
  // load-bearing for the runner (resolving `node`, finding home dirs), but
  // any session-scoped key MUST win over a same-named parent var. Today
  // the allowlist (PATH/HOME/LANG/LC_ALL/TZ/NODE_OPTIONS) doesn't overlap
  // with sessionEnv, but if a future expansion ever did — e.g. an operator
  // adds ANTHROPIC_API_KEY or HTTPS_PROXY to the allowlist — the session-
  // scoped placeholder MUST take precedence. A parent ANTHROPIC_API_KEY
  // leaking into the sandbox would re-introduce a real credential into a
  // process that's only supposed to see ax-cred:<hex> placeholders (I1).
  const env = { ...allowlistFromParent(), ...sessionEnv };

  // 7. Spawn. argv[0] is the literal 'node', which trivially matches the
  //    existing ARGV0 regex — no extra validation here. shell:false, fixed
  //    argv, stdio piped (parent keeps stdin closed; child's stdout/stderr
  //    are pipes we can read).
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn('node', [input.runnerBinary], {
      shell: false,
      cwd: input.workspaceRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    // Synchronous spawn errors are rare (usually an async 'error' event) —
    // but handle them cleanly. Clean up the session + listener + tempdir.
    await bus
      .call('ipc:stop', ctx, { sessionId: created.sessionId })
      .catch(() => undefined);
    await bus
      .call('session:terminate', ctx, { sessionId: created.sessionId })
      .catch(() => undefined);
    await unlockInstalledSkillsDir(installedSkillsDir);
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    throw new PluginError({
      code: 'spawn-failed',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: `spawn failed for ${input.runnerBinary}`,
      cause,
    });
  }

  // 8. Exited promise. Resolves once the child's stdio pipes are drained
  //    (close) — not exit, which fires before pipes drain.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );

  // 9. Cleanup on child close: terminate the session (revokes the token),
  //    stop the listener, and remove the tempdir. All best-effort —
  //    failures log at warn (no token, no endpoint URI in info+). We don't
  //    propagate errors from here; the caller already has `exited`.
  child.once('close', () => {
    void (async () => {
      try {
        await bus.call<SessionTerminateInput, Record<string, never>>(
          'session:terminate',
          ctx,
          { sessionId: created.sessionId },
        );
      } catch (err) {
        ctx.logger.warn('session_terminate_failed', {
          sessionId: created.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await bus.call<IpcStopInput, Record<string, never>>('ipc:stop', ctx, {
          sessionId: created.sessionId,
        });
      } catch (err) {
        ctx.logger.warn('ipc_stop_failed', {
          sessionId: created.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      await unlockInstalledSkillsDir(installedSkillsDir);
      try {
        await fs.rm(socketDir, { recursive: true, force: true });
      } catch (err) {
        ctx.logger.warn('socket_cleanup_failed', {
          sessionId: created.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  // Swallow async 'error' events from the child so an ENOENT between spawn
  // and the first exit doesn't crash the host. The 'close' handler above
  // still runs and does cleanup. We log at debug (no token).
  child.on('error', (err) => {
    ctx.logger.debug('runner_child_error', { err: err.message });
  });

  // 10. Stderr → debug. reqId is already bound on ctx.logger so per-request
  //     correlation is automatic; no token anywhere.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    ctx.logger.debug('runner_stderr', { chunk });
  });

  // 11. kill(): SIGTERM, escalate to SIGKILL after 5s if still alive. A no-op
  //     if the child has already exited (exitCode !== null).
  const kill = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already dead between the exitCode check and the signal — fine.
    }
    const killTimer: NodeJS.Timeout = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Race with natural exit — fine.
        }
      }
    }, SIGKILL_DELAY_MS);
    // Don't keep the host event loop alive on account of the fallback timer.
    killTimer.unref();
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  };

  const handle: OpenSessionHandle = { kill, exited, child };
  return { runnerEndpoint, handle };
}
