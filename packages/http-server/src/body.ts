import type * as http from 'node:http';

/** The body crossed the route's cap. `handle()` maps this to a 413. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * TASK-1028 (the http-server twin of TASK-1024's ipc-core fix): a request that
 * is already gone can never deliver its body. Its last event fired before our
 * listeners attached, so waiting on data/error/end would hang forever. That is
 * reachable: `handle()` reads the body only after awaiting `http:request`, and
 * a client can hang up during that await. Answer now instead:
 *   - errored (the client hung up: `aborted` / ECONNRESET) → that error,
 *     unchanged (same as a stream error mid-read);
 *   - already ended → a fixed-text Error. Checked before `destroyed`, because
 *     a request auto-destroys right after 'end';
 *   - destroyed with neither → a fixed-text Error.
 * Returns null when the request is still readable.
 */
function bodyGoneError(req: http.IncomingMessage): Error | null {
  const errored: unknown = req.errored;
  if (errored instanceof Error) return errored;
  if (req.readableEnded) {
    return new Error('request was already ended before its body was read');
  }
  if (req.destroyed) {
    return new Error('request was already destroyed before its body was read');
  }
  return null;
}

/**
 * Read the request body into a Buffer, capped at `maxBytes`. Over the cap it
 * rejects with BodyTooLargeError and DRAINS the rest (never destroys), so the
 * 413 can flush before the connection closes.
 */
export function readBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // Before the Content-Length 413 check, as in ipc-core: a request that is
    // already gone can't receive a 413 either, so an oversized one whose
    // client hung up rejects with the gone error (handle() rethrows it to the
    // catch-all), not BodyTooLargeError.
    const gone = bodyGoneError(req);
    if (gone !== null) {
      reject(gone);
      return;
    }

    const cl = req.headers['content-length'];
    if (typeof cl === 'string' && cl.length > 0) {
      const n = Number(cl);
      if (Number.isFinite(n) && n > maxBytes) {
        // Drain via resume() (not destroy) so the 413 response can flush
        // before the connection closes — destroying mid-flight resets the
        // connection and the client never sees our error.
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
    }

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
        // Don't destroy the request mid-stream — that aborts the connection
        // before the 413 response can flush. Drop chunks and resume() to
        // drain the rest while the response writes cleanly.
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        settle(() => reject(new BodyTooLargeError()));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (e) => settle(() => reject(e)));
    req.on('end', () => {
      settle(() => resolve(Buffer.concat(chunks, total)));
    });
    // A bare destroy() mid-read emits only 'close' — never 'end' or 'error'.
    // A normal read emits 'end' first, so the latch makes this a no-op then.
    req.on('close', () => {
      settle(() => reject(new Error('request closed before its body was read')));
    });
  });
}
