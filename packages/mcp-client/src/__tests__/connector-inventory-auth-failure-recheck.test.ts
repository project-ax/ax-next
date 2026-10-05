import { describe, it, expect, vi } from 'vitest';
import { makeAgentContext, createLogger, type AgentContext } from '@ax/core';
import { createDescribeTools, createUnstoredInventory, type BusLike } from '../connector-inventory/describe-tools.js';
import { createAuthFailureRecheck } from '../connector-inventory/auth-failure-recheck.js';
import type { ListOutcome, ListServerToolsOptions } from '../connector-inventory/list-tools.js';
import type { InventoryKey, InventoryRow, InventoryStore } from '../connector-inventory/store.js';

// ---------------------------------------------------------------------------
// TASK-842 — a runner reports that a connector's MCP server refused it; the
// host re-checks the connector itself through the REAL describe-tools (fake
// bus, in-memory store, fake listing), so the report reaches TASK-817's
// `credentials:get {rejected: true}` path exactly when the HOST sees the 401.
// ---------------------------------------------------------------------------

const NS = 'c0123456789';
const NS_OTHER = 'cfedcba9876';
const USER = 'u1';
const AGENT = 'agent-1';

function connector() {
  return {
    id: 'linear',
    capabilities: {
      credentials: [{ slot: 'token', kind: 'oauth', server: 'main' }],
      mcpServers: [{ name: 'main', transport: 'http', url: 'https://mcp.linear.app/mcp' }],
    },
    credentialPlan: [{ slot: 'token', ref: 'account:linear', scope: 'user', service: 'linear' }],
    toolNamespaces: [{ server: 'main', toolNamespace: NS }],
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
    async statuses() {
      return [];
    },
    async okInventories() {
      return [];
    },
    async deleteForAgent() {
      return { deleted: 0 };
    },
  };
}

interface Setup {
  list?: (opts: ListServerToolsOptions) => Promise<ListOutcome>;
  credential?: (input: { ref: string; userId: string; rejected?: boolean }) => string;
  /** The agent row's attachments (default: the linear connector). */
  attachments?: string[];
  /** Effective set the connectors plugin answers. */
  effective?: Array<{ summary: { id: string }; toolNamespaces?: Array<{ server: string; toolNamespace: string }> }>;
  hasListEffective?: boolean;
  describeThrows?: boolean;
}

