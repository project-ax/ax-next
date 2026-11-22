/**
 * The bridge's rate limits: takes per (platform, app) on `/call`, takes per
 * platform on every route, and calls in flight per platform.
 *
 * The windows slide, in the shape of channel-web's per-user limiter
 * (src/server/per-user-rate-limit.ts, copied, not imported): a take frees up
 * exactly `windowMs` after it was spent. A refused take spends nothing.
 *
 * Memory is bounded: each window map tracks at most `maxTrackedKeys` keys.
 * When a map is full it sweeps expired keys first; if it is still full, a NEW
 * key is refused (a key already tracked is never refused for that reason).
 *
 * Keys are the platform id and the app id after they passed their grammars,
 * nothing else.
 */

export const APPS_BRIDGE_LIMITS = {
  perAppPerMinute: 120,
  perPlatformPerMinute: 600,
  maxInFlightPerPlatform: 32,
  windowMs: 60_000,
  maxTrackedKeys: 10_000,
} as const;

/** The limits as numbers: `typeof APPS_BRIDGE_LIMITS` is literal-typed (`as const`), so overrides use this. */
export type BridgeLimits = { [K in keyof typeof APPS_BRIDGE_LIMITS]: number };

export interface BridgeLimiter {
  takePlatform(platformId: string): boolean;
  takeApp(platformId: string, appId: string): boolean;
  /** A slot for one call in flight, or null at the cap. The release is idempotent. */
  acquire(platformId: string): (() => void) | null;
}

interface SlidingWindow {
  take(key: string): boolean;
}

function slidingWindow(limit: number, windowMs: number, maxKeys: number, now: () => number): SlidingWindow {
  /** key → the times of its takes still inside the window, oldest first. */
  const takes = new Map<string, number[]>();

  function recent(times: number[], cutoff: number): number[] {
    let i = 0;
    while (i < times.length && (times[i] ?? 0) <= cutoff) i++;
    return i === 0 ? times : times.slice(i);
  }

  function sweep(cutoff: number): void {
    for (const [key, times] of takes) {
      const kept = recent(times, cutoff);
      if (kept.length === 0) takes.delete(key);
      else takes.set(key, kept);
    }
  }

  return {
    take(key) {
      const t = now();
      const cutoff = t - windowMs;
      const existing = takes.get(key);
      if (existing === undefined) {
        if (takes.size >= maxKeys) sweep(cutoff);
        if (takes.size >= maxKeys) return false;
        if (limit < 1) return false;
        takes.set(key, [t]);
        return true;
      }
      const kept = recent(existing, cutoff);
      if (kept.length >= limit) {
        takes.set(key, kept);
        return false;
      }
      kept.push(t);
      takes.set(key, kept);
      return true;
    },
  };
}

export function createBridgeLimiter(
  opts: { now?: () => number; limits?: Partial<BridgeLimits> } = {},
): BridgeLimiter {
  const now = opts.now ?? Date.now;
  const l: BridgeLimits = { ...APPS_BRIDGE_LIMITS, ...opts.limits };
  const platforms = slidingWindow(l.perPlatformPerMinute, l.windowMs, l.maxTrackedKeys, now);
  const apps = slidingWindow(l.perAppPerMinute, l.windowMs, l.maxTrackedKeys, now);
  const inFlight = new Map<string, number>();

  return {
    takePlatform: (platformId) => platforms.take(platformId),
    // JSON keeps the pair unambiguous whatever the ids hold.
    takeApp: (platformId, appId) => apps.take(JSON.stringify([platformId, appId])),
    acquire(platformId) {
      const held = inFlight.get(platformId) ?? 0;
      if (held >= l.maxInFlightPerPlatform) return null;
      inFlight.set(platformId, held + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (inFlight.get(platformId) ?? 1) - 1;
        if (left <= 0) inFlight.delete(platformId);
        else inFlight.set(platformId, left);
      };
    },
  };
}
