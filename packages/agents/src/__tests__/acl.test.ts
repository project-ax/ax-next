import { describe, it, expect } from 'vitest';
import { HookBus, makeChatContext } from '@ax/core';
import { checkAccess } from '../acl.js';
import type { Agent } from '../types.js';

function makePersonalAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_x',
    ownerId: 'u1',
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'A',
    systemPrompt: '',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude-opus-4-7',
    workspaceRef: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTeamAgent(overrides: Partial<Agent> = {}): Agent {
  return makePersonalAgent({
    ownerType: 'team',
    visibility: 'team',
    ownerId: 't1',
    ...overrides,
  });
}

function ctx() {
  return makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u1',
  });
}

describe('checkAccess', () => {
  it('personal: owner matches → allowed', async () => {
    const bus = new HookBus();
    const result = await checkAccess(makePersonalAgent(), 'u1', bus, ctx());
    expect(result).toEqual({ allowed: true });
  });

  it('personal: owner mismatch → forbidden', async () => {
    const bus = new HookBus();
    const result = await checkAccess(makePersonalAgent(), 'someone-else', bus, ctx());
    expect(result).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('team: teams:is-member returns true → allowed', async () => {
    const bus = new HookBus();
    bus.registerService<{ teamId: string; userId: string }, { member: boolean }>(
      'teams:is-member',
      'mock',
      async (_c, { teamId, userId }) => {
        expect(teamId).toBe('t1');
        expect(userId).toBe('u1');
        return { member: true };
      },
    );
    const result = await checkAccess(makeTeamAgent(), 'u1', bus, ctx());
    expect(result).toEqual({ allowed: true });
  });

  it('team: teams:is-member returns false → forbidden', async () => {
    const bus = new HookBus();
    bus.registerService<{ teamId: string; userId: string }, { member: boolean }>(
      'teams:is-member',
      'mock',
      async () => ({ member: false }),
    );
    const result = await checkAccess(makeTeamAgent(), 'u1', bus, ctx());
    expect(result).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('team: NO teams:is-member registered → forbidden + warns once', async () => {
    const bus = new HookBus();
    const warned: string[] = [];
    const c = makeChatContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u1',
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg) => warned.push(msg),
        error: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => undefined as any }) as any,
      },
    });
    const warnState = { warned: false };
    const r1 = await checkAccess(makeTeamAgent(), 'u1', bus, c, { warnState });
    const r2 = await checkAccess(makeTeamAgent(), 'u1', bus, c, { warnState });
    expect(r1).toEqual({ allowed: false, reason: 'forbidden' });
    expect(r2).toEqual({ allowed: false, reason: 'forbidden' });
    // warnState exists to assert exactly-once warning behavior even across
    // multiple calls within the same test.
    expect(warnState.warned).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toBe('agents_acl_team_check_unavailable');
  });

  it('schema-illegal: owner_type=user with visibility=team → forbidden', async () => {
    const bus = new HookBus();
    // The DB CHECK constraint should make this row impossible, but if it
    // ever reaches runtime (raw SQL bypass), we deny defensively.
    const weird = makePersonalAgent({ visibility: 'team' });
    const result = await checkAccess(weird, 'u1', bus, ctx());
    expect(result).toEqual({ allowed: false, reason: 'forbidden' });
  });
});
