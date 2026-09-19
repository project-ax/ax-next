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

/**
 * TASK-406 — the read + revoke half.
 *
 * `allowedFor` answers the ENFORCEMENT question ("may this call go through")
 * and a bare host is enough for it. These two answer the PERSON's question
 * ("what did I allow, and how do I take it back"), which needs one more fact:
 * whose list an entry is on. Getting that wrong in either direction is a real
 * failure — hide the scope and the panel offers a revoke button that can only
 * ever answer `false`; let `revoke` reach a `global` row and one person quietly
 * edits the operator's deployment-wide list.
 */
describe('the in-memory store: listFor', () => {
  it('returns the operator list and the caller list, tagged and sorted by host', async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'global', ownerId: null, host: 'zeta.test' });
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'mid.test' });
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'alpha.test' });
    await store.remember({ scope: 'user', ownerId: 'bob', host: 'bobs.test' });

    const sites = await store.listFor('alice');
    // Sorted by host and NOT by insertion or by scope: the order is a property
    // of the data, so the renderer never has to invent one.
    expect(sites.map((s) => s.host)).toEqual(['alpha.test', 'mid.test', 'zeta.test']);
    // The tag is the load-bearing field. Without it these three rows look
    // identical and the operator's entry looks like something alice can drop.
    expect(sites.map((s) => s.scope)).toEqual(['user', 'user', 'global']);
    // An instant, as a string, because a Date does not survive JSON.
    for (const site of sites) {
      expect(typeof site.rememberedAt).toBe('string');
      expect(Number.isNaN(Date.parse(site.rememberedAt))).toBe(false);
    }
    // And never another person's — same isolation `allowedFor` promises.
    expect(sites.some((s) => s.host === 'bobs.test')).toBe(false);
  });

  it('gives an id that names no person the operator list and nothing else', async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'global', ownerId: null, host: 'g.test' });
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' });
    for (const notAUser of ['system', '', 'has space', '_leading']) {
      const sites = await store.listFor(notAUser);
      expect(sites.map((s) => s.host), notAUser).toEqual(['g.test']);
      expect(sites[0]!.scope).toBe('global');
    }
  });

  it('agrees with allowedFor about what the caller may reach', async () => {
    // Two methods, one answer. If they ever disagree, the panel is showing a
    // list that is not the list being enforced.
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'global', ownerId: null, host: 'g.test' });
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' });
    expect((await store.listFor('alice')).map((s) => s.host).sort()).toEqual(
      [...(await store.allowedFor('alice'))].sort(),
    );
  });

  it('shows a host on BOTH lists once, as global — the row that says "you cannot take this back"', async () => {
    // Reachable on the first read of a globally-allowed site, not in a corner
    // case: `web_extract`'s executor remembers every successful fetch, the
    // silent ones included, and `remember` keys its existence check on
    // (scope, owner, host) — so the global row does not match and a personal
    // row lands beside it.
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'global', ownerId: null, host: 'example.test' });
    expect(
      await store.remember({ scope: 'user', ownerId: 'alice', host: 'example.test' }),
    ).toBe(true);

    const sites = await store.listFor('alice');
    // ONE row. Two would collide on the panel's host key, and the personal
    // duplicate would render a revoke control that deletes a row which is not
    // why the site is silent — telling the person we will ask next time when
    // we will not.
    expect(sites).toHaveLength(1);
    expect(sites[0]!.host).toBe('example.test');
    // `global` and not `user`: while the operator's entry stands, this host
    // cannot be taken back, and that is the answer the panel has to give.
    expect(sites[0]!.scope).toBe('global');
    // Still enforced, obviously — dedupe is a reporting rule, not a grant one.
    expect(await store.allowedFor('alice')).toEqual(new Set(['example.test']));
  });

  it('hands the row back with its control once the operator drops the global entry', async () => {
    // The other half of "global wins": the personal row is hidden, never lost.
    // Modelled by seeding the global list into a SEPARATE store, which is what
    // an operator removing a host from `globalEgressHosts` and restarting
    // actually produces.
    const withGlobal = createMemoryEgressAllowlistStore();
    await withGlobal.remember({ scope: 'global', ownerId: null, host: 'example.test' });
    await withGlobal.remember({ scope: 'user', ownerId: 'alice', host: 'example.test' });
    expect((await withGlobal.listFor('alice'))[0]!.scope).toBe('global');

    const withoutGlobal = createMemoryEgressAllowlistStore();
    await withoutGlobal.remember({ scope: 'user', ownerId: 'alice', host: 'example.test' });
    const sites = await withoutGlobal.listFor('alice');
    expect(sites).toHaveLength(1);
    expect(sites[0]!.scope).toBe('user');
    // And it is revocable again, by host — `revoke` never needed the row the
    // list chose to show.
    expect(await withoutGlobal.revoke({ ownerId: 'alice', host: 'example.test' })).toBe(true);
  });

  it('still revokes the hidden personal row while the global entry stands', async () => {
    // Deleting it changes nothing a person can observe (the global entry still
    // allows the host), so the panel does not offer the control — but `revoke`
    // keys on the host, not on what the list rendered, and must not silently
    // become a no-op just because the row is not on screen.
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'global', ownerId: null, host: 'example.test' });
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'example.test' });

    expect(await store.revoke({ ownerId: 'alice', host: 'example.test' })).toBe(true);
    // The global row is untouched — the host is still listed, still allowed.
    expect((await store.listFor('alice')).map((s) => [s.host, s.scope])).toEqual([
      ['example.test', 'global'],
    ]);
    expect(await store.allowedFor('alice')).toEqual(new Set(['example.test']));
  });
});

