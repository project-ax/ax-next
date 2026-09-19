/**
 * The shared reach-shape guards (TASK-388).
 *
 * Both grant renderers route their wire-supplied `hosts`/`slots` through these,
 * and the component suites prove the guards are load-bearing — but they only
 * exercise the shapes a card happens to render. The element-level branches
 * (`null` elements, non-object elements, a non-string inside an otherwise fine
 * array) are cheapest to pin here, directly, which is the whole reason the
 * answers were lifted out of the two components in the first place.
 */
import { describe, expect, test } from 'vitest';
import { slotAccount, usableHosts, usableSlots } from '../grant-shape';

describe('usableHosts', () => {
  test('keeps a well-formed list untouched', () => {
    expect(usableHosts(['api.linear.app', 'example.org'])).toEqual([
      'api.linear.app',
      'example.org',
    ]);
  });

  test('treats a non-array as no hosts at all', () => {
    // The case `?? []` misses: a string has a truthy `.length` and no `.map`.
    expect(usableHosts('api.linear.app')).toEqual([]);
    expect(usableHosts(undefined)).toEqual([]);
    expect(usableHosts(null)).toEqual([]);
    expect(usableHosts({ 0: 'api.linear.app', length: 1 })).toEqual([]);
  });

  test('drops elements that are not usable hostnames, keeping the rest', () => {
    expect(
      usableHosts(['api.linear.app', { hostname: 'evil' }, null, 42, '', '   ', 'example.org']),
    ).toEqual(['api.linear.app', 'example.org']);
  });
});

describe('usableSlots', () => {
  const good = { slot: 'api_key', kind: 'api-key' as const };

  test('keeps a well-formed list untouched', () => {
    expect(usableSlots([good])).toEqual([good]);
  });

  test('treats a non-array as no slots at all', () => {
    expect(usableSlots(undefined)).toEqual([]);
    expect(usableSlots('api_key' as unknown as { slot: string }[])).toEqual([]);
  });

  test('drops elements that cannot be drawn a field for', () => {
    // A slot id is what labels the field, keys the input, and names the vault
    // row — without one there is nothing to render and nowhere to write.
    const slots = [
      good,
      null,
      'api_key',
      42,
      {},
      { slot: '' },
      { slot: '   ' },
      { slot: 7 },
    ] as unknown as { slot: string }[];

    expect(usableSlots(slots)).toEqual([good]);
  });
});

describe('slotAccount', () => {
  test('returns a real account tag', () => {
    expect(slotAccount({ account: 'linear' })).toBe('linear');
  });

  test('treats absent, blank and non-string tags alike as no tag', () => {
    // Absent is legitimate (it just means "no service prefix"), which is why
    // this one COALESCES where `usableSlots` drops. The non-string cases are
    // the bug: `s.account ?? s.slot` only falls back on null and undefined.
    expect(slotAccount({})).toBeUndefined();
    // Cast: `exactOptionalPropertyTypes` rejects an explicit `undefined` for an
    // optional prop, but the wire can absolutely hand us one.
    expect(slotAccount({ account: undefined } as unknown as { account?: string })).toBeUndefined();
    expect(slotAccount({ account: '' })).toBeUndefined();
    expect(slotAccount({ account: '   ' })).toBeUndefined();
    expect(slotAccount({ account: {} } as unknown as { account?: string })).toBeUndefined();
    expect(slotAccount({ account: 42 } as unknown as { account?: string })).toBeUndefined();
    expect(slotAccount({ account: ['linear'] } as unknown as { account?: string })).toBeUndefined();
    expect(slotAccount({ account: null } as unknown as { account?: string })).toBeUndefined();
  });
});
