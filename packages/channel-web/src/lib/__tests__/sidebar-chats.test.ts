import { describe, expect, it } from 'vitest';
import { chatsFromDetail, filterChatsByTitle } from '../sidebar-chats';

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

describe('chatsFromDetail', () => {
  const OLD = { id: 'c-old', title: 'March', lastActivityAt: at };
  const NOW = { id: 'c-now', title: 'Plan the offsite', lastActivityAt: at };

  it('lists the latest chat first, by its title, then the rest', () => {
    expect(chatsFromDetail({ conversationId: 'c-now', past: [OLD], latest: NOW })).toEqual([NOW, OLD]);
  });

  it('is the same list whichever chat is on screen', () => {
    // Reading an older chat: `past` still carries it, `latest` is the newest.
    expect(chatsFromDetail({ conversationId: 'c-old', past: [OLD], latest: NOW })).toEqual([NOW, OLD]);
  });

  it('is empty before the agent has any chat', () => {
    expect(chatsFromDetail({ conversationId: null, past: [], latest: null })).toEqual([]);
  });

  it('still lists the current chat from a server that predates `latest`', () => {
    const rows = chatsFromDetail({ conversationId: 'c-now', past: [OLD] });
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      ['c-now', 'Untitled conversation'],
      ['c-old', 'March'],
    ]);
    // …without listing an older chat twice when that is the one on screen.
    expect(chatsFromDetail({ conversationId: 'c-old', past: [OLD] })).toEqual([OLD]);
  });
});
