import { describe, it, expect } from 'vitest';
import {
  BlockedRequestError,
  ResponseTooLargeError,
  assertAllowedServerUrl,
  createGuardedFetch,
  isBlockedIp,
  makePinnedLookup,
} from '../connector-inventory/safe-fetch.js';

// ---------------------------------------------------------------------------
// The host-side SSRF guard for `connectors:describe-tools`. The connector URL
// is author-supplied (any user can author a private connector), so every rule
// here is a refusal we must be able to see fail.
// ---------------------------------------------------------------------------

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '168.63.129.16',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::7f00:1',
    '64:ff9b::a00:1',
    '2002:a00:1::',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe('assertAllowedServerUrl', () => {
  it.each([
    ['http://mcp.example.com/mcp', 'https'],
    ['https://user:pw@mcp.example.com/mcp', 'credentials'],
    ['https://127.0.0.1/mcp', 'publicly routable'],
    ['https://[::1]/mcp', 'publicly routable'],
    ['https://169.254.169.254/latest', 'publicly routable'],
    ['https://localhost/mcp', 'publicly routable'],
    ['https://api.localhost/mcp', 'publicly routable'],
    ['not a url', 'invalid'],
  ])('refuses %s', (url, why) => {
    expect(() => assertAllowedServerUrl(url)).toThrow(BlockedRequestError);
    expect(() => assertAllowedServerUrl(url)).toThrow(why);
  });

  it('accepts a public https url', () => {
    expect(assertAllowedServerUrl('https://mcp.example.com/mcp').hostname).toBe('mcp.example.com');
  });
});

describe('makePinnedLookup', () => {
  function run(addresses: Array<{ address: string; family: number }>, all: boolean) {
    const lookup = makePinnedLookup(async () => addresses);
    return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) => {
      lookup('h.example', { all }, (err, address, family) => resolve({ err, address, family }));
    });
  }

  it('refuses when ANY resolved address is private (rebinding / split answers)', async () => {
    const r = await run(
      [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      true,
    );
    expect(r.err).toBeInstanceOf(BlockedRequestError);
  });

  it('hands back exactly the vetted addresses', async () => {
    const vetted = [{ address: '93.184.216.34', family: 4 }];
    expect((await run(vetted, true)).address).toEqual(vetted);
    const single = await run(vetted, false);
    expect(single.address).toBe('93.184.216.34');
    expect(single.family).toBe(4);
  });

  it('refuses an empty answer', async () => {
    expect((await run([], true)).err).toBeInstanceOf(BlockedRequestError);
  });
});

describe('createGuardedFetch', () => {
  const opts = { serverUrl: 'https://mcp.example.com/mcp', timeoutMs: 1_000, maxResponseBytes: 16 };

  it('passes its pinned dispatcher, manual redirects and a deadline to the base fetch', async () => {
    let seen: Record<string, unknown> = {};
    const g = createGuardedFetch({
      ...opts,
      baseFetch: async (_url, init) => {
        seen = init;
        return new Response('ok');
      },
    });
    await g.fetch('https://mcp.example.com/mcp', { method: 'POST' });
    expect(seen.redirect).toBe('manual');
    expect(seen.dispatcher).toBeDefined();
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    await g.close();
  });

  it('refuses a request to another origin without calling the base fetch', async () => {
    let called = false;
    const g = createGuardedFetch({
      ...opts,
      baseFetch: async () => {
        called = true;
        return new Response('ok');
      },
    });
    await expect(g.fetch('https://evil.example.com/mcp')).rejects.toThrow(BlockedRequestError);
    await expect(g.fetch('http://mcp.example.com/mcp')).rejects.toThrow(BlockedRequestError);
    expect(called).toBe(false);
    await g.close();
  });

  it('refuses a redirect', async () => {
    const g = createGuardedFetch({
      ...opts,
      baseFetch: async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    });
    await expect(g.fetch('https://mcp.example.com/mcp')).rejects.toThrow('redirect');
    await g.close();
  });

  it('refuses an oversize declared body', async () => {
    const g = createGuardedFetch({
      ...opts,
      baseFetch: async () =>
        new Response('x'.repeat(64), { headers: { 'content-length': '64' } }),
    });
    await expect(g.fetch('https://mcp.example.com/mcp')).rejects.toThrow(ResponseTooLargeError);
    await g.close();
  });

  it('errors a streamed body that crosses the cap (no/lying content-length)', async () => {
    const g = createGuardedFetch({
      ...opts,
      baseFetch: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(10));
            c.enqueue(new Uint8Array(10));
            c.close();
          },
        });
        return new Response(body, { headers: { 'content-length': '5' } });
      },
    });
    const res = await g.fetch('https://mcp.example.com/mcp');
    await expect(res.arrayBuffer()).rejects.toThrow(ResponseTooLargeError);
    await g.close();
  });

  it('lets a body under the cap through intact', async () => {
    const g = createGuardedFetch({ ...opts, baseFetch: async () => new Response('hello') });
    const res = await g.fetch('https://mcp.example.com/mcp');
    expect(await res.text()).toBe('hello');
    await g.close();
  });

  it('real undici path: a hostname resolving to a private address never connects', async () => {
    let resolved = 0;
    const g = createGuardedFetch({
      ...opts,
      serverUrl: 'https://rebind.example.test/mcp',
      resolver: async () => {
        resolved++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const err = await g.fetch('https://rebind.example.test/mcp').catch((e: unknown) => e);
    expect(resolved).toBeGreaterThan(0);
    expect(err).toBeInstanceOf(Error);
    expect(((err as Error).cause as Error | undefined)?.name).toBe('BlockedRequestError');
    await g.close();
  });
});
