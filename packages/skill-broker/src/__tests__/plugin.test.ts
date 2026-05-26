import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { createSkillBrokerPlugin } from '../plugin.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

function busWithStubs() {
  const bus = new HookBus();
  const registered: string[] = [];
  bus.registerService('tool:register', 'disp', async (_c, d: unknown) => {
    registered.push((d as { name: string }).name);
    return { ok: true };
  });
  bus.registerService('skills:search-catalog', 'skills', async (_c, input: unknown) => {
    const intent = ((input as { intent?: string }).intent ?? '').trim();
    return {
      skills: intent
        ? [
            {
              id: 'linear',
              description: 'Linear',
              tier: 'bounded',
              hosts: ['api.linear.app'],
              slots: ['API_KEY'],
            },
          ]
        : [],
    };
  });
  return { bus, registered };
}

describe('createSkillBrokerPlugin — search_catalog', () => {
  it('manifest declares the execute hook + its calls', () => {
    const p = createSkillBrokerPlugin();
    expect(p.manifest.name).toBe('@ax/skill-broker');
    expect(p.manifest.registers).toContain('tool:execute:search_catalog');
    expect(p.manifest.calls).toEqual(
      expect.arrayContaining(['tool:register', 'skills:search-catalog', 'skills:get']),
    );
  });

  it('registers the search_catalog descriptor on init', async () => {
    const { bus, registered } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    expect(registered).toContain('search_catalog');
  });

  it('search_catalog forwards intent to skills:search-catalog and returns candidates', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:search_catalog', ctx, {
      name: 'search_catalog',
      input: { intent: 'linear issues' },
    });
    expect((out as { skills: Array<{ id: string }> }).skills[0]?.id).toBe('linear');
  });
});
