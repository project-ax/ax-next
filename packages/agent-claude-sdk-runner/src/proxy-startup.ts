// ---------------------------------------------------------------------------
// Phase 2 — runner-side proxy startup.
//
// Reads the per-session proxy env the host injected (sandbox-subprocess
// for subprocess sandbox; sandbox-k8s for the k8s pod, future). Two
// modes:
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
// In BOTH proxy modes the SDK calls api.anthropic.com (no
// ANTHROPIC_BASE_URL). The credential-proxy intercepts the request,
// substitutes the `ax-cred:<hex>` placeholder for the real Anthropic key
// (held only on the host), and forwards. The runner never sees the real
// key — that's I1.
//
// In the legacy mode (AX_LLM_PROXY_URL only, no AX_PROXY_*), we keep
// the old shape: ANTHROPIC_BASE_URL points at the in-sandbox llm-proxy,
// which validates the IPC bearer and translates. Phase 5/6 deletes that
// branch.
// ---------------------------------------------------------------------------

import { MissingEnvError, type RunnerEnv } from './env.js';

export interface ProxyStartup {
  /**
   * Env to pass into the SDK's `query({ options: { env } })`. Always
   * includes `ANTHROPIC_API_KEY`; includes `ANTHROPIC_BASE_URL` only on
   * the legacy llm-proxy path.
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
    // sandbox path or pre-Phase-2 wiring). The package is a workspace dep
    // so the import is in-tree.
    const { startWebProxyBridge } = await import('@ax/credential-proxy-bridge');
    const bridge = await startWebProxyBridge(env.proxyUnixSocket);
    const local = `http://127.0.0.1:${bridge.port}`;
    process.env.HTTP_PROXY = local;
    process.env.HTTPS_PROXY = local;
    stop = bridge.stop;
  }

  // The bridge is now live (in bridge mode). If anything below throws, we
  // MUST stop it — otherwise the local TCP listener stays bound on a
  // failed boot and the runner exits with the port held until process
  // teardown (which can race the host's next session-spawn). The
  // try/catch here keeps that cleanup tight to the bridge's lifetime.
  try {
    const anthropicEnv: Record<string, string> = {};
    if (env.proxyEndpoint !== undefined || env.proxyUnixSocket !== undefined) {
      // Phase 2 path. sandbox-subprocess injected the envMap from
      // proxy:open-session into the child env, so process.env.ANTHROPIC_API_KEY
      // already holds the `ax-cred:<hex>` placeholder. We forward that
      // through options.env so the SDK's outbound x-api-key header carries
      // the placeholder verbatim — the credential-proxy substitutes the
      // real value mid-flight.
      //
      // I1: the IPC bearer (env.authToken) is NEVER sent to api.anthropic.com.
      // Phase 1a confirmed this is the only credential the runner is allowed
      // to forward.
      const placeholder = process.env.ANTHROPIC_API_KEY;
      if (placeholder === undefined || placeholder.length === 0) {
        // Should be unreachable: proxy:open-session always returns an
        // envMap when an Anthropic credential ref is provided, and
        // sandbox-subprocess merges it into the child env. Fail loud so a
        // wiring bug doesn't silently pass the IPC bearer upstream.
        throw new MissingEnvError(
          'ANTHROPIC_API_KEY (expected ax-cred placeholder from proxy:open-session)',
        );
      }
      anthropicEnv.ANTHROPIC_API_KEY = placeholder;
      // No ANTHROPIC_BASE_URL — direct calls to api.anthropic.com.
    } else {
      // Legacy in-sandbox llm-proxy path. The proxy validates env.authToken
      // (the IPC bearer) and forwards with the host-held Anthropic key.
      // Phase 5/6 deletes this branch when @ax/llm-proxy-anthropic-format
      // is removed.
      if (env.llmProxyUrl === undefined) {
        // readRunnerEnv guarantees one of the three is set; this throw is
        // belt-and-suspenders for an internal contract drift.
        throw new MissingEnvError('AX_LLM_PROXY_URL (legacy proxy path)');
      }
      anthropicEnv.ANTHROPIC_BASE_URL = env.llmProxyUrl;
      anthropicEnv.ANTHROPIC_API_KEY = env.authToken;
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
