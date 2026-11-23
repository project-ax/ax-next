// ---------------------------------------------------------------------------
// Runner env read + validate — claude-sdk variant.
//
// Reads the host-injected per-session proxy fields plus the runner
// endpoint, session id, auth token, the agent's home and the scratch root
// (AX_USERFILES_ROOT, AX_EPHEMERAL_ROOT) and the SDK config dir
// (CLAUDE_CONFIG_DIR). The proxy fields
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

import * as path from 'node:path';

export interface RunnerEnv {
  runnerEndpoint: string;
  sessionId: string;
  authToken: string;
  /**
   * Session-scoped scratch root (`AX_EPHEMERAL_ROOT`) for everything that must
   * not outlive the session: the conversation's uploads (`<root>/uploads/`),
   * the SDK transcript working copy, tool caches, the Python venv, temporary
   * clones. k8s stamps a disk-backed emptyDir; subprocess stamps a per-session
   * tempdir. Required and absolute (TASK-995). There is no default: a guessed
   * path would point uploads and caches at a directory the sandbox never
   * created.
   */
  ephemeralRoot: string;
  /**
   * The agent's home (`AX_USERFILES_ROOT`): its durable, per-agent files. The
   * sandbox provider sets it from the `role:'user-files'` mount it resolved
   * (k8s: the `/files` NFS subPath mount; subprocess: the per-agent localDir).
   * It is the SDK subprocess's HOME and cwd, and where the agent keeps work
   * that should last. Required and absolute (TASK-995): there is no fallback
   * home, because a home in scratch would lose the agent's work at the end of
   * every session.
   */
  userFilesRoot: string;
  /**
   * `AX_USERFILES_READONLY=1` (TASK-1122): the sandbox mounted the agent's home
   * read-only for this session (an outsider's turn). Set only for `'1'`; absent
   * otherwise. The runner only uses it to tell the model so: the mount is the
   * enforcement, not this flag.
   */
  userFilesReadOnly?: true;
  /**
   * The per-session directory (outside the agent's home; the agent's shell can
   * still write it, see `assertConfigDirFresh`) the SDK loads as its own trusted configuration
   * (`CLAUDE_CONFIG_DIR`): installed skills, connector `.mcp.json`, settings,
   * `.claude.json`, and its session state. k8s pins `/home/runner/.ax/session`;
   * subprocess uses `<per-session HOME>/.ax/session`. Required and absolute
   * (TASK-994): unset, the SDK falls back to `$HOME/.claude`, which is the
   * agent's own files; relative, the SDK resolves it against its cwd, which
   * is also the agent's home. `assertConfigDirOutsideAgentHome` checks at
   * startup that it exists and does not overlap the agent's home.
   */
  claudeConfigDir: string;
  /**
   * Optional, absolute directory where the Claude SDK's per-session transcript
   * working copy lives (`AX_TRANSCRIPTS_ROOT`, TASK-994). k8s stamps
   * `/tmp/transcripts` (the pod's disk-backed emptyDir: `/home/runner` is tmpfs
   * and counts against the pod's memory limit). Absent means "use the SDK's own
   * `$CLAUDE_CONFIG_DIR/projects`", which is already per-session under the
   * subprocess sandbox. The claude-sdk runner's `transcript-dir.ts` consumes it;
   * the DB, not this directory, is the transcript's source of truth.
   */
  transcriptsRoot?: string;
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
  /**
   * `AX_INBOX_IDLE_MS`: how long the inbox loop waits for the next message
   * before it gives up (the host-crash fallback reaper). Absent means the
   * inbox loop's own default (15 min). Positive whole milliseconds only; any
   * other value is ignored, not an error, so a bad value never stops a boot.
   */
  inboxIdleMs?: number;
  /** `AX_TURN_LIMIT_MS`: the longest one turn may run. Same parsing; absent means the runner's own default. */
  turnLimitMs?: number;
  /**
   * `AX_SERVICE_FORWARDS`: loopback forwards for published service ports
   * (`127.0.0.1:<published>` -> `127.0.0.1:<target>`). Absent means none.
   */
  serviceForwards?: Array<{ published: number; target: number }>;
}

const SERVICE_FORWARDS_MAX_PAIRS = 64;
const SERVICE_FORWARDS_MAX_CHARS = 4096;
/**
 * Strict parse of `AX_SERVICE_FORWARDS`: a JSON array of at most 64
 * `{published, target}` integer pairs in 1..65535, no other keys, bounded
 * length. Same rule as `@ax/sandbox-protocol`'s `parseServiceForwards` (not
 * imported: the runner stays independent of the host-side package). Null on
 * anything else.
 */
