/**
 * Where a grant card's key actually gets written — under a wire payload
 * nobody validated (TASK-388).
 *
 * These builders decide which vault row a SECRET lands in, and their own
 * header says getting that wrong is the failure mode. Both callers feed them
 * slot rows straight off the wire: chat's producer validates nothing at all,
 * and the workspace's `isRenderableGrant` checks `slot` and stops — so
 * `service`/`account`/`slotTag` being typed `string` means the producer
 * promised, not that anybody looked.
 *
 * The contract pinned here: a tag we cannot use is ABSENT, so the destination
 * degrades onto the next defined fallback (the collapsed `account` route, then
 * `skill-slot` / the connector id) instead of carrying a malformed value into
 * the write.
 */
import { describe, expect, test } from 'vitest';
import {
  accountDestinationForConnectorSlot,
  accountOrSkillDestination,
  type CardSlot,
} from '../grant-destinations';

describe('accountOrSkillDestination', () => {
  test('prefers the resolved service tag', () => {
    expect(accountOrSkillDestination({ slot: 'api_key', service: 'linear' }, 'linear-issues')).toEqual(
      { kind: 'account', service: 'linear' },
    );
  });

  test('carries slotTag through for a multi-slot connector', () => {
    expect(
      accountOrSkillDestination(
        { slot: 'api_key', service: 'linear', slotTag: 'read' },
        'linear-issues',
      ),
    ).toEqual({ kind: 'account', service: 'linear', slot: 'read' });
  });

  test('falls back to the legacy account route, then to skill-slot', () => {
    expect(accountOrSkillDestination({ slot: 'api_key', account: 'linear' }, 'linear-issues')).toEqual(
      { kind: 'account', service: 'linear' },
    );
    expect(accountOrSkillDestination({ slot: 'api_key' }, 'linear-issues')).toEqual({
      kind: 'skill-slot',
      skillId: 'linear-issues',
      slot: 'api_key',
    });
  });

  test('a non-string service is treated as absent, not written into the row', () => {
    // Without the guard this returns `{kind:'account', service:{}}` — a secret
    // filed under a row nobody can name or find again.
    const malformed = { slot: 'api_key', service: {} } as unknown as CardSlot;

    expect(accountOrSkillDestination(malformed, 'linear-issues')).toEqual({
      kind: 'skill-slot',
      skillId: 'linear-issues',
      slot: 'api_key',
    });
  });

  test('a non-string account is treated as absent too', () => {
    const malformed = { slot: 'api_key', account: 42 } as unknown as CardSlot;

    expect(accountOrSkillDestination(malformed, 'linear-issues')).toEqual({
      kind: 'skill-slot',
      skillId: 'linear-issues',
      slot: 'api_key',
    });
  });

  test('a non-string slotTag is dropped while a good service is kept', () => {
    // The tags are independent: one being malformed must not discard the other.
    const malformed = { slot: 'api_key', service: 'linear', slotTag: [] } as unknown as CardSlot;

    expect(accountOrSkillDestination(malformed, 'linear-issues')).toEqual({
      kind: 'account',
      service: 'linear',
    });
  });

  test('a blank service falls through rather than filing under an empty row', () => {
    const blank = { slot: 'api_key', service: '   ' } as unknown as CardSlot;

    expect(accountOrSkillDestination(blank, 'linear-issues')).toEqual({
      kind: 'skill-slot',
      skillId: 'linear-issues',
      slot: 'api_key',
    });
  });
});

describe('accountDestinationForConnectorSlot', () => {
  test('prefers service, then account, then the connector id', () => {
    expect(
      accountDestinationForConnectorSlot({ slot: 'api_key', service: 'linear' }, 'linear-connector'),
    ).toEqual({ kind: 'account', service: 'linear' });
    expect(
      accountDestinationForConnectorSlot({ slot: 'api_key', account: 'linear' }, 'linear-connector'),
    ).toEqual({ kind: 'account', service: 'linear' });
    expect(accountDestinationForConnectorSlot({ slot: 'api_key' }, 'linear-connector')).toEqual({
      kind: 'account',
      service: 'linear-connector',
    });
  });

  test('malformed service and account both fall through to the connector id', () => {
    // A non-blank string caller id remains the floor when optional tags are malformed.
    const malformed = { slot: 'api_key', service: {}, account: 7 } as unknown as CardSlot;

    expect(accountDestinationForConnectorSlot(malformed, 'linear-connector')).toEqual({
      kind: 'account',
      service: 'linear-connector',
    });
  });

  test('a malformed slotTag is dropped, collapsing to the per-service row', () => {
    const malformed = {
      slot: 'api_key',
      service: 'linear',
      slotTag: { nested: true },
    } as unknown as CardSlot;

    expect(accountDestinationForConnectorSlot(malformed, 'linear-connector')).toEqual({
      kind: 'account',
      service: 'linear',
    });
  });
});

const invalidCallerIds = [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['blank', ' \t\n '],
  ['number', 42],
  ['boolean', false],
  ['object', {}],
  ['empty array', []],
  ['string array', ['linear']],
] as const;

describe.each([
  { name: 'skill', build: accountOrSkillDestination },
  { name: 'connector', build: accountDestinationForConnectorSlot },
])('$name caller-id floor', ({ name, build }) => {
  test.each(invalidCallerIds)('rejects a %s caller-id floor', (_label, value) => {
    const invoke = () => build({ slot: 'api_key' }, value as unknown as string);
    expect(invoke).toThrow(TypeError);
    expect(invoke).toThrow('Invalid credential caller identifier.');
  });

  test('does not consume an invalid floor when a service or account is usable', () => {
    const missing = undefined as unknown as string;
    expect(build({ slot: 'api_key', service: 'linear', slotTag: 'READ' }, missing)).toEqual({
      kind: 'account', service: 'linear', slot: 'READ',
    });
    expect(build({ slot: 'api_key', account: 'linear' }, missing)).toEqual({
      kind: 'account', service: 'linear',
    });
  });

  test('preserves a nonblank caller identifier verbatim', () => {
    const id = ' caller-id ';
    expect(build({ slot: 'api_key' }, id)).toEqual(name === 'skill'
      ? { kind: 'skill-slot', skillId: id, slot: 'api_key' }
      : { kind: 'account', service: id });
  });
});
