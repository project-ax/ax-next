import { describe, expect, it } from 'vitest';
import { assertSafeUrl, BlockedUrlError } from '../ssrf.js';

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
