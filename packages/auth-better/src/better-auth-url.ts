// Type-only import from `@ax/http-server`, as everywhere in this package: no
// runtime value from a peer plugin (Invariant I2).
import type { HttpRequest } from '@ax/http-server';

/** Everything `betterAuthUrl` reads. No other header, X-Forwarded-Proto included. */
export type BetterAuthUrlRequest = Pick<HttpRequest, 'protocol' | 'headers' | 'path' | 'query'>;

/**
 * A bare `host[:port]`: a name of letters, digits, `.`, `_` (compose-style
 * service names) and `-`, or a bracketed IP literal, then an optional port.
 * No userinfo, path, query, fragment, backslash, percent-escape, space or
 * non-ASCII. `URL.canParse` then refuses what the shape alone lets through:
 * a port over 65535, an invalid IPv4 or IPv6 literal.
 */
const HOST_RE = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** Stands in for an absent, empty or malformed Host. */
const FALLBACK_HOST = 'localhost';

/**
 * The absolute URL we hand Better Auth for one `/auth/*` request. This file
 * is the only place it is built.
 *
 * Its origin is not decoration (an older comment here said the hostname didn't
 * matter; it does). With no pinned `baseURL` (AX_PUBLIC_BASE_URL unset: kind,
 * local dev, tests), Better Auth takes its base URL, its trusted origin and the
 * OAuth `redirect_uri` from this URL's origin. So:
 *
 * - The scheme is http-server's `req.protocol`, the same decision that sets
 *   cookie `Secure`: `X-Forwarded-Proto` counts only under `AX_TRUST_PROXY=1`,
 *   and this function never reads it.
 * - The Host header is used only when it is a bare `host[:port]`. Anything else
 *   could make `new Request` throw, or move the path or query Better Auth
 *   routes on (`x/y`, `x?y`, `x#y`; an empty Host once gave `http:///auth/x`,
 *   which parses as host `auth`, path `/x`).
 *
 * An absent or empty Host means `localhost` and is not malformed: RFC 9110
 * allows an empty Host for a target with no authority. A malformed Host also
 * builds on `localhost`, and `malformedHost: true` tells the caller to refuse
 * the request.
 */
export function betterAuthUrl(req: BetterAuthUrlRequest): { url: string; malformedHost: boolean } {
  const raw = req.headers['host'];
  let host = FALLBACK_HOST;
  let malformedHost = false;
  if (raw !== undefined && raw !== '') {
    if (isWellFormedHost(raw)) host = raw;
    else malformedHost = true;
  }
  const queryString = serializeQuery(req.query);
  const url = `${req.protocol}://${host}${req.path}${queryString.length > 0 ? `?${queryString}` : ''}`;
  return { url, malformedHost };
}

function isWellFormedHost(host: string): boolean {
  return HOST_RE.test(host) && URL.canParse(`http://${host}`);
}

function serializeQuery(query: Record<string, string>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return pairs.join('&');
}
