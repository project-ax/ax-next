// ---------------------------------------------------------------------------
// Runner env read + validate.
//
// The runner is spawned by `sandbox:open-session` (subprocess or k8s impl)
// with these env vars set. We parse them at startup and fail loudly if any
// are missing — a runner with a missing AX_RUNNER_ENDPOINT has no way to
// talk back to the host, so there's no graceful degradation path.
//
// AX_RUNNER_ENDPOINT is an opaque URI (I1). The IPC client parses the
// scheme:
//   - `unix:///abs/path` — Unix domain socket (subprocess sandbox).
//   - `http://host:port` — TCP HTTP (k8s pod sandbox).
// The runner doesn't care which; it hands the URI to createIpcClient.
//
// Empty-string values are treated as missing: an env var set to '' is
// almost always a wiring bug, not an intentional value.
// ---------------------------------------------------------------------------

export interface RunnerEnv {
  runnerEndpoint: string;
  sessionId: string;
  authToken: string;
  workspaceRoot: string;
}

export class MissingEnvError extends Error {
  public override readonly name = 'MissingEnvError';
  constructor(public readonly varName: string) {
    super(`missing required env: ${varName}`);
  }
}

export function readRunnerEnv(env: NodeJS.ProcessEnv = process.env): RunnerEnv {
  const need = (k: string): string => {
    const v = env[k];
    if (typeof v !== 'string' || v.length === 0) throw new MissingEnvError(k);
    return v;
  };
  return {
    runnerEndpoint: need('AX_RUNNER_ENDPOINT'),
    sessionId: need('AX_SESSION_ID'),
    authToken: need('AX_AUTH_TOKEN'),
    workspaceRoot: need('AX_WORKSPACE_ROOT'),
  };
}
