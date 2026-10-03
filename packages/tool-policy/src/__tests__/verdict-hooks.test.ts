import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryEgressAllowlistStore } from '../egress-allowlist.js';
import { createToolPolicyPlugin } from '../plugin.js';
import { BUILTIN_RULES } from '../rules.js';
import type {
  EvaluateResult,
  GetConnectorDefaultsOutput,
  ListAgentOverridesOutput,
  PolicyVerdict,
  SetAgentOverrideOutput,
  SetConnectorDefaultsOutput,
  SnapshotConnectorForAgentOutput,
} from '../types.js';
import { createMemoryVerdictStore, type VerdictStore } from '../verdict-store.js';

/**
 * TASK-736 — the per-tool verdict hooks, through a real bus with the real
 * `returns` schemas, and their effect on `tool-policy:evaluate`.
 */

const NS = 'c5e0235982f';
const NS2 = 'c0123456789';
const SEND = `mcp.${NS}.send_message`;
const LIST = `mcp.${NS}.list_messages`;
const OTHER = `mcp.${NS2}.create_issue`;
const AGENT = 'agent-1';

const harnesses: TestHarness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
});

interface BootOpts {
  verdictStore?: VerdictStore;
  now?: () => number;
  verdictCacheTtlMs?: number;
}

async function boot(opts: BootOpts = {}): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createToolPolicyPlugin({
        egressStore: createMemoryEgressAllowlistStore(),
        verdictStore: opts.verdictStore ?? createMemoryVerdictStore(),
        ...(opts.now !== undefined && { now: opts.now }),
        ...(opts.verdictCacheTtlMs !== undefined && { verdictCacheTtlMs: opts.verdictCacheTtlMs }),
      }),
    ],
  });
  harnesses.push(h);
  return h;
}

const call = <O>(h: TestHarness, hook: string, input: unknown) =>
  h.bus.call<unknown, O>(hook, h.ctx({ userId: 'admin-1' }), input);

async function verdictOf(h: TestHarness, name: string, agentId: string | null = AGENT, input: unknown = {}) {
  const r = await h.bus.call<unknown, EvaluateResult>(
    'tool-policy:evaluate',
    h.ctx({ agentId: agentId ?? "x" }),
    { call: { name, input }, ...(agentId !== null && { agentId }) },
  );
  return r.verdict;
}

const setDefaults = (h: TestHarness, verdicts: Array<{ toolKey: string; verdict: PolicyVerdict | null }>, connectorId = 'gmail') =>
  call<SetConnectorDefaultsOutput>(h, 'tool-policy:set-connector-defaults', { connectorId, verdicts });

const setOverride = (h: TestHarness, toolKey: string, verdict: PolicyVerdict | null, agentId = AGENT) =>
  call<SetAgentOverrideOutput>(h, 'tool-policy:set-agent-override', { agentId, toolKey, verdict });

const listOverrides = (h: TestHarness, agentId = AGENT) =>
  call<ListAgentOverridesOutput>(h, 'tool-policy:list-agent-overrides', { agentId });

