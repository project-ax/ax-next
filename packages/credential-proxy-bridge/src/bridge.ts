/**
 * TCP-to-Unix-socket bridge for the HTTP forward proxy.
 *
 * Inside a sandbox (Docker --network=none, k8s pod with no egress, etc.),
 * agents can't reach the host credential-proxy directly via TCP. This bridge
 * listens on 127.0.0.1:{ephemeral port} (loopback works even with no
 * network) and forwards connections to the host proxy via a mounted Unix
 * socket.
 *
 * Handles both HTTP forwarding and HTTPS CONNECT tunneling:
 * - Regular HTTP requests: forwarded via undici Agent with socketPath
 * - CONNECT requests: raw TCP pipe to Unix socket, proxy handles outbound
 *
 * Ported from v1: src/agent/web-proxy-bridge.ts.
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface WebProxyBridge {
  port: number;
  stop(): void;
}

export async function startWebProxyBridge(unixSocketPath: string): Promise<WebProxyBridge> {
  const { Agent } = await import('undici');
  const dispatcher = new Agent({ connect: { socketPath: unixSocketPath } });
  const activeSockets = new Set<net.Socket>();

  // ── HTTP forwarding ──
  // Regular HTTP requests are forwarded through undici with socketPath.
  // The host proxy sees a normal HTTP request and handles forwarding.

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      // Forward headers (strip hop-by-hop and encoding headers — fetch handles these)
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          !value ||
          key === 'host' ||
          key === 'connection' ||
          key === 'proxy-connection' ||
          key === 'transfer-encoding' ||
          key === 'content-length'
        )
          continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }

      // Forward to Unix socket proxy — use the full URL as the path
      // (HTTP proxy protocol sends the complete URL, not just the path)
      const response = await fetch(`http://localhost${req.url}`, {
        method: req.method ?? 'GET',
        headers,
        body: body.length > 0 ? body : undefined,
        dispatcher,
      } as RequestInit);

      // Stream response back
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') {
          outHeaders[k] = v;
        }
      });
      res.writeHead(response.status, outHeaders);

      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Bridge error: ${(err as Error).message}`);
    }
  });

  // ── Start listening ──

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  return {
    port,
    stop: () => {
      for (const s of activeSockets) s.destroy();
      activeSockets.clear();
      server.close();
    },
  };
}
