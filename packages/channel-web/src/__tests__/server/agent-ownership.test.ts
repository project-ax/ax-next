/**
 * TASK-1246 / TASK-1247 — the readings of `agents:resolve` /
 * `agents:list-for-user`'s `isOwner` that channel-web makes. `agents:resolve`
 * now admits the people a personal agent is shared with as well as its owners,
 * so "resolved, and personal" no longer means "owner".
 *
 *   - `ownsPersonalAgent` guards writes, so it is STRICT: only an answer that
 *     says `personal` AND `isOwner: true` is an owner.
 *   - `hideAgentsSharedWithMe` shapes the lists of agents the caller manages,
 *     so it is LENIENT: a row with no `isOwner` at all reads as owned (a
 *     producer from before sharing), and only a row that says `isOwner: false`
 *     and isn't a team agent goes.
 *   - `agentAccess` (TASK-1247) says how the caller stands with an agent on
 *     the workspace roster and the agent view, and is LENIENT in the same way.
 *     The rows it calls `audience` are exactly the rows the managed lists
 *     leave out, and that agreement is pinned below.
 *
 * TASK-1248 — and the one reading of `shared`. `isSharedPersonalAgent` widens
 * who keeps a site and who sees memory as shared, so it is STRICT too: only an
 * answer that says `personal` AND `shared: true` is a shared personal agent.
 */
import { describe, it, expect } from 'vitest';
import {
  agentAccess,
  hideAgentsSharedWithMe,
  isSharedPersonalAgent,
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

describe('agentAccess', () => {
  it("agentAccess: a team agent is 'team' whatever else it says", () => {
    expect(agentAccess({ visibility: 'team' }, 'u1')).toBe('team');
    expect(agentAccess({ visibility: 'team', isOwner: false }, 'u1')).toBe('team');
    // `isOwner` is always false on a team agent; a stray true changes nothing.
    expect(agentAccess({ visibility: 'team', isOwner: true, ownerId: 'u1' }, 'u1')).toBe('team');
    // Its `ownerId` is the team's: never read as a person, never a co-owner.
    expect(agentAccess({ visibility: 'team', isOwner: true, ownerId: 'team-1' }, 'u1')).toBe(
      'team',
    );
  });

  it("agentAccess: isOwner false is 'audience'", () => {
    expect(agentAccess({ visibility: 'personal', isOwner: false, ownerId: 'vin' }, 'u1')).toBe(
      'audience',
    );
    // Even when the answer names the caller as its creator: `isOwner` is the
    // answer about the caller, so false means they only use it.
    expect(agentAccess({ visibility: 'personal', isOwner: false, ownerId: 'u1' }, 'u1')).toBe(
      'audience',
    );
    // A row that doesn't say it is a team agent, and says the caller isn't an
    // owner, is someone else's agent (as `hideAgentsSharedWithMe` reads it).
    expect(agentAccess({ isOwner: false }, 'u1')).toBe('audience');
  });

  it("agentAccess: the owner who created it is 'creator'; any other owner is 'co-owner'", () => {
    expect(agentAccess({ visibility: 'personal', isOwner: true, ownerId: 'u1' }, 'u1')).toBe(
      'creator',
    );
    expect(agentAccess({ visibility: 'personal', isOwner: true, ownerId: 'vin' }, 'u1')).toBe(
      'co-owner',
    );
    // The same agent, asked about by its creator.
    expect(agentAccess({ visibility: 'personal', isOwner: true, ownerId: 'vin' }, 'vin')).toBe(
      'creator',
    );
  });

  it("agentAccess: a row with no isOwner reads as the caller's own (a producer from before sharing)", () => {
    expect(agentAccess({ visibility: 'personal' }, 'u1')).toBe('creator');
    expect(agentAccess({ visibility: 'personal', ownerId: 'u1' }, 'u1')).toBe('creator');
    expect(agentAccess({}, 'u1')).toBe('creator');
    // It says who created it, and that isn't the caller: an owner, not the creator.
    expect(agentAccess({ visibility: 'personal', ownerId: 'vin' }, 'u1')).toBe('co-owner');
  });

  it('agentAccess: its audience rows are exactly the rows the managed lists leave out', () => {
    // The roster lists every agent `agents:list-for-user` returns, and the
    // lists of agents the caller manages (`/route`, `/tasks`,
    // `/api/chat/agents`) drop some. The two readings must never disagree
    // about which rows are only shared with the caller, or an agent they only
    // use lands in a managed list (or one they manage reads as only shared).
    const visibilities: unknown[] = ['personal', 'team', undefined, 'Personal', null];
    const isOwners: unknown[] = [true, false, undefined, 'false', 0, null];
    const ownerIds: unknown[] = ['u1', 'vin', undefined];
    for (const visibility of visibilities) {
      for (const isOwner of isOwners) {
        for (const ownerId of ownerIds) {
          const row = { visibility, isOwner, ownerId };
          expect(hideAgentsSharedWithMe([row]).length === 0, JSON.stringify(row)).toBe(
            agentAccess(row, 'u1') === 'audience',
          );
        }
      }
    }
  });
});

describe('isSharedPersonalAgent (TASK-1248)', () => {
  it('is true only for personal + shared true; false for shared false or missing, or a team agent', () => {
    expect(isSharedPersonalAgent({ visibility: 'personal', shared: true })).toBe(true);
    // Whoever is asking: one of its owners, or someone it is shared with.
    const asOwner = { visibility: 'personal', shared: true, isOwner: true };
    const asSharee = { visibility: 'personal', shared: true, isOwner: false };
    expect(isSharedPersonalAgent(asOwner)).toBe(true);
    expect(isSharedPersonalAgent(asSharee)).toBe(true);

    // "Just me".
    expect(isSharedPersonalAgent({ visibility: 'personal', shared: false })).toBe(false);
    // An answer that doesn't say keeps the Just-me rule: never assumed shared.
    expect(isSharedPersonalAgent({ visibility: 'personal' })).toBe(false);
    // A team agent keeps its own branch; this asks about personal agents only.
    expect(isSharedPersonalAgent({ visibility: 'team', shared: true })).toBe(false);
    // An answer that doesn't say what the agent is.
    expect(isSharedPersonalAgent({ shared: true })).toBe(false);
    expect(isSharedPersonalAgent({})).toBe(false);
  });

  it('reads the two words exactly: a truthy look-alike is not shared', () => {
    for (const shared of ['true', 1, 'yes', {}, [true], null]) {
      expect(isSharedPersonalAgent({ visibility: 'personal', shared }), String(shared)).toBe(false);
    }
    for (const visibility of ['Personal', 'personal ', 'user', null, undefined]) {
      expect(isSharedPersonalAgent({ visibility, shared: true }), String(visibility)).toBe(false);
    }
  });

  it('never reads audience: shared is the one answer (TASK-1246)', () => {
    const saysEveryoneOnly = { visibility: 'personal', audience: 'everyone' };
    expect(isSharedPersonalAgent(saysEveryoneOnly)).toBe(false);
    const saysSharedOnly = { visibility: 'personal', shared: true, audience: 'just-me' };
    expect(isSharedPersonalAgent(saysSharedOnly)).toBe(true);
  });
});
