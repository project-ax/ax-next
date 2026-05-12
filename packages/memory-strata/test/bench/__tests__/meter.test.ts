import { describe, it, expect } from 'vitest';
import { CostMeter, type Pricing } from '../meter.js';

const pricing: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
  'zembed-1': { in: 0.05 / 1_000_000, out: 0 },
  'zerank-2': { in: 0.1 / 1_000_000, out: 0 },
};

describe('CostMeter', () => {
  it('accumulates spend by model', () => {
    const m = new CostMeter({ capDollars: 50, pricing });
    m.record('claude-sonnet-4-6', { in: 1_000_000, out: 1_000_000 });
    expect(m.totalDollars()).toBeCloseTo(18, 5);
  });

  it('projectWouldExceedCap returns true above cap', () => {
    const m = new CostMeter({ capDollars: 1, pricing });
    m.record('claude-sonnet-4-6', { in: 100_000, out: 100_000 });
    expect(m.projectWouldExceedCap('claude-sonnet-4-6', { in: 1_000_000, out: 1_000_000 })).toBe(true);
  });

  it('projectWouldExceedCap returns false below cap', () => {
    const m = new CostMeter({ capDollars: 50, pricing });
    expect(m.projectWouldExceedCap('claude-sonnet-4-6', { in: 1_000, out: 1_000 })).toBe(false);
  });

  it('snapshot returns per-model totals', () => {
    const m = new CostMeter({ capDollars: 50, pricing });
    m.record('claude-sonnet-4-6', { in: 1_000_000, out: 0 });
    m.record('x-ai/grok-4.3', { in: 1_000_000, out: 0 });
    const snap = m.snapshot();
    expect(snap['claude-sonnet-4-6']!.dollars).toBeCloseTo(3, 5);
    expect(snap['x-ai/grok-4.3']!.dollars).toBeCloseTo(1.25, 5);
  });
});
