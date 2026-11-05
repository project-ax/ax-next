import { describe, expect, it } from 'vitest';
import { filterChatsByTitle } from '../sidebar-chats';

const at = '2026-11-01T10:00:00.000Z';
const PAST = [
  { id: 'c1', title: 'Q3 Vendor Review', lastActivityAt: at },
  { id: 'c2', title: 'Draft onboarding email', lastActivityAt: at },
  { id: 'c3', title: 'Vendor shortlist', lastActivityAt: at },
];

describe('filterChatsByTitle', () => {
  it('returns every chat, in order, for an empty or blank query', () => {
    expect(filterChatsByTitle(PAST, '').map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(filterChatsByTitle(PAST, '   ').map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('matches anywhere in the title, ignoring case and surrounding space', () => {
    expect(filterChatsByTitle(PAST, '  vendor ').map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(filterChatsByTitle(PAST, 'ONBOARD').map((c) => c.id)).toEqual(['c2']);
  });

  it('returns nothing when no title matches', () => {
    expect(filterChatsByTitle(PAST, 'zebra')).toEqual([]);
  });

  it('never mutates the list it was handed', () => {
    const copy = [...PAST];
    const out = filterChatsByTitle(PAST, '');
    expect(out).not.toBe(PAST);
    expect(PAST).toEqual(copy);
  });
});
