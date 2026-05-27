import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createSkillBrokerPlugin, type SkillBrokerPlugin } from '../plugin.js';
import { REQUEST_CAPABILITY_DESCRIPTOR } from '../tools/request-capability.js';
import { SEARCH_CATALOG_DESCRIPTOR } from '../tools/search-catalog.js';
import { registerInstallAuthoredSkill } from '../tools/install-authored-skill.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
const convCtx = makeAgentContext({
  sessionId: 's',
  agentId: 'a',
  userId: 'u',
  conversationId: 'cnv_1',
});

function busWithStubs(
  opts: {
    /** credential slots the stub `linear` skill declares (default: one account-free slot). */
    linearCredentials?: Array<{ slot: string; kind: 'api-key'; account?: string }>;
    /** when true, register a credentials:list stub seeded with `vaultRefs`. */
    withVault?: boolean;
    /** when false, do NOT register the catalog:submit stub (degrade path). default true. */
    withCatalogSubmit?: boolean;
    /** when true, skills:search-catalog returns [] for ANY intent (force a miss). */
    searchAlwaysEmpty?: boolean;
  } = {},
) {
  const bus = new HookBus();
  const registered: string[] = [];
  // Cold-start admit-queue submissions captured for assertions (TASK-53).
  const coldStarts: Array<{
    kind: string;
    skillId: string;
    requestedByUserId: string;
    description: string;
  }> = [];
  const linearCredentials = opts.linearCredentials ?? [{ slot: 'api_key', kind: 'api-key' }];
  // The user's existing vault entries (account:<service> refs). A closure the
  // test flips via setVault before invoking the tool.
  let vaultRefs: string[] = [];
  const setVault = (refs: string[]): void => {
    vaultRefs = refs;
  };
  bus.registerService('tool:register', 'disp', async (_c, d: unknown) => {
    registered.push((d as { name: string }).name);
    return { ok: true };
  });
  bus.registerService('skills:search-catalog', 'skills', async (_c, input: unknown) => {
    const intent = ((input as { intent?: string }).intent ?? '').trim();
    return {
      skills:
        intent && opts.searchAlwaysEmpty !== true
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
          credentials: linearCredentials,
        },
      } as never;
    }
    throw new PluginError({ code: 'skill-not-found', plugin: 'skills', message: 'nope' });
  });
  if (opts.withVault === true) {
    // Metadata-only vault listing — refs + kinds, NEVER a secret value.
    bus.registerService('credentials:list', 'creds', async (_c, _input: unknown) => ({
      credentials: vaultRefs.map((ref) => ({
        scope: 'user' as const,
        ownerId: 'u',
        ref,
        kind: 'api-key',
        createdAt: new Date(0).toISOString(),
      })),
    }));
  }
  if (opts.withCatalogSubmit !== false) {
    // The admit-queue submit hook (owned by @ax/skills in production). The
    // broker fires kind:'cold-start' on a search/request miss (TASK-53, §13).
    bus.registerService('catalog:submit', 'skills', async (_c, input: unknown) => {
      coldStarts.push(input as never);
      return { requestId: 'req_stub', created: true, status: 'pending' };
    });
  }
  return { bus, registered, setVault, coldStarts };
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

  // TASK-56 (design §13): on an empty result the broker has filed an admit
  // request; the descriptor steers the model to narrate "asked your admin",
  // not an error.
  it('descriptor steers cold-start narration on an empty result (TASK-56)', () => {
    const desc = SEARCH_CATALOG_DESCRIPTOR.description.toLowerCase();
    expect(desc).toContain('asked your admin');
    expect(desc).toContain('not an error');
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

// TASK-53 (design §13) — a search_catalog MISS (no candidates) also files a
// cold-start admit-queue request, carrying the untrusted free-text intent as the
// (clamped) description and a locally-derived dedup slug as the skillId. The
// returned (empty) result is unchanged.
describe('search_catalog — cold-start admit-queue trigger (TASK-53)', () => {
  it('files a cold-start catalog:submit when the catalog returns no candidates', async () => {
    // searchAlwaysEmpty forces the catalog stub to miss for any intent.
    const { bus, coldStarts } = busWithStubs({ searchAlwaysEmpty: true });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:search_catalog', ctx, {
      name: 'search_catalog',
      input: { intent: 'Read my Notion pages' },
    });
    expect(out).toEqual({ skills: [] });
    expect(coldStarts).toEqual([
      {
        kind: 'cold-start',
        skillId: 'read-my-notion-pages',
        requestedByUserId: 'u',
        description: 'Read my Notion pages',
      },
    ]);
  });

  it('files NO cold-start when the catalog returns at least one candidate', async () => {
    const { bus, coldStarts } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    await bus.call('tool:execute:search_catalog', ctx, {
      name: 'search_catalog',
      input: { intent: 'linear issues' },
    });
    expect(coldStarts).toEqual([]);
  });

  it('files NO cold-start for an empty/whitespace intent (no signal to file)', async () => {
    const { bus, coldStarts } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    // The default stub returns [] for an empty intent.
    await bus.call('tool:execute:search_catalog', ctx, {
      name: 'search_catalog',
      input: { intent: '   ' },
    });
    expect(coldStarts).toEqual([]);
  });

  it('still returns the empty result when catalog:submit is unavailable (degrade)', async () => {
    const { bus } = busWithStubs({ withCatalogSubmit: false, searchAlwaysEmpty: true });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:search_catalog', ctx, {
      name: 'search_catalog',
      input: { intent: 'something the catalog lacks' },
    });
    expect(out).toEqual({ skills: [] });
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

  // TASK-56 (design §13): on a not-found result the broker has filed an admit
  // request; the descriptor steers the model to narrate "asked your admin",
  // not an error.
  it('descriptor steers cold-start narration on a not-found result (TASK-56)', () => {
    const desc = REQUEST_CAPABILITY_DESCRIPTOR.description.toLowerCase();
    expect(desc).toContain('asked your admin');
    expect(desc).toContain('not an error');
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

// TASK-53 (design §13) — a request_capability MISS files a cold-start admit-queue
// request so the unmet need reaches the admin. The model-facing return is
// unchanged (still {status:'not-found'}); the submit is a best-effort side-effect.
describe('request_capability — cold-start admit-queue trigger (TASK-53)', () => {
  it('files a cold-start catalog:submit on a not-found miss (return unchanged)', async () => {
    const { bus, coldStarts } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:request_capability', ctx, {
      name: 'request_capability',
      input: { skillId: 'ghost' },
    });
    expect(out).toEqual({ status: 'not-found', skillId: 'ghost' });
    expect(coldStarts).toEqual([
      {
        kind: 'cold-start',
        skillId: 'ghost',
        // requestedByUserId comes from the authenticated ctx, never model input.
        requestedByUserId: 'u',
        description: expect.stringContaining("'ghost'") as unknown as string,
      },
    ]);
  });

  it('files NO cold-start when the skill IS in the catalog', async () => {
    const { bus, coldStarts } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    await bus.call('tool:execute:request_capability', ctx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(coldStarts).toEqual([]);
  });

  it('files NO cold-start for a malformed skillId (throws before the catalog)', async () => {
    const { bus, coldStarts } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    await expect(
      bus.call('tool:execute:request_capability', ctx, {
        name: 'request_capability',
        input: { skillId: '../evil' },
      }),
    ).rejects.toThrow(/valid catalog/i);
    expect(coldStarts).toEqual([]);
  });

  it('still returns not-found cleanly when catalog:submit is unavailable (degrade)', async () => {
    const { bus } = busWithStubs({ withCatalogSubmit: false });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:request_capability', ctx, {
      name: 'request_capability',
      input: { skillId: 'ghost' },
    });
    expect(out).toEqual({ status: 'not-found', skillId: 'ghost' });
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
      kind: 'skill',
      skillId: 'linear',
      description: 'Read your Linear issues',
      hosts: ['api.linear.app'],
      // Account-free slot: no `account` key, haveExisting false (never vaulted).
      slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: false }],
    });
  });

  // JIT P2/P7.2 — when a slot declares `account: <svc>` and the user already
  // has the vaulted key, the card marks haveExisting:true so the UI offers
  // "use your existing <service> key" with no re-entry.
  it('card marks haveExisting:true + account when the user already has the vaulted key', async () => {
    const { bus, setVault } = busWithStubs({
      linearCredentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' }],
      withVault: true,
    });
    setVault(['account:linear']);
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: Array<{ slots: unknown[] }> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(cards[0]?.slots).toEqual([
      { slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: true },
    ]);
  });

  it('card marks haveExisting:false when the vault has no entry yet', async () => {
    const { bus, setVault } = busWithStubs({
      linearCredentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' }],
      withVault: true,
    });
    setVault([]); // empty vault
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: Array<{ slots: Array<Record<string, unknown>> }> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(cards[0]?.slots[0]).toMatchObject({
      slot: 'LINEAR_TOKEN',
      account: 'linear',
      haveExisting: false,
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
    const inp = input as { packages?: { npm?: string[]; pypi?: string[] } };
    return {
      description: 'Take notes',
      hosts: ['api.example.com'],
      slots: [{ slot: 'API_KEY', kind: 'api-key' }],
      packages: inp.packages ?? { npm: [], pypi: [] },
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
      { agentId: 'agent-1', skillId: 'notes', hosts: ['api.example.com'], slots: ['API_KEY'], packages: { npm: [], pypi: [] } },
    ]);
    expect(cards).toEqual([
      {
        kind: 'skill',
        skillId: 'notes',
        description: 'Take notes',
        hosts: ['api.example.com'],
        slots: [{ slot: 'API_KEY', kind: 'api-key' }],
        packages: { npm: [], pypi: [] },
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
      packages: { npm: [], pypi: [] },
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

  it('forwards validated packages to the promote and the approval card', async () => {
    // Override the agents stub to echo back packages and record input.
    const bus = new HookBus();
    const registered: string[] = [];
    bus.registerService('tool:register', 'disp', async (_c, d: unknown) => {
      registered.push((d as { name: string }).name);
      return { ok: true };
    });
    let promoteInput: Record<string, unknown> = {};
    bus.registerService('agents:install-authored-skill', 'agents', async (_c, input: unknown) => {
      promoteInput = input as Record<string, unknown>;
      const inp = input as { packages?: { npm?: string[]; pypi?: string[] } };
      return {
        description: 'Cowsay skill',
        hosts: [],
        slots: [],
        packages: inp.packages ?? { npm: [], pypi: [] },
      };
    });
    const firedCards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/card', async (_c, payload) => {
      firedCards.push(payload);
      return undefined;
    });

    await registerInstallAuthoredSkill(bus);
    expect(registered).toEqual(['install_authored_skill']);
    await bus.call('tool:execute:install_authored_skill', toolCtx(), {
      name: 'install_authored_skill',
      // '@anthropic-ai/sdk' is a scoped npm name and MUST survive the filter;
      // 'BAD NAME' (space) must be dropped at the trust boundary.
      input: {
        skillId: 'demo',
        hosts: [],
        slots: [],
        packages: { npm: ['cowsay', '@anthropic-ai/sdk', 'BAD NAME'], pypi: [] },
      },
    });

    const firedCard = firedCards[0] as Record<string, unknown>;
    const pkgIn = promoteInput.packages as { npm: string[]; pypi: string[] };
    expect(pkgIn.npm).toEqual(['cowsay', '@anthropic-ai/sdk']);
    expect(pkgIn.pypi).toEqual([]);
    expect((firedCard.packages as { npm: string[] }).npm).toEqual(['cowsay', '@anthropic-ai/sdk']);
  });

  it('omits packages (empty) when none provided', async () => {
    const { bus, grants, cards } = busForAuthoring();
    await registerInstallAuthoredSkill(bus);
    await bus.call('tool:execute:install_authored_skill', toolCtx(), {
      name: 'install_authored_skill',
      input: { skillId: 'notes', hosts: [], slots: [] },
    });
    const grant = grants[0] as Record<string, unknown>;
    const card = cards[0] as Record<string, unknown>;
    // When packages is not provided, it should default to { npm: [], pypi: [] }.
    expect(grant.packages).toEqual({ npm: [], pypi: [] });
    expect(card.packages).toEqual({ npm: [], pypi: [] });
  });
});
