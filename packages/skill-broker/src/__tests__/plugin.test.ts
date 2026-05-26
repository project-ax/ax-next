import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createSkillBrokerPlugin, type SkillBrokerPlugin } from '../plugin.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
const convCtx = makeAgentContext({
  sessionId: 's',
  agentId: 'a',
  userId: 'u',
  conversationId: 'cnv_1',
});

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
  bus.registerService('skills:get', 'skills', async (_c, input: unknown) => {
    const skillId = (input as { skillId: string }).skillId;
    if (skillId === 'linear') {
      return {
        id: 'linear',
        description: 'Read your Linear issues',
        version: 1,
        capabilities: {
          allowedHosts: ['api.linear.app'],
          credentials: [{ slot: 'api_key', kind: 'api-key' }],
        },
      } as never;
    }
    throw new PluginError({ code: 'skill-not-found', plugin: 'skills', message: 'nope' });
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

describe('createSkillBrokerPlugin — request_capability', () => {
  it('manifest declares the request_capability execute hook', () => {
    const p = createSkillBrokerPlugin();
    expect(p.manifest.registers).toContain('tool:execute:request_capability');
  });

  it('registers the request_capability descriptor on init', async () => {
    const { bus, registered } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    expect(registered).toContain('request_capability');
  });

  it('returns { status: "requested" } for a real catalog skill', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:request_capability', ctx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(out).toEqual({ status: 'requested', skillId: 'linear' });
  });

  it('returns { status: "not-found" } for an unknown skill', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:request_capability', ctx, {
      name: 'request_capability',
      input: { skillId: 'ghost' },
    });
    expect(out).toEqual({ status: 'not-found', skillId: 'ghost' });
  });

  it('rejects a malformed skillId before touching the catalog', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    await expect(
      bus.call('tool:execute:request_capability', ctx, {
        name: 'request_capability',
        input: { skillId: '../evil' },
      }),
    ).rejects.toThrow(/valid catalog/i);
  });
});

describe('request_capability — bundled approval card (chat:permission-request)', () => {
  it('fires chat:permission-request with the skill manifest hosts + slots', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });

    const cards: Array<{
      skillId: string;
      description: string;
      hosts: string[];
      slots: { slot: string; kind: string }[];
    }> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });

    const ack = await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });

    expect(ack).toEqual({ status: 'requested', skillId: 'linear' });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({
      skillId: 'linear',
      description: 'Read your Linear issues',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'api_key', kind: 'api-key' }],
    });
  });

  it('raises NO card when the skill is not in the catalog', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p);
      return undefined;
    });
    const out = await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'ghost' },
    });
    expect(out).toEqual({ status: 'not-found', skillId: 'ghost' });
    expect(cards).toHaveLength(0);
  });
});

describe('createSkillBrokerPlugin — open-mode gate (allow_user_installed_skills)', () => {
  it('defaults the open-mode gate OFF when no config is passed', () => {
    const p = createSkillBrokerPlugin() as SkillBrokerPlugin;
    expect(p.allowUserInstalledSkills).toBe(false);
  });

  it('defaults OFF when config omits the flag', () => {
    const p = createSkillBrokerPlugin({}) as SkillBrokerPlugin;
    expect(p.allowUserInstalledSkills).toBe(false);
  });

  it('reflects allowUserInstalledSkills:true when enabled', () => {
    const p = createSkillBrokerPlugin({ allowUserInstalledSkills: true }) as SkillBrokerPlugin;
    expect(p.allowUserInstalledSkills).toBe(true);
  });

  // Half-wired window (TASK-38): the flag is stored + exposed, but the broker
  // registers the SAME tool set in both modes — the authoring tool that the
  // flag gates ships in TASK-39. This pins "behaviorally inert" so a future
  // edit that wires authoring has to update this test deliberately.
  it('registers the same tools whether open mode is on or off', async () => {
    const off = busWithStubs();
    await (createSkillBrokerPlugin({ allowUserInstalledSkills: false }) as SkillBrokerPlugin).init({
      bus: off.bus,
      config: {} as never,
    });
    const on = busWithStubs();
    await (createSkillBrokerPlugin({ allowUserInstalledSkills: true }) as SkillBrokerPlugin).init({
      bus: on.bus,
      config: {} as never,
    });
    expect(off.registered.sort()).toEqual(['request_capability', 'search_catalog']);
    expect(on.registered.sort()).toEqual(off.registered.sort());
  });
});
