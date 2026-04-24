import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import { makeChatContext, type HookBus } from '@ax/core';
import { authenticate } from './auth.js';
import { dispatch } from './dispatcher.js';
import { writeJsonError } from './response.js';

// ---------------------------------------------------------------------------
// Listener
//
// HTTP server bound to a unix socket at `opts.socketPath`. Enforces the five
// inbound gates, in order:
//
//   1. Method gate       — only POST / GET. Other methods → 405.
//   2. Content-Type gate — POST must carry application/json. Otherwise → 415.
//   3. Auth gate         — `Authorization: Bearer <token>` resolves via the
//                          session:resolve-token hook. Missing / malformed /
//                          unknown → 401 (token value NEVER echoed — I9).
//   4. Cross-session gate — resolved sessionId must match the listener's
//                           owning session. Otherwise → 403. Closes the
//                           cross-session confusion window.
//   5. Body size gate    — enforced by the dispatcher's body reader
//                          (Task 4), which uses MAX_FRAME (I11). Over →
//                          413 (and req.destroy()); bad JSON → 400.
//
// After all four pre-dispatch gates, the dispatcher (src/dispatcher.ts)
// picks a handler by (method, path), reads the body if needed, and writes
// the response.
//
// I12: long-poll timeout is 30 s. Node's default idle socket timeout is 0
// (disabled for HTTP servers) but we set it to 60 s explicitly so any
// future change to HTTP server defaults can't silently kill a 30 s
// long-poll request mid-flight.
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 60_000;

export interface Listener {
  close(): Promise<void>;
  readonly socketPath: string;
}

export interface CreateListenerOptions {
  socketPath: string;
  sessionId: string;
  bus: HookBus;
}

export async function createListener(opts: CreateListenerOptions): Promise<Listener> {
  const server = http.createServer((req, res) => {
    // Top-level handler is sync so we can install the async logic under a
    // single try/catch; any uncaught error becomes a 500 INTERNAL. Defensive
    // — everything below SHOULD catch its own errors.
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
      // Intentionally does not include the socket path.
      process.stderr.write(`ipc-server: unhandled handler error: ${(err as Error).message}\n`);
    });
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // 1. method gate
    if (req.method !== 'POST' && req.method !== 'GET') {
      return writeJsonError(res, 405, 'VALIDATION', 'method not allowed');
    }

    // 2. content-type gate (POST only)
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

    // 3. auth gate — pre-auth ctx uses a rootPath placeholder; rebuild with
    //    the real workspaceRoot after auth succeeds so downstream handlers
    //    (e.g. future tool.execute-host) see the authenticated session's
    //    workspace. The 4xx error paths below run on THIS pre-auth ctx.
    const preAuthCtx = makeChatContext({
      sessionId: opts.sessionId,
      agentId: 'ipc-server',
      userId: 'ipc-server',
      workspace: { rootPath: '/' },
    });
    const auth = await authenticate(req.headers.authorization, opts.bus, preAuthCtx);
    if (!auth.ok) {
      return writeJsonError(res, auth.status, auth.body.error.code, auth.body.error.message);
    }

    // 4. cross-session gate: a valid token for a DIFFERENT session must not
    //    reach this listener's handlers.
    if (auth.sessionId !== opts.sessionId) {
      return writeJsonError(
        res,
        403,
        'SESSION_INVALID',
        'token bound to a different session',
      );
    }

    // Per-request ChatContext with a fresh reqId and the REAL workspaceRoot
    // from the auth result. The dispatcher reads the body under MAX_FRAME
    // (I11) and routes to the per-action handler.
    const ctx = makeChatContext({
      sessionId: auth.sessionId,
      agentId: 'ipc-server',
      userId: 'ipc-server',
      workspace: { rootPath: auth.workspaceRoot },
    });
    await dispatch(req, res, ctx, opts.bus);
  };

  // I12: bump idle timeout so 30 s long-polls (Task 4) aren't killed.
  server.setTimeout(IDLE_TIMEOUT_MS);

  // Best-effort cleanup of a stale socket file from a prior crashed listener.
  // Binding over a stale unix socket yields EADDRINUSE; since we own the
  // per-session tempdir, an unlink here is safe — no other process can be
  // legitimately listening on this path. ENOENT is the expected "nothing to
  // clean up" case.
  try {
    await fs.unlink(opts.socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(opts.socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    // Best-effort unlink — close() on Node's http server already unlinks
    // unix sockets, but in some edge cases (crashed listener, EADDRINUSE
    // recovery) the file may linger. ENOENT is the only expected error here
    // and is fine.
    try {
      await fs.unlink(opts.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };

  return {
    get socketPath() { return opts.socketPath; },
    close,
  };
}
