import { createServer, type ServerOptions } from 'node:https';
import { StorageAssignmentSchema, StorageIdentitySchema } from './protocol.js';
import { STORAGE_REQUEST_MAX_BYTES, type StorageNodeEngine } from './engine.js';

/** Only a controller certificate issued by this deployment's dedicated CA is accepted. */
export function createStorageServer(engine: StorageNodeEngine, tls: ServerOptions) {
  const server = createServer({ ...tls, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.3', maxHeaderSize: 8192 }, async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !['/assign', '/status', '/release'].includes(req.url ?? '')) {
      reply(404, { error: 'unknown storage operation' }); return;
    }
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > STORAGE_REQUEST_MAX_BYTES) { reply(413, { error: 'storage request too large' }); req.destroy(); return; }
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/assign') reply(200, await engine.assign(StorageAssignmentSchema.parse(body)));
      else if (req.url === '/status') reply(200, await engine.status(StorageIdentitySchema.parse(body)));
      else { await engine.release(StorageIdentitySchema.parse(body)); reply(200, {}); }
    } catch { reply(409, { error: 'storage operation rejected' }); }
  });
  server.requestTimeout = 120_000; server.headersTimeout = 10_000;
  server.setTimeout(120_000, socket => socket.destroy());
  return server;
}
