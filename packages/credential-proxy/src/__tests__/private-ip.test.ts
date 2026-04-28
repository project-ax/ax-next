import { describe, it, expect } from 'vitest';
import { resolveAndCheck, isPrivateIPv4, isPrivateIPv6, type Resolver } from '../private-ip.js';

describe('isPrivateIPv4', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false], // outside 172.16/12
    ['192.168.1.1', true],
    ['169.254.169.254', true], // AWS metadata
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
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

describe('resolveAndCheck', () => {
  it('throws Blocked: for literal private IP', async () => {
    await expect(resolveAndCheck('127.0.0.1')).rejects.toThrow(/Blocked: private IP/);
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
});