describe('evaluate — layered verdicts through the bus', () => {
  it('an unknown connector tool is held (Ask first) — it used to be allowed', async () => {
    const h = await boot();
    expect(await verdictOf(h, SEND)).toBe('hold');
  });

  it('an admin default decides it, and an agent override can only tighten', async () => {
    const h = await boot();
    expect(await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }])).toEqual({ ok: true });
    expect(await verdictOf(h, SEND)).toBe('allow');
    expect(await setOverride(h, SEND, 'deny')).toEqual({ ok: true });
    expect(await verdictOf(h, SEND)).toBe('deny');
    // Another agent is untouched.
    expect(await verdictOf(h, SEND, 'agent-2')).toBe('allow');
  });

  it('Bash deny / web_search deny take effect; static deny on WebFetch is untouchable', async () => {
    const h = await boot();
    expect(await verdictOf(h, 'Bash')).toBe('allow');
    expect(await setOverride(h, 'Bash', 'deny')).toEqual({ ok: true });
    expect(await setOverride(h, 'web_search', 'deny')).toEqual({ ok: true });
    expect(await verdictOf(h, 'Bash')).toBe('deny');
    expect(await verdictOf(h, 'web_search')).toBe('deny');
    expect(await setOverride(h, 'WebFetch', 'allow')).toEqual({ ok: false, reason: 'invalid-key' });
    expect(await verdictOf(h, 'WebFetch')).toBe('deny');
  });

  it('keeps the table’s ruleId / capability when a stored verdict tightens', async () => {
    const h = await boot();
    await setOverride(h, 'Bash', 'deny');
    const r = await h.bus.call<unknown, EvaluateResult>('tool-policy:evaluate', h.ctx({ agentId: AGENT }), {
      call: { name: 'Bash', input: {} },
      agentId: AGENT,
    });
    const rule = BUILTIN_RULES.find((x) => x.match.tool === 'Bash' && x.match.when === undefined)!;
    expect(r).toMatchObject({ verdict: 'deny', ruleId: rule.id, capability: rule.capability });
  });

  it('a tool that is not overridable never reads the store', async () => {
    let reads = 0;
    const inner = createMemoryVerdictStore();
    const store: VerdictStore = {
      ...inner,
      overridesFor: async (a) => {
        reads += 1;
        return inner.overridesFor(a);
      },
    };
    const h = await boot({ verdictStore: store });
    expect(await verdictOf(h, 'Read')).toBe('allow');
    expect(await verdictOf(h, 'request_capability')).toBe('hold');
    expect(reads).toBe(0);
    await verdictOf(h, 'Bash');
    expect(reads).toBe(1);
  });
});

describe('evaluate — store-read failure fails CLOSED', () => {
  const broken = (): VerdictStore => {
    const inner = createMemoryVerdictStore();
    return {
      ...inner,
      overridesFor: async () => {
        throw new Error('storage unreachable');
      },
      connectorDefaultsFor: async () => {
        throw new Error('storage unreachable');
      },
    };
  };

  it('holds an mcp.* tool and every ability — never falls back to the static allow', async () => {
    const h = await boot({ verdictStore: broken() });
    expect(await verdictOf(h, SEND)).toBe('hold');
    expect(await verdictOf(h, 'mcp.github.list_issues')).toBe('hold');
    expect(await verdictOf(h, 'Bash')).toBe('hold');
    expect(await verdictOf(h, 'web_search')).toBe('hold');
    expect(await verdictOf(h, 'web_extract', AGENT, { url: 'https://example.com/' })).toBe('hold');
  });

  it('only the connector-defaults read failing is enough to hold', async () => {
    const inner = createMemoryVerdictStore();
    const h = await boot({
      verdictStore: {
        ...inner,
        connectorDefaultsFor: async () => {
          throw new Error('storage unreachable');
        },
      },
    });
    expect(await verdictOf(h, SEND)).toBe('hold');
  });

  it('a static deny stays a deny, and untouched tools keep their table answer', async () => {
    const h = await boot({ verdictStore: broken() });
    expect(await verdictOf(h, 'WebFetch')).toBe('deny');
    expect(await verdictOf(h, 'Read')).toBe('allow');
  });

  it('an evaluate payload with no agentId holds an overridable tool', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    expect(await verdictOf(h, SEND, null)).toBe('hold');
    expect(await verdictOf(h, "Bash", null)).toBe('hold');
  });
});

