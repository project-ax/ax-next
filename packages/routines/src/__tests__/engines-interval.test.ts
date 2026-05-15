import { describe, expect, it } from 'vitest';
import { intervalEngine } from '../engines/interval.js';

describe('intervalEngine', () => {
  it('advances by 30m', () => {
    const from = new Date('2026-05-14T12:00:00Z');
    const next = intervalEngine.nextRun({ kind: 'interval', every: '30m' }, from);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-05-14T12:30:00.000Z');
  });

  it('advances by 1h', () => {
    const from = new Date('2026-05-14T12:00:00Z');
    const next = intervalEngine.nextRun({ kind: 'interval', every: '1h' }, from);
    expect(next!.toISOString()).toBe('2026-05-14T13:00:00.000Z');
  });

  it('advances by 1d', () => {
    const from = new Date('2026-05-14T12:00:00Z');
    const next = intervalEngine.nextRun({ kind: 'interval', every: '1d' }, from);
    expect(next!.toISOString()).toBe('2026-05-15T12:00:00.000Z');
  });

  it('returns null for unparseable every (defensive — validator should reject)', () => {
    const from = new Date('2026-05-14T12:00:00Z');
    const next = intervalEngine.nextRun({ kind: 'interval', every: 'bad' }, from);
    expect(next).toBeNull();
  });

  it('schedulable: true', () => {
    expect(intervalEngine.schedulable).toBe(true);
  });
});