function setup(s: Setup = {}) {
  const calls: Array<{ hook: string; input: unknown; ctx: AgentContext }> = [];
  const bus: BusLike & { hasService(h: string): boolean } = {
    async call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> {
      calls.push({ hook, input, ctx });
      if (hook === 'connectors:resolve') return connector() as O;
      if (hook === 'credentials:get') return (s.credential ?? (() => 'tok-123'))(input as never) as O;
      if (hook === 'agents:resolve') {
        return { agent: { connectorAttachments: s.attachments ?? ['linear'], connectorExclusions: [] } } as O;
      }
      if (hook === 'connectors:list-effective') {
        return {
          connectors: s.effective ?? [
            { summary: { id: 'linear' }, toolNamespaces: [{ server: 'main', toolNamespace: NS }] },
          ],
        } as O;
      }
      throw new Error(`unexpected hook ${hook}`);
    },
    async fire() {
      return undefined;
    },
    hasService: (h: string) => (h === 'connectors:list-effective' ? s.hasListEffective !== false : true),
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
  const realDescribe = createDescribeTools({ bus, store, unstored: createUnstoredInventory(), listTools: list });
  const describeTools = s.describeThrows
    ? vi.fn(async () => {
        throw new Error('vault blip');
      })
    : vi.fn(realDescribe);
  const logs: Array<{ msg: string; fields: unknown }> = [];
  const logger = createLogger({
    reqId: 'r',
    writer: (line: string) => {
      const parsed = JSON.parse(line) as { msg: string };
      logs.push({ msg: parsed.msg, fields: parsed });
    },
  });
  const onReport = createAuthFailureRecheck({ bus, describeTools });
  const ctx = (over: Partial<{ userId: string; agentId: string }> = {}) =>
    makeAgentContext({ sessionId: 'sess-1', agentId: over.agentId ?? AGENT, userId: over.userId ?? USER, logger });
  return { calls, list, store, describeTools, logs, onReport, ctx };
}

const report = (...servers: Array<[string, string]>) => ({
  servers: servers.map(([toolNamespace, status]) => ({ toolNamespace, status })),
});

const rejectedGets = (calls: Array<{ hook: string; input: unknown }>) =>
  calls.filter((c) => c.hook === 'credentials:get' && (c.input as { rejected?: boolean }).rejected === true);

describe('connectors:auth-failure-reported → host re-check (TASK-842)', () => {
  it('a 401 the host sees on re-check tells the vault the token was refused, and the row becomes needs-auth', async () => {
    const t = setup({
      // The provider revoked the token: every listing with it is refused.
      list: async (): Promise<ListOutcome> => ({ kind: 'needs-auth', rejected: true }),
      credential: (input) => {
        if (input.rejected !== true) return 'tok-revoked';
        // The renewal is refused too: mcp-oauth writes the needs-reconnect
        // marker on the owner and answers with its reconnect error.
        const dead = new Error('refresh token rejected; reconnect required');
        dead.name = 'NeedsReconnectError';
        throw dead;
      },
    });
    await t.onReport(t.ctx(), report([NS, 'failed']));

    expect(t.describeTools).toHaveBeenCalledTimes(1);
    expect(t.describeTools.mock.calls[0]?.[1]).toEqual({
      userId: USER,
      agentId: AGENT,
      connectorId: 'linear',
      force: true,
    });
    // TASK-817's path: the vault is told the sent token was refused, for the
    // session's user (the vault walk finds the owner).
    expect(rejectedGets(t.calls).map((c) => c.input)).toEqual([
      { ref: 'account:linear', userId: USER, rejected: true },
    ]);
    const row = t.store.rows.get(JSON.stringify([USER, AGENT, 'linear']));
    expect(row?.status).toBe('needs-auth');
    expect(t.logs.find((l) => l.msg === 'connector_auth_report_rechecked')?.fields).toMatchObject({
      connectorId: 'linear',
      reported: ['failed'],
      status: 'needs-auth',
    });
  });

  it('a server that answers fine on re-check stays ok: the runner report alone marks nothing', async () => {
    const t = setup();
    await t.onReport(t.ctx(), report([NS, 'needs-auth']));
    expect(t.list).toHaveBeenCalledTimes(1);
    expect(rejectedGets(t.calls)).toEqual([]);
    expect(t.store.rows.get(JSON.stringify([USER, AGENT, 'linear']))?.status).toBe('ok');
  });

  it("a namespace outside the session agent's effective set is not checked (the host maps, never the runner)", async () => {
    const t = setup();
    await t.onReport(t.ctx(), report([NS_OTHER, 'failed']));
    expect(t.describeTools).not.toHaveBeenCalled();
    expect(t.list).not.toHaveBeenCalled();
    expect(t.logs.find((l) => l.msg === 'connector_auth_report_unmatched')?.fields).toMatchObject({ unmatched: 1 });
  });

  it("maps through the agent row's attachments and exclusions", async () => {
    const t = setup({ attachments: ['linear', 'notion'] });
    await t.onReport(t.ctx(), report([NS, 'tool-error']));
    const listEffective = t.calls.find((c) => c.hook === 'connectors:list-effective');
    expect(listEffective?.input).toEqual({ userId: USER, attachmentIds: ['linear', 'notion'], exclusions: [] });
    expect(t.calls.find((c) => c.hook === 'agents:resolve')?.input).toEqual({ agentId: AGENT, userId: USER });
  });

  it('two namespaces of one connector re-check it once', async () => {
    const t = setup({
      effective: [
        {
          summary: { id: 'linear' },
          toolNamespaces: [
            { server: 'main', toolNamespace: NS },
            { server: 'aux', toolNamespace: NS_OTHER },
          ],
        },
      ],
    });
    await t.onReport(t.ctx(), report([NS, 'failed'], [NS_OTHER, 'tool-error']));
    expect(t.describeTools).toHaveBeenCalledTimes(1);
  });

  it("a flood of reports costs one check per connector per cooldown window (describe-tools' chokepoint)", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) await t.onReport(t.ctx(), report([NS, 'tool-error']));
    expect(t.describeTools).toHaveBeenCalledTimes(5);
    expect(t.list).toHaveBeenCalledTimes(1);
  });

  it('an owner-less session, a malformed payload, or no connectors plugin does nothing', async () => {
    for (const [ctxOver, payload, s] of [
      [{ userId: 'ownerless:ipc-http' }, report([NS, 'failed']), {}],
      [{}, { servers: [{ toolNamespace: 'linear', status: 'failed' }] }, {}],
      [{}, { servers: [{ toolNamespace: NS, status: 'exploded' }] }, {}],
      [{}, null, {}],
      [{}, report([NS, 'failed']), { hasListEffective: false }],
    ] as const) {
      const t = setup(s as Setup);
      await t.onReport(t.ctx(ctxOver as Partial<{ userId: string }>), payload);
      expect(t.describeTools).not.toHaveBeenCalled();
      expect(t.calls).toEqual([]);
    }
  });

  it('never throws: a failed re-check is logged and swallowed', async () => {
    const t = setup({ describeThrows: true });
    await expect(t.onReport(t.ctx(), report([NS, 'failed']))).resolves.toBeUndefined();
    expect(t.logs.some((l) => l.msg === 'connector_auth_report_recheck_failed')).toBe(true);
  });
});
