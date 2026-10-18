import { createServer, type ServerOptions } from 'node:https';
import { StorageAssignmentSchema, StorageIdentitySchema, CHANGE_SHARED_REQUEST_MAX_BYTES,
  type ChangeSharedWireRequest } from './protocol.js';
import { STORAGE_REQUEST_MAX_BYTES, type StorageNodeEngine } from './engine.js';

const ROUTES = ['/assign', '/status', '/release', '/change-shared'];
/**
 * `/change-shared` (W3c) carries file content, so it alone gets the large cap;
 * every other route keeps `STORAGE_REQUEST_MAX_BYTES`. Exported for tests.
 */
export const requestCap = (route: string): number =>
  route === '/change-shared' ? CHANGE_SHARED_REQUEST_MAX_BYTES : STORAGE_REQUEST_MAX_BYTES;
/**
 * At most this many `/change-shared` bodies are buffered at once; later ones
 * wait (unread) for a slot. One body costs several times its ~35 MB on the
 * wire while it is parsed and decoded, and the helper's memory limit is
 * 512 MiB, so unbounded concurrency would let a burst of saves OOM the node
 * that holds every runner's mounts.
 */
export const CHANGE_SHARED_CONCURRENCY = 2;

/** Only a controller certificate issued by this deployment's dedicated CA is accepted. */
export function createStorageServer(engine: StorageNodeEngine, tls: ServerOptions) {
  let changing = 0; const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (changing >= CHANGE_SHARED_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
    else changing++;
  };
  // Hand the slot straight to the next waiter, so the count never dips below the work in flight.
  const releaseSlot = () => { const next = waiting.shift(); if (next) next(); else changing--; };
  const server = createServer({ ...tls, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.3', maxHeaderSize: 8192 }, async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const route = req.url ?? '';
    if (req.method !== 'POST' || !ROUTES.includes(route)) {
      reply(404, { error: 'unknown storage operation' }); return;
    }
    const limited = route === '/change-shared';
    if (limited) await acquire();
    try {
      const cap = requestCap(route);
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > cap) { reply(413, { error: 'storage request too large' }); req.destroy(); return; }
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8'); chunks.length = 0;
      const body: unknown = JSON.parse(text);
      if (route === '/assign') reply(200, await engine.assign(StorageAssignmentSchema.parse(body)));
      else if (route === '/status') reply(200, await engine.status(StorageIdentitySchema.parse(body)));
      // The engine parses the wire form itself (base64 → bytes, every cap).
      else if (route === '/change-shared') reply(200, await engine.changeShared(body as ChangeSharedWireRequest));
      else { await engine.release(StorageIdentitySchema.parse(body)); reply(200, {}); }
    } catch { reply(409, { error: 'storage operation rejected' }); }
    finally { if (limited) releaseSlot(); }
  });
  server.requestTimeout = 120_000; server.headersTimeout = 10_000;
  server.setTimeout(120_000, socket => socket.destroy());
  return server;
}
