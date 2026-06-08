import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class BlockedUrlError extends Error {
  constructor(message: string) { super(message); this.name = 'BlockedUrlError'; }
}

export type HostResolver = (hostname: string) => Promise<string>;
const defaultResolver: HostResolver = async (h) => (await lookup(h)).address;

/** True for an IPv4 dotted-quad in a private/loopback/link-local/CGNAT range, or
 *  a multicast/reserved/broadcast range we never want an OAuth fetch to reach. */
function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  return false;
}

/**
 * True if the IP is anything an outbound OAuth fetch must never reach — every
 * private/loopback/link-local/ULA/multicast/reserved range, across IPv4, IPv6,
 * and the v4-in-v6 embedding/tunneling encodings that string-matching misses.
 *
 * IPv6 is handled with `ipaddr.js` rather than hand-rolled prefix checks: the hex
 * forms (`::7f00:1`, `0:0:0:0:0:ffff:7f00:1`, fully-expanded `fe80`/`ff` variants)
 * have too many spellings for `startsWith` to be safe. We **fail closed**: an
 * unparseable address is treated as private/blocked.
 */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIpv4(ip);

  let addr: ReturnType<typeof ipaddr.parse>;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // fail closed — can't reason about it, don't reach it
  }
  if (addr.kind() === 'ipv4') return isPrivateIpv4(addr.toString());

  const v6 = addr as ipaddr.IPv6;

  // IPv4-mapped (::ffff:a.b.c.d): extract the embedded IPv4 and run the SAME check.
  if (v6.isIPv4MappedAddress()) return isPrivateIp(v6.toIPv4Address().toString());

  // Other v4-in-v6 embedding / tunneling forms. ipaddr's range() flags NAT64
  // (rfc6052), 6to4, and teredo, but NOT the IPv4-*compatible* form (::a.b.c.d,
  // high 96 bits zero with a non-zero low 32) — it reports that as 'unicast', so
  // ::7f00:1 (= ::127.0.0.1) would otherwise sail through. The safe default for
  // every embedding/tunneling form is to BLOCK: legit OAuth endpoints never
  // resolve to one. Detect IPv4-compatible explicitly from the 8 hextets.
  const p = v6.parts; // eight 16-bit groups, [0..7]
  const highZero = p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0 && p[4] === 0;
  const isV4Compatible = highZero && p[5] === 0 && !(p[6] === 0 && p[7] === 0); // exclude :: and ::1
  if (isV4Compatible) return true;

  // Everything else: allow ONLY genuine global unicast. range() lumps loopback,
  // unspecified, linkLocal, uniqueLocal, multicast, reserved, rfc6052 (NAT64),
  // rfc6145, 6to4, teredo, etc. into non-'unicast' buckets — all blocked here.
  return v6.range() !== 'unicast';
}

/**
 * Throw BlockedUrlError unless `url` is https, its host is in `allowedHosts`, and
 * it resolves to a non-private IP. Used for EVERY discovery/registration/token
 * fetch — the metadata that names these URLs is untrusted third-party input.
 */
export async function assertSafeUrl(
  url: string,
  allowedHosts: Set<string>,
  resolver: HostResolver = defaultResolver,
): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { throw new BlockedUrlError(`invalid url: ${url}`); }
  if (u.protocol !== 'https:') throw new BlockedUrlError(`non-https url blocked: ${url}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowedHosts.has(host)) throw new BlockedUrlError(`host not allowlisted: ${host}`);
  const ip = isIP(host) ? host : await resolver(host);
  if (isPrivateIp(ip)) throw new BlockedUrlError(`host resolves to a private ip: ${host}`);
}

/** A `fetch`-shaped function. Defaults to the global `fetch`; injectable in tests
 *  so the redirect loop can be exercised without real DNS/TLS. */
export type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECT_HOPS = 5;

/**
 * `fetch` wrapper that re-runs `assertSafeUrl` on EVERY hop, including redirects.
 *
 * Why manual redirect following: the metadata that names these URLs is untrusted,
 * and so is any `Location` header an allowlisted server hands back. If we let the
 * platform `fetch` auto-follow (`redirect: 'follow'`), a server we trust for the
 * FIRST hop could `302` us to `https://169.254.169.254/...` (or any internal /
 * non-allowlisted host) and we'd silently connect to it — bypassing the allowlist,
 * the private-IP check, AND the https-only rule all at once. So we set
 * `redirect: 'manual'`, validate each hop's URL before fetching it, and resolve
 * the `Location` relative to the current URL before re-checking. Legit redirects
 * to allowlisted, public hosts (e.g. discovery canonicalization) still work; a hop
 * into a blocked target throws `BlockedUrlError`. Bounded at `MAX_REDIRECT_HOPS`.
 *
 * KNOWN, KNOWINGLY-ACCEPTED GAP — DNS rebinding (TOCTOU). `assertSafeUrl`
 * resolves the host once to vet the IP, then `fetch(url)` resolves it AGAIN at
 * connect time. A host that passed the check could rebind to an internal IP in
 * that window. We accept this for now because the blast radius is bounded: only a
 * host the connector has ALREADY been granted in its allowlist can attempt it (an
 * attacker can't introduce a fresh internal hostname), so this narrows to a
 * malicious-but-allowlisted server racing its own DNS — not arbitrary SSRF.
 *
 * Proper fix (follow-up, NOT implemented here): pin the validated IP through an
 * undici Agent/dispatcher with a custom `lookup` that returns the vetted address,
 * while keeping the original hostname for TLS SNI + cert validation. That closes
 * the check-vs-connect window entirely. Tracked as a follow-up task.
 */
export async function safeFetch(
  url: string,
  allowedHosts: Set<string>,
  init?: RequestInit,
  resolver?: HostResolver,
  doFetch: FetchFn = fetch,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertSafeUrl(current, allowedHosts, resolver);
    // `redirect: 'manual'` stops fetch from auto-following so WE control each hop.
    const res = await doFetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res; // 3xx without a Location — nothing to follow; caller's call.
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new BlockedUrlError(`too many redirects starting at ${url}`);
      }
      current = new URL(loc, current).toString(); // resolve relative; re-validated next loop
      continue;
    }
    return res;
  }
}
