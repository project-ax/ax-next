// ---------------------------------------------------------------------------
// @ax/channel-web — a per-person sliding-window limiter.
//
// Each person gets `limit` takes in any `windowMs`; the window slides, so a
// take frees up exactly `windowMs` after it was spent, not at a fixed minute
// boundary. Same shape as the mcp-oauth discovery limiter (routes.ts).
//
// Memory is bounded: at most `maxUsers` people are tracked. When the map is
// full, expired people are swept out first; if it is still full, a NEW person
// is refused (better a busy host says "wait a minute" than grows without end).
// Someone already tracked is never refused for that reason.
//
// The key is the person's id, nothing else — never a path or a code.
// ---------------------------------------------------------------------------

export interface PerUserRateLimiterOptions {
  limit: number;
  windowMs: number;
  maxUsers: number;
  now?: () => number;
}

export interface PerUserRateLimiter {
  /** Spend one take for this person. False means they are over the limit. */
  take(userId: string): boolean;
}

export function createPerUserRateLimiter(o: PerUserRateLimiterOptions): PerUserRateLimiter {
  const now = o.now ?? Date.now;
  /** person → the times of their takes still inside the window, oldest first. */
  const takes = new Map<string, number[]>();

  function recent(times: number[], cutoff: number): number[] {
    let i = 0;
    while (i < times.length && (times[i] ?? 0) <= cutoff) i++;
    return i === 0 ? times : times.slice(i);
  }

  function sweep(cutoff: number): void {
    for (const [id, times] of takes) {
      const kept = recent(times, cutoff);
      if (kept.length === 0) takes.delete(id);
      else takes.set(id, kept);
    }
  }

  return {
    take(userId: string): boolean {
      const t = now();
      const cutoff = t - o.windowMs;
      const existing = takes.get(userId);
      if (existing === undefined) {
        if (takes.size >= o.maxUsers) sweep(cutoff);
        if (takes.size >= o.maxUsers) return false;
        if (o.limit < 1) return false;
        takes.set(userId, [t]);
        return true;
      }
      const kept = recent(existing, cutoff);
      if (kept.length >= o.limit) {
        takes.set(userId, kept);
        return false;
      }
      kept.push(t);
      takes.set(userId, kept);
      return true;
    },
  };
}
