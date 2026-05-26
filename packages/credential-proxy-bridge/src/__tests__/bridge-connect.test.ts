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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bridge-connect-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'proxy.sock');
}

/**
 * Stand up a Unix-socket "host proxy" that:
 *   - Reads a CONNECT host:port HTTP/1.1 ... \r\n\r\n preamble
 *   - Replies 200 Connection Established
 *   - Then echoes any subsequent bytes back to the client
 *
 * If accept = false, replies with a 502 instead.
 */
async function startUnixCONNECTServer(
  socketPath: string,
  opts: { accept: boolean } = { accept: true },
): Promise<{ close(): Promise<void>; targets: string[]; headers: string[] }> {
  const targets: string[] = [];
  // Full CONNECT request-header block (up to the \r\n\r\n) as the host proxy
  // saw it — lets a test assert which headers the bridge forwarded (TASK-52).
  const headers: string[] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let headersDone = false;
    sock.on('data', (chunk) => {
      if (!headersDone) {
        buf += chunk.toString();
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const header = buf.slice(0, end);
        const remainder = Buffer.from(buf.slice(end + 4), 'utf8');
        headersDone = true;
        headers.push(header);

        const m = header.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.1/);
        if (m) targets.push(m[1] ?? '');

        if (opts.accept) {
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          // Echo any data already buffered after the CONNECT preamble
          if (remainder.length > 0) sock.write(remainder);
        } else {
          sock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
          sock.end();
        }
      } else {
        // Echo back
        sock.write(chunk);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    targets,
    headers,
  };
}

/** Send a raw CONNECT to the bridge port and return the socket once tunneled. */
function tunnelThroughBridge(
  bridgePort: number,
  target: string,
): Promise<{ socket: net.Socket; banner: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(bridgePort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const banner = buf.slice(0, end);
      // anything after the banner is leftover for the caller — re-emit
      const leftover = buf.slice(end + 4);
      if (leftover.length > 0) {
        process.nextTick(() => socket.emit('data', Buffer.from(leftover, 'utf8')));
      }
      resolve({ socket, banner });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

describe('startWebProxyBridge — CONNECT tunneling', () => {
  it('proxies a CONNECT through the Unix socket and bidirectionally pipes', async () => {
    const socketPath = tmpSocketPath();
    const upstream = await startUnixCONNECTServer(socketPath, { accept: true });

    const bridge = await startWebProxyBridge(socketPath);
    cleanups.push(() => bridge.stop());

    const { socket, banner } = await tunnelThroughBridge(bridge.port, 'example.test:443');
    expect(banner).toMatch(/^HTTP\/1\.1 200/);
    expect(upstream.targets).toEqual(['example.test:443']);

    // Now pump bytes through and expect them echoed back
    const echoed = await new Promise<string>((resolve) => {
      let acc = '';
      socket.on('data', (chunk) => {
        acc += chunk.toString();
        if (acc.length >= 'hello tunnel'.length) resolve(acc);
      });
      socket.write('hello tunnel');
    });
    expect(echoed.startsWith('hello tunnel')).toBe(true);

    socket.destroy();
  });

  it('forwards Proxy-Authorization on the CONNECT it writes to the unix socket (TASK-52)', async () => {
    // Egress attribution: the sandbox sends the per-session token as
    // `Proxy-Authorization: Basic ax:<token>`. The bridge must carry that
    // header on the CONNECT it rebuilds for the host proxy, or k8s-mode
    // HTTPS egress arrives at the listener token-less (unattributed).
    const socketPath = tmpSocketPath();
    const upstream = await startUnixCONNECTServer(socketPath, { accept: true });

    const bridge = await startWebProxyBridge(socketPath);
    cleanups.push(() => bridge.stop());

    const token = 'd'.repeat(32);
    const authValue = 'Basic ' + Buffer.from('ax:' + token).toString('base64');

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(bridge.port, '127.0.0.1', () => {
        // A real CONNECT request WITH the Proxy-Authorization header. Node's
        // http server parses it into req.headers['proxy-authorization'].
        socket.write(
          `CONNECT api.example.com:443 HTTP/1.1\r\n` +
            `Host: api.example.com:443\r\n` +
            `Proxy-Authorization: ${authValue}\r\n` +
            `\r\n`,
        );
      });
      let buf = '';
      const onData = (c: Buffer) => {
        buf += c.toString();
        if (buf.indexOf('\r\n\r\n') !== -1) {
          socket.off('data', onData);
          socket.destroy();
          resolve();
        }
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });

    // The host proxy received exactly one CONNECT; its header block carries
    // the forwarded Proxy-Authorization (case-insensitive header name).
    expect(upstream.headers).toHaveLength(1);
    expect(upstream.headers[0]!.toLowerCase()).toContain(
      `proxy-authorization: ${authValue.toLowerCase()}`,
    );
  });

  it('forwards a non-200 CONNECT response from the host proxy', async () => {
    const socketPath = tmpSocketPath();
    await startUnixCONNECTServer(socketPath, { accept: false });

    const bridge = await startWebProxyBridge(socketPath);
    cleanups.push(() => bridge.stop());

    const banner = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(bridge.port, '127.0.0.1', () => {
        socket.write(`CONNECT denied.test:443 HTTP/1.1\r\nHost: denied.test:443\r\n\r\n`);
      });
      let buf = '';
      socket.on('data', (c) => {
        buf += c.toString();
      });
      socket.on('end', () => resolve(buf));
      socket.on('close', () => resolve(buf));
      socket.on('error', reject);
    });

    expect(banner).toMatch(/^HTTP\/1\.1 502/);
  });
});
