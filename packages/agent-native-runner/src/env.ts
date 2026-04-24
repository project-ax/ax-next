// ---------------------------------------------------------------------------
// Runner env read + validate.
//
// The runner is spawned by @ax/sandbox-subprocess's `sandbox:open-session`
// with these four env vars set. We parse them at startup and fail loudly
// if any are missing — a runner with a missing AX_IPC_SOCKET has no way
// to talk back to the host, so there's no graceful degradation path.
//
// Empty-string values are treated as missing: an env var set to '' is
// almost always a wiring bug, not an intentional value.
// ---------------------------------------------------------------------------

export interface RunnerEnv {
  ipcSocket: string;
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
    ipcSocket: need('AX_IPC_SOCKET'),
    sessionId: need('AX_SESSION_ID'),
    authToken: need('AX_AUTH_TOKEN'),
    workspaceRoot: need('AX_WORKSPACE_ROOT'),
  };
}
