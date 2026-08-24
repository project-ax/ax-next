/**
 * `request_capability`'s freshness pair (AW-7).
 *
 * The thing worth proving here is the ROUND TRIP: capture and check must agree
 * on the token for an unchanged catalog, and must DISAGREE the moment the entry
 * moves or vanishes. A producer whose two halves quietly disagree is worse than
 * no producer at all — it stales every decision forever.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createSkillBrokerPlugin } from '../plugin.js';
import {
  CAPABILITY_CAPTURE_HOOK,
  CAPABILITY_CHECK_HOOK,
  CATALOG_SKILL_KIND,
} from '../tools/capability-freshness.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

/**
 * One credential slot as `connectors:resolve` hands it over. The four pinned
 * OAuth fields are optional on the wire (DCR is the default path) and each one
 * says WHERE the credential actually points, so each one is reach.
 */
interface StubSlot {
  slot: string;
  kind?: 'api-key' | 'oauth';
  server?: string;
  scopes?: string[];
  clientId?: string;
  clientSecretRef?: string;
  authServerUrl?: string;
  tokenUrl?: string;
}

/** The subset of `connectors:resolve` output a test stub returns. */
interface StubResolve {
  keyMode?: 'personal' | 'workspace';
  requiresSharedKeyConsent?: boolean;
  /**
   * The connector's model-facing blurb. Present here ONLY so a test can prove
   * the digest ignores it — it is prose, not reach, and rewording it must not
   * stale an in-flight approval.
   */
  usageNote?: string;
  capabilities?: {
    allowedHosts?: string[];
    credentials?: Array<StubSlot>;
    mcpServers?: Array<Record<string, unknown>>;
    packages?: { npm?: string[]; pypi?: string[] };
    services?: Array<Record<string, unknown>>;
  };
}

interface Catalog {
  /** The `linear` entry, or null for "not in the catalog". */
  linear: { description: string; connectors?: string[] } | null;
  getThrows?: Error;
  /**
   * The live connector registry, keyed by id. Present ⇒ a `connectors:resolve`
   * stub is registered; ABSENT ⇒ the hook is not on the bus at all, which is
   * the stripped/connector-less preset the reach fold has to degrade for.
   * A missing key inside a present registry is a clean `not-found`.
   */
  registry?: Record<string, StubResolve>;
  resolveThrows?: Error;
}

async function bootWith(catalog: Catalog): Promise<HookBus> {
  const bus = new HookBus();
  bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
  bus.registerService('skills:search-catalog', 'skills', async () => ({ skills: [] }));
  if (catalog.registry !== undefined) {
    bus.registerService('connectors:resolve', 'connectors', async (_c, input: unknown) => {
      if (catalog.resolveThrows) throw catalog.resolveThrows;
      const { connectorId } = input as { connectorId: string };
      const row = catalog.registry?.[connectorId];
      if (row === undefined) {
        throw new PluginError({
          code: 'not-found',
          plugin: 'connectors',
          message: `connector '${connectorId}' not found`,
        });
      }
      return { id: connectorId, keyMode: 'personal', usageNote: '', ...row };
    });
  }
  bus.registerService('skills:get', 'skills', async (_c, input: unknown) => {
    if (catalog.getThrows) throw catalog.getThrows;
    const { skillId } = input as { skillId: string };
    const row = skillId === 'linear' ? catalog.linear : null;
    if (row === null) {
      throw new PluginError({
        code: 'skill-not-found',
        plugin: 'skills',
        message: `skill '${skillId}' not found`,
      });
    }
    return { id: skillId, description: row.description, ...(row.connectors ? { connectors: row.connectors } : {}) };
  });
  await createSkillBrokerPlugin().init({ bus, config: {} });
  return bus;
}

function capture(bus: HookBus, skillId: unknown): Promise<{ predicate: unknown }> {
  return bus.call(CAPABILITY_CAPTURE_HOOK, ctx, {
    call: { id: 't1', name: 'request_capability', input: { skillId } },
  });
}

