import { describe, expect, it } from 'vitest';
import { filterSensitive, filterSensitiveMulti } from '../sensitive-gate.js';

describe('filterSensitive', () => {
  it('rejects a fake Anthropic API key', () => {
    // Fake key — "sk-ant-" prefix + 40 random base62-ish chars. The pattern
    // intentionally matches the issued shape, not the value of any real key.
    const fact = 'My key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const result = filterSensitive(fact);
    expect(result.kept).toBe(false);
    expect(result.rejections.map((r) => r.kind)).toContain('anthropic-api-key');
  });

  it('rejects a fake AWS access key id', () => {
    const fact = 'AKIAIOSFODNN7EXAMPLE was rotated yesterday.';
    const result = filterSensitive(fact);
    expect(result.kept).toBe(false);
    expect(result.rejections.map((r) => r.kind)).toContain('aws-access-key');
  });

  it('rejects a JWT-shaped token', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = filterSensitive(`token: ${jwt}`);
    expect(result.kept).toBe(false);
    expect(result.rejections.map((r) => r.kind)).toContain('jwt');
  });

  it('rejects an email address', () => {
    const fact = 'reach me at jane.doe@example.com';
    const result = filterSensitive(fact);
    expect(result.kept).toBe(false);
    expect(result.rejections.map((r) => r.kind)).toContain('email');
  });

  it('rejects a US phone number', () => {
    const fact = 'call me at (415) 555-1234';
    const result = filterSensitive(fact);
    expect(result.kept).toBe(false);
    expect(result.rejections.map((r) => r.kind)).toContain('phone');
  });

  it('rejects "password=" assignments', () => {
    const fact = 'use password=hunter2 to log in';
    const result = filterSensitive(fact);
    expect(result.kept).toBe(false);
    expect(result.rejections.map((r) => r.kind)).toContain('password-assignment');
  });

  it('rejects "secret=" assignments', () => {
    const fact = 'export secret=topsecretvalue';
    const result = filterSensitive(fact);
    expect(result.kept).toBe(false);
    expect(result.rejections.map((r) => r.kind)).toContain('secret-assignment');
  });

  it('keeps a benign fact', () => {
    const fact = 'The user prefers React over Vue.';
    const result = filterSensitive(fact);
    expect(result.kept).toBe(true);
    expect(result.rejections).toEqual([]);
  });

  it('redacts short secrets in the excerpt — never returns the full match', () => {
    // Regression for PR #61 review: redactExcerpt used to return the raw
    // match if it was ≤ 12 chars, which leaked complete short
    // credentials into operator logs (a 6-char email, an 8-char
    // `secret=a`, a 10-char `password=a`). The fix always truncates.
    const samples = [
      { input: 'a@b.co', kind: 'email' as const },
      { input: 'secret=x', kind: 'secret-assignment' as const },
      { input: 'password=y', kind: 'password-assignment' as const },
    ];
    for (const { input, kind } of samples) {
      const result = filterSensitive(input);
      expect(result.kept).toBe(false);
      const hit = result.rejections.find((r) => r.kind === kind);
      expect(hit).toBeDefined();
      // The excerpt MUST NOT echo the full short input back.
      expect(hit!.excerpt).not.toBe(input);
      // ... and the bytes after the first 4 chars must not appear.
      expect(hit!.excerpt.slice(4)).toBe('…');
    }
  });

  it('reports every distinct violation in a single fact', () => {
    // I7 audit trail: the gate should not stop at the first match; we want
    // to see every category that fired so the rejection log is complete.
    const fact = 'email me at bob@example.com or call (212) 555-7890';
    const result = filterSensitive(fact);
    expect(result.kept).toBe(false);
    const kinds = result.rejections.map((r) => r.kind).sort();
    expect(kinds).toContain('email');
    expect(kinds).toContain('phone');
  });
});

describe('filterSensitiveMulti', () => {
  // TASK-219: extracted from the three hand-written "scan a few fields,
  // merge + dedupe kinds" blocks in observer.ts, tools/memory-note.ts, and
  // promotion.ts. These tests pin the contract those call sites rely on.

  it('reports a hit found in a later field', () => {
    const result = filterSensitiveMulti(['nothing here', 'AKIAIOSFODNN7EXAMPLE was rotated']);
    expect(result.kept).toBe(false);
    expect(result.kinds).toEqual(['aws-access-key']);
  });

  it('dedupes a kind that fires in two different fields to one entry', () => {
    const result = filterSensitiveMulti([
      'key sk-ant-XXXXXXXXXXXXXXXXXXXXX one',
      'key sk-ant-XXXXXXXXXXXXXXXXXXXXX two',
    ]);
    expect(result.kept).toBe(false);
    expect(result.kinds).toEqual(['anthropic-api-key']);
  });

  it('orders distinct kinds first-seen: field order, then pattern order within a field', () => {
    // Field 0 trips 'secret-assignment' (pattern index 6) and
    // 'anthropic-api-key' (pattern index 0) — within-field order must be
    // pattern-declaration order (anthropic first), THEN field 1's
    // 'email' (a kind not seen yet) appended after.
    const result = filterSensitiveMulti([
      'secret=shh and the key is sk-ant-XXXXXXXXXXXXXXXXXXXXX',
      'contact bob@example.com',
    ]);
    expect(result.kept).toBe(false);
    expect(result.kinds).toEqual(['anthropic-api-key', 'secret-assignment', 'email']);
  });

  it('returns kept:true with empty kinds when every field is clean', () => {
    const result = filterSensitiveMulti(['User prefers React.', 'Meeting is on Friday.']);
    expect(result).toEqual({ kept: true, kinds: [] });
  });

  it('returns kept:true for an empty field list', () => {
    expect(filterSensitiveMulti([])).toEqual({ kept: true, kinds: [] });
  });

  it('returns kept:true for a list of empty strings', () => {
    expect(filterSensitiveMulti(['', '', ''])).toEqual({ kept: true, kinds: [] });
  });

  it('does not let a field-boundary seam produce a false positive (no concatenation)', () => {
    // The historical bug this extraction removes from promotion.ts: joining
    // fields with '\n' let a field ending in "secret" and the next field
    // starting ": ..." cross-match secret-assignment. Per-field scanning has
    // no seam to cross.
    const result = filterSensitiveMulti(['the plan is still secret', ': rotation policy TBD']);
    expect(result).toEqual({ kept: true, kinds: [] });
  });
});
