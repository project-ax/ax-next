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

  it('rejects non-UTF-8 bytes', () => {
    const r = parseRoutineFrontmatterBytes(new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/UTF-8/);
  });
});

describe('parseRoutineFrontmatter — webhook trigger', () => {
  it('parses a minimal webhook routine (no events, no hmac)', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: pr-triage',
      'description: PR triage',
      'trigger:',
      '  kind: webhook',
      '  path: "/r/github"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.trigger).toEqual({
      kind: 'webhook', path: '/r/github',
    });
  });

  it('parses webhook with events filter', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: pr', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/gh"',
      '  events: ["pull_request", "issues"]',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.trigger).toEqual({
      kind: 'webhook', path: '/r/gh', events: ['pull_request', 'issues'],
    });
  });

  it('parses webhook with full hmac config', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: pr', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/gh"',
      '  hmac:',
      '    secretRef: gh-secret',
      '    header: "X-Hub-Signature-256"',
      '    algorithm: sha256',
      '    prefix: "sha256="',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.trigger).toEqual({
      kind: 'webhook', path: '/r/gh',
      hmac: {
        secretRef: 'gh-secret',
        header: 'X-Hub-Signature-256',
        algorithm: 'sha256',
        prefix: 'sha256=',
      },
    });
  });

  it('defaults hmac.algorithm to sha256 when omitted', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: pr', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      '  hmac:', '    secretRef: s', '    header: "X-Sig"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.fields.trigger.kind !== 'webhook') throw new Error('kind');
    expect(r.fields.trigger.hmac?.algorithm).toBe('sha256');
  });

  it.each([
    ['missing path', ['name: a', 'description: d', 'trigger:', '  kind: webhook', 'conversation: per-fire']],
    ['empty path', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: ""', 'conversation: per-fire']],
    ['path missing leading slash', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: "r/x"', 'conversation: per-fire']],
    ['path starts with /webhooks/', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: "/webhooks/leak"', 'conversation: per-fire']],
    ['path contains ..', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: "/r/../etc"', 'conversation: per-fire']],
    ['path contains //', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: "/r//x"', 'conversation: per-fire']],
    ['path too long', ['name: a', 'description: d', 'trigger:', '  kind: webhook', `  path: "/${'a'.repeat(128)}"`, 'conversation: per-fire']],
  ])('rejects webhook %s', (_label, lines) => {
    const r = parseRoutineFrontmatter(fm(lines.join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects events item with illegal characters', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      '  events: ["has space"]',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects more than 32 events', () => {
    const events = Array.from({ length: 33 }, (_, i) => `evt${i}`);
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      `  events: ${JSON.stringify(events)}`,
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects hmac missing secretRef', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      '  hmac:', '    header: "X-Sig"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects hmac missing header', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      '  hmac:', '    secretRef: s',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects hmac.algorithm not in sha256/sha1', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      '  hmac:', '    secretRef: s', '    header: "X-Sig"',
      '    algorithm: md5',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects activeHours on webhook routines', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      'activeHours:',
      '  start: "08:00"', '  end: "18:00"', '  tz: "UTC"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });
});
