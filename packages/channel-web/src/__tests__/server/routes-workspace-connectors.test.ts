// @vitest-environment node
/**
 * The Connectors tab's list routes (TASK-739, connectors-rail slice 6):
 *
 *   GET    /api/workspace/agents/:agentId/connectors
 *   POST   /api/workspace/agents/:agentId/connectors          {connectorId}
 *   DELETE /api/workspace/agents/:agentId/connectors/:connectorId
 *
 * What the tests are for, most expensive first:
 *
 *   1. THE ACL. A caller `agents:resolve` refuses gets a 404 and nothing
 *      downstream runs — not the list, not the detach, not the cleanup.
 *   2. REMOVE MEANS THE RIGHT THING PER SOURCE. An attached connector is
 *      detached; a default / legacy-owned one is excluded from THIS agent.
 *      A connector not in the agent's list is a 404, never a silent exclusion.
 *   3. CLEANUP IS SCOPED. Only this connector's per-tool choices and this
 *      connector's approved access are cleared — and a cleanup miss is
 *      reported as `partial`, never as complete.
 *   4. THE HOOK OWNS THE ADMIN RULE. The route passes the caller's real admin
 *      bit and turns the hook's refusal into a 403.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeWorkspaceHandlers } from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function mkReq(params: Record<string, string>, body?: unknown, raw?: string): RouteRequest {
  return {
    headers: {},
    body:
      raw !== undefined
        ? Buffer.from(raw, 'utf-8')
        : body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(body), 'utf-8'),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface Captured {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

const NS_LINEAR = 'c0123456789';
const NS_GMAIL = 'cabcdef0123';

type Source = 'default' | 'attached' | 'legacy-owned';
interface Effective {
  summary: { id: string; name: string; canEdit?: boolean };
  source: Source;
  toolNamespaces: Array<{ server: string; toolNamespace: string }>;
}

describe('agent connector routes', () => {
  let bus: HookBus;
  let caller: { id: string; isAdmin: boolean };
  /** agentId → owner. */
  let owners: Map<string, string>;
  let agentRow: { connectorAttachments: string[]; connectorExclusions: string[] };
  let effective: Effective[];
  let listEffectiveCalls: unknown[];
  let detachCalls: Array<Record<string, unknown>>;
  let attachCalls: Array<Record<string, unknown>>;
  let detachRefusal: PluginError | null;
  let attachRefusal: PluginError | null;
  /** toolKey → verdict, for agent a1. */
  let overrides: Map<string, string>;
  let overrideClears: string[];
  /** approved access per connector id. */
  let approved: Map<string, Array<{ kind: string; value: string }>>;
  let revokeCalls: Array<Record<string, unknown>>;
  let approvedListThrows: boolean;
  let revokeClears: boolean;

  function handlers() {
    return makeWorkspaceHandlers({ bus, initCtx });
  }

  beforeEach(() => {
    bus = new HookBus();
    caller = { id: 'u1', isAdmin: false };
    owners = new Map([
      ['a1', 'u1'],
      ['a-theirs', 'u2'],
    ]);
    agentRow = { connectorAttachments: ['linear'], connectorExclusions: ['old-thing'] };
    effective = [
      {
        summary: { id: 'gmail', name: 'Gmail', canEdit: false },
        source: 'default',
        toolNamespaces: [{ server: 'gmail', toolNamespace: NS_GMAIL }],
      },
      {
        summary: { id: 'linear', name: 'Linear', canEdit: true },
        source: 'attached',
        toolNamespaces: [{ server: 'linear', toolNamespace: NS_LINEAR }],
      },
      {
        summary: { id: 'notes', name: 'My notes', canEdit: true },
        source: 'legacy-owned',
        toolNamespaces: [],
      },
    ];
    listEffectiveCalls = [];
    detachCalls = [];
    attachCalls = [];
    detachRefusal = null;
    attachRefusal = null;
    overrides = new Map([
      [`mcp.${NS_LINEAR}.create_issue`, 'deny'],
      [`mcp.${NS_LINEAR}.search`, 'hold'],
      [`mcp.${NS_GMAIL}.send`, 'deny'],
      ['Bash', 'deny'],
    ]);
    overrideClears = [];
    approved = new Map([
      ['linear', [{ kind: 'host', value: 'api.linear.app' }]],
      ['gmail', [{ kind: 'host', value: 'gmail.googleapis.com' }]],
    ]);
    revokeCalls = [];
    approvedListThrows = false;
    revokeClears = true;

    bus.registerService('auth:require-user', 'auth', async () => ({ user: caller }));
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId, userId } = i as { agentId: string; userId: string };
      if (owners.get(agentId) !== userId) {
        throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
      }
      return { agent: { id: agentId, displayName: 'Quill', ...agentRow } };
    });
    bus.registerService('connectors:list-effective', 'connectors', async (_c, i: unknown) => {
      listEffectiveCalls.push(i);
      return { connectors: effective };
    });
    bus.registerService('agents:attach-connector', 'agents', async (_c, i: unknown) => {
      attachCalls.push(i as Record<string, unknown>);
      if (attachRefusal !== null) throw attachRefusal;
      return { agent: {}, changed: true };
    });
    bus.registerService('agents:detach-connector', 'agents', async (_c, i: unknown) => {
      detachCalls.push(i as Record<string, unknown>);
      if (detachRefusal !== null) throw detachRefusal;
      return { agent: {}, changed: true };
    });
    bus.registerService('tool-policy:list-agent-overrides', 'policy', async () => ({
      overrides: [...overrides.entries()].map(([toolKey, verdict]) => ({
        toolKey,
        verdict,
        ceiling: 'allow',
        origin: 'user',
      })),
    }));
    bus.registerService('tool-policy:set-agent-override', 'policy', async (_c, i: unknown) => {
      const { toolKey, verdict } = i as { toolKey: string; verdict: string | null };
      if (verdict === null) {
        overrides.delete(toolKey);
        overrideClears.push(toolKey);
      }
      return { ok: true };
    });
    bus.registerService('skills:approved-caps-list', 'skills', async (_c, i: unknown) => {
      if (approvedListThrows) throw new Error('store down');
      const { connectorId } = i as { connectorId?: string };
      return { capabilities: approved.get(connectorId ?? '') ?? [] };
    });
    bus.registerService('skills:approved-caps-revoke', 'skills', async (_c, i: unknown) => {
      revokeCalls.push(i as Record<string, unknown>);
      return { cleared: revokeClears };
    });
  });

  async function list(agentId = 'a1'): Promise<Captured> {
    const { res, captured } = mkRes();
    await handlers().connectors(mkReq({ agentId }), res);
    return captured;
  }
  async function remove(connectorId: string, agentId = 'a1'): Promise<Captured> {
    const { res, captured } = mkRes();
    await handlers().removeConnector(mkReq({ agentId, connectorId }), res);
    return captured;
  }
  async function attach(body: unknown, agentId = 'a1', raw?: string): Promise<Captured> {
    const { res, captured } = mkRes();
    await handlers().attachConnector(mkReq({ agentId }, body, raw), res);
    return captured;
  }

  describe('GET', () => {
    it('lists the effective set as name-only rows, read under the caller', async () => {
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({
        connectors: [
          { id: 'gmail', name: 'Gmail', source: 'default', editable: false },
          { id: 'linear', name: 'Linear', source: 'attached', editable: true },
          { id: 'notes', name: 'My notes', source: 'legacy-owned', editable: true },
        ],
      });
      // The SAME inputs a session opens with: this agent's attachments AND
      // exclusions, under the person asking.
      expect(listEffectiveCalls).toEqual([
        { userId: 'u1', attachmentIds: ['linear'], exclusions: ['old-thing'] },
      ]);
    });

    it("404s another person's agent and never reads the list", async () => {
      const r = await list('a-theirs');
      expect(r.statusCode).toBe(404);
      expect(listEffectiveCalls).toHaveLength(0);
    });

    it('fences an author-chosen name, and shows the id rather than hiding the row', async () => {
      effective = [
        {
          summary: { id: 'evil', name: 'Lin‮ear​', canEdit: false },
          source: 'attached',
          toolNamespaces: [],
        },
        { summary: { id: 'blank', name: '​​', canEdit: false }, source: 'default', toolNamespaces: [] },
      ];
      const r = await list();
      const rows = (r.body as { connectors: Array<{ id: string; name: string }> }).connectors;
      expect(rows[0]?.name).not.toMatch(/[‮​]/);
      expect(rows[1]).toMatchObject({ id: 'blank', name: 'blank' });
    });

    it('drops an entry whose id is not a connector id', async () => {
      effective = [
        { summary: { id: '../x', name: 'Bad' }, source: 'attached', toolNamespaces: [] },
        ...effective,
      ];
      const r = await list();
      expect((r.body as { connectors: unknown[] }).connectors).toHaveLength(3);
    });

    it('503s when there is no effective-list hook rather than claiming none', async () => {
      bus = new HookBus();
      bus.registerService('auth:require-user', 'auth', async () => ({ user: caller }));
      bus.registerService('agents:resolve', 'agents', async () => ({
        agent: { id: 'a1', displayName: 'Quill' },
      }));
      const r = await list();
      expect(r.statusCode).toBe(503);
    });
  });

  describe('DELETE', () => {
    it('detaches an ATTACHED connector (no exclusion)', async () => {
      const r = await remove('linear');
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ removed: true, cleanup: 'complete' });
      expect(detachCalls).toEqual([
        { actor: { userId: 'u1', isAdmin: false }, agentId: 'a1', connectorId: 'linear', exclude: false },
      ]);
    });

    it('EXCLUDES a workspace default from this agent only', async () => {
      const r = await remove('gmail');
      expect(r.statusCode).toBe(200);
      expect(detachCalls[0]).toMatchObject({ connectorId: 'gmail', exclude: true });
    });

    it('excludes a legacy-owned connector', async () => {
      await remove('notes');
      expect(detachCalls[0]).toMatchObject({ connectorId: 'notes', exclude: true });
    });

    it('404s a connector that is not in this agent\'s list — never a blind exclusion', async () => {
      const r = await remove('stranger');
      expect(r.statusCode).toBe(404);
      expect(detachCalls).toHaveLength(0);
    });

    it("404s another person's agent and touches nothing", async () => {
      const r = await remove('linear', 'a-theirs');
      expect(r.statusCode).toBe(404);
      expect(listEffectiveCalls).toHaveLength(0);
      expect(detachCalls).toHaveLength(0);
      expect(overrideClears).toHaveLength(0);
      expect(revokeCalls).toHaveLength(0);
    });

    it('400s a malformed connector id before anything runs', async () => {
      const r = await remove('Not An Id');
      expect(r.statusCode).toBe(400);
      expect(listEffectiveCalls).toHaveLength(0);
    });

    it("clears ONLY this connector's per-tool choices", async () => {
      await remove('linear');
      expect(overrideClears.sort()).toEqual([
        `mcp.${NS_LINEAR}.create_issue`,
        `mcp.${NS_LINEAR}.search`,
      ]);
      // Another connector's choice and the ability switches are untouched.
      expect(overrides.get(`mcp.${NS_GMAIL}.send`)).toBe('deny');
      expect(overrides.get('Bash')).toBe('deny');
    });

    it("revokes ONLY this connector's approved access, for the caller", async () => {
      await remove('linear');
      expect(revokeCalls).toEqual([
        {
          ownerUserId: 'u1',
          agentId: 'a1',
          kind: 'host',
          value: 'api.linear.app',
          connectorId: 'linear',
        },
      ]);
    });

    it('cleans up nothing when the detach is refused, and says 403', async () => {
      detachRefusal = new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
      const r = await remove('linear');
      expect(r.statusCode).toBe(403);
      expect(overrideClears).toHaveLength(0);
      expect(revokeCalls).toHaveLength(0);
    });

    it('reports a cleanup miss as partial, not complete', async () => {
      approvedListThrows = true;
      const r = await remove('linear');
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ removed: true, cleanup: 'partial' });
      // The per-tool clear still ran.
      expect(overrideClears).toHaveLength(2);
    });

    it('reports a revoke that cleared nothing as partial, not complete', async () => {
      revokeClears = false;
      const r = await remove('linear');
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ removed: true, cleanup: 'partial' });
      expect(revokeCalls).toHaveLength(1);
    });

    it('reports a refused per-tool clear as partial', async () => {
      bus = new HookBus();
      bus.registerService('auth:require-user', 'auth', async () => ({ user: caller }));
      bus.registerService('agents:resolve', 'agents', async () => ({
        agent: { id: 'a1', displayName: 'Quill', ...agentRow },
      }));
      bus.registerService('connectors:list-effective', 'connectors', async () => ({
        connectors: effective,
      }));
      bus.registerService('agents:detach-connector', 'agents', async () => ({ changed: true }));
      bus.registerService('tool-policy:list-agent-overrides', 'policy', async () => ({
        overrides: [{ toolKey: `mcp.${NS_LINEAR}.search`, verdict: 'hold' }],
      }));
      bus.registerService('tool-policy:set-agent-override', 'policy', async () => ({
        ok: false,
        reason: 'store-unavailable',
      }));
      const r = await remove('linear');
      expect(r.body).toEqual({ removed: true, cleanup: 'partial' });
    });
  });

  describe('POST (attach)', () => {
    it("hands the hook the caller's real admin bit", async () => {
      caller = { id: 'u1', isAdmin: true };
      const r = await attach({ connectorId: 'linear' });
      expect(r.statusCode).toBe(200);
      expect(attachCalls).toEqual([
        { actor: { userId: 'u1', isAdmin: true }, agentId: 'a1', connectorId: 'linear' },
      ]);
    });

    it("turns the hook's workspace-connector refusal into a 403", async () => {
      attachRefusal = new PluginError({
        code: 'forbidden',
        plugin: 'agents',
        message: "forbidden: 'shared' is a workspace (shared) connector — only an admin can attach it",
      });
      const r = await attach({ connectorId: 'shared' });
      expect(r.statusCode).toBe(403);
    });

    it("404s another person's agent and never attaches", async () => {
      const r = await attach({ connectorId: 'linear' }, 'a-theirs');
      expect(r.statusCode).toBe(404);
      expect(attachCalls).toHaveLength(0);
    });

    it('400s a malformed body', async () => {
      expect((await attach(undefined, 'a1', '{nope')).statusCode).toBe(400);
      expect((await attach({ connectorId: 'UPPER' })).statusCode).toBe(400);
      expect((await attach({ connectorId: ['linear'] })).statusCode).toBe(400);
      expect(attachCalls).toHaveLength(0);
    });
  });
});
