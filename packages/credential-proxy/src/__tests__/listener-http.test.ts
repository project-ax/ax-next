import { describe, it, expect, afterEach } from 'vitest';
import { createServer as httpCreate, type Server } from 'node:http';
import { ProxyAgent } from 'undici';
import { startProxyListener, type ProxyListener } from '../listener.js';
import { SharedCredentialRegistry } from '../registry.js';

let upstream: Server | undefined;
let listener: ProxyListener | undefined;

afterEach(async () => {
  if (listener) listener.stop();
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  upstream = listener = undefined;
});

describe('proxy listener — HTTP forwarding', () => {
  it('forwards GET to allowlisted upstream and returns body', async () => {
    upstream = httpCreate((_req, res) => {
      res.end('OK from upstream');
    });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      sessions: new Map([
        ['s1', { allowlist: new Set(['127.0.0.1']), allowedIPs: new Set(['127.0.0.1']) }],
      ]),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false, // HTTP path: send absolute-URL request, not CONNECT
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK from upstream');
  });

  it('returns 403 when host not in any session allowlist', async () => {
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as { port: number }).port)),
    );

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      sessions: new Map([
        [
          's1',
          { allowlist: new Set(['other.example.com']), allowedIPs: new Set(['127.0.0.1']) },
        ],
      ]),
    });

    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false, // HTTP path: send absolute-URL request, not CONNECT
    });
    const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(res.status).toBe(403);
  });

  it('returns 403 for private-IP target without allowedIPs override', async () => {
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      sessions: new Map([
        ['s1', { allowlist: new Set(['127.0.0.1']) /* no allowedIPs */ }],
      ]),
    });
    const dispatcher = new ProxyAgent({
      uri: `http://127.0.0.1:${listener.port}`,
      proxyTunnel: false, // HTTP path: send absolute-URL request, not CONNECT
    });
    const res = await fetch(`http://127.0.0.1/`, { dispatcher } as RequestInit);
    expect(res.status).toBe(403);
  });
});
