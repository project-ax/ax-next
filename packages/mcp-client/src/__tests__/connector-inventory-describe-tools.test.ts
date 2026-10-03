import { describe, it, expect, vi } from 'vitest';
import { PluginError, makeAgentContext, createLogger, type AgentContext } from '@ax/core';
import {
  FAILURE_TTL_MS,
  CHECK_COOLDOWN_MS,
  OK_TTL_MS,
  createDescribeTools,
  type BusLike,
} from '../connector-inventory/describe-tools.js';
import type { ListOutcome, ListServerToolsOptions } from '../connector-inventory/list-tools.js';
import type { InventoryKey, InventoryRow, InventoryStore } from '../connector-inventory/store.js';

// ---------------------------------------------------------------------------
// `connectors:describe-tools` orchestration with a fake bus, an in-memory
// store and a fake listing. The network/SSRF layer is covered by the
// list-tools and safe-fetch suites; the Postgres store by the store suite.
// ---------------------------------------------------------------------------

const NS = 'c0123456789';
const NS2 = 'cabcdefabcd';

function connector(overrides: Record<string, unknown> = {}) {
  return {
    id: 'linear',
    capabilities: {
      credentials: [{ slot: 'token', kind: 'oauth', server: 'main' }],
      mcpServers: [{ name: 'main', transport: 'http', url: 'https://mcp.linear.app/mcp' }],
    },
    credentialPlan: [{ slot: 'token', ref: 'account:linear', scope: 'user', service: 'linear' }],
    toolNamespaces: [{ server: 'main', toolNamespace: NS }],
    ...overrides,
  };
}

function memoryStore(): InventoryStore & { rows: Map<string, InventoryRow> } {
  const rows = new Map<string, InventoryRow>();
  const k = (key: InventoryKey) => JSON.stringify([key.userId, key.agentId, key.connectorId]);
  return {
    rows,
    async get(key) {
      return rows.get(k(key)) ?? null;
    },
    async put(key, row) {
      rows.set(k(key), row);
    },
    async deleteForAgent() {
      return { deleted: 0 };
    },
  };
}

interface Setup {
  resolve?: (input: { userId: string; connectorId: string }) => unknown;
  credential?: (input: { ref: string; userId: string }, ctx: AgentContext) => string;
  agentsResolve?: (input: { agentId: string; userId: string }) => unknown;
  list?: (opts: ListServerToolsOptions) => Promise<ListOutcome>;
  /** TASK-773 — make `store.put` reject while this returns true. */
  putFails?: () => boolean;
}

