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
  capabilities?: { mcpServers: Array<{ name: string }> };
}

describe('agent connector routes', () => {
  let bus: HookBus;
  let caller: { id: string; isAdmin: boolean };
  /** agentId → owner. */
  let owners: Map<string, string>;
  let agentRow: {
    connectorAttachments: string[];
    connectorExclusions: string[];
    visibility?: 'personal' | 'team';
  };
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
  /** TASK-761 — what `connectors:get` knows, by id (absent = not visible). */
  let catalog: Map<string, { id: string; name: string; keyMode: string; capabilities: { credentials: Array<Record<string, unknown>> } }>;
  /** TASK-761 — refs `credentials:get` resolves; anything else is not-found. */
  let vault: Set<string>;
  let credentialReads: Array<{ ref: string; userId: string; agentId: string }>;
  let credentialError: unknown;

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
    const conn = (id: string, keyMode: string, credentials: Array<Record<string, unknown>>) => ({
      id,
      name: id,
      keyMode,
      capabilities: { credentials },
    });
    catalog = new Map([
      ['linear', conn('linear', 'personal', [])],
      ['shared', conn('shared', 'personal', [])],
      ['figma', conn('figma', 'personal', [{ slot: 'MCP_OAUTH', kind: 'oauth', server: 'figma' }])],
      ['stripe', conn('stripe', 'personal', [{ slot: 'STRIPE_KEY', kind: 'api-key' }])],
      ['company', conn('company', 'workspace', [{ slot: 'KEY', kind: 'api-key' }])],
    ]);
    vault = new Set();
    credentialReads = [];
    credentialError = null;
    bus.registerService('connectors:get', 'connectors', async (_c, i: unknown) => {
      const { connectorId } = i as { connectorId: string };
      const found = catalog.get(connectorId);
      if (found === undefined) {
        throw new PluginError({ code: 'not-found', plugin: 'connectors', message: 'nope' });
      }
      return { connector: found };
    });
    bus.registerService('credentials:get', 'credentials', async (c, i: unknown) => {
      const { ref, userId } = i as { ref: string; userId: string };
      credentialReads.push({ ref, userId, agentId: c.agentId });
      if (credentialError !== null) throw credentialError;
      if (!vault.has(ref)) {
        throw new PluginError({ code: 'credential-not-found', plugin: 'credentials', message: 'none' });
      }
      return 'secret-value';
    });

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

  async function retry(connectorId: string, agentId = 'a1'): Promise<Captured> {
    const { res, captured } = mkRes();
    await handlers().retryConnector(mkReq({ agentId, connectorId }), res);
    return captured;
  }

  describe('health (TASK-741)', () => {
    let signInCalls: unknown[];
    let inventoryCalls: unknown[];
    let describeCalls: unknown[];
    let marked: Set<string>;
    let cached: Map<string, string>;
    let describeStatus: string;
    let describeThrows: boolean;

    function registerHealth(opts: { signIn?: boolean; inventory?: boolean; describe?: boolean } = {}) {
      if (opts.signIn !== false) {
        bus.registerService('mcp-oauth:status-batch', 'mcp-oauth', async (_c, i: unknown) => {
          signInCalls.push(i);
          const { connectorIds } = i as { connectorIds: string[] };
          return { needsReconnect: connectorIds.filter((id) => marked.has(id)) };
        });
      }
      if (opts.inventory !== false) {
        bus.registerService('connectors:inventory-status-batch', 'mcp-client', async (_c, i: unknown) => {
          inventoryCalls.push(i);
          const { connectorIds } = i as { connectorIds: string[] };
          return {
            statuses: connectorIds
              .filter((id) => cached.has(id))
              .map((id) => ({ connectorId: id, status: cached.get(id), checkedAt: '2026-10-03T00:00:00.000Z' })),
          };
        });
      }
      if (opts.describe !== false) {
        bus.registerService('connectors:describe-tools', 'mcp-client', async (_c, i: unknown) => {
          describeCalls.push(i);
          if (describeThrows) throw new Error('boom');
          const { connectorId } = i as { connectorId: string };
          cached.set(connectorId, describeStatus);
          return { status: describeStatus, tools: [], checkedAt: '2026-10-03T00:00:00.000Z' };
        });
      }
    }

    beforeEach(() => {
      signInCalls = [];
      inventoryCalls = [];
      describeCalls = [];
      marked = new Set();
      cached = new Map();
      describeStatus = 'ok';
      describeThrows = false;
    });

    function healthById(r: Captured): Record<string, string> {
      const rows = (r.body as { connectors: Array<{ id: string; health: string }> }).connectors;
      return Object.fromEntries(rows.map((x) => [x.id, x.health]));
    }

    it('maps stored state to health: marker → needs-reconnect, cached unreachable → unreachable, else ok', async () => {
      registerHealth();
      marked = new Set(['gmail']);
      cached = new Map([
        ['linear', 'unreachable'],
        ['notes', 'needs-auth'],
      ]);
      const r = await list();
      expect(r.statusCode).toBe(200);
      // needs-auth alone is NOT "sign-in expired": a never-signed-in connector reports it too.
      expect(healthById(r)).toEqual({ gmail: 'needs-reconnect', linear: 'unreachable', notes: 'ok' });
      // One batch read each, for exactly the listed ids, under the caller + agent — and no probe.
      expect(signInCalls).toEqual([{ userId: 'u1', connectorIds: ['gmail', 'linear', 'notes'] }]);
      expect(inventoryCalls).toEqual([
        { userId: 'u1', agentId: 'a1', connectorIds: ['gmail', 'linear', 'notes'] },
      ]);
      expect(describeCalls).toHaveLength(0);
    });

    it('a rejected sign-in outranks an unreachable server', async () => {
      registerHealth();
      marked = new Set(['linear']);
      cached = new Map([['linear', 'unreachable']]);
      expect(healthById(await list()).linear).toBe('needs-reconnect');
    });

    it('a failing or missing health source degrades to ok — the list still loads', async () => {
      bus.registerService('mcp-oauth:status-batch', 'mcp-oauth', async () => {
        throw new Error('db down');
      });
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(healthById(r)).toEqual({ gmail: 'ok', linear: 'ok', notes: 'ok' });
    });

    // TASK-745 — a session folds these same rows and DROPS a server it cannot
    // key (connector-union.ts foldConnectorCaps). The rail must say so.
    describe("a connector a session can't fully load (TASK-745)", () => {
      const caps = (...names: string[]) => ({ mcpServers: names.map((name) => ({ name })) });

      it('two servers under one name: the connector is not-loaded, the rest stay ok', async () => {
        registerHealth();
        effective[1] = {
          ...effective[1]!,
          capabilities: caps('linear', 'linear'),
          toolNamespaces: [
            { server: 'linear', toolNamespace: NS_LINEAR },
            { server: 'linear', toolNamespace: NS_LINEAR },
          ],
        };
        effective[0] = { ...effective[0]!, capabilities: caps('gmail') };
        expect(healthById(await list())).toEqual({ gmail: 'ok', linear: 'not-loaded', notes: 'ok' });
      });

      it('a server with no namespace, or a malformed one, is not-loaded', async () => {
        registerHealth();
        effective[0] = { ...effective[0]!, capabilities: caps('gmail', 'drive') }; // drive has none
        effective[1] = {
          ...effective[1]!,
          capabilities: caps('linear'),
          toolNamespaces: [{ server: 'linear', toolNamespace: 'linear' }],
        };
        expect(healthById(await list())).toEqual({ gmail: 'not-loaded', linear: 'not-loaded', notes: 'ok' });
      });

      it('a namespace an EARLIER connector took: only the later one is not-loaded (fold order)', async () => {
        registerHealth();
        effective[0] = { ...effective[0]!, capabilities: caps('gmail') };
        effective[1] = {
          ...effective[1]!,
          capabilities: caps('linear'),
          toolNamespaces: [{ server: 'linear', toolNamespace: NS_GMAIL }],
        };
        expect(healthById(await list())).toEqual({ gmail: 'ok', linear: 'not-loaded', notes: 'ok' });
      });

      it('accepts a REAL namespace @ax/connectors derives (cross-package drift pin)', async () => {
        // The literal @ax/connectors' tool-namespace.test.ts pins.
        registerHealth();
        effective[1] = {
          ...effective[1]!,
          capabilities: caps('linear'),
          toolNamespaces: [{ server: 'linear', toolNamespace: 'c5e0235982f' }],
        };
        expect(healthById(await list()).linear).toBe('ok');
      });

      it('outranks a rejected sign-in and an unreachable server — neither fix would help', async () => {
        registerHealth();
        marked = new Set(['linear']);
        cached = new Map([['linear', 'unreachable']]);
        effective[1] = { ...effective[1]!, capabilities: caps('linear', 'linear') };
        expect(healthById(await list()).linear).toBe('not-loaded');
      });

      it('still says not-loaded when the stored health reads fail', async () => {
        bus.registerService('mcp-oauth:status-batch', 'mcp-oauth', async () => {
          throw new Error('db down');
        });
        effective[1] = { ...effective[1]!, capabilities: caps('linear', 'linear') };
        expect(healthById(await list()).linear).toBe('not-loaded');
      });

      it('Retry on such a connector answers not-loaded, so the row does not flip to ok', async () => {
        registerHealth();
        describeStatus = 'ok';
        effective[1] = { ...effective[1]!, capabilities: caps('linear', 'linear') };
        expect((await retry('linear')).body).toEqual({ health: 'not-loaded' });
      });
    });

    it('says when the agent is shared (Reconnect asks before signing in for a team)', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      expect((await list()).body).toMatchObject({ shared: true });
    });

    it('Retry runs exactly one forced check of that connector, under the caller and agent', async () => {
      registerHealth();
      describeStatus = 'unreachable';
      const r = await retry('linear');
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ health: 'unreachable' });
      expect(describeCalls).toEqual([
        { userId: 'u1', agentId: 'a1', connectorId: 'linear', force: true },
      ]);
    });

    it('Retry that reaches the server answers ok', async () => {
      registerHealth();
      cached = new Map([['linear', 'unreachable']]);
      describeStatus = 'ok';
      expect((await retry('linear')).body).toEqual({ health: 'ok' });
      expect(describeCalls).toHaveLength(1);
    });

    it('Retry that hits a rejected sign-in answers needs-reconnect', async () => {
      registerHealth();
      describeStatus = 'needs-auth';
      marked = new Set(['linear']);
      expect((await retry('linear')).body).toEqual({ health: 'needs-reconnect' });
    });

    it("Retry 404s a connector that is not on this agent, and another person's agent — no check runs", async () => {
      registerHealth();
      expect((await retry('slack')).statusCode).toBe(404);
      expect((await retry('linear', 'a-theirs')).statusCode).toBe(404);
      expect(describeCalls).toHaveLength(0);
    });

    it('Retry rejects a malformed connector id before anything runs', async () => {
      registerHealth();
      expect((await retry('../x')).statusCode).toBe(400);
      expect(listEffectiveCalls).toHaveLength(0);
      expect(describeCalls).toHaveLength(0);
    });

    it('Retry answers 503 without the inventory service, and 502 when the check itself throws', async () => {
      registerHealth({ describe: false });
      expect((await retry('linear')).statusCode).toBe(503);
      bus.registerService('connectors:describe-tools', 'mcp-client', async () => {
        throw new Error('boom');
      });
      expect((await retry('linear')).statusCode).toBe(502);
    });
  });

  describe('GET', () => {
    it('lists the effective set as name-only rows, read under the caller', async () => {
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({
        connectors: [
          { id: 'gmail', name: 'Gmail', source: 'default', editable: false, health: 'ok' },
          { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok' },
          { id: 'notes', name: 'My notes', source: 'legacy-owned', editable: true, health: 'ok' },
        ],
        shared: false,
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

    describe('signed in / keyed first (TASK-761)', () => {
      it('refuses an OAuth connector nobody signed in to, and attaches nothing', async () => {
        const r = await attach({ connectorId: 'figma' });
        expect(r.statusCode).toBe(409);
        expect(r.body).toMatchObject({ error: 'connector-needs-sign-in' });
        expect(attachCalls).toHaveLength(0);
      });

      it('attaches it once the sign-in resolves, checked under the caller AND this agent', async () => {
        vault.add('account:figma');
        const r = await attach({ connectorId: 'figma' });
        expect(r.statusCode).toBe(200);
        expect(credentialReads).toEqual([{ ref: 'account:figma', userId: 'u1', agentId: 'a1' }]);
        expect(attachCalls).toHaveLength(1);
        // The token is read host-side and dropped — never echoed back.
        expect(JSON.stringify(r.body)).not.toContain('secret-value');
      });

      it('treats an expired sign-in (refresh rejected) as not signed in', async () => {
        vault.add('account:figma');
        const reconnect = new Error('needs reconnect');
        reconnect.name = 'NeedsReconnectError';
        credentialError = new PluginError({
          code: 'unknown',
          plugin: 'credentials',
          message: 'wrapped',
          cause: reconnect,
        });
        const r = await attach({ connectorId: 'figma' });
        expect(r.statusCode).toBe(409);
        expect(r.body).toMatchObject({ error: 'connector-needs-sign-in' });
        expect(attachCalls).toHaveLength(0);
      });

      it('refuses a connector whose required key is missing', async () => {
        const r = await attach({ connectorId: 'stripe' });
        expect(r.statusCode).toBe(409);
        expect(r.body).toMatchObject({ error: 'connector-needs-key' });
        expect(attachCalls).toHaveLength(0);
        vault.add('account:stripe');
        expect((await attach({ connectorId: 'stripe' })).statusCode).toBe(200);
      });

      it('attaches a connector that needs nothing without reading the vault', async () => {
        expect((await attach({ connectorId: 'linear' })).statusCode).toBe(200);
        expect(credentialReads).toHaveLength(0);
      });

      it('fails closed: an unexpected vault error, or no vault, refuses the attach', async () => {
        credentialError = new Error('db down');
        expect((await attach({ connectorId: 'figma' })).statusCode).toBe(503);
        bus = new HookBus();
        // Rebuild without credentials:get by re-registering only what POST needs.
        bus.registerService('auth:require-user', 'auth', async () => ({ user: caller }));
        bus.registerService('agents:resolve', 'agents', async () => ({
          agent: { id: 'a1', displayName: 'Quill', ...agentRow },
        }));
        bus.registerService('agents:attach-connector', 'agents', async (_c, i: unknown) => {
          attachCalls.push(i as Record<string, unknown>);
          return { agent: {}, changed: true };
        });
        bus.registerService('connectors:get', 'connectors', async () => ({
          connector: catalog.get('figma'),
        }));
        expect((await attach({ connectorId: 'figma' })).statusCode).toBe(503);
        expect(attachCalls).toHaveLength(0);
      });

      it('404s a connector the caller cannot see, and attaches nothing', async () => {
        const r = await attach({ connectorId: 'someone-elses' });
        expect(r.statusCode).toBe(404);
        expect(attachCalls).toHaveLength(0);
      });

      it("403s a non-admin on a company-key connector without reading the company key", async () => {
        const r = await attach({ connectorId: 'company' });
        expect(r.statusCode).toBe(403);
        expect(credentialReads).toHaveLength(0);
        expect(attachCalls).toHaveLength(0);
      });

      it('lets an admin attach a company-key connector once the company key exists', async () => {
        caller = { id: 'u1', isAdmin: true };
        expect((await attach({ connectorId: 'company' })).statusCode).toBe(409);
        vault.add('account:company');
        expect((await attach({ connectorId: 'company' })).statusCode).toBe(200);
      });
    });

    it('400s a malformed body', async () => {
      expect((await attach(undefined, 'a1', '{nope')).statusCode).toBe(400);
      expect((await attach({ connectorId: 'UPPER' })).statusCode).toBe(400);
      expect((await attach({ connectorId: ['linear'] })).statusCode).toBe(400);
      expect(attachCalls).toHaveLength(0);
    });
  });
});
