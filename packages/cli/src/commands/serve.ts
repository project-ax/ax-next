// ax-next serve --port <n>
//
// Boots the k8s preset (postgres trio + workspace + sandbox-k8s + chat
// orchestrator + ipc-http + tools + LLM) and exposes a thin HTTP front door:
//
//   GET  /health  → 200 OK (no auth) — for k8s readiness/liveness probes.
//   POST /chat    → mints a session, runs one chat turn, returns the outcome.
//
// We deliberately keep the HTTP surface tiny. The full multi-tenant story
// (real auth, per-user sessions, agents, admin UI) is Week 9.5's territory;
// this command exists to make the chart's host pod actually boot and to
// satisfy the multi-replica MANUAL-ACCEPTANCE scenario.
//
// Auth: optional bearer token via AX_SERVE_TOKEN. If unset, /chat is open to
// anything that can route to this port. We log a loud warning at boot so an
// operator can't accidentally ship that posture to production thinking it
// was protected. The chart's NetworkPolicy + the fact that ingress is OFF by
// default still bounds reach to in-cluster + port-forward.

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  HookBus,
  type KernelHandle,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentMessage,
  type AgentOutcome,
  type Plugin,
} from '@ax/core';
import {
  createK8sPlugins,
  loadK8sConfigFromEnv,
} from '@ax/preset-k8s';

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0';
// Bound the request body. Chat messages can be long but they're not files —
// 1 MiB is more than enough and keeps a misbehaving client from filling
// memory. Distinct from @ax/core's MAX_FRAME (4 MiB) because that cap is
// for runner ↔ host IPC, where binary tool outputs can be larger.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

const USAGE = `usage: ax-next serve [--port <n>] [--host <h>]
  --port  TCP port to listen on (default ${DEFAULT_PORT})
  --host  bind address (default ${DEFAULT_HOST})

env (required):
  DATABASE_URL              postgres DSN
  AX_K8S_HOST_IPC_URL       cluster URL runners use to reach this pod
  AX_WORKSPACE_BACKEND      'local' | 'http'
  AX_WORKSPACE_ROOT         (when backend=local)
  AX_WORKSPACE_GIT_HTTP_URL    (when backend=http)
  AX_WORKSPACE_GIT_HTTP_TOKEN  (when backend=http)
  ANTHROPIC_API_KEY         used by @ax/llm-anthropic at init
  AX_CREDENTIALS_KEY        used by @ax/credentials at init

env (optional):
  AX_SERVE_TOKEN            if set, /chat requires Bearer <token>
                            if unset, /chat is unauthenticated (loud warning)
  K8S_NAMESPACE / K8S_POD_IMAGE / K8S_RUNTIME_CLASS / K8S_IMAGE_PULL_SECRETS
  BIND_HOST / PORT          (overridden by --host / --port if both present)
  AX_LLM_MODEL / AX_LLM_MAX_TOKENS
  AX_RUNNER_BINARY / AX_CHAT_TIMEOUT_MS`;

interface ParsedArgs {
  port: number;
  host: string;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') {
      const v = argv[i + 1];
      if (v === undefined) return { error: '--port requires a value' };
      const n = Number(v);
      // Allow 0 ("OS-assigned port" — tests rely on it). Reject negative
      // and >65535. Non-integer values (e.g. NaN) fail the Finite check.
      if (!Number.isFinite(n) || n < 0 || n > 65535 || !Number.isInteger(n)) {
        return { error: `--port must be 0..65535, got ${v}` };
      }
      port = n;
      i++;
    } else if (a === '--host') {
      const v = argv[i + 1];
      if (v === undefined) return { error: '--host requires a value' };
      host = v;
      i++;
    } else if (a === '--help' || a === '-h') {
      return { error: 'help' };
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  return { port, host };
}

export interface RunServeOptions {
  argv: string[];
  /** Defaults to `process.env`. Tests pass an explicit map. */
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Test-only seam. When set, skips `loadK8sConfigFromEnv` + `createK8sPlugins`
   * and uses the returned plugins instead. Production callers don't pass this
   * — they rely on the env-driven preset.
   */
  pluginsFactory?: (env: NodeJS.ProcessEnv) => Plugin[] | Promise<Plugin[]>;
  /**
   * Test-only seam. When provided, called with the bound listener so tests
   * can read back the actual port and tear down. Production lifecycle is
   * SIGTERM-driven; this hook is never invoked there.
   */
  onListening?: (handle: { host: string; port: number; close: () => Promise<void> }) => void;
}

