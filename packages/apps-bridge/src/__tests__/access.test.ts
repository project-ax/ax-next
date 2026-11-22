import { PluginError, type AgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { bridgeCtx, canManageAgent, connectorNames, effectiveConnectors, resolveAgent, type AgentView, type BridgeBus } from '../access.js';

/*
  The shared reads: each sends exactly the payload its owning hook expects,
  reads the answer structurally (no runtime import of @ax/agents or
  @ax/connectors), and turns "not this person's" into null/false while any
  other failure, or an answer it can't read, throws.
*/

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const pluginError = (code: string) => new PluginError({ code, plugin: 'fake', message: code });

function fakeBus(answer: (hook: string, input: unknown) => unknown) {
  const calls: Array<{ hook: string; ctx: AgentContext; input: unknown }> = [];
  const bus: BridgeBus = {
    async call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> {
      calls.push({ hook, ctx, input });
      return (await answer(hook, input)) as O;
    },
  };
  return { bus, calls };
}

const ctx = bridgeCtx('usr_ada', 'agt_support', silent);

const AGENT = {
  id: 'agt_support',
  ownerId: 'usr_ada',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'Support',
  connectorAttachments: ['linear', 'github'],
  connectorExclusions: ['notion'],
  model: 'x',
};

describe('access', () => {
  it('bridgeCtx runs as the given person and agent, in the apps-bridge session', () => {
    expect(ctx.userId).toBe('usr_ada');
    expect(ctx.agentId).toBe('agt_support');
    expect(ctx.sessionId).toBe('apps-bridge');
    expect(ctx.logger).toBe(silent);
  });

  it('resolveAgent reads the agent; not-found or forbidden is null; anything else throws', async () => {
    const ok = fakeBus(() => ({ agent: AGENT }));
    const view = await resolveAgent(ok.bus, ctx, 'agt_support', 'usr_ada');
    expect(view).toEqual<AgentView>({
      id: 'agt_support',
      ownerId: 'usr_ada',
      ownerType: 'user',
      displayName: 'Support',
      connectorAttachments: ['linear', 'github'],
      connectorExclusions: ['notion'],
    });
    expect(ok.calls).toEqual([{ hook: 'agents:resolve', ctx, input: { agentId: 'agt_support', userId: 'usr_ada' } }]);

    for (const code of ['not-found', 'forbidden']) {
      const miss = fakeBus(() => { throw pluginError(code); });
      expect(await resolveAgent(miss.bus, ctx, 'agt_support', 'usr_ada')).toBeNull();
    }
    const down = fakeBus(() => { throw pluginError('timeout'); });
    await expect(resolveAgent(down.bus, ctx, 'agt_support', 'usr_ada')).rejects.toThrow();
    const plain = fakeBus(() => { throw new Error('not-found'); });
    await expect(resolveAgent(plain.bus, ctx, 'agt_support', 'usr_ada')).rejects.toThrow();

    for (const bad of [null, {}, { agent: null }, { agent: { ...AGENT, ownerType: 'org' } }, { agent: { ...AGENT, ownerId: 7 } }]) {
      const unreadable = fakeBus(() => bad);
      await expect(resolveAgent(unreadable.bus, ctx, 'agt_support', 'usr_ada')).rejects.toThrow();
    }
    // A different agent than asked for is not this agent.
    const other = fakeBus(() => ({ agent: { ...AGENT, id: 'agt_other' } }));
    await expect(resolveAgent(other.bus, ctx, 'agt_support', 'usr_ada')).rejects.toThrow();
    // Missing or odd connector lists read as empty, keeping only strings.
    const lists = fakeBus(() => ({ agent: { ...AGENT, connectorAttachments: ['a', 3], connectorExclusions: undefined } }));
    expect(await resolveAgent(lists.bus, ctx, 'agt_support', 'usr_ada')).toMatchObject({ connectorAttachments: ['a'], connectorExclusions: [] });
  });

  it('effectiveConnectors sends the agent lists and reads ids, names and tool namespaces', async () => {
    const view = (await resolveAgent(fakeBus(() => ({ agent: AGENT })).bus, ctx, 'agt_support', 'usr_ada')) as AgentView;
    const b = fakeBus(() => ({
      connectors: [
        { summary: { id: 'linear', name: 'Linear' }, source: 'attached', toolNamespaces: [{ toolNamespace: 'c0123456789', server: 'main' }] },
        { summary: { id: 'github', name: 'GitHub' }, source: 'attached', toolNamespaces: [] },
      ],
    }));
    expect(await effectiveConnectors(b.bus, ctx, 'usr_ada', view)).toEqual([
      { id: 'linear', name: 'Linear', toolNamespaces: ['c0123456789'] },
      { id: 'github', name: 'GitHub', toolNamespaces: [] },
    ]);
    expect(b.calls).toEqual([
      { hook: 'connectors:list-effective', ctx, input: { userId: 'usr_ada', attachmentIds: ['linear', 'github'], exclusions: ['notion'] } },
    ]);
    const bad = fakeBus(() => ({ nope: 1 }));
    await expect(effectiveConnectors(bad.bus, ctx, 'usr_ada', view)).rejects.toThrow();
  });

  it('connectorNames maps connector ids to names for the person', async () => {
    const b = fakeBus(() => ({ connectors: [{ id: 'linear', name: 'Linear' }, { id: 'github', name: 'GitHub' }, { id: 3 }] }));
    const names = await connectorNames(b.bus, ctx, 'usr_ada');
    expect([...names]).toEqual([
      ['linear', 'Linear'],
      ['github', 'GitHub'],
    ]);
    expect(b.calls).toEqual([{ hook: 'connectors:list', ctx, input: { userId: 'usr_ada' } }]);
    await expect(connectorNames(fakeBus(() => null).bus, ctx, 'usr_ada')).rejects.toThrow();
  });

  it('canManageAgent asks as a non-admin; not-found or forbidden is false; anything else throws', async () => {
    const yes = fakeBus(() => ({ allowed: true }));
    expect(await canManageAgent(yes.bus, ctx, 'agt_support', 'usr_ada')).toBe(true);
    expect(yes.calls).toEqual([
      { hook: 'agents:can-manage-connectors', ctx, input: { agentId: 'agt_support', actor: { userId: 'usr_ada', isAdmin: false } } },
    ]);
    expect(await canManageAgent(fakeBus(() => ({ allowed: false })).bus, ctx, 'agt_support', 'usr_ada')).toBe(false);
    for (const code of ['not-found', 'forbidden']) {
      expect(await canManageAgent(fakeBus(() => { throw pluginError(code); }).bus, ctx, 'agt_support', 'usr_ada')).toBe(false);
    }
    await expect(canManageAgent(fakeBus(() => { throw pluginError('timeout'); }).bus, ctx, 'agt_support', 'usr_ada')).rejects.toThrow();
    await expect(canManageAgent(fakeBus(() => ({ allowed: 'true' })).bus, ctx, 'agt_support', 'usr_ada')).rejects.toThrow();
  });
});
