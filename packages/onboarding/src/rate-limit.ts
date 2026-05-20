import { reject, type Rejection } from '@ax/core';

// ---------------------------------------------------------------------------
// In-memory token bucket for /setup/* endpoints.
//
// Onboarding tightens the budget to 5 wrong attempts per minute per IP
// because /setup/claim is a single-use surface — brute force on a 32-byte
// token is the primary threat model.
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Tokens per window. Task 2.5 fixes 5/min for /setup/claim. */
  tokensPerWindow: number;
  /** Window length in ms. Task 2.5 fixes 60_000 (= 1 minute). */
  windowMs: number;
  /**
   * Path predicate. Buckets only consume on matching paths so non-setup
   * traffic isn't rate-limited by this subscriber.
   */
  matchPath: (path: string) => boolean;
  /**
   * Cap on distinct buckets retained in memory. Older idle buckets are
   * evicted on insert when this is exceeded. Defaults to 10_000.
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
  const buckets = new Map<string, Bucket>();
  const now = config.now ?? (() => Date.now());
  const trustProxy = config.trustProxy ?? (() => process.env.AX_TRUST_PROXY === '1');
  const maxBuckets = config.maxBuckets ?? 10_000;
  const staleAfterMs = config.windowMs * 2;

  const refill = (b: Bucket, t: number): void => {
    const elapsed = t - b.refilledAt;
    if (elapsed <= 0) return;
    if (elapsed >= config.windowMs) {
      b.tokens = config.tokensPerWindow;
      b.refilledAt = t;
    }
  };

  const evictOverflow = (): void => {
    while (buckets.size > maxBuckets) {
      const oldest = buckets.keys().next();
      if (oldest.done === true) return;
      buckets.delete(oldest.value);
    }
  };

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
        buckets.delete(key);
        buckets.set(key, b);
      }

      if (b.tokens <= 0) {
        return reject({
          reason: 'rate-limited',
          source: '@ax/onboarding/rate-limit',
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
      const first = xff.split(',')[0]?.trim().toLowerCase();
      if (first !== undefined && first.length > 0) return `ip:${first}`;
    }
  }
  return 'local';
}
