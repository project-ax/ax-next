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

/**
 * The eight 16-bit groups of an IPv6 literal, or `undefined` if it is not one.
 * Parsing (rather than string-prefix matching) is what lets one check cover
 * every spelling of an address — `::1`, `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`
 * and its hex form `::ffff:7f00:1` (WHATWG URL's serialization) alike.
 */
function ipv6Groups(ip: string): number[] | undefined {
  if (!net.isIPv6(ip) || ip.includes('%')) return undefined;
  let text = ip;
  // A trailing dotted IPv4 is the last two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((h) => parseInt(h, 16));
  const head = parse(halves[0]!);
  const tailGroups = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tailGroups.length;
  const groups =
    halves.length === 2 ? [...head, ...Array<number>(fill).fill(0), ...tailGroups] : head;
  return groups.length === 8 ? groups : undefined;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (g === undefined) return false;
  // The last 32 bits as dotted IPv4, for the prefixes that embed one.
  const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::/96 — `::`, `::1` (both land in 0.0.0.0/8) and deprecated IPv4-compatible.
  if (zeroThrough(6)) return isPrivateIPv4(v4);
  // ::ffff:0:0/96 — IPv4-mapped (RFC 4291 §2.5.5.2).
  if (zeroThrough(5) && g[5] === 0xffff) return isPrivateIPv4(v4);
  // 64:ff9b::/96 — NAT64 well-known prefix (RFC 6052); a NAT64 gateway would
  // carry it to the embedded IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateIPv4(v4);
  }
  return (
    (g[0]! & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0]! & 0xfe00) === 0xfc00 //    fc00::/7  unique local
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
