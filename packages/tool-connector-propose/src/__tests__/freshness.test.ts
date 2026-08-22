/**
 * `connector_propose`'s freshness pair (AW-7).
 *
 * The thing worth proving here is the ROUND TRIP: capture and check must agree
 * on the token for an unchanged world, and must DISAGREE the moment the
 * registry moves. A producer whose two halves quietly disagree is worse than no
 * producer at all — it stales every decision forever.
 */
import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createToolConnectorProposePlugin } from '../plugin.js';
import { CONNECTOR_PROPOSE_TOOL_NAME } from '../descriptor.js';
import {
  CONNECTOR_CAPTURE_HOOK,
  CONNECTOR_CHECK_HOOK,
  CONNECTOR_REGISTRY_KIND,
} from '../freshness.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent_1', userId: 'user_1' });

interface Registry {
  /** What `connectors:resolve` answers for `linear`, or null for "not there". */
  linear: { keyMode: string; hosts: string[]; slots: string[] } | null;
  resolveThrows?: Error;
}

interface ResolveArgs {
  userId: string;
  connectorId: string;
}

async function bootWith(
  registry: Registry | null,
): Promise<{ bus: HookBus; resolveCalls: ResolveArgs[] }> {
  const bus = new HookBus();
  const resolveCalls: ResolveArgs[] = [];
  bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
  bus.registerService('connectors:install-authored', 'connectors', async () => ({
    connectorId: 'linear',
    status: 'pending' as const,
  }));
  if (registry !== null) {
    bus.registerService('connectors:resolve', 'connectors', async (_c, input: unknown) => {
      resolveCalls.push(input as ResolveArgs);
      if (registry.resolveThrows) throw registry.resolveThrows;
      const { connectorId } = input as ResolveArgs;
      const row = connectorId === 'linear' ? registry.linear : null;
      if (row === null) {
        throw new PluginError({
          code: 'not-found',
          plugin: 'connectors',
          message: `connector '${connectorId}' not found`,
        });
      }
      return {
        id: connectorId,
        keyMode: row.keyMode,
        usageNote: 'anything at all',
        capabilities: {
          allowedHosts: row.hosts,
          credentials: row.slots.map((slot) => ({ slot, kind: 'api-key' as const })),
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
        credentialPlan: [],
        requiresSharedKeyConsent: false,
      };
    });
  }
  await createToolConnectorProposePlugin().init({ bus, config: {} });
  return { bus, resolveCalls };
}

function capture(bus: HookBus, connectorId: unknown): Promise<{ predicate: unknown }> {
  return bus.call(CONNECTOR_CAPTURE_HOOK, ctx, {
    call: { id: 't1', name: CONNECTOR_PROPOSE_TOOL_NAME, input: { connectorId } },
  });
}

function check(
  bus: HookBus,
  predicate: unknown,
): Promise<{ value: string; changed?: string }> {
  return bus.call(CONNECTOR_CHECK_HOOK, ctx, { predicate });
}

describe('@ax/tool-connector-propose — the freshness pair', () => {
  it('registers both halves, never one', async () => {
    const { bus } = await bootWith({ linear: null });
    expect(bus.hasService(CONNECTOR_CAPTURE_HOOK)).toBe(true);
    expect(bus.hasService(CONNECTOR_CHECK_HOOK)).toBe(true);
  });

  it('round-trips unchanged for an id nothing occupies — the normal case', async () => {
    const registry: Registry = { linear: null };
    const { bus } = await bootWith(registry);
    const { predicate } = await capture(bus, 'linear');
    expect(predicate).toMatchObject({ kind: CONNECTOR_REGISTRY_KIND });

    const out = await check(bus, predicate);
    expect(out.value).toBe((predicate as { value: string }).value);
    expect(out.changed).toBeUndefined();
  });

  it('reads the world for the OWNER on the context, never for whoever asked', async () => {
    const registry: Registry = { linear: null };
    const { bus, resolveCalls } = await bootWith(registry);
    await capture(bus, 'linear');
    expect(resolveCalls[0]).toEqual({ userId: 'user_1', connectorId: 'linear' });
  });

  it('DISAGREES once a human has set that connection up in the meantime', async () => {
    // The failure this producer exists for: replaying the recorded draft would
    // write the agent's older idea of "linear" over a live, human-approved
    // connection that governs what the agent can reach.
    const registry: Registry = { linear: null };
    const { bus } = await bootWith(registry);
    const { predicate } = await capture(bus, 'linear');

    registry.linear = { keyMode: 'personal', hosts: ['api.linear.app'], slots: ['api_key'] };
    const out = await check(bus, predicate);
    expect(out.value).not.toBe((predicate as { value: string }).value);
    expect(out.changed).toMatch(/already exists now/i);
    expect(out.changed).toContain('linear');
  });

  it('DISAGREES when the reach of an existing connection changes', async () => {
    const registry: Registry = {
      linear: { keyMode: 'personal', hosts: ['api.linear.app'], slots: ['api_key'] },
    };
    const { bus } = await bootWith(registry);
    const { predicate } = await capture(bus, 'linear');

    registry.linear = {
      keyMode: 'personal',
      hosts: ['api.linear.app', 'exfil.example.com'],
      slots: ['api_key'],
    };
    const out = await check(bus, predicate);
    expect(out.value).not.toBe((predicate as { value: string }).value);
    expect(out.changed).toMatch(/reaches somewhere different/i);
  });

  it('does NOT trip on a merely reordered host list', async () => {
    // A false positive costs a human a second look for nothing, which is how a
    // guard earns a reputation for crying wolf.
    const registry: Registry = {
      linear: { keyMode: 'personal', hosts: ['a.example.com', 'b.example.com'], slots: [] },
    };
    const { bus } = await bootWith(registry);
    const { predicate } = await capture(bus, 'linear');

    registry.linear = {
      keyMode: 'personal',
      hosts: ['b.example.com', 'a.example.com'],
      slots: [],
    };
    expect((await check(bus, predicate)).changed).toBeUndefined();
  });

  it('captures nothing when there is no registry to read', async () => {
    // No `connectors:resolve` producer: the decision is UNGUARDED rather than
    // guarded against a value we invented. The manifest records the trade.
    const { bus } = await bootWith(null);
    expect((await capture(bus, 'linear')).predicate).toBeNull();
  });

  it('captures nothing for a draft whose id the executor would reject anyway', async () => {
    const { bus } = await bootWith({ linear: null });
    expect((await capture(bus, 'Not A Valid Id')).predicate).toBeNull();
    expect((await capture(bus, undefined)).predicate).toBeNull();
  });

  it('THROWS on a token it did not write, rather than inventing a value', async () => {
    // @ax/decisions turns a throwing check into "changed", which re-opens the
    // decision and runs nothing. Answering with a made-up value would either
    // execute on a world nobody looked at or stale on one that never moved.
    const { bus } = await bootWith({ linear: null });
    await expect(check(bus, { kind: 'thread-head', value: 'nope', label: null })).rejects.toThrow();
  });

  it('propagates a registry that is DOWN, so the guard fails closed', async () => {
    const registry: Registry = { linear: null };
    const { bus } = await bootWith(registry);
    const { predicate } = await capture(bus, 'linear');

    registry.resolveThrows = new Error('the connector store is unreachable');
    await expect(check(bus, predicate)).rejects.toThrow();
  });

  it('never puts a credential VALUE in the token — only slot names', async () => {
    const registry: Registry = {
      linear: { keyMode: 'personal', hosts: ['api.linear.app'], slots: ['api_key'] },
    };
    const { bus } = await bootWith(registry);
    const { predicate } = await capture(bus, 'linear');
    const value = (predicate as { value: string }).value;
    // The token is `<id>@<digest>` and nothing else. There is no room in it for
    // a secret even by accident.
    expect(value).toMatch(/^linear@[0-9a-f]{16}$/);
  });
});
