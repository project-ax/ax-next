import { describe, expect, it } from 'vitest';
import {
  buildRoutineMd,
  parseRoutineFrontmatter,
  type RoutineFrontmatterFields,
} from '../frontmatter.js';

/**
 * buildRoutineMd is the form→markdown half of the round-trip the form-first
 * RoutineEditor relies on. The contract: parse(build(fields)) deep-equals the
 * original fields for every modeled shape. The parser is strict (no unknown-key
 * passthrough), so the round-trip is lossless on modeled fields.
 */
describe('buildRoutineMd — round-trips through parseRoutineFrontmatter', () => {
  function roundTrip(fields: RoutineFrontmatterFields): RoutineFrontmatterFields {
    const md = buildRoutineMd(fields);
    const parsed = parseRoutineFrontmatter(md);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(`build produced unparseable md: ${parsed.reason}`);
    return parsed.fields;
  }

  it('round-trips a minimal interval routine (default silenceMaxChars)', () => {
    const fields: RoutineFrontmatterFields = {
      name: 'heartbeat',
      description: 'Periodic check',
      trigger: { kind: 'interval', every: '30m' },
      silenceMaxChars: 300,
      conversation: 'per-fire',
      promptBody: '# Prompt body\nhello',
    };
    expect(roundTrip(fields)).toEqual(fields);
  });

  it('omits silenceMaxChars from the markdown when it equals the parser default (300)', () => {
    const md = buildRoutineMd({
      name: 'heartbeat',
      description: 'Periodic check',
      trigger: { kind: 'interval', every: '1h' },
      silenceMaxChars: 300,
      conversation: 'shared',
      promptBody: 'body',
    });
    expect(md).not.toContain('silenceMaxChars');
  });

  it('emits silenceMaxChars when it is non-default', () => {
    const fields: RoutineFrontmatterFields = {
      name: 'heartbeat',
      description: 'Periodic check',
      trigger: { kind: 'interval', every: '5m' },
      silenceMaxChars: 1000,
      conversation: 'per-fire',
      promptBody: 'body',
    };
    const md = buildRoutineMd(fields);
    expect(md).toContain('silenceMaxChars');
    expect(roundTrip(fields)).toEqual(fields);
  });

  it('round-trips a cron routine with tz', () => {
    const fields: RoutineFrontmatterFields = {
      name: 'nightly-triage',
      description: 'nightly bug triage',
      trigger: { kind: 'cron', expr: '0 2 * * *', tz: 'America/New_York' },
      silenceMaxChars: 300,
      conversation: 'shared',
      promptBody: 'Triage the overnight bugs.',
    };
    expect(roundTrip(fields)).toEqual(fields);
  });

  it('round-trips a webhook routine with path, events and hmac', () => {
    const fields: RoutineFrontmatterFields = {
      name: 'gh-webhook',
      description: 'react to GitHub pushes',
      trigger: {
        kind: 'webhook',
        path: '/gh/push',
        events: ['push', 'pull_request'],
        hmac: {
          secretRef: 'routine:agt_x:.ax/routines/gh-webhook.md:hmac',
          header: 'X-Hub-Signature-256',
          algorithm: 'sha256',
          prefix: 'sha256=',
        },
      },
      silenceMaxChars: 300,
      conversation: 'per-fire',
      promptBody: 'Handle the webhook payload.',
    };
    expect(roundTrip(fields)).toEqual(fields);
  });

  it('round-trips a webhook routine with a bare path (no events/hmac)', () => {
    const fields: RoutineFrontmatterFields = {
      name: 'simple-hook',
      description: 'minimal webhook',
      trigger: { kind: 'webhook', path: '/hook' },
      silenceMaxChars: 300,
      conversation: 'per-fire',
      promptBody: 'go',
    };
    expect(roundTrip(fields)).toEqual(fields);
  });

  it('round-trips optional activeHours and silenceToken', () => {
    const fields: RoutineFrontmatterFields = {
      name: 'daytime-digest',
      description: 'digest during work hours',
      trigger: { kind: 'interval', every: '2h' },
      activeHours: { start: '09:00', end: '17:00', tz: 'America/New_York' },
      silenceToken: 'NOTHING_TO_REPORT',
      silenceMaxChars: 300,
      conversation: 'shared',
      promptBody: 'Summarize.',
    };
    expect(roundTrip(fields)).toEqual(fields);
  });

  it('omits activeHours and silenceToken from the markdown when unset', () => {
    const md = buildRoutineMd({
      name: 'x',
      description: 'y',
      trigger: { kind: 'interval', every: '1h' },
      silenceMaxChars: 300,
      conversation: 'per-fire',
      promptBody: 'z',
    });
    expect(md).not.toContain('activeHours');
    expect(md).not.toContain('silenceToken');
  });
});