export async function runServeCommand(opts: RunServeOptions): Promise<number> {
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const env = opts.env ?? process.env;

  const parsed = parseArgs(opts.argv);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      out(USAGE);
      return 0;
    }
    err(`serve: ${parsed.error}`);
    err(USAGE);
    return 2;
  }

  // Loud warning when running unauthenticated. We boot anyway because the
  // local-dev / kind canary path legitimately runs without a token; an
  // operator targeting prod still has the chart's NetworkPolicy + ingress-off
  // posture as defense in depth.
  const serveToken = env.AX_SERVE_TOKEN;
  if (serveToken === undefined || serveToken === '') {
    err('serve: AX_SERVE_TOKEN is unset — /chat is open to anything that can reach this port');
  }

  // Production-only: register signal handlers BEFORE the heavy boot work
  // (preset bootstrap + listen). If kubelet sends SIGTERM during a slow
  // boot (postgres pool warm-up, k8s API client init, image-pull races),
  // Node's default SIGTERM handler terminates immediately and skips any
  // partial cleanup. Registering handlers up-front + gating on a
  // `closeListener` reference keeps SIGTERM-during-boot fast and SIGTERM-
  // after-boot graceful. Tests pass `onListening`, which we treat as a
  // signal that the test owns teardown.
  let closeListener: (() => Promise<void>) | null = null;
  let kernelHandle: KernelHandle | null = null;
  const isTest = opts.onListening !== undefined;
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
      err(`[ax/serve] ${sig} — closing listener`);
      try {
        if (closeListener !== null) await closeListener();
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
  // Tests: caller-provided.
  let plugins: Plugin[];
  if (opts.pluginsFactory !== undefined) {
    plugins = await opts.pluginsFactory(env);
  } else {
    let cfg;
    try {
      cfg = loadK8sConfigFromEnv(env);
    } catch (e) {
      err(`serve: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    plugins = createK8sPlugins(cfg);
  }

  const bus = new HookBus();
  kernelHandle = await bootstrap({ bus, plugins, config: {} });

  const server = http.createServer((req, res) => {
    void handle(req, res, bus, serveToken).catch((e) => {
      // Per-request fallback. Should not normally fire — `handle` catches
      // its own errors — but a programming bug shouldn't take the process
      // down.
      err(`serve: unhandled handler error: ${e instanceof Error ? e.message : String(e)}`);
      try {
        if (!res.headersSent) writeJson(res, 500, { error: { code: 'INTERNAL', message: 'internal server error' } });
        else res.end();
      } catch {
        // socket already dead
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => reject(e);
    server.once('error', onErr);
    server.listen(parsed.port, parsed.host, () => {
      server.off('error', onErr);
      resolve();
    });
  });

  // Permanent error handler so a stray server-level error doesn't crash us.
  server.on('error', (e) => {
    err(`serve: server error: ${e instanceof Error ? e.message : String(e)}`);
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : parsed.port;
  out(`[ax/serve] listening on http://${parsed.host}:${boundPort}`);

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  if (opts.onListening !== undefined) {
    opts.onListening({ host: parsed.host, port: boundPort, close });
    // Tests own teardown; signal handlers were not installed.
    return 0;
  }

  // Production: hand the close handle to the pre-installed signal
  // handlers, then block forever.
  closeListener = close;
  return new Promise<number>(() => {
    // never resolves; signal handlers above own exit
  });
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bus: HookBus,
  serveToken: string | undefined,
): Promise<void> {
  // Method gate
  if (req.method !== 'GET' && req.method !== 'POST') {
    return writeJson(res, 405, { error: { code: 'VALIDATION', message: 'method not allowed' } });
  }

  const url = new URL(req.url ?? '/', 'http://serve.local');
  const pathname = url.pathname;

  // /health pre-auth — k8s probes hit this. Always 200 unconditionally.
  if (pathname === '/health' && req.method === 'GET') {
    writeJson(res, 200, { ok: true });
    return;
  }

  // Auth: when serveToken is set, /chat requires Bearer <token>.
  if (serveToken !== undefined && serveToken !== '') {
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${serveToken}`;
    // Constant-time-ish: same length + .toLowerCase() doesn't help us here
    // since the token portion is case-sensitive. We do a length-pre-check
    // and string compare. A stricter timingSafeEqual would also be fine; the
    // token never appears in any error message either way.
    if (auth.length !== expected.length || auth !== expected) {
      return writeJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid or missing bearer token' } });
    }
  }

  // /chat — POST JSON {message: string, sessionId?: string}.
  if (pathname === '/chat' && req.method === 'POST') {
    return handleChat(req, res, bus);
  }

  writeJson(res, 404, { error: { code: 'NOT_FOUND', message: `unknown path: ${pathname}` } });
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bus: HookBus,
): Promise<void> {
  // Content-type
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return writeJson(res, 415, { error: { code: 'VALIDATION', message: 'content-type must be application/json' } });
  }

  // Body cap
  const cl = req.headers['content-length'];
  if (typeof cl === 'string' && cl.length > 0) {
    const declared = Number(cl);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return writeJson(res, 413, { error: { code: 'VALIDATION', message: 'body too large' } });
    }
  }

  // Read body with mid-stream cap.
  let body: unknown;
  try {
    body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return writeJson(res, 413, { error: { code: 'VALIDATION', message: 'body too large' } });
    }
    if (e instanceof BadJsonError) {
      return writeJson(res, 400, { error: { code: 'VALIDATION', message: `invalid json: ${e.message}` } });
    }
    throw e;
  }

  // Validate payload shape.
  if (typeof body !== 'object' || body === null) {
    return writeJson(res, 400, { error: { code: 'VALIDATION', message: 'body must be a JSON object' } });
  }
  const message = (body as { message?: unknown }).message;
  if (typeof message !== 'string' || message.length === 0) {
    return writeJson(res, 400, { error: { code: 'VALIDATION', message: 'message must be a non-empty string' } });
  }
  const sessionId = (body as { sessionId?: unknown }).sessionId;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0)) {
    return writeJson(res, 400, { error: { code: 'VALIDATION', message: 'sessionId must be a non-empty string when provided' } });
  }

  // Always mint a fresh session for each chat. Sharing sessionIds across
  // requests is a multi-tenant concern (Week 9.5) — for the canary scenario
  // we want each request to be independent.
  const finalSessionId = sessionId !== undefined ? (sessionId as string) : `serve-${randomUUID()}`;
  const workspaceRoot = '/'; // synthetic — not used for workspace ops in http backend

  // session:create. Idempotency-ish: session-postgres throws on duplicate
  // sessionId, so a client passing the same sessionId twice will get a 500
  // here. Document that for now; multi-turn within one session is Week 9.5.
  try {
    await bus.call('session:create', makeServeCtx(finalSessionId, workspaceRoot), {
      sessionId: finalSessionId,
      workspaceRoot,
    });
  } catch (e) {
    if (e instanceof PluginError) {
      return writeJson(res, 400, { error: { code: e.code, message: e.message } });
    }
    throw e;
  }

  // agent:invoke.
  const ctx = makeServeCtx(finalSessionId, workspaceRoot);
  const chatMessage: AgentMessage = { role: 'user', content: message };
  let outcome: AgentOutcome;
  try {
    outcome = await bus.call('agent:invoke', ctx, { message: chatMessage });
  } catch (e) {
    if (e instanceof PluginError) {
      return writeJson(res, 500, { error: { code: e.code, message: e.message } });
    }
    return writeJson(res, 500, { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } });
  }

  writeJson(res, 200, { sessionId: finalSessionId, outcome });
}

function makeServeCtx(sessionId: string, workspaceRoot: string) {
  return makeAgentContext({
    sessionId,
    agentId: 'serve',
    userId: 'serve',
    workspace: { rootPath: workspaceRoot },
  });
}

// ---------------------------------------------------------------------------
// Body / response helpers (small enough not to warrant a shared package)
// ---------------------------------------------------------------------------

class BodyTooLargeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BodyTooLargeError';
  }
}

class BadJsonError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BadJsonError';
  }
}

function readJsonBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        settle(() => reject(new BodyTooLargeError(`body exceeded cap ${maxBytes}`)));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (e) => settle(() => reject(e)));
    req.on('end', () => {
      if (settled) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
        settle(() => resolve(value));
      } catch (e) {
        settle(() => reject(new BadJsonError((e as Error).message)));
      }
    });
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
