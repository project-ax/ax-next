// ---------------------------------------------------------------------------
// Runner-side proxy startup.
//
// Reads the per-session proxy env the host injected (sandbox-subprocess
// for subprocess sandbox; sandbox-k8s for the k8s pod). Two modes:
//
//   1. Bridge mode (AX_PROXY_UNIX_SOCKET set, k8s):
//        - Start a TCP-to-unix bridge via @ax/credential-proxy-bridge.
//          Off-the-shelf libraries inside the sandbox cannot dial a
//          Unix socket directly; the bridge gives them a loopback TCP
//          target.
//        - Rewrite process.env.HTTP_PROXY / HTTPS_PROXY to point at the
//          bridge's local port. The SDK's outbound fetch reads
//          process.env directly (not options.env), so this MUST be a
//          process-level mutation.
//
//   2. Direct mode (AX_PROXY_ENDPOINT set, subprocess):
//        - sandbox-subprocess already set HTTPS_PROXY in the child env
//          before spawn; we don't need to do anything else here. The
//          SDK's calls flow through that proxy directly.
//
// In both modes the SDK calls api.anthropic.com (no ANTHROPIC_BASE_URL).
// The credential-proxy intercepts the request, substitutes the
// `ax-cred:<hex>` placeholder for the real Anthropic key (held only on
// the host), and forwards. The runner never sees the real key — that's I1.
// ---------------------------------------------------------------------------

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissingEnvError, type RunnerEnv } from './env.js';

// Path to the CJS bootstrap that the SDK subprocess loads via
// NODE_OPTIONS=--require. Resolved relative to THIS file so it survives
// pnpm hoisting and tsc dist layout (both ts → js sit next to the .cjs).
function proxyBootstrapPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxy-bootstrap.cjs');
}

// Explicit allowlist of process.env keys to forward into the SDK
// subprocess. Anything not here (and not matching ENV_ALLOWLIST_PREFIXES
// below) is dropped. Notably excludes AX_* — the runner's IPC bearer
// (`AX_AUTH_TOKEN`) and other control-plane env vars must never be
// reachable from a Bash tool the SDK spawns: `echo $AX_AUTH_TOKEN` in a
// tool call would land in the model's context and could be exfiltrated
// via the next assistant message.
const ENV_ALLOWLIST = new Set<string>([
  // Filesystem / process basics
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'USERNAME',
  'LOGNAME',
  // Locale / terminal
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLUMNS',
  'LINES',
  // Network
  'NO_PROXY',
  'no_proxy',
  'http_proxy',
  'https_proxy',
]);

// Prefix allowlist:
//   - GIT_* — git ops invoked by the Bash tool. sandbox-k8s/pod-spec
//             stamps GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> /
//             GIT_CONFIG_VALUE_<n> with safe.directory=* so git on the
//             kubelet-owned /permanent mount doesn't hit "dubious
//             ownership."
//   - LC_*  — locale categories (LC_CTYPE, LC_COLLATE, etc.).
const ENV_ALLOWLIST_PREFIXES = ['GIT_', 'LC_'] as const;

