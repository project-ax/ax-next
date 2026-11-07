import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { can, isAgentMember, roleFor, type ArtifactAction } from '../artifacts/access.js';

// §6.6, exhaustively: every role against every action.
const ACTIONS: ArtifactAction[] = [
  'list',
  'view-any-version',
  'view-current',
  'download',
  'copy-link',
  'restore',
  'rename',
  'set-link',
  'delete',
];

describe('can', () => {
  it.each(ACTIONS)('owner may %s', (a) => expect(can('owner', a)).toBe(true));
  it.each(ACTIONS)('a link holder may %s only if it is view-current or download', (a) =>
    expect(can('link', a)).toBe(a === 'view-current' || a === 'download'));
  it.each(ACTIONS)('nobody else may %s', (a) => expect(can('none', a)).toBe(false));
});

describe('roleFor', () => {
  it('a member is the owner, with or without the code', () => {
    expect(roleFor({ agentMember: true, codeMatched: false })).toBe('owner');
    expect(roleFor({ agentMember: true, codeMatched: true })).toBe('owner');
  });
  it('a non-member with the code holds a link; without it, nothing', () => {
    expect(roleFor({ agentMember: false, codeMatched: true })).toBe('link');
    expect(roleFor({ agentMember: false, codeMatched: false })).toBe('none');
  });
});

describe('isAgentMember', () => {
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u-1' });
  function busAnswering(answer: () => unknown) {
    const bus = new HookBus();
    const seen: unknown[] = [];
    bus.registerService<unknown, unknown>('agents:resolve', 'test-agents', async (_c, input) => {
      seen.push(input);
      return answer();
    });
    return { bus, seen };
  }

  it('asks agents:resolve for the caller and the agent, and a resolved agent is a member', async () => {
    const { bus, seen } = busAnswering(() => ({ agent: { id: 'agt-1' } }));
    await expect(isAgentMember(bus, ctx, 'agt-1')).resolves.toBe(true);
    expect(seen).toEqual([{ agentId: 'agt-1', userId: 'u-1' }]);
  });

  it.each(['not-found', 'forbidden'] as const)('%s is not a member', async (code) => {
    const { bus } = busAnswering(() => {
      throw new PluginError({ code, plugin: 'test-agents', message: 'no' });
    });
    await expect(isAgentMember(bus, ctx, 'agt-1')).resolves.toBe(false);
  });

  it('any other failure is an outage and propagates as itself', async () => {
    const { bus } = busAnswering(() => {
      throw new PluginError({ code: 'timeout', plugin: 'test-agents', message: 'slow' });
    });
    await expect(isAgentMember(bus, ctx, 'agt-1')).rejects.toMatchObject({ code: 'timeout' });
  });
});
