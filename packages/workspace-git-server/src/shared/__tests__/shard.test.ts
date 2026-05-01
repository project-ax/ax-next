import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { shardForWorkspace, shardUrl } from '../shard.js';

describe('shardForWorkspace — determinism', () => {
  it('returns the same shard for the same input across 1000 calls', () => {
    const id = 'alice';
    const first = shardForWorkspace(id, 4);
    for (let i = 0; i < 1000; i++) {
      expect(shardForWorkspace(id, 4)).toBe(first);
    }
  });

  it('different inputs are independently deterministic', () => {
    const a = shardForWorkspace('a', 8);
    const b = shardForWorkspace('b', 8);
    expect(shardForWorkspace('a', 8)).toBe(a);
    expect(shardForWorkspace('b', 8)).toBe(b);
  });
});

describe('shardForWorkspace — range', () => {
  it.each([1, 2, 4, 8, 16])(
    'always returns a value in [0, %i) across 10000 random ids',
    (shards) => {
      for (let i = 0; i < 10_000; i++) {
        const result = shardForWorkspace(randomUUID(), shards);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(shards);
        expect(Number.isInteger(result)).toBe(true);
      }
    },
  );
});

describe('shardForWorkspace — distribution', () => {
  it('spreads 10000 random ids across 4 shards within ~5% of uniform', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 10_000; i++) {
      const idx = shardForWorkspace(randomUUID(), 4);
      counts[idx]!++;
    }
    // Uniform expectation is 2500 per shard; ±5% gives [2375, 2625]. We use
    // a slightly looser [2300, 2700] band per the slice spec to keep the
    // test robust against unlucky RNG draws — at this sample size SHA-256
    // truncation is uniform enough that even the loose band catches a
    // genuine modulo-bias regression but tolerates the natural variance of
    // a single 10k-sample run.
    for (const c of counts) {
      expect(c).toBeGreaterThanOrEqual(2300);
      expect(c).toBeLessThanOrEqual(2700);
    }
    // Sanity: counts sum to N, no off-by-one.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10_000);
  });
});

describe('shardForWorkspace — edge cases', () => {
  it('shards: 1 always returns 0', () => {
    for (let i = 0; i < 1000; i++) {
      expect(shardForWorkspace(randomUUID(), 1)).toBe(0);
    }
  });

  it('shards: 0 throws', () => {
    expect(() => shardForWorkspace('a', 0)).toThrow(
      /shards must be a positive integer/,
    );
  });

  it('shards: -1 throws', () => {
    expect(() => shardForWorkspace('a', -1)).toThrow(
      /shards must be a positive integer/,
    );
  });

  it('shards: 1.5 throws', () => {
    expect(() => shardForWorkspace('a', 1.5)).toThrow(
      /shards must be a positive integer/,
    );
  });

  it('shards: NaN throws', () => {
    expect(() => shardForWorkspace('a', Number.NaN)).toThrow(
      /shards must be a positive integer/,
    );
  });

  it('shards: Infinity throws', () => {
    expect(() => shardForWorkspace('a', Number.POSITIVE_INFINITY)).toThrow(
      /shards must be a positive integer/,
    );
  });
});

describe('shardUrl', () => {
  it('strips -headless suffix from serviceName when building pod DNS', () => {
    expect(
      shardUrl({
        serviceName: 'ax-next-git-server-headless',
        namespace: 'ax',
        port: 7780,
        shardIndex: 0,
      }),
    ).toBe(
      'http://ax-next-git-server-0.ax-next-git-server-headless.ax.svc.cluster.local:7780',
    );
  });

  it('uses the right ordinal in the pod-name segment', () => {
    expect(
      shardUrl({
        serviceName: 'ax-next-git-server-headless',
        namespace: 'ax',
        port: 7780,
        shardIndex: 3,
      }),
    ).toBe(
      'http://ax-next-git-server-3.ax-next-git-server-headless.ax.svc.cluster.local:7780',
    );
  });

  it('is a no-op replace when serviceName has no -headless suffix', () => {
    expect(
      shardUrl({
        serviceName: 'foo',
        namespace: 'ax',
        port: 7780,
        shardIndex: 0,
      }),
    ).toBe('http://foo-0.foo.ax.svc.cluster.local:7780');
  });

  it('respects custom namespace + port', () => {
    expect(
      shardUrl({
        serviceName: 'gs-headless',
        namespace: 'team-prod',
        port: 9090,
        shardIndex: 7,
      }),
    ).toBe('http://gs-7.gs-headless.team-prod.svc.cluster.local:9090');
  });
});
