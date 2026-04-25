import { reject, type Rejection } from '@ax/core';

// ---------------------------------------------------------------------------
// In-memory token bucket for /auth/* endpoints.
//
// Why this lives here (not @ax/http-server): rate-limit posture is a per-
// route concern, and @ax/http-server is supposed to stay tenant-blind.
// Auth registers a path-scoped http:request subscriber that consumes a
// token from a bucket keyed by request IP.
//
// Multi-replica caveat: this is a single-process bucket. Multi-replica
// rate-limit coordination is deferred to Week 13+ (eventbus-postgres). For
// MVP, a per-pod bucket is "better than nothing" — see plan §Out of scope.
//
// IP-source rule (mirrors http-server's trust-proxy gate):
//   - AX_TRUST_PROXY=1 → first value of x-forwarded-for, lowercased + trimmed
//   - else            → fixed key 'local' (single shared bucket; degraded
//                       but safe — refuses pinning on unattributed traffic)
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Tokens per window. Plan §Task 4 fixes 30/min. */
  tokensPerWindow: number;
  /** Window length in ms. Plan §Task 4 fixes 60_000 (= 1 minute). */
  windowMs: number;
  /**
   * Path predicate. Buckets only consume on matching paths so non-auth
   * traffic isn't rate-limited by this subscriber.
   */
  matchPath: (path: string) => boolean;
  /**
   * Test seam — defaults to Date.now. Lets unit tests advance time without
   * sleeping.
   */
  now?: () => number;
  /**
   * Test seam — defaults to reading process.env.AX_TRUST_PROXY. Returning
   * true makes the limiter key off x-forwarded-for; otherwise 'local'.
   */
  trustProxy?: () => boolean;
}

interface Bucket {
  tokens: number;
  /** Wall-clock ms when the bucket was last refilled. */
  refilledAt: number;
}

export interface RateLimiter {
  /**
   * Returns null if the request is allowed (and one token consumed); a
   * Rejection otherwise. Header lookup is case-insensitive — the http-server
   * already lowercases keys, so we only read the lowercased name.
   */
  check(headers: Record<string, string>, path: string): Rejection | null;
  /** Test seam — clear all buckets between cases. */
  reset(): void;
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const now = config.now ?? (() => Date.now());
  const trustProxy = config.trustProxy ?? (() => process.env.AX_TRUST_PROXY === '1');

  const refill = (b: Bucket, t: number): void => {
    const elapsed = t - b.refilledAt;
    if (elapsed <= 0) return;
    // Full-window refill: simpler than a leaky token-per-ms drip and
    // matches the "30 requests / 1 minute" mental model the plan uses.
    if (elapsed >= config.windowMs) {
      b.tokens = config.tokensPerWindow;
      b.refilledAt = t;
    }
  };

  return {
    check(headers, path) {
      if (!config.matchPath(path)) return null;

      const key = deriveKey(headers, trustProxy());
      const t = now();
      let b = buckets.get(key);
      if (b === undefined) {
        b = { tokens: config.tokensPerWindow, refilledAt: t };
        buckets.set(key, b);
      } else {
        refill(b, t);
      }

      if (b.tokens <= 0) {
        return reject({
          reason: 'rate-limited',
          source: '@ax/auth/rate-limit',
        });
      }
      b.tokens -= 1;
      return null;
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * Derive a bucket key from request headers. Exported for unit testing the
 * fallback behavior — production callers go through `check`.
 */
export function deriveKey(
  headers: Record<string, string>,
  trustProxyEnabled: boolean,
): string {
  if (trustProxyEnabled) {
    const xff = headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      // Comma-separated chain; the first value is the client closest to
      // the original requester. Trim aggressively — quoted IPv6 and
      // RFC-7239 obfuscated forms aren't supported, but we lowercase to
      // collapse case-different repeats of the same address.
      const first = xff.split(',')[0]?.trim().toLowerCase();
      if (first !== undefined && first.length > 0) return `ip:${first}`;
    }
  }
  // Single-bucket fallback. Also see plan §Out of scope: multi-replica
  // promotion is post-MVP.
  return 'local';
}
