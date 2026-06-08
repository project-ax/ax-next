import { type AddressInfo, createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeUrl, BlockedUrlError, safeFetch } from '../ssrf.js';

const allow = new Set(['mcp.example.com', 'auth.example.com']);
// Resolver stub: example hosts → public IP; everything else → loopback.
const resolver = async (h: string) =>
  allow.has(h) ? '93.184.216.34' : '127.0.0.1';

describe('assertSafeUrl', () => {
  it('passes an https URL on an allowlisted host resolving to a public IP', async () => {
    await expect(assertSafeUrl('https://auth.example.com/token', allow, resolver))
      .resolves.toBeUndefined();
  });
  it('rejects http (non-TLS)', async () => {
    await expect(assertSafeUrl('http://auth.example.com/', allow, resolver))
      .rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('rejects a host not in the connector allowlist', async () => {
    await expect(assertSafeUrl('https://evil.example.net/', allow, resolver))
      .rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('rejects a host that resolves into a private range', async () => {
    const internalAllow = new Set(['internal.example.com']);
    await expect(
      assertSafeUrl('https://internal.example.com/', internalAllow,
        async () => '169.254.169.254'),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  // Regression / acceptance table. A malicious connector resolves an allowlisted
  // host to one of these to reach internal infrastructure. The hand-rolled IPv6
  // string-prefix guard let several IPv6 encodings of internal IPs through; these
  // are the hard acceptance criterion for the ipaddr.js-backed rewrite.
  const internal = new Set(['internal.example.com']);
  const blockedIps = [
    // --- IPv4-compatible IPv6 (::a.b.c.d) — ipaddr.range() returns 'unicast'! ---
    '::7f00:1', // ::127.0.0.1 loopback — THE critical bypass range() misses
    '::a9fe:a9fe', // ::169.254.169.254 link-local (cloud metadata) via v4-compat
    '::169.254.169.254', // same, dotted v4-compat form
    // --- NAT64 / tunneling embeddings — block outright ---
    '64:ff9b::a9fe:a9fe', // NAT64 64:ff9b::/96 wrapping 169.254.169.254
    '2002:7f00:1::', // 6to4 of 127.0.0.1
    '2001:0:0:0:0:0:a9fe:a9fe', // teredo (2001:0::/32)
    // --- IPv4-mapped IPv6 (::ffff:a.b.c.d) ---
    '0:0:0:0:0:ffff:7f00:1', // ::ffff:127.0.0.1 fully expanded
    '::ffff:192.168.1.1', // IPv4-mapped RFC1918 (192.168/16)
    '::ffff:172.16.0.1', // IPv4-mapped RFC1918 (172.16/12)
    // --- plain IPv6 ranges ---
    '0:0:0:0:0:0:0:1', // ::1 loopback, fully expanded
    'febf::1', // link-local (fe80::/10 upper edge)
    'ff02::1', // IPv6 multicast (ff00::/8)
    // --- IPv4 broadcast / multicast / reserved ---
    '255.255.255.255', // limited broadcast
    '224.0.0.1', // IPv4 multicast (224.0.0.0/4)
  ];
  for (const ip of blockedIps) {
    it(`rejects a host resolving to ${ip}`, async () => {
      await expect(
        assertSafeUrl('https://internal.example.com/', internal, async () => ip),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    });
  }

  it('rejects a literal IPv6 host in the allowlist (no resolver hop)', async () => {
    // Even if the connector somehow allowlisted the literal, the IP check still fires.
    const literalAllow = new Set(['::7f00:1']);
    await expect(
      assertSafeUrl('https://[::7f00:1]/', literalAllow),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  // ALLOW: real public endpoints (incl. range boundaries just outside private blocks).
  const allowedIps = [
    '8.8.8.8', // public IPv4
    '2606:2800:220:1:248:1893:25c8:1946', // public IPv6
    '172.15.0.1', // just below 172.16/12
    '172.32.0.1', // just above 172.16-31/12
    '100.63.0.1', // just below 100.64/10 CGNAT
    '223.255.255.255', // just below 224.0.0.0/4 multicast
  ];
  for (const ip of allowedIps) {
    it(`passes a host resolving to public ${ip}`, async () => {
      await expect(
        assertSafeUrl('https://auth.example.com/token', allow, async () => ip),
      ).resolves.toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// safeFetch redirect handling. The bug: validating only the FIRST url and then
// letting fetch auto-follow (`redirect: 'follow'`) means an allowlisted server
// can 302 us to an internal/non-allowlisted host that never gets re-checked.
// safeFetch must re-validate EVERY hop, so a redirect into a blocked target is
// rejected, while legit redirects to allowlisted-public hosts still work.
//
// We drive this with a real in-process http server (matches repo style) and a
// resolver stub so the FIRST hop passes the https/allowlist/public-IP gate; the
// REDIRECT target is the thing under test. The first hop is the test server, so
// we route safeFetch's outbound calls through an injected dispatcher that hits
// the http server while keeping safeFetch's per-hop assertSafeUrl gate intact.
describe('safeFetch redirect re-validation', () => {
  let server: Server;
  let port: number;
  // Resolver: allowlisted test hosts → public IP; the internal Location → its
  // real (private) literal so the private-IP gate fires on the redirect hop.
  const resolver = async (h: string) =>
    h === 'good.example.com' || h === 'hop.example.com' ? '93.184.216.34' : '169.254.169.254';
  const redirectAllow = new Set(['good.example.com', 'hop.example.com']);

  // The injected fetch maps the validated https URL onto the local test server,
  // preserving path so the server can branch. safeFetch still runs assertSafeUrl
  // on the original https URL of each hop BEFORE this is called — that's the gate.
  const toLocal = (u: string | URL): string => {
    const url = new URL(typeof u === 'string' ? u : u.toString());
    return `http://127.0.0.1:${port}${url.pathname}`;
  };
  const localFetch = (input: string | URL, init?: RequestInit) =>
    fetch(toLocal(input), init);

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect-to-internal') {
        // Allowlisted server tries to bounce us to the cloud metadata endpoint.
        res.writeHead(302, { location: 'https://metadata.internal/latest' });
        res.end();
      } else if (req.url === '/redirect-to-allowed') {
        res.writeHead(302, { location: 'https://hop.example.com/final' });
        res.end();
      } else if (req.url === '/final') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('arrived');
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('BLOCKS a 302 redirect to an internal host (does not follow it)', async () => {
    // metadata.internal is NOT allowlisted AND resolves private — either gate
    // alone must reject. Against the old follow-default code this URL would be
    // fetched silently; here the second-hop assertSafeUrl throws.
    await expect(
      safeFetch('https://good.example.com/redirect-to-internal', redirectAllow, undefined, resolver, localFetch),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('FOLLOWS a 302 redirect to an allowlisted, public host', async () => {
    const res = await safeFetch(
      'https://good.example.com/redirect-to-allowed',
      redirectAllow,
      undefined,
      resolver,
      localFetch,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('arrived');
  });

  it('rejects a redirect loop exceeding the hop budget', async () => {
    // A server that always 302s back to an allowlisted-but-looping URL must hit
    // the MAX_HOPS ceiling rather than spin forever.
    const looper = createServer((_req, res) => {
      res.writeHead(302, { location: 'https://hop.example.com/loop' });
      res.end();
    });
    await new Promise<void>((resolve) => looper.listen(0, '127.0.0.1', resolve));
    const loopPort = (looper.address() as AddressInfo).port;
    const loopFetch = (input: string | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      return fetch(`http://127.0.0.1:${loopPort}${url.pathname}`, init);
    };
    try {
      await expect(
        safeFetch('https://hop.example.com/loop', redirectAllow, undefined, resolver, loopFetch),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    } finally {
      await new Promise<void>((resolve) => looper.close(() => resolve()));
    }
  });
});