function isEnvAllowed(key: string): boolean {
  if (ENV_ALLOWLIST.has(key)) return true;
  for (const prefix of ENV_ALLOWLIST_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export interface ProxyStartup {
  /**
   * Env to pass into the SDK's `query({ options: { env } })`. Always
   * includes `ANTHROPIC_API_KEY` (the `ax-cred:<hex>` placeholder the
   * credential-proxy substitutes mid-flight).
   */
  anthropicEnv: Record<string, string>;
  /**
   * Bridge stop. Set only in bridge mode. The runner's exit path MUST
   * call this so the bridge releases its TCP port + active sockets.
   */
  stop?: () => void;
}

export async function setupProxy(env: RunnerEnv): Promise<ProxyStartup> {
  // Belt-and-suspenders: readRunnerEnv() already rejects when both are set,
  // but setupProxy() is exported and may be called by future tests / callers
  // that bypass readRunnerEnv. Fail fast rather than silently picking the
  // bridge path.
  if (env.proxyEndpoint !== undefined && env.proxyUnixSocket !== undefined) {
    throw new Error(
      'AX_PROXY_ENDPOINT and AX_PROXY_UNIX_SOCKET are mutually exclusive',
    );
  }

  let stop: (() => void) | undefined;

  if (env.proxyUnixSocket !== undefined) {
    // Dynamic import keeps the bridge unloaded when not needed (subprocess
    // sandbox path). The package is a workspace dep so the import is in-tree.
    const { startWebProxyBridge } = await import('@ax/credential-proxy-bridge');
    const bridge = await startWebProxyBridge(env.proxyUnixSocket);
    const local = `http://127.0.0.1:${bridge.port}`;
    process.env.HTTP_PROXY = local;
    process.env.HTTPS_PROXY = local;

    // Critical: Node's built-in fetch (undici) does NOT auto-honor
    // HTTP_PROXY / HTTPS_PROXY env vars. Without setGlobalDispatcher
    // pointing at a ProxyAgent, the Claude SDK's outbound fetch
    // bypasses the bridge entirely — the SDK calls api.anthropic.com
    // directly with the `ax-cred:<hex>` placeholder, the proxy never
    // substitutes, and the upstream rejects with "Invalid API key".
    // Library users that explicitly set their own dispatcher win;
    // we only override the global, which the bare fetch() reads.
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(local));

    stop = bridge.stop;
  }

  // The bridge is now live (in bridge mode). If anything below throws, we
  // MUST stop it — otherwise the local TCP listener stays bound on a
  // failed boot and the runner exits with the port held until process
  // teardown (which can race the host's next session-spawn). The
  // try/catch here keeps that cleanup tight to the bridge's lifetime.
  try {
    // Build the SDK subprocess env from an explicit allowlist of the
    // runner's own env (see ENV_ALLOWLIST + ENV_ALLOWLIST_PREFIXES). The
    // SDK builds the subprocess env from `query({ options: { env } })`
    // exactly — keys not present here are NOT inherited from
    // process.env. Without forwarding PATH, the SDK's Bash tool executes
    // `ls` and gets exit code 127 (command not found); without the GIT_*
    // family, git ops in /permanent fail "dubious ownership."
    //
    // Capability minimization (I5): control-plane vars that ARE in the
    // runner's process.env (notably AX_AUTH_TOKEN, the IPC bearer) stay
    // out of the SDK subprocess. The Bash tool can spawn arbitrary
    // commands the model requests, and `echo $AX_AUTH_TOKEN` would land
    // the bearer in tool output → model context → assistant reply.
    const anthropicEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      if (isEnvAllowed(k)) anthropicEnv[k] = v;
    }
    // sandbox-subprocess injected the envMap from proxy:open-session into
    // the child env, so process.env.ANTHROPIC_API_KEY already holds the
    // `ax-cred:<hex>` placeholder. We forward that through options.env so
    // the SDK's outbound x-api-key header carries the placeholder verbatim
    // — the credential-proxy substitutes the real value mid-flight.
    //
    // I1: the IPC bearer (env.authToken) is NEVER sent to api.anthropic.com.
    // Defense-in-depth: enforce the exact `ax-cred:<32-hex>` shape produced
    // by @ax/credential-proxy's registry. A non-empty check would let a
    // regressed wiring (e.g., a real `sk-ant-...` key landing in
    // ANTHROPIC_API_KEY) flow upstream silently. The format is asserted at
    // both ends — generator and consumer — so a future format change has
    // to update both, surfacing as a loud test failure rather than a
    // silent capability leak.
    const placeholder = process.env.ANTHROPIC_API_KEY;
    if (
      typeof placeholder !== 'string' ||
      !/^ax-cred:[0-9a-f]{32}$/.test(placeholder)
    ) {
      throw new MissingEnvError(
        'ANTHROPIC_API_KEY (expected ax-cred:<32-hex> placeholder from proxy:open-session)',
      );
    }
    anthropicEnv.ANTHROPIC_API_KEY = placeholder;

    // Forward the proxy + NODE_OPTIONS=--require=<bootstrap> into the
    // SDK subprocess so its undici dispatcher routes through the bridge
    // too (see proxy-bootstrap.cjs for the full rationale). Only set
    // when we're in bridge mode (proxyUnixSocket present) — subprocess
    // sandbox already has HTTPS_PROXY in the child env from sandbox-
    // subprocess and uses ProxyAgent on the parent dispatcher only,
    // which the subprocess doesn't inherit either, but THAT path needs
    // the same fix for the same reason. Wiring it for both is harmless.
    if (env.proxyUnixSocket !== undefined || env.proxyEndpoint !== undefined) {
      const proxyUrl = env.proxyEndpoint ?? process.env.HTTPS_PROXY;
      if (proxyUrl !== undefined) {
        anthropicEnv.HTTPS_PROXY = proxyUrl;
        anthropicEnv.HTTP_PROXY = proxyUrl;
      }
      // Forward NODE_EXTRA_CA_CERTS / SSL_CERT_FILE so the subprocess
      // trusts the credential-proxy's MITM root CA. Without these the
      // TLS handshake to api.anthropic.com (the proxy presents its own
      // cert during MITM) fails with `SSL certificate verification
      // failed` — sandbox-k8s/pod-spec stamps these on the runner pod
      // env but the SDK builds the subprocess env from `o6` (our
      // anthropicEnv), NOT from the runner's process.env. Have to
      // copy them explicitly.
      if (process.env.NODE_EXTRA_CA_CERTS !== undefined) {
        anthropicEnv.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
      }
      if (process.env.SSL_CERT_FILE !== undefined) {
        anthropicEnv.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
      }
      // Append our --require to any caller-supplied NODE_OPTIONS so
      // operators can still set their own (e.g. --max-old-space-size).
      // Quote the path with JSON.stringify: Node tokenizes NODE_OPTIONS
      // on whitespace using shell-like quoting rules. Under pnpm hoisting
      // (or any install path containing a space), an unquoted
      // `--require=/Users/foo bar/proxy-bootstrap.cjs` would split mid-path
      // and the SDK subprocess would fail at startup before our hook ran.
      const existing = process.env.NODE_OPTIONS ?? '';
      const requireFlag = `--require=${JSON.stringify(proxyBootstrapPath())}`;
      anthropicEnv.NODE_OPTIONS = existing.length > 0
        ? `${existing} ${requireFlag}`
        : requireFlag;
    }

    return stop !== undefined ? { anthropicEnv, stop } : { anthropicEnv };
  } catch (err) {
    // Stop the bridge before re-raising so a failed boot doesn't leave a
    // stranded TCP listener bound on 127.0.0.1.
    if (stop !== undefined) {
      try {
        stop();
      } catch {
        /* swallow — we're already bailing */
      }
    }
    throw err;
  }
}