function check(bus: HookBus, predicate: unknown): Promise<{ value: string; changed?: string }> {
  return bus.call(CAPABILITY_CHECK_HOOK, ctx, { predicate });
}

const PRESENT: Catalog['linear'] = {
  description: 'Read and write Linear issues',
  connectors: ['linear'],
};

describe('@ax/skill-broker — the request_capability freshness pair', () => {
  it('registers both halves, never one', async () => {
    const bus = await bootWith({ linear: PRESENT });
    expect(bus.hasService(CAPABILITY_CAPTURE_HOOK)).toBe(true);
    expect(bus.hasService(CAPABILITY_CHECK_HOOK)).toBe(true);
  });

  it('round-trips unchanged while the catalog entry stands still', async () => {
    const catalog: Catalog = { linear: PRESENT };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');
    expect(predicate).toMatchObject({
      kind: CATALOG_SKILL_KIND,
      label: 'the "linear" entry in the capability catalog',
    });

    const out = await check(bus, predicate);
    expect(out.value).toBe((predicate as { value: string }).value);
    expect(out.changed).toBeUndefined();
  });

  it('DISAGREES once the entry asks for a different set of connectors', async () => {
    // What the human was asked about at 7am is not what would be granted at
    // 1pm: the catalog now reaches somewhere else.
    const catalog: Catalog = { linear: PRESENT };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.linear = { description: PRESENT.description, connectors: ['linear', 'exfil'] };
    const out = await check(bus, predicate);
    expect(out.value).not.toBe((predicate as { value: string }).value);
    expect(out.changed).toMatch(/asks for something different/i);
    expect(out.changed).toContain('linear');
  });

  it('DISAGREES — and says so plainly — once the entry is gone', async () => {
    const catalog: Catalog = { linear: PRESENT };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.linear = null;
    const out = await check(bus, predicate);
    expect(out.value).toMatch(/@absent$/);
    expect(out.changed).toMatch(/no longer in the capability catalog/i);
  });

  it('captures an ABSENT entry as a first-class value, and notices it arriving', async () => {
    const catalog: Catalog = { linear: null };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');
    expect((predicate as { value: string }).value).toBe('linear@absent');

    catalog.linear = PRESENT;
    const out = await check(bus, predicate);
    expect(out.changed).toMatch(/has been added/i);
  });

  it('does NOT trip on a merely reordered connector list', async () => {
    // A false positive costs a human a second look for nothing.
    const catalog: Catalog = { linear: { description: 'd', connectors: ['a', 'b'] } };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.linear = { description: 'd', connectors: ['b', 'a'] };
    expect((await check(bus, predicate)).changed).toBeUndefined();
  });

  it('captures nothing for a call whose skillId the executor would reject anyway', async () => {
    const bus = await bootWith({ linear: PRESENT });
    expect((await capture(bus, 'Not A Valid Id')).predicate).toBeNull();
    expect((await capture(bus, undefined)).predicate).toBeNull();
  });

  it('THROWS on a token it did not write, rather than inventing a value', async () => {
    // @ax/decisions turns a throwing check into "changed", which re-opens the
    // decision and runs nothing. Answering with a made-up value would either
    // execute on a world nobody looked at or stale on one that never moved.
    const bus = await bootWith({ linear: PRESENT });
    await expect(check(bus, { kind: 'thread-head', value: 'nope', label: null })).rejects.toThrow();
  });

  it('propagates a catalog that is DOWN, so the guard fails closed', async () => {
    const catalog: Catalog = { linear: PRESENT };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.getThrows = new Error('the catalog store is unreachable');
    await expect(check(bus, predicate)).rejects.toThrow();
  });

  it('keeps the token to `<skillId>@<digest>` and nothing else', async () => {
    const bus = await bootWith({ linear: PRESENT });
    const { predicate } = await capture(bus, 'linear');
    expect((predicate as { value: string }).value).toMatch(/^linear@[0-9a-f]{16}$/);
  });
});

