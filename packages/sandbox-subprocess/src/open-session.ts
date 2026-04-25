import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  PluginError,
  type ChatContext,
  type HookBus,
} from '@ax/core';
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

export const OpenSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  workspaceRoot: z.string().regex(/^\//, 'workspaceRoot must be absolute'),
  runnerBinary: z.string().regex(/^\//, 'runnerBinary must be absolute'),
});

export type OpenSessionInput = z.input<typeof OpenSessionInputSchema>;
export type OpenSessionParsed = z.infer<typeof OpenSessionInputSchema>;

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
interface LlmProxyStartInput {
  sessionId: string;
}
interface LlmProxyStartOutput {
  url: string;
  port: number;
}
interface LlmProxyStopInput {
  sessionId: string;
}

export async function openSessionImpl(
  ctx: ChatContext,
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

  // 4. Mint session + token. The token flows to the runner as env — it is
  //    never returned from this hook (I9). We do NOT log the token here; if
  //    we need to correlate failures, we log `sessionId` instead.
  let created: SessionCreateOutput;
  try {
    created = await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: input.sessionId, workspaceRoot: input.workspaceRoot },
    );
  } catch (err) {
    // Clean up tempdir so a session:create failure doesn't leak dirs.
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
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // 6. Start the LLM proxy BEFORE spawning the runner so the runner's first
  //    `query()` call can't race the proxy bind. A failure here rolls back
  //    the ipc listener and session we minted above.
  let proxy: LlmProxyStartOutput;
  try {
    proxy = await bus.call<LlmProxyStartInput, LlmProxyStartOutput>(
      'llm-proxy:start',
      ctx,
      { sessionId: created.sessionId },
    );
  } catch (err) {
    await bus
      .call<IpcStopInput, Record<string, never>>('ipc:stop', ctx, {
        sessionId: created.sessionId,
      })
      .catch(() => undefined);
    await bus
      .call<SessionTerminateInput, Record<string, never>>('session:terminate', ctx, {
        sessionId: created.sessionId,
      })
      .catch(() => undefined);
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // 7. Build child env. I5: caller-side env NEVER flows in — this hook's
  //    input doesn't accept env, so the only sources are
  //      (a) our five session-scoped injects, and
  //      (b) the allowlist from the parent process.
  //    Allowlist merges LAST so PATH/HOME/etc. from the host always win.
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
    AX_LLM_PROXY_URL: proxy.url,
  };
  const env = { ...sessionEnv, ...allowlistFromParent() };

  // 8. Spawn. argv[0] is the literal 'node', which trivially matches the
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
    // but handle them cleanly. Clean up the session + listener + proxy + tempdir.
    await bus
      .call('llm-proxy:stop', ctx, { sessionId: created.sessionId })
      .catch(() => undefined);
    await bus
      .call('ipc:stop', ctx, { sessionId: created.sessionId })
      .catch(() => undefined);
    await bus
      .call('session:terminate', ctx, { sessionId: created.sessionId })
      .catch(() => undefined);
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    throw new PluginError({
      code: 'spawn-failed',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: `spawn failed for ${input.runnerBinary}`,
      cause,
    });
  }

  // 9. Exited promise. Resolves once the child's stdio pipes are drained
  //    (close) — not exit, which fires before pipes drain.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );

  // 10. Cleanup on child close: terminate the session (revokes the token),
  //     stop the proxy, stop the listener, and remove the tempdir. All four
  //     are best-effort — failures log at warn (no token, no endpoint URI
  //     in info+). We don't propagate errors from here; the caller already
  //     has `exited`.
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
        await bus.call<LlmProxyStopInput, Record<string, never>>('llm-proxy:stop', ctx, {
          sessionId: created.sessionId,
        });
      } catch (err) {
        ctx.logger.warn('llm_proxy_stop_failed', {
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

  // 11. Stderr → debug. reqId is already bound on ctx.logger so per-request
  //     correlation is automatic; no token anywhere.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    ctx.logger.debug('runner_stderr', { chunk });
  });

  // 12. kill(): SIGTERM, escalate to SIGKILL after 5s if still alive. A no-op
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