describe('the in-memory store: revoke', () => {
  it("removes the caller's own entry and nobody else's", async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' });
    await store.remember({ scope: 'user', ownerId: 'bob', host: 'docs.test' });

    expect(await store.revoke({ ownerId: 'alice', host: 'docs.test' })).toBe(true);
    expect(await store.listFor('alice')).toEqual([]);
    // Bob remembered the SAME host independently. A revoke that matched on the
    // host alone would have taken his grant away too.
    expect((await store.listFor('bob')).map((s) => s.host)).toEqual(['docs.test']);
  });

  it('refuses a global entry and leaves it in place', async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'global', ownerId: null, host: 'intranet.test' });
    // The scope is hard-coded to `user` inside the store precisely so this can
    // never succeed: a global entry is the operator's list for the whole
    // deployment, and one person must not be able to edit it from a panel.
    expect(await store.revoke({ ownerId: 'alice', host: 'intranet.test' })).toBe(false);
    expect((await store.listFor('alice')).map((s) => s.host)).toEqual(['intranet.test']);
    expect(await store.allowedFor('alice')).toContain('intranet.test');
  });

  it('answers false for a host that was never there', async () => {
    const store = createMemoryEgressAllowlistStore();
    expect(await store.revoke({ ownerId: 'alice', host: 'never.test' })).toBe(false);
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' });
    expect(await store.revoke({ ownerId: 'alice', host: 'other.test' })).toBe(false);
    expect((await store.listFor('alice')).map((s) => s.host)).toEqual(['docs.test']);
  });

  it('refuses a malformed host or a caller who is not a person, without throwing', async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' });
    for (const bad of ['https://docs.test/x', '*.test', '', 'a b', 'docs.test.']) {
      expect(await store.revoke({ ownerId: 'alice', host: bad }), JSON.stringify(bad)).toBe(false);
    }
    // `system` passes the id shape check and names nobody — the store never
    // wrote under it, so it cannot delete under it either.
    for (const notAUser of ['system', '', '_leading']) {
      expect(await store.revoke({ ownerId: notAUser, host: 'docs.test' }), notAUser).toBe(false);
    }
    expect((await store.listFor('alice')).map((s) => s.host)).toEqual(['docs.test']);
  });

  it('normalises the host on the way in, so the casing somebody typed still matches', async () => {
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' });
    expect(await store.revoke({ ownerId: 'alice', host: '  DOCS.Test ' })).toBe(true);
    expect(await store.listFor('alice')).toEqual([]);
  });

  it('actually stops the enforcement path allowing it — not just the list showing it', async () => {
    // THE ONE THAT MATTERS. A revoke that only changed what `listFor` returns
    // would look completely correct in a UI while the site stayed silently
    // reachable forever.
    const store = createMemoryEgressAllowlistStore();
    await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' });
    expect(await store.allowedFor('alice')).toContain('docs.test');
    expect(await store.revoke({ ownerId: 'alice', host: 'docs.test' })).toBe(true);
    expect(await store.allowedFor('alice')).not.toContain('docs.test');
    // And it can be remembered again afterwards — a revoke is a deletion, not
    // a tombstone that would make the next approval a silent no-op.
    expect(await store.remember({ scope: 'user', ownerId: 'alice', host: 'docs.test' })).toBe(true);
  });
});
