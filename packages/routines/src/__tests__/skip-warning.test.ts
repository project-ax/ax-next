import { describe, expect, it } from 'vitest';
import { buildSkipWarning, SKIP_WARNING_MAX } from '../skip-warning.js';

describe('buildSkipWarning (slice 6)', () => {
  it('nothing skipped → null', () => {
    expect(buildSkipWarning('Bob', [])).toBeNull();
  });

  it('one connector, not signed in', () => {
    expect(buildSkipWarning('Bob', [{ name: 'Gmail', reason: 'not-signed-in' }]))
      .toBe("Gmail isn't signed in on Bob, so this run went without it.");
  });

  it('one connector, needs to be signed in again', () => {
    expect(buildSkipWarning('Bob', [{ name: 'Gmail', reason: 'needs-reconnect' }]))
      .toBe('Gmail needs to be signed in again on Bob, so this run went without it.');
  });

  it('two connectors, same reason', () => {
    expect(buildSkipWarning('Bob', [
      { name: 'Gmail', reason: 'not-signed-in' },
      { name: 'Linear', reason: 'not-signed-in' },
    ])).toBe("Gmail and Linear aren't signed in on Bob, so this run went without them.");
    expect(buildSkipWarning('Bob', [
      { name: 'Gmail', reason: 'needs-reconnect' },
      { name: 'Linear', reason: 'needs-reconnect' },
    ])).toBe('Gmail and Linear need to be signed in again on Bob, so this run went without them.');
  });

  it('three connectors read "A, B and C"', () => {
    expect(buildSkipWarning('Bob', [
      { name: 'Gmail', reason: 'not-signed-in' },
      { name: 'Linear', reason: 'not-signed-in' },
      { name: 'Slack', reason: 'not-signed-in' },
    ])).toBe("Gmail, Linear and Slack aren't signed in on Bob, so this run went without them.");
  });

  it('mixed reasons: two sentences, the not-signed-in one first', () => {
    expect(buildSkipWarning('Bob', [
      { name: 'Linear', reason: 'needs-reconnect' },
      { name: 'Gmail', reason: 'not-signed-in' },
    ])).toBe(
      "Gmail isn't signed in on Bob, so this run went without it. "
      + 'Linear needs to be signed in again on Bob, so this run went without it.',
    );
  });

  it('a null or blank agent name reads "this agent"', () => {
    expect(buildSkipWarning(null, [{ name: 'Gmail', reason: 'not-signed-in' }]))
      .toBe("Gmail isn't signed in on this agent, so this run went without it.");
    expect(buildSkipWarning(' ‮\n ', [{ name: 'Gmail', reason: 'not-signed-in' }]))
      .toBe("Gmail isn't signed in on this agent, so this run went without it.");
  });

  it('a hostile name: control, format and bidi characters stripped, whitespace collapsed', () => {
    const out = buildSkipWarning('Bo​b\u0007', [
      { name: '  Gm\nail‮⁦  \t x ', reason: 'not-signed-in' },
    ]);
    expect(out).toBe("Gm ail x isn't signed in on Bo b, so this run went without it.");
    expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('a name that sanitizes to nothing is dropped; all dropped → null', () => {
    expect(buildSkipWarning('Bob', [{ name: '‮\n', reason: 'not-signed-in' }])).toBeNull();
    expect(buildSkipWarning('Bob', [
      { name: '‮', reason: 'not-signed-in' },
      { name: 'Gmail', reason: 'not-signed-in' },
    ])).toBe("Gmail isn't signed in on Bob, so this run went without it.");
  });

  it('the same name twice under one reason is listed once', () => {
    expect(buildSkipWarning('Bob', [
      { name: 'Gmail', reason: 'not-signed-in' },
      { name: 'Gmail', reason: 'not-signed-in' },
    ])).toBe("Gmail isn't signed in on Bob, so this run went without it.");
  });

  it('caps the whole warning at 300 characters', () => {
    expect(SKIP_WARNING_MAX).toBe(300);
    const long = `${'G'.repeat(500)}\n‮`;
    const out = buildSkipWarning('A'.repeat(500), [
      { name: long, reason: 'not-signed-in' },
      { name: `${long}2`, reason: 'needs-reconnect' },
    ])!;
    expect(Array.from(out).length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('the cap never splits a surrogate pair', () => {
    const out = buildSkipWarning('Bob', Array.from({ length: 40 }, (_, i) => ({
      name: `😀😀😀😀😀😀 ${i}`, reason: 'not-signed-in' as const,
    })))!;
    expect(Array.from(out).length).toBeLessThanOrEqual(300);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
