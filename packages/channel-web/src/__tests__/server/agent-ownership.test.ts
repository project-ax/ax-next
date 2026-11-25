/**
 * TASK-1246 — the two readings of `agents:resolve` / `agents:list-for-user`'s
 * `isOwner` that channel-web makes. `agents:resolve` now admits the people a
 * personal agent is shared with as well as its owners, so "resolved, and
 * personal" no longer means "owner".
 *
 *   - `ownsPersonalAgent` guards writes, so it is STRICT: only an answer that
 *     says `personal` AND `isOwner: true` is an owner.
 *   - `hideAgentsSharedWithMe` shapes lists, so it is LENIENT: a row with no
 *     `isOwner` at all reads as owned (a producer from before sharing), and
 *     only a row that says `isOwner: false` and isn't a team agent goes.
 */
import { describe, it, expect } from 'vitest';
import {
  hideAgentsSharedWithMe,
  ownsPersonalAgent,
} from '../../server/agent-ownership.js';

describe('ownsPersonalAgent', () => {
  it('is true only for personal + isOwner true; false for a missing isOwner, isOwner false, or a team agent', () => {
    expect(ownsPersonalAgent({ visibility: 'personal', isOwner: true })).toBe(true);

    // Someone the agent is shared with.
    expect(ownsPersonalAgent({ visibility: 'personal', isOwner: false })).toBe(false);
    // An answer that doesn't say: never assumed to be the owner.
    expect(ownsPersonalAgent({ visibility: 'personal' })).toBe(false);
    // A team agent has no owning person (and @ax/agents says false there).
    expect(ownsPersonalAgent({ visibility: 'team', isOwner: true })).toBe(false);
    expect(ownsPersonalAgent({ visibility: 'team', isOwner: false })).toBe(false);
    // An answer that doesn't say what the agent is.
    expect(ownsPersonalAgent({ isOwner: true })).toBe(false);
    expect(ownsPersonalAgent({})).toBe(false);
  });

  it('reads the two words exactly: a truthy look-alike is not an owner', () => {
    for (const isOwner of ['true', 1, 'yes', {}, [true], null]) {
      expect(ownsPersonalAgent({ visibility: 'personal', isOwner }), String(isOwner)).toBe(false);
    }
    for (const visibility of ['Personal', 'personal ', 'user', null, undefined]) {
      expect(ownsPersonalAgent({ visibility, isOwner: true }), String(visibility)).toBe(false);
    }
  });
});

describe('hideAgentsSharedWithMe', () => {
  it('drops only personal rows with isOwner false', () => {
    const rows = [
      { id: 'mine', visibility: 'personal', isOwner: true },
      { id: 'shared-with-me', visibility: 'personal', isOwner: false },
      { id: 'team', visibility: 'team', isOwner: false },
      { id: 'team-no-flag', visibility: 'team' },
      { id: 'mine-no-flag', visibility: 'personal' },
    ];
    expect(hideAgentsSharedWithMe(rows).map((r) => r.id)).toEqual([
      'mine',
      'team',
      'team-no-flag',
      'mine-no-flag',
    ]);
  });

  it('keeps a row that says isOwner false only when it is a team agent', () => {
    // A row that doesn't say it is a team agent, and says the caller isn't an
    // owner, is someone else's agent: it goes, like a personal one.
    const notMine: Array<{ id: string; isOwner?: boolean }> = [{ id: 'x', isOwner: false }];
    expect(hideAgentsSharedWithMe(notMine)).toEqual([]);
    // Without the flag at all, it stays (lenient, as before sharing).
    const unflagged: Array<{ id: string; isOwner?: boolean }> = [{ id: 'y' }];
    expect(hideAgentsSharedWithMe(unflagged)).toEqual([{ id: 'y' }]);
  });

  it('keeps order and the rows themselves, and leaves its input alone', () => {
    const a = { id: 'a', displayName: 'A', visibility: 'personal' as const, isOwner: true };
    const b = { id: 'b', displayName: 'B', visibility: 'personal' as const, isOwner: false };
    const c = { id: 'c', displayName: 'C', visibility: 'team' as const, isOwner: false };
    const input = [c, b, a];
    const out = hideAgentsSharedWithMe(input);
    expect(out).toEqual([c, a]);
    expect(out[0]).toBe(c);
    expect(out[1]).toBe(a);
    expect(input).toEqual([c, b, a]);
  });
});
