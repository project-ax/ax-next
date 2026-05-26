import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createSkillBrokerPlugin, type SkillBrokerPlugin } from '../plugin.js';
import { REQUEST_CAPABILITY_DESCRIPTOR } from '../tools/request-capability.js';
import { registerInstallAuthoredSkill } from '../tools/install-authored-skill.js';

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

  it('description tells the model the conversation continues automatically (TASK-36)', () => {
    const desc = REQUEST_CAPABILITY_DESCRIPTOR.description.toLowerCase();
    expect(desc).toContain('continue automatically');
    // TASK-34's "don't narrate / restate keys" guidance is preserved.
    expect(desc).toContain('do not narrate');
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

  // TASK-39 CLOSES the TASK-38 half-wired pin: open mode now registers the
  // gated install_authored_skill tool; closed mode does not. Curated tools
  // (search_catalog, request_capability) register in BOTH modes.
  it('registers the authoring tool ONLY when open mode is on (closes the TASK-38 half-wired pin)', async () => {
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
    expect(on.registered.sort()).toEqual(['install_authored_skill', 'request_capability', 'search_catalog']);
  });

  it('the manifest registers tool:execute:install_authored_skill only in open mode', () => {
    const off = createSkillBrokerPlugin({ allowUserInstalledSkills: false });
    const on = createSkillBrokerPlugin({ allowUserInstalledSkills: true });
    expect(off.manifest.registers).not.toContain('tool:execute:install_authored_skill');
    expect(on.manifest.registers).toContain('tool:execute:install_authored_skill');
  });
});

// ---------------------------------------------------------------------------
// install_authored_skill tool (TASK-39, open-mode flow C)
// ---------------------------------------------------------------------------

function busForAuthoring() {
  const { bus, registered } = busWithStubs();
  const grants: unknown[] = [];
  const cards: unknown[] = [];
  bus.registerService('agents:install-authored-skill', 'agents', async (_c, input: unknown) => {
    grants.push(input);
    return {
      description: 'Take notes',
      hosts: ['api.example.com'],
      slots: [{ slot: 'API_KEY', kind: 'api-key' }],
    };
  });
  bus.subscribe('chat:permission-request', 'test/card', async (_c, payload) => {
    cards.push(payload);
    return undefined;
  });
  return { bus, registered, grants, cards };
}

function toolCtx() {
  return makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'user-1', conversationId: 'cnv-1' });
}

describe('install_authored_skill tool', () => {
  it('registers the descriptor', async () => {
    const { bus, registered } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    expect(registered).toContain('install_authored_skill');
  });

  it('calls agents:install-authored-skill then fires an authored permission card', async () => {
    const { bus, grants, cards } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    const out = await bus.call('tool:execute:install_authored_skill', toolCtx(), {
      name: 'install_authored_skill',
      input: { skillId: 'notes', hosts: ['api.example.com'], slots: ['API_KEY'] },
    });
    expect(out).toEqual({ status: 'requested', skillId: 'notes' });
    expect(grants).toEqual([
      { agentId: 'agent-1', skillId: 'notes', hosts: ['api.example.com'], slots: ['API_KEY'] },
    ]);
    expect(cards).toEqual([
      {
        skillId: 'notes',
        description: 'Take notes',
        hosts: ['api.example.com'],
        slots: [{ slot: 'API_KEY', kind: 'api-key' }],
        authored: true,
      },
    ]);
  });

  it('rejects a traversal-shaped skillId before reaching the agents hook', async () => {
    const { bus, grants } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    await expect(
      bus.call('tool:execute:install_authored_skill', toolCtx(), {
        name: 'install_authored_skill',
        input: { skillId: '../evil', hosts: [], slots: [] },
      }),
    ).rejects.toThrow(/valid "skillId"|invalid/i);
    expect(grants).toEqual([]);
  });

  it('drops malformed hosts/slots (filtered before the card)', async () => {
    const { bus, grants } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    await bus.call('tool:execute:install_authored_skill', toolCtx(), {
      name: 'install_authored_skill',
      input: {
        skillId: 'notes',
        // 'bad host!' has a space; 'api_key' (lowercase) + 'no-dashes!' fail the
        // SCREAMING_SNAKE slot grammar that matches parseSkillManifest.
        hosts: ['ok.example.com', 'bad host!'],
        slots: ['API_KEY', 'api_key', 'no-dashes!'],
      },
    });
    expect(grants[0]).toEqual({
      agentId: 'agent-1',
      skillId: 'notes',
      hosts: ['ok.example.com'],
      slots: ['API_KEY'],
    });
  });

  it('surfaces a clear tool error when @ax/agents is not loaded', async () => {
    // busWithStubs has no agents:install-authored-skill service.
    const { bus } = busWithStubs();
    await registerInstallAuthoredSkill(bus);
    await expect(
      bus.call('tool:execute:install_authored_skill', toolCtx(), {
        name: 'install_authored_skill',
        input: { skillId: 'notes', hosts: [], slots: [] },
      }),
    ).rejects.toThrow(/not available in this deployment/i);
  });
});
