/**
 * TASK-906 — how often a proposed task checks in, in plain words.
 *
 * The approval card asks a person whether a task should start. "1h" and
 * "0 9 * * 1-5" are exact and opaque, so the card says what they mean, and
 * falls back to the raw expression rather than guessing when a cron is past
 * what `describeCron` will put into words.
 */
import { describe, expect, it } from 'vitest';
import type { RoutineTrigger } from '@ax/routines-contract';
import { describeCheckIns } from '../task-schedule';

describe('describeCheckIns', () => {
  it.each([
    ['15m', 'Runs every 15 minutes'],
    ['1h', 'Runs every hour'],
    ['1m', 'Runs every minute'],
    ['2d', 'Runs every 2 days'],
    ['900s', 'Runs every 900 seconds'],
    ['00060s', 'Runs every 60 seconds'],
  ])('says an interval of %s as "%s"', (every, text) => {
    expect(describeCheckIns({ kind: 'interval', every })).toBe(text);
  });

  it('describes a cron it can put into words, naming the timezone', () => {
    expect(describeCheckIns({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'America/New_York' })).toBe(
      'Runs at 9:00 AM, every weekday (America/New_York)',
    );
  });

  it('shows the raw expression for a cron it will not narrate', () => {
    expect(describeCheckIns({ kind: 'cron', expr: '*/20 9-17 * * 1-5', tz: 'UTC' })).toBe(
      'Custom schedule: */20 9-17 * * 1-5 (UTC)',
    );
  });

  it('has nothing to say about a webhook, which does not check in on a schedule', () => {
    expect(describeCheckIns({ kind: 'webhook', path: '/zendesk' })).toBeNull();
  });

  it('says nothing rather than guess at an interval it cannot read', () => {
    const unreadable = { kind: 'interval', every: 'soon' } as RoutineTrigger;
    expect(describeCheckIns(unreadable)).toBeNull();
  });
});