describe('set-agent-override — tighten-only', () => {
  it('admin Ask → the agent may pick Ask or Deny; Allow is a ceiling-violation', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'hold' }]);
    expect(await setOverride(h, SEND, 'allow')).toEqual({
      ok: false,
      reason: 'ceiling-violation',
      ceiling: 'hold',
    });
    expect(await setOverride(h, SEND, 'hold')).toEqual({ ok: true });
    expect(await setOverride(h, SEND, 'deny')).toEqual({ ok: true });
  });

  it('admin Deny → only Deny', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'deny' }]);
    expect(await setOverride(h, SEND, 'hold')).toMatchObject({ reason: 'ceiling-violation', ceiling: 'deny' });
    expect(await setOverride(h, SEND, 'allow')).toMatchObject({ reason: 'ceiling-violation' });
    expect(await setOverride(h, SEND, 'deny')).toEqual({ ok: true });
  });

  it('no admin default → capped at Ask first', async () => {
    const h = await boot();
    expect(await setOverride(h, SEND, 'allow')).toMatchObject({ reason: 'ceiling-violation', ceiling: 'hold' });
  });

  it('web_extract cannot be loosened past its static hold', async () => {
    const h = await boot();
    expect(await setOverride(h, 'web_extract', 'allow')).toMatchObject({
      reason: 'ceiling-violation',
      ceiling: 'hold',
    });
  });

  it('refuses keys outside the closed list and malformed input', async () => {
    const h = await boot();
    for (const k of ['Task', 'request_capability', 'connector_propose', 'skill_propose', 'Read', 'mcp..x']) {
      expect(await setOverride(h, k, 'deny')).toEqual({ ok: false, reason: 'invalid-key' });
    }
    expect(await setOverride(h, 'Bash', 'maybe' as PolicyVerdict)).toEqual({ ok: false, reason: 'invalid-verdict' });
    expect(await setOverride(h, 'Bash', 'deny', '')).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('null clears the override', async () => {
    const h = await boot();
    await setOverride(h, 'Bash', 'deny');
    expect(await verdictOf(h, 'Bash')).toBe('deny');
    expect(await setOverride(h, 'Bash', null)).toEqual({ ok: true });
    expect(await verdictOf(h, 'Bash')).toBe('allow');
  });
});

describe('set/get-connector-defaults', () => {
  it('accepts connector keys only, validating the whole batch before writing any of it', async () => {
    const h = await boot();
    expect(
      await setDefaults(h, [
        { toolKey: SEND, verdict: 'allow' },
        { toolKey: 'mcp.github.x', verdict: 'allow' },
      ]),
    ).toEqual({ ok: false, reason: 'invalid-key', toolKey: 'mcp.github.x' });
    expect(await setDefaults(h, [{ toolKey: 'Bash', verdict: 'deny' }])).toMatchObject({ reason: 'invalid-key' });
    expect(await setDefaults(h, [{ toolKey: SEND, verdict: 'nope' as PolicyVerdict }])).toMatchObject({
      reason: 'invalid-verdict',
    });
    // Nothing from the rejected batches landed.
    expect(await verdictOf(h, SEND)).toBe('hold');
  });

  it('round-trips, filtered by namespace AND connector id', async () => {
    const h = await boot();
    await setDefaults(h, [
      { toolKey: SEND, verdict: 'hold' },
      { toolKey: LIST, verdict: 'allow' },
    ]);
    await setDefaults(h, [{ toolKey: OTHER, verdict: 'deny' }], 'linear');
    const got = await call<GetConnectorDefaultsOutput>(h, 'tool-policy:get-connector-defaults', {
      connectorId: 'gmail',
      toolNamespaces: [NS, NS2],
    });
    expect(got.defaults).toEqual([
      { toolKey: LIST, verdict: 'allow' },
      { toolKey: SEND, verdict: 'hold' },
    ]);
  });

  it('null clears a default back to the implicit hold', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    expect(await verdictOf(h, SEND)).toBe('allow');
    await setDefaults(h, [{ toolKey: SEND, verdict: null }]);
    expect(await verdictOf(h, SEND)).toBe('hold');
  });

  it('get refuses a call without namespaces', async () => {
    const h = await boot();
    await expect(
      call(h, 'tool-policy:get-connector-defaults', { connectorId: 'gmail' }),
    ).rejects.toThrow();
  });
});

