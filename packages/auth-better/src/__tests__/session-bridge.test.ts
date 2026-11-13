import { describe, it, expect } from 'vitest';
import { APIError } from 'better-auth';
import {
  parseDomains,
  emailDomain,
  assertDomainAllowed,
  isDomainAllowed,
} from '../session-bridge.js';

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

// The one domain predicate. The Google sign-in gate (assertDomainAllowed) and
// auth:find-user-by-email both answer through it, so the two can't drift.
describe('isDomainAllowed', () => {
  it('allows any email when the list is empty (blank = open, as at sign-in)', () => {
    expect(isDomainAllowed('x@anywhere.com', [])).toBe(true);
  });
  it('matches the domain case-insensitively', () => {
    expect(isDomainAllowed('X@Example.COM', ['example.com'])).toBe(true);
  });
  it('rejects an out-of-list domain', () => {
    expect(isDomainAllowed('x@evil.com', ['example.com'])).toBe(false);
  });
  it('rejects a subdomain of a listed domain (the match is exact)', () => {
    expect(isDomainAllowed('x@eng.example.com', ['example.com'])).toBe(false);
  });
  it('rejects an address with no domain', () => {
    expect(isDomainAllowed('garbage', ['example.com'])).toBe(false);
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
