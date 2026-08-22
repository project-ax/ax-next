/**
 * `request_capability`'s freshness pair (AW-7).
 *
 * The thing worth proving here is the ROUND TRIP: capture and check must agree
 * on the token for an unchanged catalog, and must DISAGREE the moment the entry
 * moves or vanishes. A producer whose two halves quietly disagree is worse than
 * no producer at all — it stales every decision forever.
 */
import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createSkillBrokerPlugin } from '../plugin.js';
import {
  CAPABILITY_CAPTURE_HOOK,
  CAPABILITY_CHECK_HOOK,
  CATALOG_SKILL_KIND,
} from '../tools/capability-freshness.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

interface Catalog {
  /** The `linear` entry, or null for "not in the catalog". */
  linear: { description: string; connectors?: string[] } | null;
  getThrows?: Error;
}

async function bootWith(catalog: Catalog): Promise<HookBus> {
  const bus = new HookBus();
  bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
  bus.registerService('skills:search-catalog', 'skills', async () => ({ skills: [] }));
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