export function parseServiceForwardsEnv(value: string): Array<{ published: number; target: number }> | null {
  if (value.length > SERVICE_FORWARDS_MAX_CHARS) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length > SERVICE_FORWARDS_MAX_PAIRS) return null;
  const out: Array<{ published: number; target: number }> = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes('published') || !keys.includes('target')) return null;
    const { published, target } = item as Record<string, unknown>;
    for (const n of [published, target]) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) return null;
    }
    out.push({ published: published as number, target: target as number });
  }
  return out;
}

/**
 * The agent's home: the SDK subprocess's HOME and cwd. Always the durable
 * user-files root. The runner process keeps its own HOME (k8s `/home/runner`),
 * so its trusted children never read agent-written dotfiles.
 */
export function runnerHomeDir(env: Pick<RunnerEnv, 'userFilesRoot'>): string {
  return env.userFilesRoot;
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

  // The value, when absolute; else InvalidEnvError naming the variable (never
  // the value). `~/x` counts as relative: nothing expands the `~`.
  const absolute = (k: string, value: string, expected: string): string => {
    if (!path.isAbsolute(value)) throw new InvalidEnvError(k, expected);
    return value;
  };

  const result: RunnerEnv = {
    runnerEndpoint: need('AX_RUNNER_ENDPOINT'),
    sessionId: need('AX_SESSION_ID'),
    authToken: need('AX_AUTH_TOKEN'),
    // No defaults for the two roots or the config dir — see their RunnerEnv
    // docs; both sandboxes always set all three. A relative root would resolve
    // against whichever cwd a process happens to have, and the runner's and
    // the SDK subprocess's differ.
    userFilesRoot: absolute(
      'AX_USERFILES_ROOT',
      need('AX_USERFILES_ROOT'),
      "expected an absolute path to the agent's home",
    ),
    ephemeralRoot: absolute(
      'AX_EPHEMERAL_ROOT',
      need('AX_EPHEMERAL_ROOT'),
      'expected an absolute path to the session scratch root',
    ),
    claudeConfigDir: absolute(
      'CLAUDE_CONFIG_DIR',
      need('CLAUDE_CONFIG_DIR'),
      "expected an absolute path — a relative one resolves against the SDK's working directory, which is the agent's home",
    ),
  };
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
  // No default — see RunnerEnv.transcriptsRoot. A relative value would resolve
  // against whichever cwd the runner happens to have, so refuse it at the edge.
  const transcriptsRoot = opt('AX_TRANSCRIPTS_ROOT');
  if (transcriptsRoot !== undefined) {
    result.transcriptsRoot = absolute('AX_TRANSCRIPTS_ROOT', transcriptsRoot, 'expected an absolute path');
  }
  const userFilesReadOnly = opt('AX_USERFILES_READONLY');
  if (userFilesReadOnly !== undefined) {
    if (userFilesReadOnly !== '1') {
      throw new InvalidEnvError('AX_USERFILES_READONLY', "expected '1' when set");
    }
    result.userFilesReadOnly = true;
  }
  const memoryRoot = opt('AX_MEMORY_ROOT');
  if (memoryRoot !== undefined) result.memoryRoot = memoryRoot;
  const positiveMs = (k: string): number | undefined => {
    const v = opt(k);
    if (v === undefined || !/^[1-9][0-9]{0,14}$/.test(v)) return undefined;
    return Number(v);
  };
  const inboxIdleMs = positiveMs('AX_INBOX_IDLE_MS');
  if (inboxIdleMs !== undefined) result.inboxIdleMs = inboxIdleMs;
  const turnLimitMs = positiveMs('AX_TURN_LIMIT_MS');
  if (turnLimitMs !== undefined) result.turnLimitMs = turnLimitMs;
  const forwardsRaw = opt('AX_SERVICE_FORWARDS');
  if (forwardsRaw !== undefined) {
    const forwards = parseServiceForwardsEnv(forwardsRaw);
    if (forwards === null) {
      throw new InvalidEnvError('AX_SERVICE_FORWARDS', 'expected a JSON array of at most 64 {published, target} port pairs');
    }
    if (forwards.length > 0) result.serviceForwards = forwards;
  }
  return result;
}
