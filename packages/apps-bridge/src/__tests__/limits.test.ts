import { describe, expect, it } from 'vitest';
import { APPS_BRIDGE_LIMITS, createBridgeLimiter } from '../limits.js';

const P = 'canopy';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('bridge limiter', () => {
  it('has the global constraints as defaults', () => {
    expect(APPS_BRIDGE_LIMITS).toEqual({
      perAppPerMinute: 120,
      perPlatformPerMinute: 600,
      maxInFlightPerPlatform: 32,
      windowMs: 60_000,
      maxTrackedKeys: 10_000,
    });
  });

  it('per-app and per-platform windows slide', () => {
    const c = clock();
    const l = createBridgeLimiter({ now: c.now });

    // Per app: 120 takes inside a minute, then refused.
    const first = c.now();
    for (let i = 0; i < 120; i++) {
      expect(l.takeApp(P, 'app_a')).toBe(true);
      c.advance(100);
    }
    expect(l.takeApp(P, 'app_a')).toBe(false);
    // Another app has its own window.
    expect(l.takeApp(P, 'app_b')).toBe(true);
    // Another platform's app of the same id too.
    expect(l.takeApp('other', 'app_a')).toBe(true);
    // Still refused just before the first take leaves the window...
    c.advance(first + 60_000 - c.now() - 1);
    expect(l.takeApp(P, 'app_a')).toBe(false);
    // ...and allowed once it has (exactly one slot freed).
    c.advance(1);
    expect(l.takeApp(P, 'app_a')).toBe(true);
    expect(l.takeApp(P, 'app_a')).toBe(false);

    // Per platform: 600 a minute, sliding the same way.
    const c2 = clock();
    const l2 = createBridgeLimiter({ now: c2.now });
    const start = c2.now();
    for (let i = 0; i < 600; i++) {
      expect(l2.takePlatform(P)).toBe(true);
      c2.advance(10);
    }
    expect(l2.takePlatform(P)).toBe(false);
    expect(l2.takePlatform('other')).toBe(true);
    c2.advance(start + 60_000 - c2.now() - 1);
    expect(l2.takePlatform(P)).toBe(false);
    c2.advance(1);
    expect(l2.takePlatform(P)).toBe(true);
    expect(l2.takePlatform(P)).toBe(false);
  });

  it('a refused take spends nothing', () => {
    const c = clock();
    const l = createBridgeLimiter({ now: c.now, limits: { perAppPerMinute: 2 } });
    expect(l.takeApp(P, 'a')).toBe(true);
    expect(l.takeApp(P, 'a')).toBe(true);
    c.advance(30_000);
    for (let i = 0; i < 50; i++) expect(l.takeApp(P, 'a')).toBe(false);
    c.advance(30_000);
    // Both original takes left the window; the refusals never counted.
    expect(l.takeApp(P, 'a')).toBe(true);
    expect(l.takeApp(P, 'a')).toBe(true);
    expect(l.takeApp(P, 'a')).toBe(false);
  });

  it('in-flight slots are capped and released once', () => {
    const l = createBridgeLimiter();
    const releases: Array<() => void> = [];
    for (let i = 0; i < 32; i++) {
      const r = l.acquire(P);
      expect(r).not.toBeNull();
      releases.push(r as () => void);
    }
    expect(l.acquire(P)).toBeNull();
    // Another platform has its own cap.
    expect(l.acquire('other')).not.toBeNull();

    const one = releases[0] as () => void;
    one();
    one(); // idempotent: frees one slot, not two
    expect(l.acquire(P)).not.toBeNull();
    expect(l.acquire(P)).toBeNull();

    // Releasing everything frees everything.
    for (const r of releases) r();
    let got = 0;
    while (l.acquire(P) !== null) got++;
    expect(got).toBe(31); // 32 minus the slot still held from above
  });

  it('tracked keys are bounded', () => {
    const c = clock();
    const l = createBridgeLimiter({ now: c.now, limits: { maxTrackedKeys: 2 } });
    expect(l.takeApp(P, 'one')).toBe(true);
    c.advance(1_000);
    expect(l.takeApp(P, 'two')).toBe(true);
    // A third app is refused: the map is full and nothing has expired.
    expect(l.takeApp(P, 'three')).toBe(false);
    // An app already tracked is never refused for that reason.
    expect(l.takeApp(P, 'one')).toBe(true);
    // Both were last taken at +1 s: just before that leaves the window the
    // map is still full; once it has, the sweep makes room.
    c.advance(59_999);
    expect(l.takeApp(P, 'three')).toBe(false);
    c.advance(1);
    expect(l.takeApp(P, 'three')).toBe(true);

    // Platforms are bounded the same way.
    const c2 = clock();
    const l2 = createBridgeLimiter({ now: c2.now, limits: { maxTrackedKeys: 2 } });
    expect(l2.takePlatform('p1')).toBe(true);
    expect(l2.takePlatform('p2')).toBe(true);
    expect(l2.takePlatform('p3')).toBe(false);
    c2.advance(60_000);
    expect(l2.takePlatform('p3')).toBe(true);
  });

  it('app keys cannot collide across platforms by joining strings', () => {
    const l = createBridgeLimiter({ limits: { perAppPerMinute: 1 } });
    expect(l.takeApp('a', 'b_c')).toBe(true);
    expect(l.takeApp('a_b', 'c')).toBe(true);
    expect(l.takeApp('a', 'b_c')).toBe(false);
  });
});
