// ---------------------------------------------------------------------------
// Connect-time-vetted fetch for the image-pin registry calls. A local copy of
// the pattern in @ax/mcp-client's connector-inventory/safe-fetch.ts (invariant
// I2: one local copy per plugin that makes outbound requests).
//
// A hostname can pass the textual host checks and still resolve to a private
// address (`10.0.0.1.nip.io`, split-horizon DNS, rebinding). So the undici
// dispatcher's `lookup` resolves the name ONCE, rejects the connection if ANY
// address is private / loopback / link-local / CGNAT / metadata, and hands the
// socket exactly the addresses it vetted. No second resolution to race.
// ---------------------------------------------------------------------------

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

/** Thrown from the lookup when policy (not the network) refuses the address. */
export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedRequestError';
  }
}

export type AllAddressesResolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: AllAddressesResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

function isBlockedIpv4(addr: ipaddr.IPv4): boolean {
  if (addr.range() !== 'unicast') return true;
  const [a, b] = addr.octets;
  // 168.63.0.0/16: Azure wireserver, nominally public space.
  return a === 168 && b === 63;
}

/** True for anything a host-side request must never reach. Fails closed. */
export function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  if (addr.kind() === 'ipv4') return isBlockedIpv4(addr as ipaddr.IPv4);
  const v6 = addr as ipaddr.IPv6;
  if (v6.isIPv4MappedAddress()) return isBlockedIpv4(v6.toIPv4Address());
  const p = v6.parts;
  if (p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0 && p[4] === 0 && p[5] === 0) return true;
  return v6.range() !== 'unicast';
}

export function makePinnedLookup(resolver: AllAddressesResolver) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new BlockedRequestError('host did not resolve'), '', 0);
          return;
        }
        if (addresses.some((a) => isBlockedIp(a.address))) {
          callback(new BlockedRequestError('host resolves to a non-public address'), '', 0);
          return;
        }
        const wantsAll = typeof options === 'object' && options !== null && options.all === true;
        if (wantsAll) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), '', 0),
    );
  };
}

/**
 * Production fetch for registry and token-realm requests: undici with the
 * pinned lookup. (The global fetch may be a different undici build that does
 * not accept this Agent, so undici's own fetch is used.)
 */
export function createPinnedFetch(
  opts: { timeoutMs: number; resolver?: AllAddressesResolver } = { timeoutMs: 10_000 },
): typeof fetch {
  const dispatcher = new Agent({
    connect: { lookup: makePinnedLookup(opts.resolver ?? defaultResolver) as never, timeout: opts.timeoutMs },
    headersTimeout: opts.timeoutMs,
    bodyTimeout: opts.timeoutMs,
  });
  return ((input: unknown, init?: RequestInit) =>
    undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}
