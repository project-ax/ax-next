import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createSkillBrokerPlugin } from '../plugin.js';
import { REQUEST_CAPABILITY_DESCRIPTOR } from '../tools/request-capability.js';
import { SEARCH_CATALOG_DESCRIPTOR } from '../tools/search-catalog.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
const convCtx = makeAgentContext({
  sessionId: 's',
  agentId: 'a',
  userId: 'u',
  conversationId: 'cnv_1',
});

function busWithStubs(
  opts: {
    /** when true, register a credentials:list stub seeded with `vaultRefs`. */
    withVault?: boolean;
    /** when false, do NOT register the catalog:submit stub (degrade path). default true. */
    withCatalogSubmit?: boolean;
    /** when true, skills:search-catalog returns [] for ANY intent (force a miss). */
    searchAlwaysEmpty?: boolean;
    /** TASK-111 — the connector ids the stub `linear` skill references. */
    linearConnectors?: string[];
    /** TASK-111 — register a connectors:resolve stub. A function lets a test
     *  resolve per-id (or throw to exercise the NON-FATAL path); when omitted,
     *  no connectors:resolve hook is registered (stripped-preset behavior). */
    connectorsResolve?: (connectorId: string) => {
      id: string;
      keyMode?: 'personal' | 'workspace';
      capabilities: {
        allowedHosts: string[];
        credentials: Array<{ slot: string; kind: 'api-key'; account?: string }>;
        mcpServers?: unknown[];
        packages?: { npm?: string[]; pypi?: string[] };
      };
    };
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
      // TASK-100 — a skill declares NO capabilities; the broker builds the card
      // entirely from the connectors the skill references.
      return {
        id: 'linear',
        description: 'Read your Linear issues',
        version: 1,
        ...(opts.linearConnectors !== undefined ? { connectors: opts.linearConnectors } : { connectors: [] }),
      } as never;
    }
    throw new PluginError({ code: 'skill-not-found', plugin: 'skills', message: 'nope' });
  });
  // TASK-111 — optional connectors:resolve stub. The broker resolves a requested
  // skill's referenced connectors and folds their reach into the approval card.
  if (opts.connectorsResolve !== undefined) {
    const resolveFn = opts.connectorsResolve;
    bus.registerService('connectors:resolve', 'connectors', async (_c, input: unknown) => {
      const connectorId = (input as { connectorId: string }).connectorId;
      return resolveFn(connectorId) as never;
    });
  }
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
  it('TASK-100: fires NO card for a skill that references no connectors (instruction-only)', async () => {
    // A skill declares no caps of its own; with no resolvable connector reach,
    // request_capability has nothing to gate → no card (the ack is still requested).
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });

    const cards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });

    const ack = await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });

    expect(ack).toEqual({ status: 'requested', skillId: 'linear' });
    expect(cards).toHaveLength(0);
  });

  it('fires a card built from the referenced connector\'s hosts + slots', async () => {
    const { bus } = busWithStubs({
      linearConnectors: ['linear'],
      connectorsResolve: (id) => ({
        id,
        keyMode: 'personal',
        capabilities: {
          allowedHosts: ['api.linear.app'],
          credentials: [{ slot: 'api_key', kind: 'api-key' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });

    const cards: Array<{
      skillId: string;
      description: string;
      hosts: string[];
      slots: { slot: string; kind: string }[];
      packages: { npm: string[]; pypi: string[] };
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
      // TASK-124 — single-slot connector keeps the collapsed ref; `service` is
      // the connectorId fallback (slot has no account), no slotTag.
      slots: [{ slot: 'api_key', kind: 'api-key', service: 'linear', haveExisting: false }],
      packages: { npm: [], pypi: [] },
    });
  });

  // JIT P2/P7.2 — a connector slot tagged `account: <svc>` + a vaulted key →
  // haveExisting:true.
  it('card marks haveExisting:true + account when the user already has the connector\'s vaulted key', async () => {
    const { bus, setVault } = busWithStubs({
      linearConnectors: ['linear'],
      withVault: true,
      connectorsResolve: (id) => ({
        id,
        capabilities: {
          allowedHosts: ['api.linear.app'],
          credentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
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
      // TASK-124 — single-slot connector: collapsed ref, `service` = the account
      // tag, no slotTag; haveExisting matches `account:linear`.
      { slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', service: 'linear', haveExisting: true },
    ]);
  });

  // TASK-124 — a ≥2-slot referenced connector yields one card slot per slot, each
  // carrying its own slotTag + per-slot haveExisting (`account:<service>:<slot>`).
  it('card builds per-slot tags for a multi-slot referenced connector', async () => {
    const { bus, setVault } = busWithStubs({
      linearConnectors: ['oauthsvc'],
      withVault: true,
      connectorsResolve: (id) => ({
        id,
        capabilities: {
          allowedHosts: [],
          credentials: [
            { slot: 'CLIENT_ID', kind: 'api-key' },
            { slot: 'CLIENT_SECRET', kind: 'api-key' },
          ],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    });
    // Only the CLIENT_ID row is vaulted.
    setVault(['account:oauthsvc:CLIENT_ID']);
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
    expect(cards[0]?.slots).toEqual([
      {
        slot: 'CLIENT_ID',
        kind: 'api-key',
        service: 'oauthsvc',
        slotTag: 'CLIENT_ID',
        haveExisting: true,
      },
      {
        slot: 'CLIENT_SECRET',
        kind: 'api-key',
        service: 'oauthsvc',
        slotTag: 'CLIENT_SECRET',
        haveExisting: false,
      },
    ]);
  });

  it('card marks haveExisting:false when the vault has no entry yet', async () => {
    const { bus, setVault } = busWithStubs({
      linearConnectors: ['linear'],
      withVault: true,
      connectorsResolve: (id) => ({
        id,
        capabilities: {
          allowedHosts: ['api.linear.app'],
          credentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
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

// ---------------------------------------------------------------------------
// TASK-111 — request_capability routes through connector-derived caps. When the
// requested catalog skill declares connectors[], the broker resolves each via
// connectors:resolve and folds the connector's hosts/slots/packages into the
// approval card (reusing the existing kind:'skill' card + the TASK-93 wall). The
// skill's own capability block still contributes (both paths live — no-regression).
// ---------------------------------------------------------------------------

describe('request_capability — connector-derived caps (TASK-111)', () => {
  it('folds a referenced connector\'s hosts + slots into the card', async () => {
    const { bus } = busWithStubs({
      // TASK-100 — the skill declares no caps of its own; it references a
      // connector, whose reach builds the card.
      linearConnectors: ['gh'],
      connectorsResolve: (id) => ({
        id,
        keyMode: 'personal',
        capabilities: {
          allowedHosts: ['api.github.com'],
          credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: Array<{
      hosts: string[];
      slots: Array<{ slot: string }>;
      packages: { npm: string[]; pypi: string[] };
    }> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(cards).toHaveLength(1);
    // Only the connector's host + slot are on the card (the skill has none).
    expect(cards[0]!.hosts).toEqual(['api.github.com']);
    expect(cards[0]!.slots.map((s) => s.slot)).toEqual(['GITHUB_TOKEN']);
  });

  it('dedups a host declared by BOTH the skill block and the connector', async () => {
    const { bus } = busWithStubs({
      linearConnectors: ['linear-conn'],
      connectorsResolve: (id) => ({
        id,
        capabilities: {
          // Same host the skill block already declares.
          allowedHosts: ['api.linear.app'],
          credentials: [],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: Array<{ hosts: string[] }> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    // api.linear.app appears exactly once despite both sources declaring it.
    expect(cards[0]!.hosts).toEqual(['api.linear.app']);
  });

  it('folds a connector\'s packages into the card', async () => {
    const { bus } = busWithStubs({
      linearConnectors: ['sf'],
      connectorsResolve: (id) => ({
        id,
        capabilities: {
          allowedHosts: [],
          credentials: [],
          mcpServers: [],
          packages: { npm: ['@salesforce/cli'], pypi: [] },
        },
      }),
    });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: Array<{ packages: { npm: string[]; pypi: string[] } }> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(cards[0]!.packages.npm).toEqual(['@salesforce/cli']);
  });

  it('carries the connector slot\'s account tag (+ haveExisting from the vault)', async () => {
    const { bus, setVault } = busWithStubs({
      linearConnectors: ['gdrive'],
      withVault: true,
      connectorsResolve: (id) => ({
        id,
        capabilities: {
          allowedHosts: [],
          credentials: [{ slot: 'GDRIVE_TOKEN', kind: 'api-key', account: 'google' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    });
    setVault(['account:google']);
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
    const connectorSlot = cards[0]!.slots.find((s) => s['slot'] === 'GDRIVE_TOKEN');
    expect(connectorSlot).toMatchObject({
      slot: 'GDRIVE_TOKEN',
      account: 'google',
      haveExisting: true,
    });
  });

  it('is NON-FATAL: a throwing connectors:resolve fires NO card (no other reach) but still acks', async () => {
    const { bus } = busWithStubs({
      linearConnectors: ['boom'],
      connectorsResolve: () => {
        throw new Error('resolve failed');
      },
    });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    const ack = await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    // The ack still succeeds; the connector resolve failed so there is no reach
    // to gate → no card (a skill has no caps of its own — TASK-100).
    expect(ack).toEqual({ status: 'requested', skillId: 'linear' });
    expect(cards).toHaveLength(0);
  });

  it('no-regression: a skill with NO connectors fires NO card (instruction-only)', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    const ack = await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(ack).toEqual({ status: 'requested', skillId: 'linear' });
    expect(cards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FIX B: request_capability card must include packages from skill capabilities
// ---------------------------------------------------------------------------

describe('request_capability — packages on approval card (TASK-100: from connectors)', () => {
  it('card carries packages from the referenced connector', async () => {
    const { bus } = busWithStubs({
      linearConnectors: ['requests-conn'],
      connectorsResolve: (id) => ({
        id,
        capabilities: {
          allowedHosts: ['api.example.com'],
          credentials: [],
          mcpServers: [],
          packages: { npm: [], pypi: ['requests'] },
        },
      }),
    });
    await createSkillBrokerPlugin().init({ bus, config: {} as never });

    const cards: Array<Record<string, unknown>> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });

    await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]!['packages']).toEqual({ npm: [], pypi: ['requests'] });
  });

  it('fires no card when a skill references no connectors (no packages of its own)', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });

    const cards: Array<Record<string, unknown>> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });

    await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });

    // TASK-100 — a skill declares no caps; with no connector reach, no card fires.
    expect(cards).toHaveLength(0);
  });
});
