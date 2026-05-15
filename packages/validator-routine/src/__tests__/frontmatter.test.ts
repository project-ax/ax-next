import { describe, expect, it } from 'vitest';
import {
  parseRoutineFrontmatter,
  parseRoutineFrontmatterBytes,
} from '../frontmatter.js';

function fm(body: string): string {
  return `---\n${body}\n---\n# Prompt body\nhello\n`;
}

describe('parseRoutineFrontmatter — happy paths', () => {
  it('parses an interval routine', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: heartbeat',
      'description: Periodic check',
      'trigger:',
      '  kind: interval',
      '  every: "30m"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.name).toBe('heartbeat');
    expect(r.fields.trigger).toEqual({ kind: 'interval', every: '30m' });
    expect(r.fields.conversation).toBe('per-fire');
    expect(r.fields.promptBody.trim()).toBe('# Prompt body\nhello');
  });

  it('parses a cron routine with tz', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: nightly-bug-triage',
      'description: nightly',
      'trigger:',
      '  kind: cron',
      '  expr: "0 2 * * *"',
      '  tz: "America/New_York"',
      'conversation: shared',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.trigger).toEqual({
      kind: 'cron',
      expr: '0 2 * * *',
      tz: 'America/New_York',
    });
  });

  it('parses optional activeHours / silenceToken / silenceMaxChars', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r',
      'description: d',
      'trigger:',
      '  kind: interval',
      '  every: "60s"',
      'activeHours:',
      '  start: "08:00"',
      '  end: "18:00"',
      '  tz: "America/New_York"',
      'silenceToken: "HEARTBEAT_OK"',
      'silenceMaxChars: 200',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.activeHours).toEqual({
      start: '08:00', end: '18:00', tz: 'America/New_York',
    });
    expect(r.fields.silenceToken).toBe('HEARTBEAT_OK');
    expect(r.fields.silenceMaxChars).toBe(200);
  });

  it('defaults conversation to per-fire and silenceMaxChars to 300', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r',
      'description: d',
      'trigger:',
      '  kind: interval',
      '  every: "60s"',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.conversation).toBe('per-fire');
    expect(r.fields.silenceMaxChars).toBe(300);
  });
});

describe('parseRoutineFrontmatter — vetoes', () => {
  it('rejects missing frontmatter', () => {
    const r = parseRoutineFrontmatter('# just a body\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/frontmatter/);
  });

  it('rejects malformed YAML', () => {
    const r = parseRoutineFrontmatter('---\nname: : bad\n---\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/yaml/i);
  });

  it('rejects missing name', () => {
    const r = parseRoutineFrontmatter(fm([
      'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/name/);
  });

  it('rejects missing description', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r',
      'trigger:', '  kind: interval', '  every: "60s"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/description/);
  });

  it('rejects missing trigger', () => {
    const r = parseRoutineFrontmatter(fm(['name: r', 'description: d'].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/trigger/);
  });

  it('rejects unknown trigger kind', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: never', '  every: "60s"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/trigger\.kind/);
  });

  it('rejects interval with sub-minute "every" (60s minimum)', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: interval', '  every: "10s"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/60s|minimum/i);
  });

  it('rejects interval missing every', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d', 'trigger:', '  kind: interval',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/every/);
  });

  it('rejects cron with no tz', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: cron', '  expr: "0 2 * * *"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/tz/);
  });

  it('rejects cron with malformed expr', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: cron',
      '  expr: "not a cron expr"', '  tz: "UTC"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cron/i);
  });

  it('rejects webhook trigger kind in Phase B (Phase C ships it)', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: r', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/x"',
    ].join('\n')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/webhook/i);
    expect(r.reason).toMatch(/Phase C|not yet supported/i);
  });

  it('rejects non-UTF-8 bytes', () => {
    const r = parseRoutineFrontmatterBytes(new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/UTF-8/);
  });
});
