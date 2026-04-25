import * as http from 'node:http';
import { authenticate, dispatch, writeJsonError } from '@ax/ipc-core';
import { makeChatContext, type HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// HTTP listener — TCP analogue of @ax/ipc-server's unix-socket listener.
//
// Process-wide bind: one listener serves ALL sessions, unlike @ax/ipc-server
// which binds a per-session unix socket. The bearer token's resolution to a
// sessionId IS the per-request session identification — there is no
// listener-owning session, so the cross-session gate from the unix listener
// is intentionally absent here. (A token belongs to exactly one session;
// resolving it gives us that session.)
//
// Five inbound gates (in order):
//   1. Method      — only POST / GET. Other → 405.
//   2. /healthz    — GET only, returned 200 BEFORE auth so a probe can
//                    succeed even when no sessions exist yet.
//   3. Content-Type — POST must carry application/json. Otherwise → 415.
//   4. Auth         — Authorization: Bearer <token>, resolved via
//                     session:resolve-token. Missing/malformed/unknown → 401
//                     (token value NEVER echoed — I9).
//   5. Body size    — enforced by the dispatcher's body reader (MAX_FRAME).
//                     Over → 413; bad JSON → 400.
//
// I12: idle-timeout 60 s — matches the unix listener so 30 s long-polls
// aren't killed by a future Node default change.
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 60_000;

export interface HttpListener {
  close(): Promise<void>;
  readonly host: string;
  readonly port: number;
}

export interface CreateHttpListenerOptions {
  host: string;
  /** Pass 0 to let the OS assign a free port; readback via `listener.port`. */
  port: number;
  bus: HookBus;
}

export async function createHttpListener(
  opts: CreateHttpListenerOptions,
): Promise<HttpListener> {
  const server = http.createServer((req, res) => {
    // Top-level handler is sync so we can install the async logic under a
    // single try/catch; any uncaught error becomes a 500 INTERNAL.
    void handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          writeJsonError(res, 500, 'INTERNAL', 'internal server error');
        } else {
          res.end();
        }
      } catch {
        // Best-effort — the socket is already dead. Swallow.
      }
      // Emit to stderr so bugs don't vanish; we can't reach into a caller's
      // logger here (this handler is per-connection, not per-request-ctx).
      process.stderr.write(
        `ipc-http: unhandled handler error: ${(err as Error).message}\n`,
      );
    });
  });

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    // 1. method gate
    if (req.method !== 'POST' && req.method !== 'GET') {
      return writeJsonError(res, 405, 'VALIDATION', 'method not allowed');
    }

    // 2. /healthz pre-auth — GET only, 200 unconditionally so liveness
    //    probes succeed before any session exists.
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // 3. content-type gate (POST only)
    if (req.method === 'POST') {
      const ct = req.headers['content-type'] ?? '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        return writeJsonError(
          res,
          415,
          'VALIDATION',
          'content-type must be application/json',
        );
      }
    }

    // 4. auth gate. Pre-auth ctx uses a placeholder workspaceRoot; rebuild
    //    after auth with the resolved real value so downstream handlers
    //    (e.g. tool.execute-host) see the authenticated session's workspace.
    //    The 4xx error paths below run on THIS pre-auth ctx — but only auth
    //    errors are emitted here, and `authenticate` never echoes tokens.
    const preAuthCtx = makeChatContext({
      sessionId: 'ipc-http-pre-auth',
      agentId: 'ipc-http',
      userId: 'ipc-http',
      workspace: { rootPath: '/' },
    });
    const auth = await authenticate(req.headers.authorization, opts.bus, preAuthCtx);
    if (!auth.ok) {
      return writeJsonError(
        res,
        auth.status,
        auth.body.error.code,
        auth.body.error.message,
      );
    }

    // Per-request ChatContext with a fresh reqId and the REAL workspaceRoot
    // from the auth result. The dispatcher reads the body under MAX_FRAME
    // (I11) and routes to the per-action handler.
    const ctx = makeChatContext({
      sessionId: auth.sessionId,
      agentId: 'ipc-http',
      userId: 'ipc-http',
      workspace: { rootPath: auth.workspaceRoot },
    });
    await dispatch(req, res, ctx, opts.bus);
  };

  // I12: bump idle timeout so 30 s long-polls aren't killed.
  server.setTimeout(IDLE_TIMEOUT_MS);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(opts.port, opts.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  // After listen succeeds, keep a permanent error listener so a stray
  // server-level error doesn't surface as an uncaught EventEmitter error
  // and crash the process. Same logging shape as the per-request handler.
  server.on('error', (err) => {
    process.stderr.write(
      `ipc-http: server error: ${(err as Error).message}\n`,
    );
  });

  // Read back the actual bound port (relevant when caller passed 0).
  const addr = server.address();
  const boundPort =
    typeof addr === 'object' && addr !== null ? addr.port : opts.port;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    get host() {
      return opts.host;
    },
    get port() {
      return boundPort;
    },
    close,
  };
}
