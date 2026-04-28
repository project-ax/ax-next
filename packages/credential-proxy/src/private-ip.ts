/**
 * Private-IP block + DNS resolver for SSRF protection.
 *
 * Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts:104-146.
 *
 * Adaptation: `resolveAndCheck` accepts an optional `resolver` parameter so
 * tests can stub DNS without depending on /etc/hosts. Default is
 * `dns.promises.lookup`.
 */

import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** DNS resolver function signature — matches `dns.promises.lookup`'s 1-arg form. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }>;

/** IPv4 ranges that must never be connected to (SSRF protection). */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  return (
    a === 127 ||                              // 127.0.0.0/8
    a === 10 ||                               // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||      // 172.16.0.0/12
    (a === 192 && b === 168) ||               // 192.168.0.0/16
    (a === 169 && b === 254) ||               // 169.254.0.0/16 (cloud metadata)
    a === 0                                    // 0.0.0.0/8
  );
}

export function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  return (
    norm === '::1' ||
    norm === '::' ||
    norm.startsWith('fe80:') ||
    norm.startsWith('fc') ||
    norm.startsWith('fd')
  );
}

/**
 * Resolve hostname and check against private IP ranges.
 * Returns the resolved IP or throws if private.
 *
 * @param hostname — IP literal or hostname to resolve
 * @param allowedIPs — optional override allowlist; matching IPs bypass the block
 * @param resolver — optional DNS resolver (default: `dns.promises.lookup`)
 */
export async function resolveAndCheck(
  hostname: string,
  allowedIPs?: Set<string>,
  resolver: Resolver = dnsLookup,
): Promise<string> {
  // Literal IP — no DNS lookup needed
  if (net.isIP(hostname)) {
    if (!allowedIPs?.has(hostname) && (isPrivateIPv4(hostname) || isPrivateIPv6(hostname))) {
      throw new Error(`Blocked: private IP ${hostname}`);
    }
    return hostname;
  }

  const result = await resolver(hostname);
  const ip = result.address;

  if (!allowedIPs?.has(ip) && (isPrivateIPv4(ip) || isPrivateIPv6(ip))) {
    throw new Error(`Blocked: ${hostname} resolved to private IP ${ip}`);
  }
  return ip;
}
