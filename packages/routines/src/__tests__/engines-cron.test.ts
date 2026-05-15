import { describe, expect, it } from 'vitest';
import { cronEngine } from '../engines/cron.js';

describe('cronEngine', () => {
  it('returns next 02:00 NYC after a 2026-05-14T01:00Z reference', () => {
    // 01:00Z on 2026-05-14 is 21:00 NYC on 2026-05-13 (EDT in May).
    // Next 02:00 NYC is 2026-05-14 02:00 EDT = 2026-05-14T06:00Z.
    const from = new Date('2026-05-14T01:00:00Z');
    const next = cronEngine.nextRun(
      { kind: 'cron', expr: '0 2 * * *', tz: 'America/New_York' },
      from,
    );
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-05-14T06:00:00.000Z');
  });

  it('handles UTC tz', () => {
    const from = new Date('2026-05-14T01:30:00Z');
    const next = cronEngine.nextRun(
      { kind: 'cron', expr: '0 2 * * *', tz: 'UTC' },
      from,
    );
    expect(next!.toISOString()).toBe('2026-05-14T02:00:00.000Z');
  });

  it('returns null for non-cron spec (defensive)', () => {
    const from = new Date('2026-05-14T01:00:00Z');
    expect(cronEngine.nextRun({ kind: 'interval', every: '30m' }, from)).toBeNull();
  });

  it('returns null on a malformed cron (defensive — validator should reject)', () => {
    const from = new Date('2026-05-14T01:00:00Z');
    expect(cronEngine.nextRun(
      { kind: 'cron', expr: 'not a cron', tz: 'UTC' }, from,
    )).toBeNull();
  });

  it('schedulable: true', () => {
    expect(cronEngine.schedulable).toBe(true);
  });
});
