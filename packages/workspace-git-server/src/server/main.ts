#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createWorkspaceGitServer, type WorkspaceGitServer } from './index.js';

// ---------------------------------------------------------------------------
// Pod-side entrypoint binary. The chart's git-server StatefulSet runs this as
// `node /path/to/dist/server/main.js` (or via the `ax-git-server` bin shim).
//
// Decomposed into:
//   - `runServer(env)` — pure function that parses env, boots the listener,
//     returns a handle. This is what the unit test imports directly so we
//     never have to spawn a subprocess.
//   - CLI gate at the bottom — only fires when this file is `process.argv[1]`,
//     wires SIGTERM/SIGINT to a clean shutdown.
//
// Env contract (all read from `env`, NOT `process.env`, so tests can pass a
// fake bag without polluting the real environment):
//   - AX_GIT_SERVER_REPO_ROOT   (required) — bare repo path on disk
//   - AX_GIT_SERVER_TOKEN       (required) — shared bearer token from Helm
//                                  Secret; constant-time compared by auth gate
//   - AX_GIT_SERVER_HOST        (optional, default 0.0.0.0) — bind address
//   - AX_GIT_SERVER_PORT        (optional, default 7780)    — bind port
//   - AX_GIT_SERVER_SHARD_INDEX (optional)                  — informational
//                                  StatefulSet ordinal injected via the
//                                  downward API. Phase 1 logs it at boot but
//                                  doesn't behaviorally branch on it; it's
//                                  there so ops can correlate pod logs with
//                                  shard layout. Validated as a non-negative
//                                  integer string if present.
//   - AX_GIT_SERVER_DRAIN_TIMEOUT_MS (optional, default 30000) — how long
//                                  close() waits for in-flight requests
//                                  before SIGKILLing surviving git children
//                                  and slamming open connections. Sized to
//                                  fit under the chart's 60 s
//                                  terminationGracePeriodSeconds.
// ---------------------------------------------------------------------------

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 7780;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const LOG_PREFIX = '[ax/workspace-git-server]';

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(`${name} is required`);
  }
  return v;
}

export interface RunServerHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Test-friendly entrypoint. The CLI gate at the bottom calls this. */
export async function runServer(
  env: NodeJS.ProcessEnv,
): Promise<RunServerHandle> {
  const repoRoot = requireEnv(env, 'AX_GIT_SERVER_REPO_ROOT');
  const token = requireEnv(env, 'AX_GIT_SERVER_TOKEN');
  const host = env.AX_GIT_SERVER_HOST ?? DEFAULT_HOST;
  const portRaw = env.AX_GIT_SERVER_PORT;
  let port = DEFAULT_PORT;
  if (portRaw !== undefined && portRaw.length > 0) {
    const parsed = Number(portRaw);
    // Reject NaN and non-integers at the boundary instead of letting them
    // surface as a confusing listener error. Allow 0 (OS-assigned).
    if (
      !Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > 65535
    ) {
      throw new Error(
        `AX_GIT_SERVER_PORT must be an integer in 0..65535, got ${JSON.stringify(portRaw)}`,
      );
    }
    port = parsed;
  }

  // Optional: shard ordinal from k8s downward API. Validate shape but never
  // gate boot on its presence — Phase 1 doesn't use it, just logs it.
  const shardIndexRaw = env.AX_GIT_SERVER_SHARD_INDEX;
  let shardIndex: number | null = null;
  if (shardIndexRaw !== undefined && shardIndexRaw.length > 0) {
    const parsed = Number(shardIndexRaw);
    if (
      !Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      parsed < 0
    ) {
      throw new Error(
        `AX_GIT_SERVER_SHARD_INDEX must be a non-negative integer, got ${JSON.stringify(shardIndexRaw)}`,
      );
    }
    shardIndex = parsed;
  }

  // Optional: drain timeout. Default 30 s sits comfortably under the chart's
  // 60 s terminationGracePeriodSeconds, leaving SIGKILL headroom.
  const drainTimeoutRaw = env.AX_GIT_SERVER_DRAIN_TIMEOUT_MS;
  let drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS;
  if (drainTimeoutRaw !== undefined && drainTimeoutRaw.length > 0) {
    const parsed = Number(drainTimeoutRaw);
    if (
      !Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      parsed < 0
    ) {
      throw new Error(
        `AX_GIT_SERVER_DRAIN_TIMEOUT_MS must be a non-negative integer, got ${JSON.stringify(drainTimeoutRaw)}`,
      );
    }
    drainTimeoutMs = parsed;
  }

  const server: WorkspaceGitServer = await createWorkspaceGitServer({
    repoRoot,
    host,
    port,
    token,
    drainTimeoutMs,
  });
  process.stderr.write(
    `${LOG_PREFIX} listening on http://${server.host}:${server.port}` +
      (shardIndex !== null ? ` (shard ${shardIndex})` : '') +
      '\n',
  );
  return server;
}

// CLI gate — runs only when executed as a script, not when imported.
// The ESM idiom mirrors @ax/cli's main.ts: compare import.meta.url against
// pathToFileURL(process.argv[1]).href so test imports don't trigger the
// signal-handler registration (which would otherwise tear down vitest).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Register signal handlers BEFORE runServer resolves. If kubelet sends
  // SIGTERM during a slow boot (image-pull races, readiness probe gives up,
  // node drain), Node's default SIGTERM handler terminates immediately and
  // skips any partial cleanup. Registering handlers up-front + gating on
  // a `handle` reference closes that window: a SIGTERM during boot still
  // terminates promptly, but SIGTERM after boot drains in-flight commits.
  let handle: RunServerHandle | null = null;
  let shuttingDown = false;
  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`${LOG_PREFIX} ${sig} — closing listener\n`);
    if (handle === null) {
      // SIGTERM landed mid-boot; nothing to drain.
      process.exit(0);
    }
    try {
      await handle.close();
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `${LOG_PREFIX} shutdown error: ${(err as Error).message}\n`,
      );
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  void runServer(process.env)
    .then((h) => {
      handle = h;
    })
    .catch((err) => {
      process.stderr.write(
        `${LOG_PREFIX} fatal: ${(err as Error).message}\n`,
      );
      process.exit(1);
    });
}
