import { describe, expect, it } from 'vitest';
import {
  AUDIENCE_MEMBERS_MAX,
  OWNERS_MAX,
  addedPeople,
  canDeleteAgent,
  canManageAgent,
  draftFrom,
  isNarrowing,
  isWidening,
  sameAudience,
  sharedAgentChoices,
  toAudienceBody,
  type DraftAudience,
} from '../agent-sharing';
import type { AdminAgent } from '../admin';

const p = (id: string) => ({ id, displayName: `Person ${id}` });
const list = (...ids: string[]): DraftAudience => ({ kind: 'list', members: ids.map(p) });
const JUST_ME: DraftAudience = { kind: 'just-me' };
const EVERYONE: DraftAudience = { kind: 'everyone' };

type Case = [string, DraftAudience, DraftAudience, boolean];

describe('limits', () => {
  it('mirror the server caps', () => {
    expect(AUDIENCE_MEMBERS_MAX).toBe(50);
    expect(OWNERS_MAX).toBe(10);
  });
});

describe('isWidening', () => {
  const cases: Case[] = [
    ['just-me -> just-me', JUST_ME, JUST_ME, false],
    ['just-me -> everyone', JUST_ME, EVERYONE, true],
    ['just-me -> [a]', JUST_ME, list('a'), true],
    ['everyone -> just-me', EVERYONE, JUST_ME, false],
    ['everyone -> everyone', EVERYONE, EVERYONE, false],
    ['everyone -> [a]', EVERYONE, list('a'), false],
    ['[a] -> just-me', list('a'), JUST_ME, false],
    ['[a] -> everyone', list('a'), EVERYONE, true],
    ['[a] -> [a]', list('a'), list('a'), false],
    ['[a] -> [a,b]', list('a'), list('a', 'b'), true],
    ['[a,b] -> [a]', list('a', 'b'), list('a'), false],
    ['[a] -> [b,c]', list('a'), list('b', 'c'), true],
    ['[a,b] -> [b,c]', list('a', 'b'), list('b', 'c'), true],
  ];
  it.each(cases)('%s', (_n, from, to, want) => {
    expect(isWidening(from, to)).toBe(want);
  });
});

describe('isNarrowing', () => {
  const cases: Case[] = [
    ['just-me -> just-me', JUST_ME, JUST_ME, false],
    ['just-me -> everyone', JUST_ME, EVERYONE, false],
    ['just-me -> [a]', JUST_ME, list('a'), false],
    ['everyone -> just-me', EVERYONE, JUST_ME, true],
    ['everyone -> everyone', EVERYONE, EVERYONE, false],
    ['everyone -> [a]', EVERYONE, list('a'), true],
    ['[a] -> just-me', list('a'), JUST_ME, true],
    ['[a] -> everyone', list('a'), EVERYONE, false],
    ['[a] -> [a]', list('a'), list('a'), false],
    ['[a] -> [a,b]', list('a'), list('a', 'b'), false],
    ['[a,b] -> [a]', list('a', 'b'), list('a'), true],
    ['[a] -> [b,c]', list('a'), list('b', 'c'), true],
    ['[a,b] -> [b,c]', list('a', 'b'), list('b', 'c'), true],
  ];
  it.each(cases)('%s', (_n, from, to, want) => {
    expect(isNarrowing(from, to)).toBe(want);
  });

  it('a change can widen and narrow at once', () => {
    const from = list('a', 'b');
    const to = list('b', 'c');
    expect(isWidening(from, to)).toBe(true);
    expect(isNarrowing(from, to)).toBe(true);
  });
});

describe('draftFrom', () => {
  it('reads each kind of audience', () => {
    expect(draftFrom({ kind: 'just-me' })).toEqual(JUST_ME);
    expect(draftFrom({ kind: 'everyone' })).toEqual(EVERYONE);
    expect(
      draftFrom({ kind: 'list', members: [{ type: 'user', id: 'a', displayName: null }] }),
    ).toEqual({ kind: 'list', members: [{ id: 'a', displayName: null }] });
  });
});

describe('toAudienceBody', () => {
  it('turns an empty list into just-me and strips names', () => {
    expect(toAudienceBody({ kind: 'list', members: [] })).toEqual({ kind: 'just-me' });
    expect(toAudienceBody(list('a', 'b'))).toEqual({
      kind: 'list',
      members: [
        { type: 'user', id: 'a' },
        { type: 'user', id: 'b' },
      ],
    });
    expect(toAudienceBody(EVERYONE)).toEqual({ kind: 'everyone' });
    expect(toAudienceBody(JUST_ME)).toEqual({ kind: 'just-me' });
  });
});

