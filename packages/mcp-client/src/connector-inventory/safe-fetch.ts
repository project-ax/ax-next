// ---------------------------------------------------------------------------
// SSRF-guarded, size-capped, time-boxed fetch for the connector tool inventory.
//
// Why this exists: `connectors:describe-tools` makes a HOST-side request to a
// URL that a connector author typed. Connector URLs are admin-written, but
// still hostile input: one can be mistyped, the server can change hands, or an
// admin account can be compromised. Pointed at
// `http://169.254.169.254/` or an in-cluster service it would turn the host
// into a proxy for the caller. Connector MCP traffic from a SESSION goes through
// the credential-proxy, which blocks private IPs; this module is the host-side
// equivalent for the one request the host itself makes.
//
// What it enforces, per request:
//   1. https only; no userinfo in the URL.
//   2. Same ORIGIN as the connector's server URL — the MCP SDK never gets to
//      steer us to a second host (e.g. via a resumption URL).
//   3. No redirects (`redirect: 'manual'`, any 3xx is an error): a public
//      server could otherwise 302 us to an internal address.
//   4. The destination IP is vetted AT CONNECT TIME. An IP-literal host is
//      checked up front; a hostname is resolved inside the undici dispatcher's
//      `lookup`, which rejects the connection if ANY resolved address is
//      private and hands the socket exactly the addresses it vetted. Checking
//      in `lookup` (rather than resolve-then-fetch) closes the DNS-rebinding
//      window the mcp-oauth `safeFetch` documents as a known gap: there is no
//      second resolution for a rebinding server to race.
//   5. A per-request deadline (AbortSignal) and a response-body byte cap,
//      enforced while streaming (a lying or absent Content-Length can't
//      bypass it).
//
// Re-declared locally rather than imported from @ax/mcp-oauth / credential-
// proxy — invariant I2 forbids cross-plugin imports, and the repo precedent is
// one local copy per plugin that makes outbound requests.
// ---------------------------------------------------------------------------

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

/** Thrown when a request is refused by policy (not a network failure). */
export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedRequestError';
  }
}

/** Thrown when a response body exceeds the byte cap. */
export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`response exceeded ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** `dns.lookup(host, {all: true})`-shaped resolver; injectable for tests. */
export type AllAddressesResolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: AllAddressesResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

function isBlockedIpv4(addr: ipaddr.IPv4): boolean {
  // ipaddr's range() is 'unicast' only for ordinary public space; private,
  // loopback, linkLocal (incl. 169.254.169.254), carrierGradeNat,
  // unspecified, broadcast, multicast and reserved are all something else.
  if (addr.range() !== 'unicast') return true;
  const [a, b] = addr.octets;
  // 168.63.0.0/16 — Azure IMDS / wireserver lives at 168.63.129.16, which is
  // nominally public space. Parity with @ax/credential-proxy's list.
  if (a === 168 && b === 63) return true;
  return false;
}

/**
 * True if `ip` is anything a host-side inventory request must never reach.
 * Fails CLOSED: an unparseable address is blocked.
 */
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
  // IPv4-compatible (::a.b.c.d) is reported as 'unicast' by ipaddr; block it,
  // along with every non-global range (loopback, ULA, link-local, NAT64,
  // 6to4, teredo, multicast, reserved…).
  const p = v6.parts;
  const highZero = p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0 && p[4] === 0;
  if (highZero && p[5] === 0) return true;
  return v6.range() !== 'unicast';
}

export interface GuardedFetchOptions {
  /** The connector server URL; every request must stay on its origin. */
  serverUrl: string;
  /** Per-request deadline in ms. */
  timeoutMs: number;
  /** Max response-body bytes per request. */
  maxResponseBytes: number;
  /** Test seam: DNS resolver. */
  resolver?: AllAddressesResolver;
  /**
   * Test seam: the underlying fetch. Receives the dispatcher the guard built,
   * so a test can assert the pinned lookup is used. Production uses undici's
   * own `fetch` (the global one may be a different undici build that does not
   * accept this Agent).
   */
  baseFetch?: (url: string, init: Record<string, unknown>) => Promise<Response>;
}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Validate the connector server URL itself. Throws BlockedRequestError. */
export function assertAllowedServerUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedRequestError('invalid server url');
  }
  if (u.protocol !== 'https:') throw new BlockedRequestError('server url must be https');
  if (u.username !== '' || u.password !== '') {
    throw new BlockedRequestError('server url must not carry credentials');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && isBlockedIp(host)) {
    throw new BlockedRequestError('server address is not publicly routable');
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new BlockedRequestError('server address is not publicly routable');
  }
  return u;
}

/**
 * Build the `lookup` the undici dispatcher uses for every new connection.
 * Exported for tests.
 */
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
      (err: unknown) => {
        callback(err instanceof Error ? err : new Error(String(err)), '', 0);
      },
    );
  };
}

/** Wrap a body so reading more than `limit` bytes errors the stream. */
function capBody(res: Response, limit: number): Response {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    void res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(limit);
  }
  if (res.body === null) return res;
  let seen = 0;
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          controller.error(new ResponseTooLargeError(limit));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export interface GuardedFetch {
  fetch: FetchLike;
  /** Release the dispatcher's sockets. Idempotent. */
  close(): Promise<void>;
}

/**
 * Build a fetch the MCP SDK's StreamableHTTPClientTransport can use (its
 * `fetch` option) that applies every rule in the file banner.
 */
export function createGuardedFetch(opts: GuardedFetchOptions): GuardedFetch {
  const server = assertAllowedServerUrl(opts.serverUrl);
  const lookup = makePinnedLookup(opts.resolver ?? defaultResolver);
  const dispatcher = new Agent({
    connect: { lookup: lookup as never, timeout: opts.timeoutMs },
    headersTimeout: opts.timeoutMs,
    bodyTimeout: opts.timeoutMs,
  });
  const base =
    opts.baseFetch ??
    ((url: string, init: Record<string, unknown>) =>
      undiciFetch(url, init as never) as unknown as Promise<Response>);
  let closed = false;

  const guarded: FetchLike = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input.toString());
    if (target.origin !== server.origin) {
      throw new BlockedRequestError('request left the connector server origin');
    }
    if (target.username !== '' || target.password !== '') {
      throw new BlockedRequestError('request url must not carry credentials');
    }
    const deadline = AbortSignal.timeout(opts.timeoutMs);
    const signal =
      init?.signal !== undefined && init.signal !== null
        ? AbortSignal.any([init.signal, deadline])
        : deadline;
    const res = await base(target.toString(), {
      ...(init ?? {}),
      signal,
      redirect: 'manual',
      dispatcher,
    });
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => {});
      throw new BlockedRequestError('connector server answered with a redirect');
    }
    return capBody(res, opts.maxResponseBytes);
  };

  return {
    fetch: guarded,
    async close() {
      if (closed) return;
      closed = true;
      await dispatcher.destroy().catch(() => {});
    },
  };
}
