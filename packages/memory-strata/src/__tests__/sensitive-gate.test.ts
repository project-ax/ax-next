import { describe, expect, it } from 'vitest';
import { filterSensitive } from '../sensitive-gate.js';

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
