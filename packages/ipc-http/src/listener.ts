import * as http from 'node:http';
import { authenticate, dispatch, writeJsonError } from '@ax/ipc-core';
import { makeAgentContext, type HookBus } from '@ax/core';

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
// Idle-timeout — matches the unix listener. It must EXCEED the longest
// per-action client budget so the client's own timeout is always the binding
// one and the server never resets an in-flight request:
//   - session.next-message: a 30 s long-poll held open with no data.
//   - workspace.materialize (BUG-W3): the host may spend up to the client's
//     120 s materialize budget building/streaming a large aged bundle; before
//     the first response byte the socket is IDLE (request received, response
//     not started), so a 60 s idle timeout would destroy the socket mid-build
//     → ECONNRESET → retry → rebuild → loop → boot crash, relocating the very
//     crash BUG-W3 fixes. 130 s sits just above the 120 s client budget so the
//     client times out first (clean) instead of the server resetting.
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 130_000;

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
    const preAuthCtx = makeAgentContext({
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

    // Per-request AgentContext with a fresh reqId and the REAL workspaceRoot
    // from the auth result. The dispatcher reads the body under MAX_FRAME
    // (I11) and routes to the per-action handler.
    //
    // Stamp the resolved userId/agentId/conversationId onto ctx so downstream
    // handlers can read them — same posture as @ax/ipc-server's listener.
    // Pre-9.5 / canary sessions resolve with nulls; we substitute placeholder
    // strings to preserve the AgentContext invariant that agentId/userId
    // are non-empty strings, and leave conversationId off (canary path).
    //
    // Without this stamping the runner's `/conversation.store-runner-session`
    // landed at `bus.call('conversations:store-runner-session', ctx, ...)`
    // with `ctx.userId === 'ipc-http'`. The store does a userId-scoped
    // UPDATE keyed off the conversation owner, so `'ipc-http'` never
    // matched any real row → 404 not-found → runner threw → resume on
    // turn 2 silently lost the transcript (regression:
    // runner-owned-sessions-k8s-gap.test.ts:156).
    const ctx = makeAgentContext({
      sessionId: auth.sessionId,
      agentId: auth.agentId ?? 'ipc-http',
      userId: auth.userId ?? 'ipc-http',
      workspace: { rootPath: auth.workspaceRoot },
      // exactOptionalPropertyTypes: only set when we have a value. Canary
      // sessions resolve with conversationId=null and leave the field off.
      ...(auth.conversationId !== null
        ? { conversationId: auth.conversationId }
        : {}),
    });
    await dispatch(req, res, ctx, opts.bus);
  };

  // Idle socket timeout (see IDLE_TIMEOUT_MS). Must outlast the longest
  // client-side per-action budget (materialize 120 s; long-poll 30 s) so the
  // server never resets an in-flight request before the client gives up.
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