describe('list-agent-overrides + snapshot-connector-for-agent', () => {
  it('lists each override with its live ceiling and origin', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'hold' }]);
    await setOverride(h, SEND, 'deny');
    await setOverride(h, 'web_extract', 'hold');
    expect(await listOverrides(h)).toEqual({
      overrides: [
        { toolKey: SEND, verdict: 'deny', ceiling: 'hold', origin: 'user' },
        { toolKey: 'web_extract', verdict: 'hold', ceiling: 'hold', origin: 'user' },
      ],
      copiedNamespaces: [],
    });
  });

  it('snapshot copies the admin defaults, never overwriting a person’s own choice', async () => {
    const h = await boot();
    await setDefaults(h, [
      { toolKey: SEND, verdict: 'hold' },
      { toolKey: LIST, verdict: 'allow' },
    ]);
    await setOverride(h, SEND, 'deny');
    const out = await call<SnapshotConnectorForAgentOutput>(h, 'tool-policy:snapshot-connector-for-agent', {
      agentId: AGENT,
      connectorId: 'gmail',
      toolNamespaces: [NS],
    });
    expect(out).toEqual({ copied: 1 });
    expect((await listOverrides(h)).overrides).toEqual([
      { toolKey: LIST, verdict: 'allow', ceiling: 'allow', origin: 'snapshot' },
      { toolKey: SEND, verdict: 'deny', ceiling: 'hold', origin: 'user' },
    ]);
  });

  it('after a snapshot, an admin LOOSENING does not loosen the agent; a TIGHTENING does', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'hold' }]);
    await call(h, 'tool-policy:snapshot-connector-for-agent', {
      agentId: AGENT,
      connectorId: 'gmail',
      toolNamespaces: [NS],
    });
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    expect(await verdictOf(h, SEND)).toBe('hold');
    expect(await verdictOf(h, SEND, 'agent-never-attached')).toBe('allow');
    await setDefaults(h, [{ toolKey: SEND, verdict: 'deny' }]);
    expect(await verdictOf(h, SEND)).toBe('deny');
  });
});

