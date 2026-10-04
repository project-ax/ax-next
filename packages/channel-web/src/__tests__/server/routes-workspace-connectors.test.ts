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
 *      detached; a legacy-owned one is excluded from THIS agent.
 *      A connector not in the agent's list is a 404, never a silent exclusion.
 *   3. CLEANUP IS SCOPED. Only this connector's per-tool choices and this
 *      connector's approved access are cleared — and a cleanup miss is
 *      reported as `partial`, never as complete.
 *   4. THE HOOK OWNS THE ADMIN RULE. The route passes the caller's real admin
 *      bit and turns the hook's refusal into a 403.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { CONNECTOR_RETRY_COOLDOWN_MS, makeWorkspaceHandlers, rememberBounded } from '../../server/routes-workspace.js';
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

type Source = 'attached' | 'legacy-owned';
interface Effective {
  summary: { id: string; name: string; canEdit?: boolean; keyMode?: 'personal' | 'workspace' };
  source: Source;
  toolNamespaces: Array<{ server: string; toolNamespace: string }>;
  capabilities?: {
    mcpServers?: Array<{ name: string }>;
    credentials?: Array<{ slot: string; kind: 'oauth' | 'api-key'; server?: string; headerName?: string }>;
  };
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
    runner?: string;
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
  /** TASK-765 / TASK-798 — what `agents:can-manage-connectors` answers. */
  let canManage: 'allow' | 'deny' | 'throw' | 'malformed' | 'not-found';
  let canManageCalls: Array<Record<string, unknown>>;

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
        source: 'attached',
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
    canManage = 'allow';
    canManageCalls = [];
    bus.registerService('agents:can-manage-connectors', 'agents', async (_c, i: unknown) => {
      canManageCalls.push(i as Record<string, unknown>);
      if (canManage === 'throw') throw new Error('teams store row 9 is corrupt');
      if (canManage === 'not-found') {
        throw new PluginError({ code: 'not-found', plugin: 'agents', message: "agent 'a1' not found" });
      }
      if (canManage === 'malformed') return {};
      return { allowed: canManage === 'allow' };
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
    /** TASK-756 — connectors whose expired sign-in is the agent's shared one. */
    let sharedMarked: Set<string>;
    let cached: Map<string, string>;
    let describeStatus: string;
    let describeThrows: boolean;

    function registerHealth(opts: { signIn?: boolean; inventory?: boolean; describe?: boolean } = {}) {
      if (opts.signIn !== false) {
        bus.registerService('mcp-oauth:status-batch', 'mcp-oauth', async (_c, i: unknown) => {
          signInCalls.push(i);
          const { connectorIds } = i as { connectorIds: string[] };
          return {
            needsReconnect: connectorIds.filter((id) => marked.has(id) || sharedMarked.has(id)),
            shared: connectorIds.filter((id) => sharedMarked.has(id) && !marked.has(id)),
          };
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
      sharedMarked = new Set();
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
      // TASK-756 — the agent is named, so its shared sign-in counts too.
      expect(signInCalls).toEqual([{ userId: 'u1', agentId: 'a1', connectorIds: ['gmail', 'linear', 'notes'] }]);
      expect(inventoryCalls).toEqual([
        { userId: 'u1', agentId: 'a1', connectorIds: ['gmail', 'linear', 'notes'] },
      ]);
      expect(describeCalls).toHaveLength(0);
    });

    // TASK-756 — whose sign-in expired: a team agent's shared one is flagged,
    // so the rail says so instead of "your sign-in".
    it('flags a needs-reconnect row whose expired sign-in is the shared one — and only that row', async () => {
      registerHealth();
      sharedMarked = new Set(['gmail']);
      marked = new Set(['linear']);
      const rows = (await list()).body as { connectors: Array<Record<string, unknown>> };
      const byId = Object.fromEntries(rows.connectors.map((r) => [r.id, r]));
      expect(byId.gmail).toMatchObject({ health: 'needs-reconnect', sharedSignIn: true });
      expect(byId.linear).toMatchObject({ health: 'needs-reconnect' });
      expect('sharedSignIn' in byId.linear!).toBe(false);
      expect('sharedSignIn' in byId.notes!).toBe(false);
    });

    it('a shared flag never rides on a row that is not needs-reconnect', async () => {
      registerHealth();
      sharedMarked = new Set(['linear']);
      effective[1] = { ...effective[1]!, capabilities: { mcpServers: [{ name: 'linear' }, { name: 'linear' }] } };
      const rows = (await list()).body as { connectors: Array<Record<string, unknown>> };
      const linear = rows.connectors.find((r) => r.id === 'linear')!;
      expect(linear.health).toBe('not-loaded');
      expect('sharedSignIn' in linear).toBe(false);
    });

    it('Retry that hits a SHARED rejected sign-in says so', async () => {
      registerHealth();
      describeStatus = 'needs-auth';
      sharedMarked = new Set(['linear']);
      expect((await retry('linear')).body).toEqual({ health: 'needs-reconnect', sharedSignIn: true });
    });

    it('Retry answers 502 — not ok — when the sign-in could not be read just now', async () => {
      registerHealth({ describe: false });
      bus.registerService('connectors:describe-tools', 'mcp-client', async () => {
        throw new PluginError({ code: 'credential-unavailable', plugin: 'mcp-client', message: 'blip' });
      });
      const r = await retry('linear');
      expect(r.statusCode).toBe(502);
      expect(r.body).toEqual({ error: 'retry-failed' });
    });

    describe('Retry cooldown (TASK-756)', () => {
      let clock: number;
      let h: ReturnType<typeof makeWorkspaceHandlers>;
      beforeEach(() => {
        clock = Date.parse('2026-10-03T12:00:00Z');
        h = makeWorkspaceHandlers({ bus, initCtx, now: () => new Date(clock) });
      });
      async function retryOn(connectorId: string, agentId = 'a1'): Promise<Captured> {
        const { res, captured } = mkRes();
        await h.retryConnector(mkReq({ agentId, connectorId }), res);
        return captured;
      }

      it('a second Retry inside the window answers the cached health and runs no check', async () => {
        registerHealth();
        describeStatus = 'unreachable';
        expect((await retryOn('linear')).body).toEqual({ health: 'unreachable' });
        describeStatus = 'ok'; // the server came back — but we must not ask it again yet
        clock += CONNECTOR_RETRY_COOLDOWN_MS - 1;
        expect((await retryOn('linear')).body).toEqual({ health: 'unreachable' });
        expect(describeCalls).toHaveLength(1);
      });

      it('after the window a Retry checks again', async () => {
        registerHealth();
        describeStatus = 'unreachable';
        await retryOn('linear');
        describeStatus = 'ok';
        clock += CONNECTOR_RETRY_COOLDOWN_MS;
        expect((await retryOn('linear')).body).toEqual({ health: 'ok' });
        expect(describeCalls).toHaveLength(2);
      });

      it('inside the window the sign-in is still read fresh (a reconnect shows at once)', async () => {
        registerHealth();
        describeStatus = 'needs-auth';
        marked = new Set(['linear']);
        expect((await retryOn('linear')).body).toEqual({ health: 'needs-reconnect' });
        marked = new Set(); // reconnected
        expect((await retryOn('linear')).body).toEqual({ health: 'ok' });
        expect(describeCalls).toHaveLength(1);
      });

      it('a burst of Retries shares the one check in flight', async () => {
        registerHealth({ describe: false });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        bus.registerService('connectors:describe-tools', 'mcp-client', async (_c, i: unknown) => {
          describeCalls.push(i);
          await gate;
          return { status: 'unreachable', tools: [], checkedAt: '2026-10-03T00:00:00.000Z' };
        });
        const all = Promise.all([retryOn('linear'), retryOn('linear'), retryOn('linear')]);
        await new Promise((r) => setTimeout(r, 0));
        release();
        const answers = await all;
        expect(answers.map((a) => a.body)).toEqual([
          { health: 'unreachable' },
          { health: 'unreachable' },
          { health: 'unreachable' },
        ]);
        expect(describeCalls).toHaveLength(1);
      });

      it('a check that could not run is answered again (502) without running another', async () => {
        registerHealth();
        describeThrows = true;
        expect((await retryOn('linear')).statusCode).toBe(502);
        describeThrows = false;
        expect((await retryOn('linear')).statusCode).toBe(502);
        expect(describeCalls).toHaveLength(1);
      });

      // Review F1 — a vault blip never reached the server: "try again" must
      // mean it, so it does not hold the next Retry back.
      it('a credential blip does not start the window — the next Retry checks again', async () => {
        registerHealth({ describe: false });
        let blip = true;
        bus.registerService('connectors:describe-tools', 'mcp-client', async (_c, i: unknown) => {
          describeCalls.push(i);
          if (blip) throw new PluginError({ code: 'credential-unavailable', plugin: 'mcp-client', message: 'blip' });
          return { status: 'ok', tools: [], checkedAt: '2026-10-03T00:00:00.000Z' };
        });
        expect((await retryOn('linear')).statusCode).toBe(502);
        blip = false;
        expect((await retryOn('linear')).body).toEqual({ health: 'ok' });
        expect(describeCalls).toHaveLength(2);
        // ...and a check that DID run starts the window as usual.
        expect((await retryOn('linear')).body).toEqual({ health: 'ok' });
        expect(describeCalls).toHaveLength(2);
      });

      it('keyed on person + connector: the same connector on another agent is not re-checked; it answers that agent\'s stored health', async () => {
        owners.set('a2', 'u1');
        registerHealth();
        describeStatus = 'ok';
        await retryOn('linear', 'a1');
        cached = new Map([['linear', 'unreachable']]); // a2's stored state
        expect((await retryOn('linear', 'a2')).body).toEqual({ health: 'unreachable' });
        expect(describeCalls).toHaveLength(1);
      });

      it('another connector, or another person, is not held back', async () => {
        owners.set('a2', 'u2');
        registerHealth();
        await retryOn('linear');
        await retryOn('gmail');
        expect(describeCalls).toHaveLength(2);
        caller = { id: 'u2', isAdmin: false };
        await retryOn('linear', 'a2');
        expect(describeCalls).toHaveLength(3);
      });

      it('a refused Retry (404) does not start the window', async () => {
        registerHealth();
        expect((await retryOn('slack')).statusCode).toBe(404);
        effective.push({
          summary: { id: 'slack', name: 'Slack', canEdit: true },
          source: 'attached',
          toolNamespaces: [{ server: 'slack', toolNamespace: 'c0000000001' }],
        } as (typeof effective)[number]);
        expect((await retryOn('slack')).statusCode).toBe(200);
        expect(describeCalls).toHaveLength(1);
      });
    });

    describe('rememberBounded (TASK-756 cooldown map bound)', () => {
      const W = 1_000;
      it('never grows past the bound: expired entries go first, then the oldest live one', () => {
        const m = new Map<string, { at: number }>();
        rememberBounded(m, 'old', { at: 0 }, W, 3);
        rememberBounded(m, 'a', { at: 1_500 }, W, 3);
        rememberBounded(m, 'b', { at: 1_600 }, W, 3);
        // Full: 'old' is outside the window at 1_700 and is the one dropped.
        rememberBounded(m, 'c', { at: 1_700 }, W, 3);
        expect([...m.keys()]).toEqual(['a', 'b', 'c']);
        // Full of live entries: the oldest live one goes.
        rememberBounded(m, 'd', { at: 1_800 }, W, 3);
        expect([...m.keys()]).toEqual(['b', 'c', 'd']);
        expect(m.size).toBe(3);
      });
      it('re-remembering a key moves it to the back instead of evicting another', () => {
        const m = new Map<string, { at: number }>();
        rememberBounded(m, 'a', { at: 10 }, W, 2);
        rememberBounded(m, 'b', { at: 20 }, W, 2);
        rememberBounded(m, 'a', { at: 30 }, W, 2);
        expect([...m.entries()]).toEqual([['b', { at: 20 }], ['a', { at: 30 }]]);
      });
      it('drops an entry stamped in the future (a clock step cannot pin it)', () => {
        const m = new Map<string, { at: number }>();
        // 'future' is NOT the oldest, so only the future-stamp rule drops it
        // (oldest-first eviction alone would drop 'a').
        rememberBounded(m, 'a', { at: 100 }, W, 2);
        rememberBounded(m, 'future', { at: 99_999 }, W, 2);
        rememberBounded(m, 'b', { at: 200 }, W, 2);
        expect([...m.keys()]).toEqual(['a', 'b']);
      });
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

    // TASK-795 — a connector nobody this caller's use would reach has signed in
    // to (or added a key for) says so, from a vault PRESENCE read: never a
    // credentials:get, never a resolver (no refresh, no network).
    describe('needs sign-in (TASK-795)', () => {
      /** Refs `credentials:has` reports present. */
      let present: Set<string>;
      let hasCalls: Array<{ ref: string; userId: string; agentId: string }>;
      let hasThrows: boolean;

      function registerHas(): void {
        bus.registerService('credentials:has', 'credentials', async (c, i: unknown) => {
          const { ref, userId } = i as { ref: string; userId: string };
          hasCalls.push({ ref, userId, agentId: c.agentId });
          if (hasThrows) throw new Error('vault down');
          return { present: present.has(ref) };
        });
      }

      const oauth = (server: string) => ({ slot: 'MCP_OAUTH', kind: 'oauth' as const, server });
      const key = (slot: string) => ({ slot, kind: 'api-key' as const });

      beforeEach(() => {
        present = new Set();
        hasCalls = [];
        hasThrows = false;
        // gmail: OAuth sign-in; linear: personal API key; notes: no credentials.
        effective[0] = {
          ...effective[0]!,
          summary: { ...effective[0]!.summary, keyMode: 'personal' },
          capabilities: { credentials: [oauth('gmail')] },
        };
        effective[1] = {
          ...effective[1]!,
          summary: { ...effective[1]!.summary, keyMode: 'personal' },
          capabilities: { credentials: [key('LINEAR_KEY')] },
        };
      });

      function rowsById(r: Captured): Record<string, Record<string, unknown>> {
        const rows = (r.body as { connectors: Array<Record<string, unknown>> }).connectors;
        return Object.fromEntries(rows.map((x) => [x.id as string, x]));
      }

      it('never signed in → needs-sign-in with setup sign-in; a key-only one → add-key', async () => {
        registerHealth();
        registerHas();
        const r = await list();
        expect(r.statusCode).toBe(200);
        const byId = rowsById(r);
        expect(byId.gmail).toMatchObject({ health: 'needs-sign-in', setup: 'sign-in' });
        expect(byId.linear).toMatchObject({ health: 'needs-sign-in', setup: 'add-key' });
        expect(byId.notes!.health).toBe('ok');
        expect('setup' in byId.notes!).toBe(false);
      });

      // TASK-798 — a sign-in on a team agent is stored ON the agent, so only
      // its owner or an admin is offered Sign in; a member is told to ask the
      // owner. A missing key stays add-key: the rail's Add key is their own.
      // UNFIXED: gmail says `sign-in` to the member -> fails.
      it('a team-agent member: a missing sign-in is ask-owner, a missing key stays add-key', async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        canManage = 'deny';
        const byId = rowsById(await list());
        expect(byId.gmail).toMatchObject({ health: 'needs-sign-in', setup: 'ask-owner' });
        expect(byId.linear).toMatchObject({ health: 'needs-sign-in', setup: 'add-key' });
      });

      it("the team agent's owner still gets sign-in; a personal agent never asks", async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        expect(rowsById(await list()).gmail).toMatchObject({ setup: 'sign-in' });
        agentRow = { ...agentRow, visibility: 'personal' };
        canManage = 'deny';
        expect(rowsById(await list()).gmail).toMatchObject({ setup: 'sign-in' });
      });

      it('Retry on a team agent answers ask-owner to a member, too', async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        canManage = 'deny';
        const r = await retry('gmail');
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({ health: 'needs-sign-in', setup: 'ask-owner' });
      });

      it('signed in → ok, and the row carries no setup key', async () => {
        registerHealth();
        registerHas();
        present = new Set(['account:gmail', 'account:linear']);
        const byId = rowsById(await list());
        expect(byId.gmail!.health).toBe('ok');
        expect(byId.linear!.health).toBe('ok');
        for (const row of Object.values(byId)) expect('setup' in row).toBe(false);
        // ok because the vault said present — not because nobody asked.
        expect(hasCalls.map((c) => c.ref).sort()).toEqual(['account:gmail', 'account:linear']);
      });

      it('presence reads use the caller, the agent, and the plan refs; no slots → no read', async () => {
        registerHealth();
        registerHas();
        // A multi-slot connector derives one `account:<id>:<SLOT>` ref per slot.
        effective[1] = {
          ...effective[1]!,
          capabilities: { credentials: [key('A_KEY'), key('B_KEY')] },
        };
        await list();
        expect(
          [...hasCalls].sort((a, b) => a.ref.localeCompare(b.ref)),
        ).toEqual([
          { ref: 'account:gmail', userId: 'u1', agentId: 'a1' },
          { ref: 'account:linear:A_KEY', userId: 'u1', agentId: 'a1' },
          { ref: 'account:linear:B_KEY', userId: 'u1', agentId: 'a1' },
        ]);
        expect(hasCalls.some((c) => c.ref.includes('notes'))).toBe(false);
      });

      it('one missing slot of several is enough; a missing OAuth slot wins sign-in over add-key', async () => {
        registerHealth();
        registerHas();
        effective[1] = {
          ...effective[1]!,
          capabilities: { credentials: [key('A_KEY'), oauth('linear')] },
        };
        present = new Set(['account:linear:A_KEY']);
        expect(rowsById(await list()).linear).toMatchObject({ health: 'needs-sign-in', setup: 'sign-in' });
      });

      it('a workspace-key connector asks a member to ask an admin, and offers an admin Add key', async () => {
        registerHealth();
        registerHas();
        effective[1] = {
          ...effective[1]!,
          summary: { ...effective[1]!.summary, keyMode: 'workspace' },
        };
        expect(rowsById(await list()).linear).toMatchObject({ health: 'needs-sign-in', setup: 'ask-admin' });
        caller = { id: 'u1', isAdmin: true };
        expect(rowsById(await list()).linear).toMatchObject({ health: 'needs-sign-in', setup: 'add-key' });
      });

      it('a rejected refresh outranks never-signed-in', async () => {
        registerHealth();
        registerHas();
        marked = new Set(['gmail']);
        const byId = rowsById(await list());
        expect(byId.gmail!.health).toBe('needs-reconnect');
        expect('setup' in byId.gmail!).toBe(false);
        // The same read, unmarked, does say needs-sign-in.
        expect(byId.linear).toMatchObject({ health: 'needs-sign-in', setup: 'add-key' });
      });

      it('needs-sign-in outranks unreachable; not-loaded outranks needs-sign-in', async () => {
        registerHealth();
        registerHas();
        cached = new Map([['gmail', 'unreachable']]);
        effective[1] = {
          ...effective[1]!,
          capabilities: { ...effective[1]!.capabilities, mcpServers: [{ name: 'linear' }, { name: 'linear' }] },
        };
        const byId = rowsById(await list());
        expect(byId.gmail!.health).toBe('needs-sign-in');
        expect(byId.linear!.health).toBe('not-loaded');
        expect('setup' in byId.linear!).toBe(false);
      });

      it('no credentials:has, or one that throws, degrades to ok — the list still loads', async () => {
        registerHealth();
        let r = await list();
        expect(r.statusCode).toBe(200);
        expect(healthById(r)).toEqual({ gmail: 'ok', linear: 'ok', notes: 'ok' });
        registerHas();
        hasThrows = true;
        r = await list();
        expect(r.statusCode).toBe(200);
        expect(healthById(r)).toEqual({ gmail: 'ok', linear: 'ok', notes: 'ok' });
        expect(hasCalls.length).toBeGreaterThan(0);
      });

      it('the health read never resolves a credential (no credentials:get, no resolver)', async () => {
        registerHealth();
        registerHas();
        const called: string[] = [];
        const real = bus.call.bind(bus);
        vi.spyOn(bus, 'call').mockImplementation(((name: string, ...rest: unknown[]) => {
          called.push(name);
          return (real as (n: string, ...r: unknown[]) => Promise<unknown>)(name, ...rest);
        }) as typeof bus.call);
        await list();
        expect(called).toContain('credentials:has');
        expect(called.filter((n) => n === 'credentials:get' || n.startsWith('credentials:resolve:'))).toEqual([]);
        expect(credentialReads).toEqual([]);
      });

      it('Retry answers needs-sign-in with its setup', async () => {
        registerHealth();
        registerHas();
        describeStatus = 'needs-auth';
        expect((await retry('gmail')).body).toEqual({ health: 'needs-sign-in', setup: 'sign-in' });
        caller = { id: 'u1', isAdmin: false };
        effective[1] = {
          ...effective[1]!,
          summary: { ...effective[1]!.summary, keyMode: 'workspace' },
        };
        expect((await retry('linear')).body).toEqual({ health: 'needs-sign-in', setup: 'ask-admin' });
      });

      it('Retry on a signed-in connector answers ok with no setup', async () => {
        registerHealth();
        registerHas();
        present = new Set(['account:gmail']);
        expect((await retry('gmail')).body).toEqual({ health: 'ok' });
        expect(hasCalls).toEqual([{ ref: 'account:gmail', userId: 'u1', agentId: 'a1' }]);
      });

      // TASK-805 — Retry on a connector nobody has signed in to is
      // needs-sign-in, never an error: Sign in / Add key is the fix, and the
      // check says nothing that could change that. @ax/mcp-client reports a
      // MISSING credential as the status `needs-auth` (it throws
      // `credential-unavailable` only for a credential it could not READ), so
      // the plain case never reached the 502 — these pin it for every status
      // the check can answer.
      it.each(['needs-auth', 'unreachable', 'unknown', 'ok'])(
        'Retry on a never-signed-in connector answers needs-sign-in (200) when the check says %s',
        async (status) => {
          registerHealth();
          registerHas();
          describeStatus = status;
          const r = await retry('gmail');
          expect(r.statusCode).toBe(200);
          expect(r.body).toEqual({ health: 'needs-sign-in', setup: 'sign-in' });
          expect((await retry('linear')).body).toEqual({ health: 'needs-sign-in', setup: 'add-key' });
        },
      );

      // TASK-805 — the check itself can still fail on such a connector: a
      // connector with a signed-in slot whose token read blips AND a slot with
      // no key reads `credential-unavailable` from the signed-in slot before it
      // ever reaches the missing one. The vault's presence read already said
      // what the person must do, so Retry says that instead of 502.
      // UNFIXED: 502 `retry-failed` for both -> fails.
      describe.each([
        [
          'credential-unavailable (a credential could not be read just now)',
          () => new PluginError({ code: 'credential-unavailable', plugin: 'mcp-client', message: 'blip' }),
        ],
        ['an unclassified failure of the check', () => new Error('boom')],
      ])('a check that cannot run (%s) on a never-signed-in connector', (_label, makeError) => {
        beforeEach(() => {
          registerHealth({ describe: false });
          registerHas();
          bus.registerService('connectors:describe-tools', 'mcp-client', async (_c, i: unknown) => {
            describeCalls.push(i);
            throw makeError();
          });
        });

        it('answers needs-sign-in with the setup, not a 502', async () => {
          const r = await retry('gmail');
          expect(r.statusCode).toBe(200);
          expect(r.body).toEqual({ health: 'needs-sign-in', setup: 'sign-in' });
          expect((await retry('linear')).body).toEqual({ health: 'needs-sign-in', setup: 'add-key' });
        });

        it('keeps the setup the caller is owed: ask-owner on a team agent, ask-admin for a company key', async () => {
          agentRow = { ...agentRow, visibility: 'team' };
          canManage = 'deny';
          expect((await retry('gmail')).body).toEqual({ health: 'needs-sign-in', setup: 'ask-owner' });
          agentRow = { ...agentRow, visibility: 'personal' };
          effective[1] = {
            ...effective[1]!,
            summary: { ...effective[1]!.summary, keyMode: 'workspace' },
          };
          expect((await retry('linear')).body).toEqual({ health: 'needs-sign-in', setup: 'ask-admin' });
        });

        // Not over-broad: the same failure on a connector the vault says IS
        // set up is still "we couldn't check" — nothing here knows better.
        it('still answers 502 once the connector is signed in', async () => {
          present = new Set(['account:gmail']);
          const r = await retry('gmail');
          expect(r.statusCode).toBe(502);
          expect(r.body).toEqual({ error: 'retry-failed' });
        });

        it('still answers 502 when the presence read itself fails — "unknown" is not "never signed in"', async () => {
          hasThrows = true;
          expect((await retry('gmail')).statusCode).toBe(502);
        });

        it('a rejected sign-in outranks it, so the failure stays a 502 rather than claiming first-time setup', async () => {
          marked = new Set(['gmail']);
          expect((await retry('gmail')).statusCode).toBe(502);
        });
      });

      it('a never-signed-in connector whose check failed is answered again inside the cooldown without a second check', async () => {
        registerHealth();
        registerHas();
        describeThrows = true;
        const clock = Date.parse('2026-10-03T12:00:00Z');
        const h = makeWorkspaceHandlers({ bus, initCtx, now: () => new Date(clock) });
        const retryOn = async (id: string): Promise<Captured> => {
          const { res, captured } = mkRes();
          await h.retryConnector(mkReq({ agentId: 'a1', connectorId: id }), res);
          return captured;
        };
        expect((await retryOn('gmail')).body).toEqual({ health: 'needs-sign-in', setup: 'sign-in' });
        expect((await retryOn('gmail')).body).toEqual({ health: 'needs-sign-in', setup: 'sign-in' });
        expect(describeCalls).toHaveLength(1);
      });

      it('a genuinely unreachable connector still says unreachable', async () => {
        registerHealth();
        registerHas();
        present = new Set(['account:gmail']);
        describeStatus = 'unreachable';
        expect((await retry('gmail')).body).toEqual({ health: 'unreachable' });
      });
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
          { id: 'gmail', name: 'Gmail', source: 'attached', editable: false, health: 'ok', removable: true },
          { id: 'linear', name: 'Linear', source: 'attached', editable: true, health: 'ok', removable: true },
          {
            id: 'notes',
            name: 'My notes',
            source: 'legacy-owned',
            editable: true,
            health: 'ok',
            removable: true,
          },
        ],
        shared: false,
        manageable: true,
        connectorsSupported: true,
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
        { summary: { id: 'blank', name: '​​', canEdit: false }, source: 'attached', toolNamespaces: [] },
      ];
      const r = await list();
      const rows = (r.body as { connectors: Array<{ id: string; name: string }> }).connectors;
      expect(rows[0]?.name).not.toMatch(/[‮​]/);
      expect(rows[1]).toMatchObject({ id: 'blank', name: 'blank' });
    });

    it("never shows a source other than attached / legacy-owned — a retired 'default' reads as attached", async () => {
      effective = [
        // Not a source the host emits any more; it must not reach the rail.
        { summary: { id: 'old', name: 'Old', canEdit: false }, source: 'default' as never, toolNamespaces: [] },
        ...effective,
      ];
      const r = await list();
      const rows = (r.body as { connectors: Array<{ id: string; source: string }> }).connectors;
      expect(rows.find((row) => row.id === 'old')?.source).toBe('attached');
      expect(new Set(rows.map((row) => row.source))).toEqual(new Set(['attached', 'legacy-owned']));
    });

    it('drops an entry whose id is not a connector id', async () => {
      effective = [
        { summary: { id: '../x', name: 'Bad' }, source: 'attached', toolNamespaces: [] },
        ...effective,
      ];
      const r = await list();
      expect((r.body as { connectors: unknown[] }).connectors).toHaveLength(3);
    });

    it("says whether the agent's runner can use connectors at all (TASK-761)", async () => {
      // No runner on the row: it predates the field and runs on claude-sdk.
      expect((await list()).body).toMatchObject({ connectorsSupported: true });
      agentRow.runner = 'claude-sdk';
      expect((await list()).body).toMatchObject({ connectorsSupported: true });
      agentRow.runner = 'aisdk';
      expect((await list()).body).toMatchObject({ connectorsSupported: false });
      // A runner nobody wired for connectors is not assumed to load them.
      agentRow.runner = 'something-new';
      expect((await list()).body).toMatchObject({ connectorsSupported: false });
    });

    // TASK-765 / TASK-798 — on a TEAM agent only its owner (a team admin) or a
    // workspace admin may add, remove or sign in ON the agent. @ax/agents owns
    // that rule; the route asks it once and shows the answer as `manageable`
    // and on every row's `removable`. The server still enforces on each write.
    describe('manageable (TASK-765, TASK-798)', () => {
      function removableById(r: Captured): Record<string, boolean> {
        const rows = (r.body as { connectors: Array<{ id: string; removable: boolean }> }).connectors;
        return Object.fromEntries(rows.map((x) => [x.id, x.removable]));
      }

      beforeEach(() => {
        agentRow = { ...agentRow, visibility: 'team' };
      });

      // UNFIXED: no `manageable`, and the attached row says removable -> fails.
      it('a plain member: not manageable, and NO row is removable — attached ones included', async () => {
        canManage = 'deny';
        const r = await list();
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({ shared: true, manageable: false });
        expect(removableById(r)).toEqual({ gmail: false, linear: false, notes: false });
      });

      it('an owner/admin the hook allows: manageable, every row removable', async () => {
        const r = await list();
        expect(r.body).toMatchObject({ manageable: true });
        expect(removableById(r)).toEqual({ gmail: true, linear: true, notes: true });
      });

      it("asks the hook ONCE, with the caller's real admin bit and this agent — even for an empty list", async () => {
        caller = { id: 'u1', isAdmin: true };
        await list();
        expect(canManageCalls).toEqual([{ actor: { userId: 'u1', isAdmin: true }, agentId: 'a1' }]);
        canManageCalls = [];
        effective = [];
        expect((await list()).body).toMatchObject({ connectors: [], manageable: true });
        expect(canManageCalls).toHaveLength(1);
      });

      it('no hook: fails closed to not manageable', async () => {
        bus = new HookBus();
        bus.registerService('auth:require-user', 'auth', async () => ({ user: caller }));
        bus.registerService('agents:resolve', 'agents', async () => ({
          agent: { id: 'a1', displayName: 'Quill', ...agentRow },
        }));
        bus.registerService('connectors:list-effective', 'connectors', async () => ({
          connectors: effective,
        }));
        const r = await list();
        expect(r.body).toMatchObject({ manageable: false });
        expect(removableById(r)).toEqual({ gmail: false, linear: false, notes: false });
      });

      it('a throwing hook: fails closed, the list still loads, logged by error NAME only', async () => {
        canManage = 'throw';
        const warn = vi.spyOn(initCtx.logger, 'warn');
        const r = await list();
        const call = warn.mock.calls.find((c) => c[0] === 'workspace_connector_can_manage_failed');
        warn.mockRestore();
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({ manageable: false });
        expect(call?.[1]).toEqual({ agentId: 'a1', name: expect.any(String) });
        expect(JSON.stringify(call?.[1])).not.toContain('corrupt');
      });
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

    it('403s a member removing a legacy-owned connector from a team agent when the hook refuses — nothing cleaned', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      detachRefusal = new PluginError({
        code: 'forbidden',
        plugin: 'agents',
        message: "only the agent's owner or an admin can change its connectors",
      });
      const r = await remove('notes');
      expect(r.statusCode).toBe(403);
      expect(r.body).toEqual({ error: 'forbidden' });
      expect(detachCalls).toEqual([
        { actor: { userId: 'u1', isAdmin: false }, agentId: 'a1', connectorId: 'notes', exclude: true },
      ]);
      expect(overrideClears).toHaveLength(0);
      expect(revokeCalls).toHaveLength(0);
    });

    // TASK-798 — an ATTACHED connector too: removing it from a team agent
    // takes it from every member. @ax/agents refuses; nothing is cleaned.
    it('403s a member removing an ATTACHED connector from a team agent — nothing cleaned (TASK-798)', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      detachRefusal = new PluginError({
        code: 'forbidden',
        plugin: 'agents',
        message: "only the agent's owner or an admin can change its connectors",
      });
      const r = await remove('linear');
      expect(r.statusCode).toBe(403);
      expect(r.body).toEqual({ error: 'forbidden' });
      expect(detachCalls).toEqual([
        { actor: { userId: 'u1', isAdmin: false }, agentId: 'a1', connectorId: 'linear', exclude: false },
      ]);
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
      expect(r.body).toEqual({ error: 'forbidden' });
    });

    // TASK-798 — a plain member of a TEAM agent may not add anything to it.
    // Refused up front (the hook decides again), before the TASK-761 gate
    // reads any credential presence on the member's behalf.
    // UNFIXED: the gate runs, the attach lands -> 200 -> fails.
    it('SECURITY: 403s a team-agent member before any credential read or attach', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      canManage = 'deny';
      const r = await attach({ connectorId: 'figma' });
      expect(r.statusCode).toBe(403);
      expect(r.body).toEqual({ error: 'forbidden' });
      expect(credentialReads).toHaveLength(0);
      expect(attachCalls).toHaveLength(0);
      expect(canManageCalls).toEqual([{ actor: { userId: 'u1', isAdmin: false }, agentId: 'a1' }]);
    });

