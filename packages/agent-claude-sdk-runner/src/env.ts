// ---------------------------------------------------------------------------
// Runner env read + validate — claude-sdk variant.
//
// Mirrors @ax/agent-native-runner's env.ts in shape, plus the per-session
// proxy fields the host injects when @ax/credential-proxy is loaded.
// Exactly one of AX_PROXY_ENDPOINT (subprocess sandbox, TCP) or
// AX_PROXY_UNIX_SOCKET (k8s sandbox, Unix socket → bridge) is required —
// they drive different transports.
//
// AX_RUNNER_ENDPOINT is an opaque URI (I1). The IPC client parses the
// scheme; see @ax/agent-runner-core/ipc-client.ts.
//
// Empty-string values are treated as missing: an env var set to '' is
// almost always a wiring bug, not an intentional value. Failing loud here
// beats a confusing downstream error.
// ---------------------------------------------------------------------------

export interface RunnerEnv {
  runnerEndpoint: string;
  sessionId: string;
  authToken: string;
  workspaceRoot: string;
  /**
   * Per-session credential-proxy TCP endpoint (subprocess sandbox).
   * Mutually exclusive with `proxyUnixSocket`. When present, the SDK calls
   * api.anthropic.com directly through HTTPS_PROXY (set by sandbox-
   * subprocess); the runner does NOT start a bridge.
   */
  proxyEndpoint?: string;
  /**
   * Per-session credential-proxy Unix socket path (k8s sandbox).
   * Mutually exclusive with `proxyEndpoint`. When present, the runner
   * starts a TCP-to-unix bridge via @ax/credential-proxy-bridge and
   * rewrites HTTP(S)_PROXY in-process to point at the local bridge
   * port. Off-the-shelf libraries inside the sandbox can't reach a
   * Unix socket directly; the bridge gives them a loopback TCP target.
   */
  proxyUnixSocket?: string;
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
  const opt = (k: string): string | undefined => {
    const v = env[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  const proxyEndpoint = opt('AX_PROXY_ENDPOINT');
  const proxyUnixSocket = opt('AX_PROXY_UNIX_SOCKET');

  // The two AX_PROXY_* transport vars are mutually exclusive (subprocess
  // sandbox sets one, k8s sandbox sets the other). Accepting both would
  // silently pick the bridge path in setupProxy() and route traffic
  // through the wrong transport — fail loud at boot instead.
  if (proxyEndpoint !== undefined && proxyUnixSocket !== undefined) {
    throw new MissingEnvError(
      'AX_PROXY_ENDPOINT xor AX_PROXY_UNIX_SOCKET (mutually exclusive — one set per session)',
    );
  }

  // I9 — exactly one proxy path must be configured. The host's
  // credential-proxy sets one of the two; if both are missing, the
  // runner has no way to reach an LLM and we fail loud at boot rather
  // than at first SDK call.
  if (proxyEndpoint === undefined && proxyUnixSocket === undefined) {
    throw new MissingEnvError(
      'AX_PROXY_ENDPOINT or AX_PROXY_UNIX_SOCKET',
    );
  }

  const result: RunnerEnv = {
    runnerEndpoint: need('AX_RUNNER_ENDPOINT'),
    sessionId: need('AX_SESSION_ID'),
    authToken: need('AX_AUTH_TOKEN'),
    workspaceRoot: need('AX_WORKSPACE_ROOT'),
  };
  if (proxyEndpoint !== undefined) result.proxyEndpoint = proxyEndpoint;
  if (proxyUnixSocket !== undefined) result.proxyUnixSocket = proxyUnixSocket;
  return result;
}