describe('sameAudience', () => {
  it('ignores list order and names', () => {
    expect(sameAudience(list('a', 'b'), list('b', 'a'))).toBe(true);
    expect(
      sameAudience(list('a'), { kind: 'list', members: [{ id: 'a', displayName: null }] }),
    ).toBe(true);
  });
  it('tells different audiences apart', () => {
    expect(sameAudience(list('a'), list('a', 'b'))).toBe(false);
    expect(sameAudience(list('a'), list('b'))).toBe(false);
    expect(sameAudience(JUST_ME, EVERYONE)).toBe(false);
    expect(sameAudience(EVERYONE, EVERYONE)).toBe(true);
    expect(sameAudience(JUST_ME, JUST_ME)).toBe(true);
    expect(sameAudience(JUST_ME, list('a'))).toBe(false);
  });
});

describe('an empty list is Just me', () => {
  const EMPTY: DraftAudience = { kind: 'list', members: [] };
  it('is the same audience as Just me, in both directions', () => {
    expect(sameAudience(JUST_ME, EMPTY)).toBe(true);
    expect(sameAudience(EMPTY, JUST_ME)).toBe(true);
    expect(sameAudience(EMPTY, EVERYONE)).toBe(false);
  });
  it('is neither widening nor narrowing against Just me', () => {
    expect(isWidening(JUST_ME, EMPTY)).toBe(false);
    expect(isNarrowing(EMPTY, JUST_ME)).toBe(false);
    expect(isNarrowing(list('a'), EMPTY)).toBe(true);
    expect(isWidening(EMPTY, list('a'))).toBe(true);
  });
});

describe('addedPeople', () => {
  it('names only the new people', () => {
    expect(addedPeople(list('a'), list('a', 'b', 'c')).map((x) => x.id)).toEqual(['b', 'c']);
    expect(addedPeople(JUST_ME, list('a', 'b')).map((x) => x.id)).toEqual(['a', 'b']);
    expect(addedPeople(EVERYONE, list('a')).map((x) => x.id)).toEqual(['a']);
  });
  it('is empty when the target is not a list', () => {
    expect(addedPeople(list('a'), EVERYONE)).toEqual([]);
    expect(addedPeople(list('a'), JUST_ME)).toEqual([]);
  });
});

function agent(over: Partial<AdminAgent>): AdminAgent {
  return {
    id: 'x',
    ownerId: 'u',
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'X',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'm',
    skillAttachments: [],
    connectorAttachments: [],
    createdAt: '',
    updatedAt: '',
    shared: false,
    ...over,
  };
}

describe('sharedAgentChoices', () => {
  it('keeps your other shared personal agents only', () => {
    const keep = agent({ id: 'keep', shared: true, isOwner: true });
    const all = [
      agent({ id: 'current', shared: true, isOwner: true }),
      keep,
      agent({ id: 'unshared', shared: false, isOwner: true }),
      agent({ id: 'not-owner', shared: true, isOwner: false }),
      agent({ id: 'no-flag', shared: true }),
      agent({ id: 'team', shared: true, isOwner: true, visibility: 'team', ownerType: 'team' }),
    ];
    expect(sharedAgentChoices(all, 'current')).toEqual([keep]);
  });
});

describe('canManageAgent / canDeleteAgent', () => {
  it('follow the reader access', () => {
    expect(canManageAgent({ access: 'creator' })).toBe(true);
    expect(canManageAgent({ access: 'co-owner' })).toBe(true);
    expect(canManageAgent({ access: 'team' })).toBe(true);
    expect(canManageAgent({ access: 'audience' })).toBe(false);
    expect(canDeleteAgent({ access: 'creator' })).toBe(true);
    expect(canDeleteAgent({ access: 'team' })).toBe(true);
    expect(canDeleteAgent({ access: 'co-owner' })).toBe(false);
    expect(canDeleteAgent({ access: 'audience' })).toBe(false);
  });
  it('is lenient when access is absent', () => {
    expect(canManageAgent({})).toBe(true);
    expect(canDeleteAgent({})).toBe(true);
  });
});
