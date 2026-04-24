// ---------------------------------------------------------------------------
// Runner env read + validate — claude-sdk variant.
//
// Mirrors @ax/agent-native-runner's env.ts in shape, adding AX_LLM_PROXY_URL
// on top of the four vars the native runner needs. The claude-sdk runner
// additionally needs that URL so it can point `ANTHROPIC_BASE_URL` at our
// sandbox-internal proxy (Week 6.5d Tasks 2–4) — without it, the vendored
// claude-agent-sdk would try to reach api.anthropic.com directly, defeating
// the whole host-mediated LLM-call story.
//
// Empty-string values are treated as missing: an env var set to '' is
// almost always a wiring bug, not an intentional value. Failing loud here
// beats a confusing downstream error.
// ---------------------------------------------------------------------------

export interface RunnerEnv {
  ipcSocket: string;
  sessionId: string;
  authToken: string;
  workspaceRoot: string;
  llmProxyUrl: string;
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
    llmProxyUrl: need('AX_LLM_PROXY_URL'),
  };
}
