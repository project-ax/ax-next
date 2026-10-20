// ---------------------------------------------------------------------------
// Runner env read + validate — claude-sdk variant.
//
// Reads the host-injected per-session proxy fields plus the runner
// endpoint, session id, auth token, and workspace root. The proxy fields
// are populated when @ax/credential-proxy is loaded.
// Exactly one of AX_PROXY_ENDPOINT (subprocess sandbox, TCP) or
// AX_PROXY_UNIX_SOCKET (k8s sandbox, Unix socket → bridge) is required —
// they drive different transports.
//
// AX_RUNNER_ENDPOINT is an opaque URI (I1). The IPC client parses the
// scheme; see @ax/ipc-protocol/ipc-client.ts.
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
   * Session-scoped scratch root the sandbox provides for throwaway files
   * (temporary clones, build caches, intermediate artifacts) that must NOT
   * round-trip to the host. k8s mounts `/ephemeral` (an emptyDir);
   * subprocess creates a per-session tempdir. Optional on purpose: there is
   * NO default (unlike `workspaceRoot`). A wrong default like `/ephemeral`
   * would be actively harmful in the subprocess sandbox — the host root is
   * read-only there, so writes would fail — whereas "absent" cleanly means
   * "this sandbox didn't wire a scratch tier" and the runner simply doesn't
   * grant the SDK an extra directory or mention one in the system prompt.
   * Both real sandbox providers set it; ad-hoc/test callers may omit it.
   */
  ephemeralRoot?: string;
  /**
   * Durable, per-agent user-files root (filestore-user-files Phase 1). The
   * sandbox provider sets `AX_USERFILES_ROOT` from the `role:'user-files'`
   * mount it resolved (k8s: the `/files` NFS subPath mount; subprocess: the
   * per-agent localDir). Optional with NO default (like `ephemeralRoot`): absent
   * means "no durable mount wired", and the runner then neither widens the
   * agent's filesystem reach nor advertises a durable location. When present it
   * is cwd/HOME; when absent the runner uses the supplied session scratch tier.
   */
  userFilesRoot?: string;
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
  /**
   * Per-session proxy token (TASK-52; the proxy's caller-authentication
   * credential since TASK-158). When present, proxy-startup embeds it as
   * `Proxy-Authorization: Basic ax:<token>` (HTTP Basic userinfo on the proxy
   * URL), so the host listener can authenticate every request as coming from
   * this session and gate it on this session's allowlist. `readRunnerEnv`
   * always sets it: a missing or malformed `AX_PROXY_TOKEN` (anything but 32
   * lowercase hex chars) fails the runner at boot (TASK-704) rather than
   * letting every request die with a 407. Optional in the type only for
   * callers that build a `RunnerEnv` by hand (tests); a missing token still
   * never widens egress — the proxy refuses the request.
   */
  proxyToken?: string;
  memoryRoot?: string;
}

/** User work prefers durable files, then session scratch; agent state stays separate. */
export function runnerHomeDir(env: Pick<RunnerEnv, 'userFilesRoot' | 'ephemeralRoot' | 'workspaceRoot'>): string {
  return env.userFilesRoot ?? env.ephemeralRoot ?? env.workspaceRoot;
}

export class MissingEnvError extends Error {
  public override readonly name = 'MissingEnvError';
  constructor(public readonly varName: string) {
    super(`missing required env: ${varName}`);
  }
}

/**
 * An env var that is set but unusable. The message names the variable and
 * what was expected — never the value, which may be a credential.
 */
export class InvalidEnvError extends Error {
  public override readonly name = 'InvalidEnvError';
  constructor(
    public readonly varName: string,
    expected: string,
  ) {
    super(`invalid env: ${varName} (${expected})`);
  }
}

/** What credential-proxy mints: 16 random bytes as lowercase hex. */
const PROXY_TOKEN_FORMAT = /^[0-9a-f]{32}$/;

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
    // Phase 3: the sandbox mounts /agent as the workspace working tree
    // and /ephemeral as scratch. The runner's git-status diff and bundle
    // creation key off /agent. Operators / orchestrators that want a
    // different path can still override via AX_WORKSPACE_ROOT, but the
    // default lines up with what `pod-spec.ts` actually mounts.
    workspaceRoot: opt('AX_WORKSPACE_ROOT') ?? '/agent',
  };
  // No default — see the RunnerEnv.ephemeralRoot doc. Absent means "no
  // scratch tier wired", which the runner treats as "don't widen the
  // agent's filesystem reach".
  const ephemeralRoot = opt('AX_EPHEMERAL_ROOT');
  if (ephemeralRoot !== undefined) result.ephemeralRoot = ephemeralRoot;
  // No default — see RunnerEnv.userFilesRoot. Absent means "no durable
  // user-files mount wired", which the runner treats as "don't widen the
  // agent's filesystem reach or advertise a user-files location".
  const userFilesRoot = opt('AX_USERFILES_ROOT');
  if (userFilesRoot !== undefined) result.userFilesRoot = userFilesRoot;
  if (proxyEndpoint !== undefined) result.proxyEndpoint = proxyEndpoint;
  if (proxyUnixSocket !== undefined) result.proxyUnixSocket = proxyUnixSocket;
  // TASK-52/158/704: per-session proxy token — the credential the proxy
  // authenticates this runner with. A proxy is ALWAYS configured (I9, checked
  // above) and since TASK-158 it refuses (407) every request without this
  // session's token, so a runner booting without a usable token can reach
  // nothing, and every failure would look like a network outage. Fail loud at
  // boot instead (TASK-704). Validate the format at the trust boundary too
  // (mirroring the listener's parse) so a garbled env can't produce a weird
  // Proxy-Authorization header. The error names the variable, NEVER the value:
  // it is a bearer credential and the message lands in runner logs.
  const proxyToken = opt('AX_PROXY_TOKEN');
  if (proxyToken === undefined) throw new MissingEnvError('AX_PROXY_TOKEN');
  if (!PROXY_TOKEN_FORMAT.test(proxyToken)) {
    throw new InvalidEnvError(
      'AX_PROXY_TOKEN',
      'expected 32 lowercase hex characters',
    );
  }
  result.proxyToken = proxyToken;
  const memoryRoot = opt('AX_MEMORY_ROOT');
  if (memoryRoot !== undefined) result.memoryRoot = memoryRoot;
  return result;
}