// TASK-754 — the copy covers tools with NO default at copy time, too.
describe('snapshot freezes unset tools (TASK-754)', () => {
  const snapshot = (h: TestHarness, extra: Record<string, unknown> = {}, agentId = AGENT) =>
    call<SnapshotConnectorForAgentOutput>(h, 'tool-policy:snapshot-connector-for-agent', {
      agentId,
      connectorId: 'gmail',
      toolNamespaces: [NS],
      ...extra,
    });

  it('a tool with no default at attach stays Ask first when the admin later allows it; a tightening still applies', async () => {
    const h = await boot();
    await snapshot(h);
    // Warm the cache so a stale read would show.
    expect(await verdictOf(h, SEND)).toBe('hold');
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    expect(await verdictOf(h, SEND)).toBe('hold');
    // An agent that never copied follows the live default.
    expect(await verdictOf(h, SEND, 'agent-never-attached')).toBe('allow');
    await setDefaults(h, [{ toolKey: SEND, verdict: 'deny' }]);
    expect(await verdictOf(h, SEND)).toBe('deny');
    // The namespace is reported, so a view can show the held tool honestly.
    expect((await listOverrides(h)).copiedNamespaces).toEqual([NS]);
    expect((await listOverrides(h, 'agent-never-attached')).copiedNamespaces).toEqual([]);
  });

  it('only the copied namespace is frozen; another connector’s tools still follow their defaults', async () => {
    const h = await boot();
    await snapshot(h);
    await setDefaults(h, [{ toolKey: OTHER, verdict: 'allow' }], 'linear');
    expect(await verdictOf(h, OTHER)).toBe('allow');
  });

  it('a person may still pick Allow for a frozen tool once the admin allows it', async () => {
    const h = await boot();
    await snapshot(h);
    expect(await setOverride(h, SEND, 'allow')).toEqual({ ok: false, reason: 'ceiling-violation', ceiling: 'hold' });
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    expect(await setOverride(h, SEND, 'allow')).toEqual({ ok: true });
    expect(await verdictOf(h, SEND)).toBe('allow');
  });

  it('default-on (onlyIfNotCopied): the first copy freezes, a later one copies nothing — so a loosening never lands', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: LIST, verdict: 'hold' }]);
    expect(await snapshot(h, { onlyIfNotCopied: true })).toEqual({ copied: 1 });
    await setDefaults(h, [
      { toolKey: LIST, verdict: 'allow' },
      { toolKey: SEND, verdict: 'allow' },
    ]);
    // Every later session open asks again; nothing is re-copied.
    expect(await snapshot(h, { onlyIfNotCopied: true })).toEqual({ copied: 0 });
    expect(await verdictOf(h, LIST)).toBe('hold');
    expect(await verdictOf(h, SEND)).toBe('hold');
    await setDefaults(h, [{ toolKey: LIST, verdict: 'deny' }]);
    expect(await verdictOf(h, LIST)).toBe('deny');
  });

  it('default-on copy also skips the store when another process copied it (store claim, not only the cache)', async () => {
    const store = createMemoryVerdictStore();
    const h = await boot({ verdictStore: store });
    await store.copyConnectorDefaults(AGENT, 'gmail', [NS], { onlyIfNotCopied: true }, 'elsewhere');
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    expect(await snapshot(h, { onlyIfNotCopied: true })).toEqual({ copied: 0 });
    expect(await verdictOf(h, SEND)).toBe('hold');
  });

  it('an attach re-copies (overwriting copied rows, never a person’s own choice)', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'hold' }, { toolKey: LIST, verdict: 'hold' }]);
    await snapshot(h, { onlyIfNotCopied: true });
    await setOverride(h, LIST, 'deny');
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }, { toolKey: LIST, verdict: 'allow' }]);
    expect(await snapshot(h)).toEqual({ copied: 1 });
    expect(await verdictOf(h, SEND)).toBe('allow');
    expect(await verdictOf(h, LIST)).toBe('deny');
  });

  it('refuses a non-boolean onlyIfNotCopied', async () => {
    const h = await boot();
    await expect(snapshot(h, { onlyIfNotCopied: 'yes' })).rejects.toThrow(/onlyIfNotCopied/);
    expect((await listOverrides(h)).copiedNamespaces).toEqual([]);
  });

  it('agents:deleted, connectors:deleted and a removed server drop the record; a rename moves it', async () => {
    const NEW = 'cabcdef0123';
    const h = await boot();
    await snapshot(h);
    await snapshot(h, {}, 'agent-2');
    await h.bus.fire('agents:deleted', h.ctx(), { agentId: 'agent-2', ownerId: 'u', ownerType: 'user' });
    expect((await listOverrides(h, 'agent-2')).copiedNamespaces).toEqual([]);

    await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
      connectorId: 'gmail',
      renamed: [{ from: { server: 's', toolNamespace: NS }, to: { server: 's', toolNamespace: NEW } }],
      removed: [],
    });
    expect((await listOverrides(h)).copiedNamespaces).toEqual([NEW]);
    await setDefaults(h, [{ toolKey: `mcp.${NEW}.send_message`, verdict: 'allow' }]);
    expect(await verdictOf(h, `mcp.${NEW}.send_message`)).toBe('hold');

    await h.bus.fire('connectors:deleted', h.ctx(), {
      connectorId: 'gmail',
      toolNamespaces: [{ server: 's', toolNamespace: NEW }],
    });
    expect((await listOverrides(h)).copiedNamespaces).toEqual([]);

    await snapshot(h);
    await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
      connectorId: 'gmail',
      renamed: [],
      removed: [{ server: 's', toolNamespace: NS }],
    });
    expect((await listOverrides(h)).copiedNamespaces).toEqual([]);
  });
});

describe('cache', () => {
  it('a write through this process is seen immediately; a write elsewhere after the TTL', async () => {
    let t = 1_000;
    const store = createMemoryVerdictStore();
    const h = await boot({ verdictStore: store, now: () => t, verdictCacheTtlMs: 30_000 });
    expect(await verdictOf(h, 'Bash')).toBe('allow');
    // Same-process write invalidates.
    await setOverride(h, 'Bash', 'deny');
    expect(await verdictOf(h, 'Bash')).toBe('deny');
    // Another replica writes straight to the store: invisible until the TTL.
    await store.setOverride(AGENT, 'Bash', null, 'elsewhere');
    expect(await verdictOf(h, 'Bash')).toBe('deny');
    t += 30_001;
    expect(await verdictOf(h, 'Bash')).toBe('allow');
  });

  it('connector defaults are cached per namespace and dropped on write', async () => {
    const t = 1_000;
    const store = createMemoryVerdictStore();
    const h = await boot({ verdictStore: store, now: () => t });
    expect(await verdictOf(h, SEND)).toBe('hold');
    await store.setConnectorDefaults('gmail', [{ toolNamespace: NS, tool: 'send_message', verdict: 'allow' }], 'x');
    expect(await verdictOf(h, SEND)).toBe('hold');
    await setDefaults(h, [{ toolKey: LIST, verdict: 'allow' }]);
    expect(await verdictOf(h, SEND)).toBe('allow');
  });
});

