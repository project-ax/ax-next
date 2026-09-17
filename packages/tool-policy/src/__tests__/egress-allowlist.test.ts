/**
 * TASK-330 — the egress allowlist's shape rules and its in-memory store.
 *
 * The store is where "the approver and the beneficiary are the same party"
 * stops being a sentence in a doc comment and becomes something a test can
 * fail on: one person's remembered host must never widen another person's
 * reach, and a global entry must be minted by nobody but an operator.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_USER_HOSTS,
  createMemoryEgressAllowlistStore,
  isOwnerId,
  normalizeHost,
} from '../egress-allowlist.js';

describe('normalizeHost', () => {
  it('accepts an ordinary hostname, lowercased and trimmed', () => {
    expect(normalizeHost('  Docs.Example.COM  ')).toBe('docs.example.com');
  });

  it('accepts a bare label and an IPv4 literal', () => {
    // A public IPv4 target is still subject to the SSRF guard above, which is
    // what refuses the private ranges. This layer only decides what may be
    // WRITTEN DOWN.
    expect(normalizeHost('localhost')).toBe('localhost');
    expect(normalizeHost('93.184.216.34')).toBe('93.184.216.34');
  });

  it('refuses anything that is not a bare hostname', () => {
    // Every one of these is a way an allowlist entry could end up matching more
    // than the one host somebody meant — or matching nothing while looking like
    // it matches something.
    for (const bad of [
      'https://example.com', // a scheme
      'example.com/path', // a path
      'example.com:443', // a port
      'example.com?q=1', // a query
      '*.example.com', // a wildcard
      'example.com.', // a trailing dot: rejected, not stripped — see the doc
      '-example.com', // a label may not start with a hyphen
      'exam ple.com',
      '',
      '   ',
      `${'a'.repeat(254)}.com`, // over 253 characters
      'exämple.com', // non-ASCII; URL hands us punycode, so this never occurs
    ]) {
      expect(normalizeHost(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses a non-string without throwing', () => {
    for (const bad of [undefined, null, 42, {}, ['example.com']]) {
      expect(normalizeHost(bad)).toBeNull();
    }
  });
});

describe('isOwnerId', () => {
  it('refuses the empty string — it is the GLOBAL sentinel in the table', () => {
    // If this ever returned true, a personal entry would be filed as an
    // operator-curated one and would apply to everybody on the deployment.
    expect(isOwnerId('')).toBe(false);
  });

  it('accepts an ordinary user id and refuses a malformed one', () => {
    expect(isOwnerId('user_1@example.com')).toBe(true);
    expect(isOwnerId('_leading-underscore')).toBe(false);
    expect(isOwnerId('has space')).toBe(false);
    expect(isOwnerId(undefined)).toBe(false);
  });

  it('refuses "system" — a well-formed id that names no person', () => {
    // Every plugin's `init` builds `makeAgentContext({ userId: 'system' })`, so
    // this id reaches the store on paths a person was never on. It passes the
    // shape check, which is exactly why it needs naming: an entry owned by
    // nobody is one a later reader takes for one that applies to everybody.
    expect(isOwnerId('system')).toBe(false);
  });
});

describe('the in-memory egress allowlist store', () => {
  it('remembers a host for one person and nobody else', () => {
    const store = createMemoryEgressAllowlistStore();
    return (async () => {
      expect(await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' })).toBe(
        true,
      );
      expect([...(await store.allowedFor('alice'))]).toEqual(['docs.test']);
      // THE ISOLATION THIS WHOLE SCOPE DESIGN EXISTS FOR. The card excludes an
      // agent tier precisely so one person's approval cannot widen another
      // person's reach; if this ever comes back non-empty, that has happened.
      expect([...(await store.allowedFor('bob'))]).toEqual([]);
    })();
  });

  it('unions the operator global list into everybody', async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'global', ownerId: null, host: 'intranet.test' });
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' });
    expect([...(await store.allowedFor('alice'))].sort()).toEqual(['docs.test', 'intranet.test']);
    expect([...(await store.allowedFor('bob'))]).toEqual(['intranet.test']);
  });

  it('normalises on the way in, so the stored form is what evaluate compares', async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'user', ownerId: 'alice', host: '  DOCS.Test ' });
    expect([...(await store.allowedFor('alice'))]).toEqual(['docs.test']);
  });

  it('is idempotent — re-remembering answers false and stores nothing new', async () => {
    const store = createMemoryEgressAllowlistStore();
    expect(await store.remember({ scope: 'user', ownerId: 'a', host: 'docs.test' })).toBe(true);
    expect(await store.remember({ scope: 'user', ownerId: 'a', host: 'docs.test' })).toBe(false);
    expect((await store.allowedFor('a')).size).toBe(1);
  });

  it('refuses a malformed host or owner instead of throwing', async () => {
    const store = createMemoryEgressAllowlistStore();
    expect(await store.remember({ scope: 'user', ownerId: 'a', host: 'https://x.test/' })).toBe(
      false,
    );
    // An empty owner under `user` scope would land on the global sentinel row.
    expect(await store.remember({ scope: 'user', ownerId: '', host: 'x.test' })).toBe(false);
    expect(await store.remember({ scope: 'user', ownerId: null, host: 'x.test' })).toBe(false);
    // And a global entry must not carry an owner.
    expect(await store.remember({ scope: 'global', ownerId: 'a', host: 'x.test' })).toBe(false);
    expect((await store.allowedFor('a')).size).toBe(0);
  });

  it('caps what one person can accumulate', async () => {
    const store = createMemoryEgressAllowlistStore();
    for (let i = 0; i < MAX_USER_HOSTS; i += 1) {
      expect(await store.remember({ scope: 'user', ownerId: 'a', host: `h${i}.test` })).toBe(true);
    }
    expect(await store.remember({ scope: 'user', ownerId: 'a', host: 'one-too-many.test' })).toBe(
      false,
    );
    expect((await store.allowedFor('a')).size).toBe(MAX_USER_HOSTS);
  });

  it('does not cap the operator list — it is a deliberate list, not an accumulation', async () => {
    const store = createMemoryEgressAllowlistStore();
    for (let i = 0; i <= MAX_USER_HOSTS; i += 1) {
      expect(await store.remember({ scope: 'global', ownerId: null, host: `g${i}.test` })).toBe(
        true,
      );
    }
    expect((await store.allowedFor('anyone')).size).toBe(MAX_USER_HOSTS + 1);
  });

  it('answers nothing for an owner id it would never have written under', async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'global', ownerId: null, host: 'g.test' });
    // A malformed caller identity still gets the global list — that is the
    // operator's decision and applies to everyone — but never a user list.
    expect([...(await store.allowedFor(''))]).toEqual(['g.test']);
  });
});
