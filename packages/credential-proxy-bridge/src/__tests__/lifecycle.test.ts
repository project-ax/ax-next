import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startWebProxyBridge } from '../bridge.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bridge-life-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'proxy.sock');
}

/** Stand up a Unix-socket server that accepts connections and stays open. */
async function startIdleUnixServer(socketPath: string): Promise<net.Server> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return server;
}

function tryConnect(port: number): Promise<{ ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => {
      sock.destroy();
      resolve({ ok: true });
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, err: err.code ?? err.message });
    });
  });
}

describe('startWebProxyBridge — lifecycle', () => {
  it('returns a valid TCP port number after start', async () => {
    const socketPath = tmpSocketPath();
    await startIdleUnixServer(socketPath);

    const bridge = await startWebProxyBridge(socketPath);
    cleanups.push(() => bridge.stop());

    expect(bridge.port).toBeGreaterThan(0);
    expect(bridge.port).toBeLessThan(65536);

    // Confirm the listener is actually accepting connections
    const result = await tryConnect(bridge.port);
    expect(result.ok).toBe(true);
  });

  it('stop() closes the listener — new connections fail with ECONNREFUSED', async () => {
    const socketPath = tmpSocketPath();
    await startIdleUnixServer(socketPath);

    const bridge = await startWebProxyBridge(socketPath);
    const port = bridge.port;

    // Sanity: listener is up
    const before = await tryConnect(port);
    expect(before.ok).toBe(true);

    bridge.stop();

    // Give the OS a tick to release the port
    await new Promise((r) => setTimeout(r, 50));

    const after = await tryConnect(port);
    expect(after.ok).toBe(false);
    // Most platforms surface ECONNREFUSED; some may surface ECONNRESET.
    expect(['ECONNREFUSED', 'ECONNRESET']).toContain(after.err);
  });

  it('stop() destroys active CONNECT sockets', async () => {
    const socketPath = tmpSocketPath();

    // A Unix server that accepts the CONNECT then keeps the tunnel open
    const sockets: net.Socket[] = [];
    const upstream = net.createServer((sock) => {
      sockets.push(sock);
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('\r\n\r\n')) {
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((resolve) => upstream.listen(socketPath, () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          upstream.close(() => resolve());
        }),
    );

    const bridge = await startWebProxyBridge(socketPath);

    // Open a CONNECT tunnel and wait for the 200
    const client = net.connect(bridge.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => {
        client.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
      });
      let buf = '';
      const onData = (c: Buffer) => {
        buf += c.toString();
        if (buf.includes('\r\n\r\n')) {
          client.off('data', onData);
          resolve();
        }
      };
      client.on('data', onData);
      client.on('error', reject);
    });

    // Now stop — the client socket should be destroyed
    const closedBeforeStop = client.destroyed;
    expect(closedBeforeStop).toBe(false);

    bridge.stop();

    await new Promise<void>((resolve) => {
      if (client.destroyed) {
        resolve();
        return;
      }
      client.once('close', () => resolve());
      // Failsafe so a regression doesn't hang forever
      setTimeout(() => resolve(), 500);
    });

    expect(client.destroyed).toBe(true);
  });
});
