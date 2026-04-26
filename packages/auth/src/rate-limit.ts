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
   * Cap on distinct buckets retained in memory. Older idle buckets are
   * evicted on insert when this is exceeded. Defaults to 10_000 — covers
   * a small pool of attackers cycling proxies without unbounded growth.
   */
  maxBuckets?: number;
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
  // Map iteration order is insertion order, so re-inserting on access
  // gives us LRU-on-access for free. The first key returned by an iterator
  // is the oldest insert that hasn't been touched since.
  const buckets = new Map<string, Bucket>();
  const now = config.now ?? (() => Date.now());
  const trustProxy = config.trustProxy ?? (() => process.env.AX_TRUST_PROXY === '1');
  // 10_000 is enough to absorb realistic burst from a small attacker pool
  // (think NAT'd household, mid-sized office) without unbounded growth.
  // An attacker rotating x-forwarded-for to defeat the limiter just gets
  // their oldest bucket evicted — they don't get extra tokens.
  const maxBuckets = config.maxBuckets ?? 10_000;
  // Stale-bucket TTL: full-tokens AND idle for 2 windows means the bucket
  // is no longer usefully tracking anyone.
  const staleAfterMs = config.windowMs * 2;

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

  // Evict oldest entries down to maxBuckets. Map iteration is insertion-
  // order, so the first keys are the least-recently-(re)inserted.
  const evictOverflow = (): void => {
    while (buckets.size > maxBuckets) {
      const oldest = buckets.keys().next();
      if (oldest.done === true) return;
      buckets.delete(oldest.value);
    }
  };

  // Cheap opportunistic sweep: drop fully-refilled idle buckets on access.
  // Bounded scan — at most 16 entries per check — so a hot path stays O(1).
  const sweepStale = (t: number): void => {
    let scanned = 0;
    for (const [key, b] of buckets) {
      if (scanned >= 16) break;
      scanned++;
      if (b.tokens >= config.tokensPerWindow && t - b.refilledAt > staleAfterMs) {
        buckets.delete(key);
      }
    }
  };

  return {
    check(headers, path) {
      if (!config.matchPath(path)) return null;

      const key = deriveKey(headers, trustProxy());
      const t = now();
      sweepStale(t);
      let b = buckets.get(key);
      if (b === undefined) {
        b = { tokens: config.tokensPerWindow, refilledAt: t };
        buckets.set(key, b);
        evictOverflow();
      } else {
        refill(b, t);
        // Re-insert to bump LRU position. delete + set is the cheapest
        // way to move a key to the tail of insertion order.
        buckets.delete(key);
        buckets.set(key, b);
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