    // TASK-803 — a hook FAULT is not a denial. The hook's only "no" is
    // `{ allowed: false }`; a rejection means the answer could not be read, so
    // the member is told nothing about permissions: the error propagates (the
    // router answers 5xx and logs it) instead of being dressed up as
    // "forbidden". Still fail-closed — nothing downstream runs.
    // UNFIXED: the fault was swallowed into `false` -> a 403 -> fails.
    it('SECURITY: a may-manage hook FAULT propagates (5xx), never a 403, and nothing downstream runs', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      canManage = 'throw';
      const { res, captured } = mkRes();
      await expect(
        handlers().attachConnector(mkReq({ agentId: 'a1' }, { connectorId: 'linear' }), res),
      ).rejects.toThrow('teams store row 9 is corrupt');
      expect(captured.statusCode).not.toBe(403);
      expect(captured.body).toBeUndefined();
      expect(credentialReads).toHaveLength(0);
      expect(attachCalls).toHaveLength(0);
    });

    // A reply that is neither `true` nor `false` is a broken hook, not a "no".
    it('SECURITY: a may-manage answer with no boolean verdict is a fault (5xx), not a 403, and not an allow', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      canManage = 'malformed';
      const { res, captured } = mkRes();
      await expect(
        handlers().attachConnector(mkReq({ agentId: 'a1' }, { connectorId: 'linear' }), res),
      ).rejects.toThrow(/allowed/);
      expect(captured.statusCode).not.toBe(403);
      expect(credentialReads).toHaveLength(0);
      expect(attachCalls).toHaveLength(0);
    });

    // The agent can vanish between the route's resolve and the hook's read.
    it('a may-manage hook that finds the agent gone answers 404 agent-not-found', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      canManage = 'not-found';
      const r = await attach({ connectorId: 'linear' });
      expect(r.statusCode).toBe(404);
      expect(r.body).toEqual({ error: 'agent-not-found' });
      expect(attachCalls).toHaveLength(0);
    });

    // No hook registered = the question cannot be asked. Not "forbidden": the
    // feature is unavailable (503, like every other missing connector hook),
    // and the member's request still never reaches the credential gate.
    it('SECURITY: no may-manage hook on a team agent is 503 connectors-unavailable, not a 403, and not an allow', async () => {
      bus = new HookBus();
      bus.registerService('auth:require-user', 'auth', async () => ({ user: caller }));
      bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => ({
        agent: { id: (i as { agentId: string }).agentId, displayName: 'Quill', visibility: 'team' },
      }));
      bus.registerService('agents:attach-connector', 'agents', async (_c, i: unknown) => {
        attachCalls.push(i as Record<string, unknown>);
        return { agent: {}, changed: true };
      });
      // Everything BELOW the ask would say yes (a connector with no credential
      // slots), so only the missing-hook branch itself can produce this 503 —
      // without it the attach would land and this reads 200.
      bus.registerService('connectors:get', 'connectors', async () => ({
        connector: { id: 'linear', name: 'Linear', keyMode: 'user', capabilities: { credentials: [] } },
      }));
      const r = await attach({ connectorId: 'linear' });
      expect(r.statusCode).toBe(503);
      expect(r.body).toEqual({ error: 'connectors-unavailable' });
      expect(attachCalls).toHaveLength(0);
    });

    // A plain `false` answer is still the one and only 403 (see the SECURITY
    // test above), and an `isAdmin` caller never asks. Personal agents never
    // ask either: the attach hook is the sole judge there.
    it('a personal agent never asks the may-manage hook, so a broken hook cannot block its owner', async () => {
      canManage = 'throw';
      const r = await attach({ connectorId: 'linear' });
      expect(r.statusCode).toBe(200);
      expect(canManageCalls).toHaveLength(0);
    });

    it("the team agent's owner (a team admin) attaches: 200", async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      const r = await attach({ connectorId: 'linear' });
      expect(r.statusCode).toBe(200);
      expect(attachCalls).toHaveLength(1);
    });

    it('a workspace admin attaches to a team agent without the up-front ask', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      caller = { id: 'u1', isAdmin: true };
      canManage = 'deny';
      const r = await attach({ connectorId: 'linear' });
      expect(r.statusCode).toBe(200);
      expect(canManageCalls).toHaveLength(0);
    });

    // The hook is the enforcer; its member refusal is a plain 403 here.
    it("turns the hook's owner-or-admin refusal into a plain 403", async () => {
      attachRefusal = new PluginError({
        code: 'forbidden',
        plugin: 'agents',
        message: "only the agent's owner or an admin can change its connectors",
      });
      const r = await attach({ connectorId: 'linear' });
      expect(r.statusCode).toBe(403);
      expect(r.body).toEqual({ error: 'forbidden' });
    });

    it('an owner/admin attach the hook allows is unchanged: 200', async () => {
      caller = { id: 'u1', isAdmin: false };
      const r = await attach({ connectorId: 'linear' });
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ attached: true, changed: true });
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

      it('logs a fail-closed check by step and error NAME only — never the message', async () => {
        const warn = vi.spyOn(initCtx.logger, 'warn');
        credentialError = new Error('vault row 42 for account:figma is corrupt');
        expect((await attach({ connectorId: 'figma' })).statusCode).toBe(503);
        const call = warn.mock.calls.find((c) => c[0] === 'workspace_connector_attach_check_failed');
        warn.mockRestore();
        expect(call?.[1]).toEqual({ connectorId: 'figma', step: 'credential', name: expect.any(String) });
        expect(JSON.stringify(call?.[1])).not.toContain('corrupt');
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
