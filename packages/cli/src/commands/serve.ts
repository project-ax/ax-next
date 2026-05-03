// ax-next serve
//
// Boots the k8s preset (postgres trio + workspace + sandbox-k8s + chat
// orchestrator + ipc-http + http-server + auth + agents + channel-web +
// tools) and adds the serve-routes plugin, which registers `POST /chat` +
// `GET /health` against @ax/http-server.
//
// Listener layout (closed in issue #39):
//   - @ax/ipc-http      → BIND_HOST:PORT (default 0.0.0.0:8080)
//                         runner-pod ↔ host back-channel.
//   - @ax/http-server   → AX_HTTP_HOST:AX_HTTP_PORT (chart sets 0.0.0.0:9090)
//                         public surface — /chat, /health, /admin/*, /auth/*,
//                         /api/chat/* (channel-web).
//
// Auth: optional bearer token via AX_SERVE_TOKEN. If unset, /chat is open
// to anything that can route to the public listener. We log a loud warning
// at boot so an operator can't accidentally ship that posture to production
// thinking it was protected. The bearer check lives inside the route
// handler (see serve-routes-plugin.ts).

import {
  HookBus,
  type KernelHandle,
  bootstrap,
  type Plugin,
} from '@ax/core';
import {
  createK8sPlugins,
  loadK8sConfigFromEnv,
} from '@ax/preset-k8s';
import { createServeRoutesPlugin } from './serve-routes-plugin.js';

const USAGE = `usage: ax-next serve

env (required):
  DATABASE_URL                postgres DSN
  AX_K8S_HOST_IPC_URL         cluster URL runners use to reach this pod
  AX_HTTP_HOST                public http listener bind host
  AX_HTTP_PORT                public http listener bind port
  AX_HTTP_COOKIE_KEY          32-byte signing key (64 hex / 44 base64 chars)
  AX_WORKSPACE_BACKEND        'local' | 'http' | 'git-protocol'
  AX_WORKSPACE_ROOT           (when backend=local)
  AX_WORKSPACE_GIT_HTTP_URL   (when backend=http)
  AX_WORKSPACE_GIT_HTTP_TOKEN (when backend=http)
  AX_CREDENTIALS_KEY          used by @ax/credentials at init

env (auth — at least one required):
  AX_DEV_BOOTSTRAP_TOKEN      pre-shared bearer token for dev/canary
  AX_AUTH_GOOGLE_CLIENT_ID    Google OIDC; full set required if any set:
  AX_AUTH_GOOGLE_CLIENT_SECRET
  AX_AUTH_GOOGLE_ISSUER
  AX_AUTH_GOOGLE_REDIRECT_URI

env (optional):
  AX_SERVE_TOKEN              if set, /chat requires Bearer <token>
                              if unset, /chat is unauthenticated (loud warn)
  AX_HTTP_ALLOWED_ORIGINS     comma-separated CSRF allow-list
  K8S_NAMESPACE / K8S_POD_IMAGE / K8S_RUNTIME_CLASS / K8S_IMAGE_PULL_SECRETS
  BIND_HOST / PORT            @ax/ipc-http listener (default 0.0.0.0:8080)
  AX_RUNNER_BINARY / AX_CHAT_TIMEOUT_MS`;

export interface RunServeOptions {
  argv: string[];
  /** Defaults to `process.env`. Tests pass an explicit map. */
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Test-only seam. When set, skips `loadK8sConfigFromEnv` + `createK8sPlugins`
   * and uses the returned plugins instead — typically a stub @ax/http-server
   * + stubs registering `session:create` / `agent:invoke`. Production callers
   * don't pass this.
   */
  pluginsFactory?: (env: NodeJS.ProcessEnv) => Plugin[] | Promise<Plugin[]>;
  /**
   * Test-only seam. Fires after bootstrap completes, with a kernel handle
   * tests can use to introspect plugins (e.g. read the http-server's
   * `boundPort()`) and shut down. Production lifecycle is SIGTERM-driven;
   * this hook is never invoked there.
   */
  onReady?: (handle: { kernel: KernelHandle; close: () => Promise<void> }) => void;
}

export async function runServeCommand(opts: RunServeOptions): Promise<number> {
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const env = opts.env ?? process.env;

  // Argument parsing. The standalone HTTP listener is gone (issue #39); the
  // public listener's host/port now come from AX_HTTP_HOST / AX_HTTP_PORT
  // (read by the k8s preset's loadK8sConfigFromEnv). Only --help remains.
  for (const a of opts.argv) {
    if (a === '--help' || a === '-h') {
      out(USAGE);
      return 0;
    }
    err(`serve: unknown argument: ${a}`);
    err(USAGE);
    return 2;
  }

  // Loud warning when running unauthenticated. We boot anyway because the
  // local-dev / kind canary path legitimately runs without a token; an
  // operator targeting prod still has the chart's NetworkPolicy + ingress-
  // off posture as defense in depth.
  const serveToken = env.AX_SERVE_TOKEN;
  if (serveToken === undefined || serveToken === '') {
    err('serve: AX_SERVE_TOKEN is unset — /chat is open to anything that can reach this port');
  }

  // Production-only: register signal handlers BEFORE the heavy boot work
  // (preset bootstrap + http listeners). If kubelet sends SIGTERM during a
  // slow boot (postgres pool warm-up, k8s API client init, image-pull
  // races), Node's default SIGTERM handler terminates immediately and skips
  // any partial cleanup. Tests pass `onReady`, which we treat as a signal
  // that the test owns teardown.
  let kernelHandle: KernelHandle | null = null;
  const isTest = opts.onReady !== undefined;
  if (!isTest) {
    let shuttingDown = false;
    const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
      if (shuttingDown) {
        // Second signal mid-shutdown: force-exit with the conventional
        // SIGINT=130 / SIGTERM=143 codes. A misbehaving plugin shouldn't
        // hold the process hostage past the operator's second Ctrl-C.
        process.exit(sig === 'SIGINT' ? 130 : 143);
      }
      shuttingDown = true;
      err(`[ax/serve] ${sig} — shutting down`);
      try {
        if (kernelHandle !== null) await kernelHandle.shutdown();
        process.exit(0);
      } catch (e) {
        err(`[ax/serve] shutdown error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  }

  // Build the plugin list. Production: env → K8sPresetConfig → createK8sPlugins.
  // Tests: caller-provided base plugins (typically a stub @ax/http-server +
  // session/agent stubs). The serve-routes plugin is appended in BOTH
  // branches — it's the whole point of the `serve` subcommand.
  let basePlugins: Plugin[];
  if (opts.pluginsFactory !== undefined) {
    basePlugins = await opts.pluginsFactory(env);
  } else {
    let cfg;
    try {
      cfg = loadK8sConfigFromEnv(env);
    } catch (e) {
      err(`serve: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    basePlugins = createK8sPlugins(cfg);
  }
  const plugins: Plugin[] = [
    ...basePlugins,
    createServeRoutesPlugin({ serveToken }),
  ];

  const bus = new HookBus();
  kernelHandle = await bootstrap({ bus, plugins, config: {} });

  out('[ax/serve] bootstrap complete — http-server is serving /chat + /health');

  if (opts.onReady !== undefined) {
    const close = async (): Promise<void> => {
      if (kernelHandle !== null) await kernelHandle.shutdown();
    };
    opts.onReady({ kernel: kernelHandle, close });
    // Tests own teardown; signal handlers were not installed.
    return 0;
  }

  // Production: signal handlers above own exit. Block forever.
  return new Promise<number>(() => {
    // never resolves
  });
}