function setup(s: Setup = {}) {
  let clock = new Date('2026-10-02T12:00:00Z');
  const calls: Array<{ hook: string; input: unknown; ctx: AgentContext }> = [];
  const fired: Array<{ hook: string; payload: unknown }> = [];
  const bus: BusLike = {
    async call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> {
      calls.push({ hook, input, ctx });
      if (hook === 'connectors:resolve') {
        return (s.resolve ?? (() => connector()))(input as never) as O;
      }
      if (hook === 'credentials:get') {
        return (s.credential ?? (() => 'tok-123'))(input as never, ctx) as O;
      }
      if (hook === 'agents:resolve') {
        return (s.agentsResolve ?? (() => ({ agent: {} })))(input as never) as O;
      }
      throw new Error(`unexpected hook ${hook}`);
    },
    async fire(hook, _ctx, payload) {
      fired.push({ hook, payload });
      return undefined;
    },
  };
  const list = vi.fn(
    s.list ??
      (async (): Promise<ListOutcome> => ({
        kind: 'ok',
        dropped: 0,
        tools: [{ name: 'search', title: 'Search', description: 'd', readOnly: true, outward: false }],
      })),
  );
  const store = memoryStore();
  const realPut = store.put.bind(store);
  store.put = async (key, row) => {
    if (s.putFails?.() === true) throw new Error('connection terminated: insert failed for tok-secret');
    return realPut(key, row);
  };
  const logLines: string[] = [];
  const describeTools = createDescribeTools({ bus, store, listTools: list, now: () => clock });
  const ctx = makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'caller',
    logger: createLogger({ reqId: 't', writer: (line) => logLines.push(line) }),
  });
  return {
    run: (input: unknown) => describeTools(ctx, input),
    list,
    calls,
    fired,
    store,
    logLines,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe('connectors:describe-tools', () => {
  it('lists an http server with the oauth bearer from the credential plan and attaches toolKeys', async () => {
    const t = setup();
    const out = await t.run({ userId: 'u1', connectorId: 'linear' });
    expect(out).toEqual({
      status: 'ok',
      checkedAt: '2026-10-02T12:00:00.000Z',
      tools: [
        {
          name: 'search',
          title: 'Search',
          description: 'd',
          readOnly: true,
          outward: false,
          toolKey: `mcp.${NS}.search`,
        },
      ],
    });
    expect(t.list).toHaveBeenCalledWith({
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer tok-123' },
    });
    const cred = t.calls.find((c) => c.hook === 'credentials:get')!;
    expect(cred.input).toEqual({ ref: 'account:linear', userId: 'u1' });
    expect(cred.ctx.userId).toBe('u1');
  });

  it('sends an api-key slot as its raw header, bound to its own server only', async () => {
    const t = setup({
      resolve: () =>
        connector({
          capabilities: {
            credentials: [
              { slot: 'key', kind: 'api-key', headerName: 'X-Api-Key', server: 'main' },
              { slot: 'other', kind: 'api-key', headerName: 'X-Other', server: 'elsewhere' },
              { slot: 'env', kind: 'api-key' },
            ],
            mcpServers: [{ name: 'main', transport: 'http', url: 'https://mcp.example.com/mcp' }],
          },
          credentialPlan: [
            { slot: 'key', ref: 'account:linear:key' },
            { slot: 'other', ref: 'account:linear:other' },
            { slot: 'env', ref: 'account:linear:env' },
          ],
        }),
      credential: ({ ref }) => `v(${ref})`,
    });
    await t.run({ userId: 'u1', connectorId: 'linear' });
    expect(t.list).toHaveBeenCalledWith({
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Api-Key': 'v(account:linear:key)' },
    });
  });

  it('runs credential lookups as the named agent after agents:resolve passes', async () => {
    const t = setup();
    await t.run({ userId: 'u1', agentId: 'agent-7', connectorId: 'linear' });
    expect(t.calls[0]!.hook).toBe('agents:resolve');
    expect(t.calls[0]!.input).toEqual({ agentId: 'agent-7', userId: 'u1' });
    expect(t.calls.find((c) => c.hook === 'credentials:get')!.ctx.agentId).toBe('agent-7');
  });

  it('propagates agents:resolve refusal and never touches credentials', async () => {
    const t = setup({
      agentsResolve: () => {
        throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
      },
    });
    await expect(t.run({ userId: 'u1', agentId: 'theirs', connectorId: 'linear' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(t.calls.some((c) => c.hook === 'credentials:get')).toBe(false);
    expect(t.list).not.toHaveBeenCalled();
  });

  it('returns unknown for a stdio-only connector without any network call', async () => {
    const t = setup({
      resolve: () =>
        connector({
          capabilities: { credentials: [], mcpServers: [{ name: 'main', transport: 'stdio' }] },
          credentialPlan: [],
        }),
    });
    const out = await t.run({ userId: 'u1', connectorId: 'linear' });
    expect(out.status).toBe('unknown');
    expect(out.tools).toEqual([]);
    expect(t.list).not.toHaveBeenCalled();
  });

  it('returns needs-auth when the credential is missing, without listing', async () => {
    const t = setup({
      credential: () => {
        throw new PluginError({ code: 'credential-not-found', plugin: 'credentials', message: 'x' });
      },
    });
    expect((await t.run({ userId: 'u1', connectorId: 'linear' })).status).toBe('needs-auth');
    expect(t.list).not.toHaveBeenCalled();
  });

  it('returns needs-auth when the OAuth sign-in was rejected (reconnect error wrapped by the bus)', async () => {
    const t = setup({
      credential: () => {
        const rejected = new Error('refresh token rejected; reconnect required');
        rejected.name = 'NeedsReconnectError';
        throw new PluginError({ code: 'unknown', plugin: '@ax/mcp-oauth', message: 'wrapped', cause: rejected });
      },
    });
    expect((await t.run({ userId: 'u1', connectorId: 'linear' })).status).toBe('needs-auth');
    expect(t.list).not.toHaveBeenCalled();
  });

  // TASK-756 — a vault / credential-proxy blip is not "needs sign-in".
  it.each<[string, () => never]>([
    ['a storage fault', () => {
      throw new PluginError({ code: 'unknown', plugin: 'credentials-store-db', message: 'db down' });
    }],
    ['a refresh the provider could not answer now', () => {
      throw new PluginError({
        code: 'unknown',
        plugin: '@ax/mcp-oauth',
        message: 'wrapped',
        cause: new Error('temporarily_unavailable'),
      });
    }],
    ['a decrypt failure', () => {
      throw new PluginError({ code: 'decrypt-failed', plugin: 'credentials', message: 'x' });
    }],
    ['a bare throw', () => {
      throw new Error('socket hang up');
    }],
  ])('a transient credential failure (%s) throws credential-unavailable, never needs-auth, and stores nothing', async (_l, credential) => {
    const t = setup({ credential });
    await expect(t.run({ userId: 'u1', connectorId: 'linear', force: true })).rejects.toMatchObject({
      code: 'credential-unavailable',
    });
    expect(t.list).not.toHaveBeenCalled();
    expect(t.store.rows.size).toBe(0);
  });

  it('a transient credential failure leaves the last real answer in place', async () => {
    let blip = false;
    const t = setup({
      credential: () => {
        if (blip) throw new PluginError({ code: 'unknown', plugin: 'credentials-store-db', message: 'db down' });
        return 'tok-123';
      },
    });
    expect((await t.run({ userId: 'u1', connectorId: 'linear' })).status).toBe('ok');
    const before = [...t.store.rows.values()][0];
    blip = true;
    t.advance(CHECK_COOLDOWN_MS);
    await expect(t.run({ userId: 'u1', connectorId: 'linear', force: true })).rejects.toMatchObject({
      code: 'credential-unavailable',
    });
    expect([...t.store.rows.values()][0]).toBe(before);
    expect(t.fired.filter((f) => f.hook === 'connectors:tools-discovered')).toHaveLength(1);
  });

  it.each<[ListOutcome, string]>([
    [{ kind: 'needs-auth' }, 'needs-auth'],
    [{ kind: 'unreachable', reason: 'timeout' }, 'unreachable'],
  ])('passes a listing outcome %j through as %s', async (outcome, status) => {
    const t = setup({ list: async () => outcome });
    expect((await t.run({ userId: 'u1', connectorId: 'linear' })).status).toBe(status);
  });

  it('fails closed on a server without a well-formed namespace', async () => {
    const t = setup({ resolve: () => connector({ toolNamespaces: [{ server: 'main', toolNamespace: 'linear' }] }) });
    expect((await t.run({ userId: 'u1', connectorId: 'linear' })).status).toBe('unreachable');
    expect(t.list).not.toHaveBeenCalled();
  });

  it('reports the worst status across servers and keeps the tools that did list', async () => {
    const t = setup({
      resolve: () =>
        connector({
          capabilities: {
            credentials: [],
            mcpServers: [
              { name: 'a', transport: 'http', url: 'https://a.example.com/mcp' },
              { name: 'b', transport: 'http', url: 'https://b.example.com/mcp' },
            ],
          },
          credentialPlan: [],
          toolNamespaces: [
            { server: 'a', toolNamespace: NS },
            { server: 'b', toolNamespace: NS2 },
          ],
        }),
      list: async ({ url }) =>
        url.includes('a.example')
          ? { kind: 'ok', dropped: 0, tools: [{ name: 'x', title: 'x', description: '', readOnly: null, outward: null }] }
          : { kind: 'unreachable', reason: 'timeout' },
    });
    const out = await t.run({ userId: 'u1', connectorId: 'linear' });
    expect(out.status).toBe('unreachable');
    expect(out.tools.map((x) => x.toolKey)).toEqual([`mcp.${NS}.x`]);
  });

  describe('cache', () => {
    it('serves a fresh ok row without re-listing, until the TTL passes', async () => {
      const t = setup();
      await t.run({ userId: 'u1', connectorId: 'linear' });
      t.advance(OK_TTL_MS - 1);
      const hit = await t.run({ userId: 'u1', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(1);
      expect(hit.checkedAt).toBe('2026-10-02T12:00:00.000Z');
      t.advance(1);
      await t.run({ userId: 'u1', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(2);
    });

    it('force bypasses a fresh row', async () => {
      const t = setup();
      await t.run({ userId: 'u1', connectorId: 'linear' });
      t.advance(CHECK_COOLDOWN_MS); // TASK-756: one check per window
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(2);
    });

    it('keeps a failure for the short failure TTL only', async () => {
      const t = setup({ list: async () => ({ kind: 'unreachable', reason: 'timeout' }) });
      await t.run({ userId: 'u1', connectorId: 'linear' });
      t.advance(FAILURE_TTL_MS - 1);
      await t.run({ userId: 'u1', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(1);
      t.advance(1);
      await t.run({ userId: 'u1', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(2);
    });

    it('keys the cache by user and agent (credential scope)', async () => {
      const t = setup();
      await t.run({ userId: 'u1', connectorId: 'linear' });
      await t.run({ userId: 'u2', connectorId: 'linear' });
      await t.run({ userId: 'u1', agentId: 'ag', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(3);
    });

    it('re-checks visibility on a cache hit: a connector the caller lost access to is not served', async () => {
      let visible = true;
      const t = setup({
        resolve: () => {
          if (!visible) throw new PluginError({ code: 'not-found', plugin: 'connectors', message: 'gone' });
          return connector();
        },
      });
      await t.run({ userId: 'u1', connectorId: 'linear' });
      visible = false;
      await expect(t.run({ userId: 'u1', connectorId: 'linear' })).rejects.toMatchObject({ code: 'not-found' });
    });

    it('collapses concurrent checks of the same key into one listing', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const t = setup({
        list: async () => {
          await gate;
          return { kind: 'ok', dropped: 0, tools: [] };
        },
      });
      const a = t.run({ userId: 'u1', connectorId: 'linear' });
      const b = t.run({ userId: 'u1', connectorId: 'linear' });
      await new Promise((r) => setTimeout(r, 0));
      release();
      await Promise.all([a, b]);
      expect(t.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('connectors:tools-discovered', () => {
    it('fires on the first ok inventory and when it changes, not when it is unchanged', async () => {
      let tools = [{ name: 'a', title: 'a', description: '', readOnly: null, outward: null }];
      const t = setup({ list: async () => ({ kind: 'ok', dropped: 0, tools }) });
      await t.run({ userId: 'u1', connectorId: 'linear' });
      expect(t.fired).toHaveLength(1);
      expect(t.fired[0]).toEqual({
        hook: 'connectors:tools-discovered',
        payload: { connectorId: 'linear', tools: [{ ...tools[0], toolKey: `mcp.${NS}.a` }] },
      });
      t.advance(CHECK_COOLDOWN_MS);
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(2); // really re-listed, and unchanged
      expect(t.fired).toHaveLength(1);
      tools = [...tools, { name: 'b', title: 'b', description: '', readOnly: null, outward: null }];
      t.advance(CHECK_COOLDOWN_MS); // TASK-756: one honoured force per window
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.fired).toHaveLength(2);
    });

    it('does not fire for a failure, and an outage does not make the same tools look new', async () => {
      let outcome: ListOutcome = { kind: 'ok', dropped: 0, tools: [] };
      const t = setup({ list: async () => outcome });
      await t.run({ userId: 'u1', connectorId: 'linear' });
      outcome = { kind: 'unreachable', reason: 'timeout' };
      t.advance(CHECK_COOLDOWN_MS);
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      outcome = { kind: 'ok', dropped: 0, tools: [] };
      t.advance(CHECK_COOLDOWN_MS);
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(3);
      expect(t.fired).toHaveLength(1);
    });
  });

  // TASK-756 — every forced check (Retry, Reconnect, ?refresh=1, from any
  // route) passes through here, so this is where the probe rate is bounded.
  describe('force cooldown (TASK-756)', () => {
    it('a second force inside the window is served from the cache — no new listing', async () => {
      const t = setup();
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      t.advance(CHECK_COOLDOWN_MS - 1);
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(1);
      t.advance(1);
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(2);
    });

    // Round-3 review F1 — switching agent must not buy a probe either.
    it('is keyed on user + connector: inside the window another agent with a STALE row is answered from it', async () => {
      const t = setup();
      const stale: InventoryRow = {
        status: 'unreachable',
        tools: [],
        fingerprint: '',
        checkedAt: new Date(Date.parse('2026-10-02T11:00:00Z')), // an hour old
      };
      await t.store.put({ userId: 'u1', agentId: 'agent-2', connectorId: 'linear' }, stale);
      await t.run({ userId: 'u1', agentId: 'agent-1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(1);
      const out = await t.run({ userId: 'u1', agentId: 'agent-2', connectorId: 'linear', force: true });
      expect(out.status).toBe('unreachable');
      expect(t.list).toHaveBeenCalledTimes(1);
      // Unforced but expired: same answer inside the window.
      await t.run({ userId: 'u1', agentId: 'agent-2', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(1);
      // A never-checked agent has nothing to answer with, so it is checked — once.
      await t.run({ userId: 'u1', agentId: 'agent-3', connectorId: 'linear', force: true });
      await t.run({ userId: 'u1', agentId: 'agent-3', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(2);
      // Another person is not held back by u1.
      await t.run({ userId: 'u2', agentId: 'agent-1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(3);
      // After the window, agent-2's stale row is re-checked.
      t.advance(CHECK_COOLDOWN_MS);
      await t.run({ userId: 'u1', agentId: 'agent-2', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(4);
    });

    // Round-3 review F2 — observable only when ANOTHER row could be served.
    it('a credential blip does not use up the window (no server was asked)', async () => {
      let blip = true;
      const t = setup({
        credential: () => {
          if (blip) throw new PluginError({ code: 'unknown', plugin: 'credentials-store-db', message: 'db down' });
          return 'tok-123';
        },
      });
      const stale: InventoryRow = {
        status: 'unreachable',
        tools: [],
        fingerprint: '',
        checkedAt: new Date(Date.parse('2026-10-02T11:00:00Z')),
      };
      await t.store.put({ userId: 'u1', agentId: 'agent-2', connectorId: 'linear' }, stale);
      await expect(
        t.run({ userId: 'u1', agentId: 'agent-1', connectorId: 'linear', force: true }),
      ).rejects.toMatchObject({ code: 'credential-unavailable' });
      blip = false;
      // Had the blip kept its window, agent-2 would be served its stale row.
      const out = await t.run({ userId: 'u1', agentId: 'agent-2', connectorId: 'linear', force: true });
      expect(out.status).toBe('ok');
      expect(t.list).toHaveBeenCalledTimes(1);
    });

    it('a blip on one server of a multi-server connector happens before ANY server is listed', async () => {
      const t = setup({
        resolve: () =>
          connector({
            capabilities: {
              credentials: [
                { slot: 'a', kind: 'oauth', server: 'main' },
                { slot: 'b', kind: 'oauth', server: 'second' },
              ],
              mcpServers: [
                { name: 'main', transport: 'http', url: 'https://a.example/mcp' },
                { name: 'second', transport: 'http', url: 'https://b.example/mcp' },
              ],
            },
            credentialPlan: [
              { slot: 'a', ref: 'account:linear', scope: 'user', service: 'linear' },
              { slot: 'b', ref: 'account:other', scope: 'user', service: 'other' },
            ],
            toolNamespaces: [
              { server: 'main', toolNamespace: NS },
              { server: 'second', toolNamespace: NS2 },
            ],
          }),
        credential: (i) => {
          if (i.ref === 'account:other') {
            throw new PluginError({ code: 'unknown', plugin: 'credentials-store-db', message: 'db down' });
          }
          return 'tok-123';
        },
      });
      await expect(t.run({ userId: 'u1', connectorId: 'linear', force: true })).rejects.toMatchObject({
        code: 'credential-unavailable',
      });
      expect(t.list).not.toHaveBeenCalled();
    });
  });

  // TASK-773 — the cooldown reads the stored row; a write that fails must
  // not leave a "never checked" connector that every call may probe.
  describe('when the store write fails (TASK-773)', () => {
    it('two forced checks inside the window cause one probe, not two', async () => {
      const t = setup({ putFails: () => true });
      const first = await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(first.status).toBe('ok'); // the server WAS asked — a real answer
      t.advance(CHECK_COOLDOWN_MS - 1);
      const second = await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(t.store.rows.size).toBe(0);
      // The bound is a window, not a lockout.
      t.advance(1);
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(2);
    });

    it('unforced calls are answered from the held answer for its TTL', async () => {
      const t = setup({ putFails: () => true });
      await t.run({ userId: 'u1', connectorId: 'linear' });
      t.advance(OK_TTL_MS - 1);
      await t.run({ userId: 'u1', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(1);
      t.advance(1);
      await t.run({ userId: 'u1', connectorId: 'linear' });
      expect(t.list).toHaveBeenCalledTimes(2);
    });

    it('logs the failed write by code, without the driver message', async () => {
      const t = setup({ putFails: () => true });
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      const failed = t.logLines.filter((l) => l.includes('connector_inventory_store_failed'));
      expect(failed).toHaveLength(1);
      expect(JSON.parse(failed[0]!)).toMatchObject({ level: 'error', connectorId: 'linear' });
      expect(failed[0]).toContain('"code":"Error"');
      expect(failed[0]).not.toContain('tok-secret');
    });

    it('the held answer is the previous answer: the same tools after the window are not "new"', async () => {
      const t = setup({ putFails: () => true });
      await t.run({ userId: 'u1', connectorId: 'linear' });
      t.advance(CHECK_COOLDOWN_MS);
      await t.run({ userId: 'u1', connectorId: 'linear', force: true });
      expect(t.list).toHaveBeenCalledTimes(2);
      expect(t.fired).toHaveLength(1);
    });

    it('once the store keeps a newer answer, that is what is served', async () => {
      let fail = true;
      let outcome: ListOutcome = { kind: 'unreachable', reason: 'timeout' };
      const t = setup({ putFails: () => fail, list: async () => outcome });
      expect((await t.run({ userId: 'u1', connectorId: 'linear' })).status).toBe('unreachable');
      fail = false;
      outcome = { kind: 'ok', dropped: 0, tools: [] };
      t.advance(CHECK_COOLDOWN_MS);
      expect((await t.run({ userId: 'u1', connectorId: 'linear', force: true })).status).toBe('ok');
      expect(t.store.rows.size).toBe(1);
      t.advance(1);
      expect((await t.run({ userId: 'u1', connectorId: 'linear' })).status).toBe('ok');
      expect(t.list).toHaveBeenCalledTimes(2);
    });
  });

  it('rejects malformed input', async () => {
    const t = setup();
    await expect(t.run({ userId: '', connectorId: 'linear' })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(t.run({ userId: 'u', connectorId: 'x', extra: 1 })).rejects.toMatchObject({
      code: 'invalid-payload',
    });
  });
});