describe('purges', () => {
  it('agents:deleted drops the agent’s overrides', async () => {
    const h = await boot();
    await setOverride(h, 'Bash', 'deny');
    await h.bus.fire('agents:deleted', h.ctx(), { agentId: AGENT, ownerId: 'u', ownerType: 'user' });
    expect((await listOverrides(h)).overrides).toEqual([]);
    expect(await verdictOf(h, 'Bash')).toBe('allow');
  });

  it('connectors:deleted drops its defaults and every agent’s overrides under its namespaces only', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    await setDefaults(h, [{ toolKey: OTHER, verdict: 'allow' }], 'linear');
    await setOverride(h, SEND, 'deny');
    await setOverride(h, 'Bash', 'deny');
    await setOverride(h, LIST, 'deny', 'agent-2');
    await h.bus.fire('connectors:deleted', h.ctx(), {
      connectorId: 'gmail',
      toolNamespaces: [{ server: 'gmail', toolNamespace: NS }],
    });
    expect((await listOverrides(h)).overrides.map((o) => o.toolKey)).toEqual(['Bash']);
    expect((await listOverrides(h, 'agent-2')).overrides).toEqual([]);
    expect(await verdictOf(h, SEND)).toBe('hold');
    expect(await verdictOf(h, OTHER)).toBe('allow');
  });

  it('a malformed connectors:deleted payload purges nothing', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    await h.bus.fire('connectors:deleted', h.ctx(), {
      connectorId: 'gmail',
      toolNamespaces: [{ server: 'gmail', toolNamespace: '%' }],
    });
    expect(await verdictOf(h, SEND)).toBe('allow');
  });
});