/**
 * TASK-262 — the reach fold.
 *
 * The catalog entry names connector IDS. Those ids are stable; what they REACH
 * is not. Digesting the entry alone let a connector's hosts, key slots,
 * packages, MCP servers or dev services move under a stable id without the
 * guard noticing — so the 1pm human was asked to approve reach the 7am human
 * never saw. (Consent clarity, not a reach hole: the executor's own permission
 * card re-resolves and re-gates. See the executor's re-resolve test in
 * plugin.test.ts.)
 */
describe('@ax/skill-broker — the freshness predicate follows connector ids into their reach', () => {
  const REACH_CAPS: NonNullable<StubResolve['capabilities']> = {
    allowedHosts: ['api.linear.app'],
    credentials: [{ slot: 'API_KEY', kind: 'api-key' }],
    packages: { npm: ['@linear/sdk'], pypi: [] },
  };
  const REACHES: StubResolve = { capabilities: REACH_CAPS };

  it('DISAGREES when a connector reaches somewhere new under a STABLE id', async () => {
    const catalog: Catalog = { linear: PRESENT, registry: { linear: REACHES } };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    // The catalog entry is untouched — same description, same connector id.
    // Only the connector's reach moved.
    catalog.registry = {
      linear: {
        capabilities: {
          ...REACH_CAPS,
          allowedHosts: ['api.linear.app', 'exfil.example.com'],
        },
      },
    };
    const out = await check(bus, predicate);
    expect(out.value).not.toBe((predicate as { value: string }).value);
    expect(out.changed).toMatch(/asks for something different/i);
  });

  it('DISAGREES on a new key slot, a new package, a new MCP server and a new service', async () => {
    const moves: StubResolve[] = [
      { capabilities: { ...REACH_CAPS, credentials: [{ slot: 'API_KEY' }, { slot: 'ADMIN_KEY' }] } },
      { capabilities: { ...REACH_CAPS, packages: { npm: ['@linear/sdk', 'left-pad'], pypi: [] } } },
      {
        capabilities: {
          ...REACH_CAPS,
          // The sibling producer omits mcpServers from its digest even though
          // resolve returns it. This producer does not inherit that blind spot.
          mcpServers: [
            { name: 'linear', transport: 'http', url: 'https://mcp.linear.app', allowedHosts: ['mcp.linear.app'], credentials: [] },
          ],
        },
      },
      {
        capabilities: {
          ...REACH_CAPS,
          services: [{ name: 'cache', image: `redis@sha256:${'a'.repeat(64)}`, ports: [6379], env: {}, writablePaths: [] }],
        },
      },
      { keyMode: 'workspace', capabilities: REACH_CAPS },
      // The shared-key consent bit is a first-class field on ResolveOutput, and
      // approving means spending a key that is not this person's.
      { requiresSharedKeyConsent: true, capabilities: REACH_CAPS },
    ];
    for (const moved of moves) {
      const catalog: Catalog = { linear: PRESENT, registry: { linear: REACHES } };
      const bus = await bootWith(catalog);
      const { predicate } = await capture(bus, 'linear');
      catalog.registry = { linear: moved };
      expect((await check(bus, predicate)).changed).toBeDefined();
    }
  });

  it('DISAGREES when an OAuth slot widens its SCOPES under a stable slot name', async () => {
    // For an OAuth grant the scopes ARE the reach — `read` becoming
    // `read,write` is exactly this card's bug one level down, so digesting slot
    // NAMES alone would have re-created it.
    const oauth = (scopes: string[]): StubResolve => ({
      capabilities: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'OAUTH', kind: 'oauth', server: 'linear', scopes }],
        packages: { npm: [], pypi: [] },
      },
    });
    const catalog: Catalog = { linear: PRESENT, registry: { linear: oauth(['read']) } };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.registry = { linear: oauth(['read', 'write']) };
    expect((await check(bus, predicate)).changed).toBeDefined();

    // …and a reordered scope list is not a changed one.
    const stable: Catalog = {
      linear: PRESENT,
      registry: { linear: oauth(['read', 'write']) },
    };
    const bus2 = await bootWith(stable);
    const { predicate: p2 } = await capture(bus2, 'linear');
    stable.registry = { linear: oauth(['write', 'read']) };
    expect((await check(bus2, p2)).changed).toBeUndefined();
  });

  /**
   * TASK-319 — the pinned OAuth client + endpoints.
   *
   * `{slot, kind, server, scopes}` alone described the GRANT but never WHERE it
   * is exchanged. An admin could re-point a pinned `authServerUrl` — or swap the
   * pinned `clientId` / `clientSecretRef` — with the digest byte-identical, so
   * an already-approved capability kept its approval while now sending the
   * agent's credential to a different authorization server. `scopes` was
   * already digested for exactly this reason; the server that grants them is
   * the same class of fact.
   *
   * Each field is varied ON ITS OWN with the other four pinned, so each case
   * proves that one field is in the digest and nothing else is doing the work.
   */
  const PINNED_SLOT: StubSlot = {
    slot: 'OAUTH',
    kind: 'oauth',
    server: 'linear',
    scopes: ['read'],
    clientId: 'client-a',
    clientSecretRef: 'account:linear:oauth',
    authServerUrl: 'https://auth.linear.app',
    tokenUrl: 'https://auth.linear.app/token',
  };

  const REPOINTED: Array<Partial<StubSlot>> = [
    { clientId: 'client-b' },
    { clientSecretRef: 'account:someone-else:oauth' },
    { authServerUrl: 'https://auth.evil.example' },
    { tokenUrl: 'https://auth.evil.example/token' },
  ];

  it('DISAGREES when a pinned OAuth client or endpoint is RE-POINTED under a stable slot', async () => {
    const topLevel = (slot: StubSlot): StubResolve => ({
      capabilities: {
        allowedHosts: ['api.linear.app'],
        credentials: [slot],
        packages: { npm: [], pypi: [] },
      },
    });
    for (const patch of REPOINTED) {
      const field = Object.keys(patch)[0];
      const catalog: Catalog = { linear: PRESENT, registry: { linear: topLevel(PINNED_SLOT) } };
      const bus = await bootWith(catalog);
      const { predicate } = await capture(bus, 'linear');

      catalog.registry = { linear: topLevel({ ...PINNED_SLOT, ...patch }) };
      const out = await check(bus, predicate);
      expect(out.changed, `re-pointing ${field} must trip the guard`).toMatch(
        /asks for something different/i,
      );
    }
  });

  it('sees a re-pointed endpoint on an MCP SERVER’s own slots too', async () => {
    // The per-slot fold is shared by the top-level `credentials` list and each
    // `mcpServers[].credentials` list, so widening it moves BOTH at once. That
    // is intended — a slot nested under an MCP server points a credential
    // exactly as hard as a top-level one does — and it is asserted rather than
    // assumed, because a future refactor could easily split the two folds.
    const nested = (slot: StubSlot): StubResolve => ({
      capabilities: {
        allowedHosts: ['mcp.linear.app'],
        credentials: [],
        packages: { npm: [], pypi: [] },
        mcpServers: [
          {
            name: 'linear',
            transport: 'http',
            url: 'https://mcp.linear.app',
            allowedHosts: ['mcp.linear.app'],
            credentials: [slot],
          },
        ],
      },
    });
    for (const patch of REPOINTED) {
      const field = Object.keys(patch)[0];
      const catalog: Catalog = { linear: PRESENT, registry: { linear: nested(PINNED_SLOT) } };
      const bus = await bootWith(catalog);
      const { predicate } = await capture(bus, 'linear');

      catalog.registry = { linear: nested({ ...PINNED_SLOT, ...patch }) };
      expect((await check(bus, predicate)).changed, `nested ${field}`).toBeDefined();
    }
  });

  it('DISAGREES when a dev service gains a healthcheck, or its probe is re-pointed', async () => {
    // A healthcheck is the most reach-shaped field on a dev service: an `exec`
    // probe is a command the backend runs inside the container
    // (`sandbox-k8s`'s `startupProbe`), and a `tcp` probe names the port it
    // opens. Arriving is a change; being re-pointed is a change.
    const svc = (healthcheck?: Record<string, unknown>): StubResolve => ({
      capabilities: {
        allowedHosts: [],
        credentials: [],
        packages: { npm: [], pypi: [] },
        services: [
          {
            name: 'cache',
            image: `redis@sha256:${'a'.repeat(64)}`,
            ports: [6379],
            env: {},
            writablePaths: [],
            ...(healthcheck !== undefined ? { healthcheck } : {}),
          },
        ],
      },
    });

    const moves: Array<[string, Record<string, unknown> | undefined, Record<string, unknown>]> = [
      // An exec probe arriving where there was none: process spawn the 7am
      // human never saw.
      ['an exec probe arriving', undefined, { kind: 'exec', command: ['redis-cli', 'ping'] }],
      // The command's ORDER is meaning, exactly like an MCP server's argv —
      // `['sh','-c','x']` and `['x','-c','sh']` are different commands, so an
      // order-insensitive normalisation would itself be a hole.
      [
        'a reordered exec command',
        { kind: 'exec', command: ['sh', '-c', 'x'] },
        { kind: 'exec', command: ['x', '-c', 'sh'] },
      ],
      ['a re-pointed tcp port', { kind: 'tcp', port: 6379 }, { kind: 'tcp', port: 6380 }],
      // Same port, different mechanism: the union's discriminant is reach too.
      [
        'tcp becoming exec',
        { kind: 'tcp', port: 6379 },
        { kind: 'exec', command: ['redis-cli', 'ping'] },
      ],
    ];

    for (const [what, before, after] of moves) {
      const catalog: Catalog = { linear: PRESENT, registry: { linear: svc(before) } };
      const bus = await bootWith(catalog);
      const { predicate } = await capture(bus, 'linear');

      catalog.registry = { linear: svc(after) };
      expect((await check(bus, predicate)).changed, what).toBeDefined();
    }

    // A probe kind this file has never heard of, and a malformed `command`,
    // DEGRADE — they do not throw. A real resolve is zod-validated (the strict
    // `HealthcheckSchema` behind `connectors:resolve` rejects a non-array
    // `command` before this file ever sees it) so neither should be reachable,
    // but the alternative to a shape check inside a guard is a TypeError that
    // takes the whole approval surface down with it.
    //
    // BOTH malformed shapes are exercised, and only the second one is load
    // bearing for the shape check. `'not-an-array'` is a STRING, and strings
    // are iterable — `[...'ab']` is `['a','b']`, no throw — so a string alone
    // passes with or without the `Array.isArray` guard and demonstrates
    // nothing. `42` is not iterable: spreading it is the TypeError, thrown from
    // inside the guard, that the shape check exists to prevent.
    const malformed: Array<[string, unknown]> = [
      ['an iterable non-array command (a string)', 'not-an-array'],
      ['a NON-iterable command (a number)', 42],
    ];
    for (const [what, command] of malformed) {
      const odd: Catalog = {
        linear: PRESENT,
        registry: {
          linear: svc({ kind: 'divination', command: command as string[] }),
        },
      };
      const bus = await bootWith(odd);
      const { predicate } = await capture(bus, 'linear');
      expect((predicate as { value: string }).value, what).toMatch(/^linear@[0-9a-f]{16}$/);
      // Resolving at all is the assertion: a throw here would have re-opened
      // the decision on a world that never moved.
      expect((await check(bus, predicate)).changed, what).toBeUndefined();
    }
  });

  it('does NOT trip on a reworded usageNote — the digest is reach, not prose', async () => {
    // The over-widening guard. The fix for TASK-319 must not degenerate into
    // "digest everything resolve returns": a rewritten blurb is not a changed
    // world, and staling an in-flight approval over a cosmetic edit is how a
    // guard that cries wolf gets clicked through.
    const note = (usageNote: string): StubResolve => ({ usageNote, capabilities: REACH_CAPS });
    const catalog: Catalog = { linear: PRESENT, registry: { linear: note('Use it for issues') } };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.registry = { linear: note('Use this connector to file Linear issues.') };
    expect((await check(bus, predicate)).changed).toBeUndefined();
  });

  it('does NOT trip when two entries SHARE a name and the registry reorders them', async () => {
    // Ordering by name alone leaves one hole: two MCP servers (or two slots)
    // called the same thing would then be ordered by whatever order the
    // registry handed them over in, and a reorder there would read as a changed
    // world. The lists are ordered by the WHOLE entry, which is a total order.
    const twin = (first: string, second: string): StubResolve => ({
      capabilities: {
        allowedHosts: [],
        credentials: [
          { slot: 'KEY', kind: 'oauth', server: first, scopes: ['read'] },
          { slot: 'KEY', kind: 'oauth', server: second, scopes: ['read'] },
        ],
        mcpServers: [
          { name: 'dup', transport: 'http', url: `https://${first}`, allowedHosts: [], credentials: [] },
          { name: 'dup', transport: 'http', url: `https://${second}`, allowedHosts: [], credentials: [] },
        ],
        packages: { npm: [], pypi: [] },
      },
    });
    const catalog: Catalog = { linear: PRESENT, registry: { linear: twin('a', 'b') } };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.registry = { linear: twin('b', 'a') };
    expect((await check(bus, predicate)).changed).toBeUndefined();
  });

  it('names what it actually checked: the label follows the fold', async () => {
    // The label completes "checked against: …". A human told only "the entry in
    // the capability catalog" after a CONNECTOR moved would inspect the entry,
    // find it untouched, and be left more confused than before.
    const folded = await bootWith({ linear: PRESENT, registry: { linear: REACHES } });
    expect((await capture(folded, 'linear')).predicate).toMatchObject({
      label: 'the "linear" capability and the connectors it reaches',
    });

    // A connector-less preset genuinely checked less, and says so.
    const bare = await bootWith({ linear: PRESENT });
    expect((await capture(bare, 'linear')).predicate).toMatchObject({
      label: 'the "linear" entry in the capability catalog',
    });
  });

  it('does NOT trip on a merely reordered host / slot / package list', async () => {
    // A false positive costs a human a second look for nothing.
    const catalog: Catalog = {
      linear: PRESENT,
      registry: {
        linear: {
          capabilities: {
            allowedHosts: ['a.example.com', 'b.example.com'],
            credentials: [{ slot: 'ONE' }, { slot: 'TWO' }],
            packages: { npm: ['x', 'y'], pypi: [] },
          },
        },
      },
    };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.registry = {
      linear: {
        capabilities: {
          allowedHosts: ['b.example.com', 'a.example.com'],
          credentials: [{ slot: 'TWO' }, { slot: 'ONE' }],
          packages: { npm: ['y', 'x'], pypi: [] },
        },
      },
    };
    expect((await check(bus, predicate)).changed).toBeUndefined();
  });

  it('treats a referenced-but-uninstalled connector as ABSENT, and notices it arriving', async () => {
    // A catalog entry may name a connector nobody has installed yet. That is a
    // first-class state, not a failure — and it becoming installed is the world
    // moving in the direction the human most needs to hear about.
    const catalog: Catalog = { linear: PRESENT, registry: {} };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');
    expect(predicate).not.toBeNull();

    catalog.registry = { linear: REACHES };
    expect((await check(bus, predicate)).changed).toMatch(/asks for something different/i);
  });

  it('propagates a connector registry that is DOWN, so the guard fails closed', async () => {
    // The executor SWALLOWS a per-connector resolve failure (it must still show
    // a card). A freshness producer must not: a blip that reads as "unchanged"
    // would execute on a world nobody looked at.
    const catalog: Catalog = { linear: PRESENT, registry: { linear: REACHES } };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');

    catalog.resolveThrows = new Error('the connector registry is unreachable');
    await expect(check(bus, predicate)).rejects.toThrow();
  });

  it('ignores a connector id the executor would refuse to resolve', async () => {
    // Same grammar the executor filters on, so the predicate never depends on
    // reach the card could not have shown.
    const catalog: Catalog = {
      linear: { description: 'd', connectors: ['Not A Connector Id'] },
      registry: {},
    };
    const bus = await bootWith(catalog);
    const { predicate } = await capture(bus, 'linear');
    expect((predicate as { value: string }).value).toMatch(/^linear@[0-9a-f]{16}$/);
    expect((await check(bus, predicate)).changed).toBeUndefined();
  });

  it('still guards the catalog entry with NO connectors:resolve on the bus at all', async () => {
    // THE REGRESSION GUARD. The sibling producer (@ax/tool-connector-propose)
    // returns `{predicate:null}` when connectors:resolve is missing, because
    // without it that producer has no world to read at all. Copying that shape
    // HERE would blank this predicate and delete the working catalog guard in
    // every connector-less preset. The gate belongs on the reach FOLD, never on
    // the predicate.
    const catalog: Catalog = { linear: PRESENT };
    const bus = await bootWith(catalog);
    expect(bus.hasService('connectors:resolve')).toBe(false);

    const { predicate } = await capture(bus, 'linear');
    expect(predicate).not.toBeNull();
    expect(predicate).toMatchObject({ kind: CATALOG_SKILL_KIND });
    expect((predicate as { value: string }).value).toMatch(/^linear@[0-9a-f]{16}$/);

    // …and it still trips on a catalog edit, which is the whole point.
    catalog.linear = { description: PRESENT.description, connectors: ['linear', 'exfil'] };
    const out = await check(bus, predicate);
    expect(out.value).not.toBe((predicate as { value: string }).value);
    expect(out.changed).toMatch(/asks for something different/i);
  });

  it('leaves the connector-less digest byte-identical to the pre-fold shape', async () => {
    // Belt to the braces above: a preset with no connectors:resolve sees no
    // digest churn at all from TASK-262, so no in-flight row there is staled.
    const bus = await bootWith({ linear: PRESENT });
    const { predicate } = await capture(bus, 'linear');
    const expected = createHash('sha256')
      .update(JSON.stringify({ description: PRESENT.description, connectors: ['linear'] }))
      .digest('hex')
      .slice(0, 16);
    expect((predicate as { value: string }).value).toBe(`linear@${expected}`);
  });

  it('resolves every referenced connector IN PARALLEL, inside capture’s 3 s budget', async () => {
    // Capture runs inside tool.pre-call's 10 s IPC ceiling on a 3 s budget, and
    // the two sides of the guard fail in OPPOSITE directions on overrun:
    // capture fails OPEN (an unguarded row), check fails CLOSED (a spurious
    // stale). A serial fan-out over N connectors is how that budget gets blown,
    // so the fold must not be serial.
    let live = 0;
    let peak = 0;
    const bus = new HookBus();
    bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
    bus.registerService('skills:search-catalog', 'skills', async () => ({ skills: [] }));
    bus.registerService('skills:get', 'skills', async () => ({
      id: 'linear',
      description: 'd',
      connectors: ['a', 'b', 'c', 'd'],
    }));
    bus.registerService('connectors:resolve', 'connectors', async (_c, input: unknown) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return { id: (input as { connectorId: string }).connectorId, keyMode: 'personal', usageNote: '', capabilities: { allowedHosts: [], credentials: [], packages: { npm: [], pypi: [] } } };
    });
    await createSkillBrokerPlugin().init({ bus, config: {} });

    await capture(bus, 'linear');
    expect(peak).toBe(4);
  });
});
