import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import { MAX_FRAME, makeChatContext, type HookBus } from '@ax/core';
import { authenticate } from './auth.js';
import { BadJsonError, readJsonBody, TooLargeError } from './body.js';
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
//   5. Body size gate    — POST body read with MAX_FRAME cap (I11). Over →
//                          413 (and req.destroy()); bad JSON → 400.
//
// After all five, the dispatcher returns 501 in Task 3 — deliberately a
// reachable placeholder so I3 (no half-wired code) stays clean. Task 4
// wires per-action handlers behind this exact guard stack.
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

    // 3. auth gate
    const ctx = makeChatContext({
      sessionId: opts.sessionId,
      agentId: 'ipc-server',
      userId: 'ipc-server',
      workspace: { rootPath: '/' },
    });
    const auth = await authenticate(req.headers.authorization, opts.bus, ctx);
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

    // 5. body-size gate (POST only).
    if (req.method === 'POST') {
      try {
        await readJsonBody(req, MAX_FRAME);
      } catch (err) {
        if (err instanceof TooLargeError) {
          // Write the 413 first so the client sees the rejection. Node's
          // http server sends the response even if the client hasn't
          // finished uploading the body, and setting Connection: close
          // tells the client not to reuse the socket (they'd be out of
          // sync anyway). For the mid-stream overflow path, readJsonBody
          // already called req.destroy() and the response socket is dead
          // — writeJsonError then becomes a best-effort no-op, which is
          // fine; the client's own socket teardown handles the signaling.
          if (!res.headersSent) {
            try {
              res.setHeader('Connection', 'close');
            } catch {
              // Response already closed; ignore.
            }
          }
          writeJsonError(res, 413, 'VALIDATION', 'body too large');
          return;
        }
        if (err instanceof BadJsonError) {
          return writeJsonError(res, 400, 'VALIDATION', `invalid json: ${err.message}`);
        }
        throw err;
      }
    }

    // Placeholder — Task 4 will route on `req.url` here.
    return writeJsonError(res, 501, 'INTERNAL', 'dispatcher not wired yet (Task 4)');
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