describe('connectors:tool-namespaces-changed — a renamed server keeps its verdicts (TASK-752)', () => {
  const NEW = 'cabcdef0123';
  const NEW_SEND = `mcp.${NEW}.send_message`;
  const NEW_LIST = `mcp.${NEW}.list_messages`;
  const entry = (toolNamespace: string) => ({ server: 's', toolNamespace });
  const renamed = (from: string, to: string) => ({ from: entry(from), to: entry(to) });

  it('moves the admin defaults and every agent’s overrides to the new namespace', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }, { toolKey: LIST, verdict: 'hold' }]);
    await setDefaults(h, [{ toolKey: OTHER, verdict: 'allow' }], 'linear');
    await setOverride(h, SEND, 'deny');
    await setOverride(h, 'Bash', 'deny');
    await setOverride(h, LIST, 'deny', 'agent-2');
    // Warm the caches, so a stale read would show.
    expect(await verdictOf(h, NEW_SEND)).toBe('hold');
    expect(await verdictOf(h, SEND)).toBe('deny');

    await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
      connectorId: 'gmail',
      renamed: [renamed(NS, NEW)],
      removed: [],
    });

    expect((await listOverrides(h)).overrides.map((o) => [o.toolKey, o.verdict])).toEqual([
      ['Bash', 'deny'],
      [NEW_SEND, 'deny'],
    ]);
    expect((await listOverrides(h, 'agent-2')).overrides.map((o) => o.toolKey)).toEqual([NEW_LIST]);
    expect(await verdictOf(h, NEW_SEND)).toBe('deny');
    expect(await verdictOf(h, NEW_SEND, 'agent-3')).toBe('allow');
    expect(await verdictOf(h, NEW_LIST, 'agent-3')).toBe('hold');
    // Nothing is left under the old namespace, and the other connector is untouched.
    expect(await verdictOf(h, SEND, 'agent-3')).toBe('hold');
    expect(await verdictOf(h, OTHER)).toBe('allow');
    expect(
      (await call<GetConnectorDefaultsOutput>(h, 'tool-policy:get-connector-defaults', {
        connectorId: 'gmail',
        toolNamespaces: [NS, NEW],
      })).defaults,
    ).toEqual([
      { toolKey: NEW_LIST, verdict: 'hold' },
      { toolKey: NEW_SEND, verdict: 'allow' },
    ]);
  });

  it('purges a removed server’s namespace like a deleted connector', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    await setDefaults(h, [{ toolKey: OTHER, verdict: 'allow' }], 'linear');
    await setOverride(h, SEND, 'deny');
    await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
      connectorId: 'gmail',
      renamed: [],
      removed: [entry(NS)],
    });
    expect((await listOverrides(h)).overrides).toEqual([]);
    expect(await verdictOf(h, SEND)).toBe('hold');
    expect(await verdictOf(h, OTHER)).toBe('allow');
  });

  it('ignores malformed and overlapping entries instead of guessing', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    await setDefaults(h, [{ toolKey: OTHER, verdict: 'allow' }], 'linear');
    await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
      connectorId: 'gmail',
      renamed: [renamed('%', NEW), renamed(NS, '%'), renamed(NS, NS), null, 'x'],
      removed: [entry('%'), entry(''), null],
    });
    expect(await verdictOf(h, SEND)).toBe('allow');
    expect(await verdictOf(h, OTHER)).toBe('allow');
    // A chain (NS -> NEW, then NEW -> NS2) keeps only the first, unambiguous pair.
    await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
      connectorId: 'gmail',
      renamed: [renamed(NS, NEW), renamed(NEW, NS2)],
      removed: [],
    });
    expect(await verdictOf(h, NEW_SEND)).toBe('allow');
    expect(await verdictOf(h, OTHER)).toBe('allow');
  });

  it('a removed entry naming either side of a rename never purges the migrated rows', async () => {
    const h = await boot();
    await setDefaults(h, [{ toolKey: SEND, verdict: 'allow' }]);
    await setOverride(h, SEND, 'deny');
    await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
      connectorId: 'gmail',
      renamed: [renamed(NS, NEW)],
      removed: [entry(NEW), entry(NS)],
    });
    // The agent's own deny made it across and is still in force.
    expect((await listOverrides(h)).overrides.map((o) => [o.toolKey, o.verdict])).toEqual([
      [NEW_SEND, 'deny'],
    ]);
    expect(await verdictOf(h, NEW_SEND)).toBe('deny');
    expect(await verdictOf(h, NEW_SEND, 'agent-3')).toBe('allow');
  });
});

describe('verdict store — keyspace guard (TASK-752)', () => {
  it('purgeNamespaces refuses a malformed namespace and removes nothing', async () => {
    const store = createMemoryVerdictStore();
    await store.setConnectorDefaults('gmail', [{ toolNamespace: NS, tool: 'send_message', verdict: 'allow' }], 'a');
    await store.setOverride(AGENT, SEND, 'deny', 'a');
    for (const bad of ['%', '', 'c%', `${NS}.x`, 'C5E0235982F']) {
      await expect(store.purgeNamespaces([NS, bad])).rejects.toThrow(/malformed tool namespace/);
    }
    expect(await store.overridesFor(AGENT)).toEqual([{ toolKey: SEND, verdict: 'deny', origin: 'user' }]);
    expect((await store.connectorDefaultsFor([NS])).get(SEND)).toBe('allow');
  });

  it('renameNamespaces refuses malformed or overlapping pairs and moves nothing', async () => {
    const store = createMemoryVerdictStore();
    await store.setOverride(AGENT, SEND, 'deny', 'a');
    const bad: Array<Array<{ from: string; to: string }>> = [
      [{ from: '%', to: NS2 }],
      [{ from: NS, to: '' }],
      [{ from: NS, to: NS }],
      [{ from: NS, to: NS2 }, { from: NS2, to: 'cabcdef0123' }],
    ];
    for (const pairs of bad) {
      await expect(store.renameNamespaces(pairs)).rejects.toThrow(/refused/);
    }
    expect(await store.overridesFor(AGENT)).toEqual([{ toolKey: SEND, verdict: 'deny', origin: 'user' }]);
  });
});
