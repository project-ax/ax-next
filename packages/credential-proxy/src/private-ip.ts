/**
 * Private-IP block + DNS resolver for SSRF protection.
 *
 * Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts:104-146.
 *
 * Adaptation: `resolveAndCheck` accepts an optional `resolver` parameter so
 * tests can stub DNS without depending on /etc/hosts. Default is
 * `dns.promises.lookup`.
 */

import net, { isIPv4 } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** DNS resolver function signature — matches `dns.promises.lookup`'s 1-arg form. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }>;

/**
 * Typed error thrown by `resolveAndCheck` when the target hostname
 * (or the IP it resolved to) sits inside one of the private CIDRs.
 *
 * Callers (e.g. the proxy listener) use `instanceof BlockedIPError` to
 * distinguish a policy block (→ HTTP 403) from a network/DNS error
 * (→ HTTP 502). Don't string-match the message; that's what this class
 * exists to avoid.
 */
export class BlockedIPError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly ip: string,
  ) {
    super(
      `Blocked: ${hostname === ip ? 'private IP' : `${hostname} resolved to private IP`} ${ip}`,
    );
    this.name = 'BlockedIPError';
  }
}

/** IPv4 ranges that must never be connected to (SSRF protection). */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  return (
    a === 127 ||                              // 127.0.0.0/8
    a === 10 ||                               // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||      // 172.16.0.0/12
    (a === 192 && b === 168) ||               // 192.168.0.0/16
    (a === 169 && b === 254) ||               // 169.254.0.0/16 (cloud metadata)
    (a === 168 && b === 63) ||                // 168.63.0.0/16 (Azure IMDS / wireserver)
    (a === 100 && b >= 64 && b <= 127) ||     // 100.64.0.0/10 (carrier-grade NAT, RFC 6598)
    a === 0                                    // 0.0.0.0/8
  );
}

export function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  // IPv4-mapped IPv6 (RFC 4291 §2.5.5.2): unwrap and check as IPv4
  if (norm.startsWith('::ffff:')) {
    const v4 = norm.slice(7);
    if (isIPv4(v4)) return isPrivateIPv4(v4);
  }
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
 * SECURITY: callers MUST use the returned IP for the actual connection
 * (with `host: ip, servername: hostname` for TLS). Re-resolving the
 * hostname when establishing the connection opens a DNS-rebinding
 * window where the second lookup returns a different (private) IP
 * than what was checked here.
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
      throw new BlockedIPError(hostname, hostname);
    }
    return hostname;
  }

  const result = await resolver(hostname);
  const ip = result.address;

  if (!allowedIPs?.has(ip) && (isPrivateIPv4(ip) || isPrivateIPv6(ip))) {
    throw new BlockedIPError(hostname, ip);
  }
  return ip;
}
