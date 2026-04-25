#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createWorkspaceGitServer, type WorkspaceGitServer } from './index.js';

// ---------------------------------------------------------------------------
// Pod-side entrypoint binary. The chart's git-server Deployment runs this as
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
//   - AX_GIT_SERVER_REPO_ROOT  (required) — bare repo path on disk
//   - AX_GIT_SERVER_TOKEN      (required) — shared bearer token from Helm
//                                Secret; constant-time compared by auth gate
//   - AX_GIT_SERVER_HOST       (optional, default 0.0.0.0) — bind address
//   - AX_GIT_SERVER_PORT       (optional, default 7780)    — bind port
// ---------------------------------------------------------------------------

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 7780;

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
  const port = portRaw !== undefined && portRaw.length > 0 ? Number(portRaw) : DEFAULT_PORT;

  const server: WorkspaceGitServer = await createWorkspaceGitServer({
    repoRoot,
    host,
    port,
    token,
  });
  process.stderr.write(
    `[ax/workspace-git-http/server] listening on http://${server.host}:${server.port}\n`,
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
  void runServer(process.env)
    .then((handle) => {
      // Clean shutdown: close the listener BEFORE process.exit so any
      // in-flight workspace.apply finishes its git write. Without this we
      // could leave dangling git objects if SIGTERM lands mid-commit.
      let shuttingDown = false;
      const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stderr.write(
          `[ax/workspace-git-http/server] ${sig} — closing listener\n`,
        );
        try {
          await handle.close();
          process.exit(0);
        } catch (err) {
          process.stderr.write(
            `[ax/workspace-git-http/server] shutdown error: ${(err as Error).message}\n`,
          );
          process.exit(1);
        }
      };
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));
    })
    .catch((err) => {
      process.stderr.write(
        `[ax/workspace-git-http/server] fatal: ${(err as Error).message}\n`,
      );
      process.exit(1);
    });
}
