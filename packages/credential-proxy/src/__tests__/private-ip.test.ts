import { describe, it, expect } from 'vitest';
import {
  resolveAndCheck,
  isPrivateIPv4,
  isPrivateIPv6,
  BlockedIPError,
  type Resolver,
} from '../private-ip.js';

describe('isPrivateIPv4', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false], // outside 172.16/12
    ['192.168.1.1', true],
    ['169.254.169.254', true], // AWS metadata
    ['168.63.129.16', true],   // Azure IMDS
    ['168.63.0.0', true],      // Azure IMDS range start
    ['168.64.0.0', false],     // outside Azure IMDS /16
    ['100.64.0.1', true],      // CGNAT
    ['100.127.255.255', true], // CGNAT upper
    ['100.128.0.0', false],    // outside CGNAT
    ['100.63.255.255', false], // below CGNAT
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });
});

describe('isPrivateIPv6', () => {
  it.each([
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['2606:4700:4700::1111', false],
    ['::ffff:127.0.0.1', true],       // IPv4-mapped IPv6 → loopback
    ['::ffff:10.0.0.1', true],        // → 10/8
    ['::ffff:169.254.169.254', true], // → AWS metadata
    ['::ffff:8.8.8.8', false],        // → public IPv4
    // TASK-874: CONNECT now accepts bracketed IPv6 literals, so every spelling
    // of a private address must be caught — not just the compressed,
    // dotted-mapped one a string-prefix check recognises.
    ['::', true],                     // unspecified
    ['0:0:0:0:0:0:0:1', true],        // uncompressed loopback
    ['0000:0000:0000:0000:0000:0000:0000:0001', true],
    ['::ffff:7f00:1', true],          // hex IPv4-mapped 127.0.0.1 (WHATWG's serialization)
    ['::ffff:a9fe:a9fe', true],       // hex IPv4-mapped 169.254.169.254
    ['0:0:0:0:0:ffff:7f00:1', true],  // uncompressed hex IPv4-mapped
    ['::FFFF:127.0.0.1', true],       // upper-case mapped
    ['::ffff:808:808', false],        // hex IPv4-mapped 8.8.8.8 (public)
    ['::127.0.0.1', true],            // deprecated IPv4-compatible → loopback v4
    ['::7f00:1', true],               // …and its canonical form, which is what the CONNECT parser emits
    // A zone id must not make a private address look public (fail closed):
    // net.isIPv6 accepts these, so a future caller could hand one in.
    ['fe80::1%eth0', true],
    ['::1%lo0', true],
    ['2001:db8::1%eth0', false],
    ['64:ff9b::7f00:1', true],        // NAT64 well-known prefix → 127.0.0.1
    ['64:ff9b::808:808', false],      // NAT64 → public 8.8.8.8
    ['fe81::1', true],                // fe80::/10 is wider than the literal "fe80:"
    ['febf::1', true],                // top of fe80::/10
    ['fec0::1', false],               // just past fe80::/10
    ['FD12:3456::1', true],           // upper-case ULA
    ['fc00::1', true],                // bottom of fc00::/7
    ['fcd::1', false],                // 0fcd:: is NOT fc00::/7 (a prefix match said it was)
    ['2001:db8::1', false],
    ['not-an-ip', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

describe('resolveAndCheck', () => {
  it('throws Blocked: for literal private IP', async () => {
    await expect(resolveAndCheck('127.0.0.1')).rejects.toThrow(/Blocked: private IP/);
  });

  it('throws Blocked: for a zoned private IPv6 literal (net.isIP accepts the zone)', async () => {
    const resolver: Resolver = async () => {
      throw new Error('a literal must not be resolved');
    };
    await expect(resolveAndCheck('fe80::1%eth0', undefined, resolver)).rejects.toBeInstanceOf(
      BlockedIPError,
    );
  });

  it('returns IP for literal public IP', async () => {
    expect(await resolveAndCheck('8.8.8.8')).toBe('8.8.8.8');
  });

  it('allowedIPs override unblocks the IP', async () => {
    expect(await resolveAndCheck('127.0.0.1', new Set(['127.0.0.1']))).toBe('127.0.0.1');
  });

  // DNS-based test — needs an actual hostname. Use 'localhost' which resolves to 127.0.0.1.
  it('throws Blocked: for hostname resolving to private IP', async () => {
    await expect(resolveAndCheck('localhost')).rejects.toThrow(/Blocked.*private IP/);
  });

  // Stub-resolver tests (Task 4 reviewer feedback): exercise hostname → IP path
  // without depending on /etc/hosts. This makes the I3 invariant testable for
  // every CIDR independent of the host's resolver config.
  const stubResolver: Resolver = async (host) => {
    if (host === 'metadata.test') return { address: '169.254.169.254', family: 4 };
    if (host === 'public.test') return { address: '8.8.8.8', family: 4 };
    throw new Error(`unknown test host: ${host}`);
  };

  it('throws Blocked: when stub resolver returns private CIDR (AWS metadata)', async () => {
    await expect(resolveAndCheck('metadata.test', undefined, stubResolver)).rejects.toThrow(
      /Blocked.*private IP 169\.254\.169\.254/,
    );
  });

  it('returns resolved IP when stub resolver returns public IP', async () => {
    expect(await resolveAndCheck('public.test', undefined, stubResolver)).toBe('8.8.8.8');
  });

  // Reviewer M3 (Task 5): callers must be able to distinguish a policy block
  // (→ HTTP 403) from a network/DNS error (→ HTTP 502) without string-matching
  // the message. resolveAndCheck throws BlockedIPError for the former.
  it('throws BlockedIPError (typed) for literal private IP', async () => {
    await expect(resolveAndCheck('127.0.0.1')).rejects.toBeInstanceOf(BlockedIPError);
  });

  it('throws BlockedIPError carrying hostname and resolved IP for hostname → private path', async () => {
    try {
      await resolveAndCheck('metadata.test', undefined, stubResolver);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedIPError);
      expect((err as BlockedIPError).hostname).toBe('metadata.test');
      expect((err as BlockedIPError).ip).toBe('169.254.169.254');
    }
  });
});
