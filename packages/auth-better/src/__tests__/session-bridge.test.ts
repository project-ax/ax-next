import { describe, it, expect } from 'vitest';
import { APIError } from 'better-auth';
import { parseDomains, emailDomain, assertDomainAllowed } from '../session-bridge.js';

describe('parseDomains', () => {
  it('splits comma-separated domains, trims + lowercases', () => {
    expect(parseDomains('Example.com, partner.org')).toEqual(['example.com','partner.org']);
  });
  it('returns [] for null/undefined/empty', () => {
    expect(parseDomains(null)).toEqual([]);
    expect(parseDomains(undefined)).toEqual([]);
    expect(parseDomains('   ')).toEqual([]);
  });
  it('drops empty entries from trailing/double commas', () => {
    expect(parseDomains('a.com,,b.com,')).toEqual(['a.com','b.com']);
  });
});

describe('emailDomain', () => {
  it('returns the lowercased domain after the last @', () => {
    expect(emailDomain('Alice@Example.COM')).toBe('example.com');
  });
  it('returns empty string when no @', () => {
    expect(emailDomain('garbage')).toBe('');
  });
  it('returns empty string for a trailing @ (no domain part)', () => {
    expect(emailDomain('user@')).toBe('');
  });
});

describe('assertDomainAllowed', () => {
  it('allows any email when the list is empty (open)', () => {
    expect(() => assertDomainAllowed('x@anywhere.com', [])).not.toThrow();
  });
  it('allows an in-list domain', () => {
    expect(() => assertDomainAllowed('x@example.com', ['example.com'])).not.toThrow();
  });
  it('rejects an out-of-list domain with a generic APIError', () => {
    expect(() => assertDomainAllowed('x@evil.com', ['example.com'])).toThrow(APIError);
    expect(() => assertDomainAllowed('x@evil.com', ['example.com'])).toThrow('email domain not permitted');
  });
});
