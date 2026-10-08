// @vitest-environment node
/**
 * The Connectors tab's list routes (TASK-739, connectors-rail slice 6):
 *
 *   GET    /api/workspace/agents/:agentId/connectors
 *   POST   /api/workspace/agents/:agentId/connectors          {connectorId, keys?}
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
 *   5. ADD IS ALL OR NOTHING (slice 3). A per-agent key is written ON the agent
 *      in the Add request and deleted again if the attach fails; an OAuth
 *      connector is never attached here; Remove deletes the agent's own
 *      sign-in and keys, never a person's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  /** When set, `connectors:list-effective` answers from the input's attachments instead. */
  let effectiveFromAttachments: boolean;
  let listEffectiveCalls: unknown[];
  let detachCalls: Array<Record<string, unknown>>;
  let attachCalls: Array<Record<string, unknown>>;
  let detachRefusal: PluginError | null;
  let attachRefusal: PluginError | null;
  /** What `agents:attach-connector` says it changed. */
  let attachChanged: boolean;
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
  /** TASK-813 — what `agents:can-set-shared-credential` answers. */
  let canSetShared: 'allow' | 'deny' | 'throw';
  let canSetSharedCalls: Array<Record<string, unknown>>;

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
    effectiveFromAttachments = false;
    listEffectiveCalls = [];
    detachCalls = [];
    attachCalls = [];
    detachRefusal = null;
    attachRefusal = null;
    attachChanged = true;
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
      if (effectiveFromAttachments) {
        const { attachmentIds } = i as { attachmentIds: string[] };
        return {
          connectors: attachmentIds.map((id) => ({
            summary: { id, name: id },
            source: 'attached',
            toolNamespaces: [],
          })),
        };
      }
      return { connectors: effective };
    });
    bus.registerService('agents:attach-connector', 'agents', async (_c, i: unknown) => {
      attachCalls.push(i as Record<string, unknown>);
      if (attachRefusal !== null) throw attachRefusal;
      return { agent: {}, changed: attachChanged };
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
    canSetShared = 'allow';
    canSetSharedCalls = [];
    bus.registerService('agents:can-set-shared-credential', 'agents', async (_c, i: unknown) => {
      canSetSharedCalls.push(i as Record<string, unknown>);
      if (canSetShared === 'throw') throw new Error('teams store row 9 is corrupt');
      return { allowed: canSetShared === 'allow' };
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
      agentRow = { ...agentRow, visibility: 'team' };
      sharedMarked = new Set(['gmail']);
      marked = new Set(['linear']);
      const rows = (await list()).body as { connectors: Array<Record<string, unknown>> };
      const byId = Object.fromEntries(rows.connectors.map((r) => [r.id, r]));
      expect(byId.gmail).toMatchObject({ health: 'needs-reconnect', sharedSignIn: true });
      expect(byId.linear).toMatchObject({ health: 'needs-reconnect' });
      expect('sharedSignIn' in byId.linear!).toBe(false);
      expect('sharedSignIn' in byId.notes!).toBe(false);
    });

    // Slice 3 — a personal agent's sign-in is the agent's too (agent scope),
    // but there is no team to share it with: an expired one is the plain
    // needs-reconnect state ("Sign in again"), never "Team sign-in expired".
    it('never flags a personal agent\'s expired agent sign-in as a team one', async () => {
      registerHealth();
      agentRow = { ...agentRow, visibility: 'personal' };
      sharedMarked = new Set(['gmail']);
      const rows = (await list()).body as { connectors: Array<Record<string, unknown>> };
      const gmail = rows.connectors.find((r) => r.id === 'gmail')!;
      expect(gmail.health).toBe('needs-reconnect');
      expect('sharedSignIn' in gmail).toBe(false);
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

      // TASK-810 — the admin's OAuth client secret is not something a person
      // signs in with. The host never asks the vault about
      // `account:<id>:OAUTH_CLIENT_SECRET` (TASK-797), so the rail must not
      // either: a connector whose ONLY absent row is that one is healthy.
      // UNFIXED: gmail reads needs-sign-in / add-key off the client-secret row.
      it('ignores the OAuth client-secret slot: signed in otherwise reads ok, never asked about', async () => {
        registerHealth();
        registerHas();
        effective[0] = {
          ...effective[0]!,
          capabilities: {
            // (The real OAuth slot also carries `clientSecretRef`; the rail
            // reads only slot / kind, so this fixture's type leaves it out.)
            credentials: [oauth('gmail'), key('OAUTH_CLIENT_SECRET')],
          },
        };
        present = new Set(['account:gmail:MCP_OAUTH', 'account:linear']);
        const byId = rowsById(await list());
        expect(byId.gmail!.health).toBe('ok');
        expect('setup' in byId.gmail!).toBe(false);
        expect(hasCalls.map((c) => c.ref)).not.toContain('account:gmail:OAUTH_CLIENT_SECRET');
        // The user's own sign-in is still checked: absent, it still says so.
        present = new Set(['account:linear']);
        expect(rowsById(await list()).gmail).toMatchObject({ health: 'needs-sign-in', setup: 'sign-in' });
      });

      // TASK-798 — a sign-in on a team agent is stored ON the agent, so only
      // its owner is offered Sign in; a member is told to ask the owner.
      // TASK-813 — "its owner" is a team admin ONLY (agents:can-set-shared-credential),
      // no workspace-admin bypass. Slice 3 — a key is the agent's too, so a
      // missing key is ask-owner for them as well.
      // UNFIXED: linear says `add-key` to the member -> fails.
      it('a team-agent member: a missing sign-in or key is ask-owner', async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        canManage = 'deny';
        canSetShared = 'deny';
        const byId = rowsById(await list());
        expect(byId.gmail).toMatchObject({ health: 'needs-sign-in', setup: 'ask-owner' });
        expect(byId.linear).toMatchObject({ health: 'needs-sign-in', setup: 'ask-owner' });
      });

      it("the team agent's owner still gets sign-in and add-key; a personal agent's owner too", async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        let byId = rowsById(await list());
        expect(byId.gmail).toMatchObject({ setup: 'sign-in' });
        expect(byId.linear).toMatchObject({ setup: 'add-key' });
        agentRow = { ...agentRow, visibility: 'personal' };
        canManage = 'deny';
        canSetShared = 'deny';
        byId = rowsById(await list());
        expect(byId.gmail).toMatchObject({ setup: 'sign-in' });
        expect(byId.linear).toMatchObject({ setup: 'add-key' });
      });

      // TASK-813 — sign-in on a team agent follows sharedCredentials, NOT
      // manageable: a workspace admin may still add/remove connectors there
      // (manageable stays true) but may not sign in for the team.
      // UNFIXED: setup reads `sign-in` off manageable -> fails.
      it('a workspace admin who is not a team admin: manageable, but a missing sign-in is ask-owner', async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        caller = { id: 'u1', isAdmin: true };
        canManage = 'allow';
        canSetShared = 'deny';
        const r = await list();
        expect(r.body).toMatchObject({ shared: true, manageable: true, sharedCredentials: false });
        const byId = rowsById(r);
        expect(byId.gmail).toMatchObject({ health: 'needs-sign-in', setup: 'ask-owner' });
        expect(byId.linear).toMatchObject({ health: 'needs-sign-in', setup: 'ask-owner' });
        expect(canSetSharedCalls).toEqual([{ actor: { userId: 'u1', isAdmin: true }, agentId: 'a1' }]);
      });

      // Slice 3 — the row no longer says `teamKey`: Add key follows `setup`.
      it('a team admin: sharedCredentials, sign-in and add-key — and no row says teamKey', async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        const r = await list();
        expect(r.body).toMatchObject({ shared: true, sharedCredentials: true });
        const byId = rowsById(r);
        expect(byId.gmail).toMatchObject({ health: 'needs-sign-in', setup: 'sign-in' });
        expect(byId.linear).toMatchObject({ health: 'needs-sign-in', setup: 'add-key' });
        for (const row of Object.values(byId)) expect('teamKey' in row).toBe(false);
      });

      it('a plain member: no sharedCredentials', async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        canManage = 'deny';
        canSetShared = 'deny';
        const r = await list();
        expect(r.body).toMatchObject({ manageable: false, sharedCredentials: false });
      });

      it('a personal agent: sharedCredentials false, the hook is never asked', async () => {
        registerHealth();
        registerHas();
        const r = await list();
        expect(r.body).toMatchObject({ shared: false, manageable: true, sharedCredentials: false });
        expect(rowsById(r).gmail).toMatchObject({ setup: 'sign-in' });
        expect(canSetSharedCalls).toEqual([]);
      });

      it('a throwing shared-credential hook fails closed: ask-owner, logged by error NAME only', async () => {
        registerHealth();
        registerHas();
        agentRow = { ...agentRow, visibility: 'team' };
        canSetShared = 'throw';
        const warn = vi.spyOn(initCtx.logger, 'warn');
        const r = await list();
        const call = warn.mock.calls.find((c) => c[0] === 'workspace_connector_can_set_shared_failed');
        warn.mockRestore();
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({ sharedCredentials: false });
        expect(rowsById(r).gmail).toMatchObject({ setup: 'ask-owner' });
        expect(call?.[1]).toEqual({ agentId: 'a1', name: expect.any(String) });
        expect(JSON.stringify(call?.[1])).not.toContain('corrupt');
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

      // Slice 3 — Add key writes the AGENT's key, which a company-key
      // connector refuses (409): the company key is added in Admin ›
      // Connectors, so even an admin's row says ask-admin, never add-key.
      // UNFIXED: the admin's row says add-key -> fails.
      it('a workspace-key connector says ask-admin to everyone — an admin too', async () => {
        registerHealth();
        registerHas();
        effective[1] = {
          ...effective[1]!,
          summary: { ...effective[1]!.summary, keyMode: 'workspace' },
        };
        expect(rowsById(await list()).linear).toMatchObject({ health: 'needs-sign-in', setup: 'ask-admin' });
        caller = { id: 'u1', isAdmin: true };
        expect(rowsById(await list()).linear).toMatchObject({ health: 'needs-sign-in', setup: 'ask-admin' });
      });

      // Slice 3 — an OAuth connector that also declares a header key: once
      // signed in, the row offers Add key for the header key.
      it('an OAuth connector signed in but missing its header key says add-key', async () => {
        registerHealth();
        registerHas();
        effective[0] = {
          ...effective[0]!,
          capabilities: { credentials: [oauth('gmail'), key('GMAIL_HEADER')] },
        };
        present = new Set(['account:gmail:MCP_OAUTH', 'account:linear']);
        expect(rowsById(await list()).gmail).toMatchObject({ health: 'needs-sign-in', setup: 'add-key' });
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

    });

    it('says when the agent is shared (Reconnect asks before signing in for a team)', async () => {
      agentRow = { ...agentRow, visibility: 'team' };
      expect((await list()).body).toMatchObject({ shared: true });
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
        sharedCredentials: false,
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
      // TASK-826 — the aisdk runner loads connectors too.
      agentRow.runner = 'aisdk';
      expect((await list()).body).toMatchObject({ connectorsSupported: true });
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

  // Slice 3 — a sign-in or key belongs to the agent it was added on. Removing
  // the connector from the agent deletes THAT agent's own sign-in and keys —
  // after the detach, best-effort — and never a person's, nor another agent's.
  describe("DELETE — the agent's own sign-in and keys go with it", () => {
    let sharedSignOuts: Array<{ input: Record<string, unknown>; detachedFirst: boolean }>;
    let sharedSignOutThrows: boolean;
    let personalSignOuts: unknown[];
    let credentialDeletes: Array<Record<string, unknown>>;
    let credentialDeleteThrows: boolean;

    const withCreds = (
      id: string,
      keyMode: 'personal' | 'workspace',
      credentials: NonNullable<NonNullable<Effective['capabilities']>['credentials']>,
    ): Effective => ({
      summary: { id, name: id, keyMode },
      source: 'attached',
      toolNamespaces: [],
      capabilities: { credentials },
    });

    beforeEach(() => {
      sharedSignOuts = [];
      sharedSignOutThrows = false;
      personalSignOuts = [];
      credentialDeletes = [];
      credentialDeleteThrows = false;
      effective.push(
        withCreds('figma', 'personal', [{ slot: 'MCP_OAUTH', kind: 'oauth', server: 'figma' }]),
        withCreds('multi', 'personal', [
          { slot: 'A_KEY', kind: 'api-key' },
          { slot: 'B_KEY', kind: 'api-key' },
        ]),
        withCreds('company', 'workspace', [{ slot: 'KEY', kind: 'api-key' }]),
      );
      bus.registerService('mcp-oauth:remove-shared-sign-in', 'mcp-oauth', async (_c, i: unknown) => {
        sharedSignOuts.push({ input: i as Record<string, unknown>, detachedFirst: detachCalls.length === 1 });
        if (sharedSignOutThrows) throw new Error('vault row 7 for account:figma is corrupt');
        return { removed: true };
      });
      // Still registered by @ax/mcp-oauth until slice 5 — Remove must not call it.
      bus.registerService('mcp-oauth:remove-personal-sign-in', 'mcp-oauth', async (_c, i: unknown) => {
        personalSignOuts.push(i);
        return { removed: true };
      });
      bus.registerService('credentials:delete', 'credentials', async (_c, i: unknown) => {
        credentialDeletes.push(i as Record<string, unknown>);
        if (credentialDeleteThrows) throw new Error('vault row 9 is corrupt');
        return undefined;
      });
    });

    it("an OAuth connector: detach, THEN this agent's sign-in goes — no signedOut, no person touched", async () => {
      const r = await remove('figma');
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ removed: true, cleanup: 'complete' });
      expect(detachCalls).toHaveLength(1);
      expect(sharedSignOuts).toEqual([
        { input: { agentId: 'a1', connectorId: 'figma' }, detachedFirst: true },
      ]);
      expect(personalSignOuts).toEqual([]);
      expect(credentialDeletes).toEqual([]);
    });

    it("a per-agent key connector: each slot's key is deleted at agent scope, under the plan refs", async () => {
      const r = await remove('multi');
      expect(r.body).toEqual({ removed: true, cleanup: 'complete' });
      expect(credentialDeletes).toEqual([
        { scope: 'agent', ownerId: 'a1', ref: 'account:multi:A_KEY' },
        { scope: 'agent', ownerId: 'a1', ref: 'account:multi:B_KEY' },
      ]);
      expect(sharedSignOuts).toEqual([]);
      expect(personalSignOuts).toEqual([]);
    });

    it("never touches a shared-key (workspace) connector's key, nor a connector that needs nothing", async () => {
      expect((await remove('company')).body).toEqual({ removed: true, cleanup: 'complete' });
      expect((await remove('linear')).body).toEqual({ removed: true, cleanup: 'complete' });
      expect(credentialDeletes).toEqual([]);
      expect(sharedSignOuts).toEqual([]);
    });

    it('a sign-in or key delete that did not land is a partial cleanup, logged by error NAME only — the remove still stands', async () => {
      const warn = vi.spyOn(initCtx.logger, 'warn');
      sharedSignOutThrows = true;
      const a = await remove('figma');
      credentialDeleteThrows = true;
      const b = await remove('multi');
      const lines = warn.mock.calls.filter((c) => c[0] === 'workspace_connector_credential_cleanup_failed');
      warn.mockRestore();
      expect(a).toEqual({ statusCode: 200, body: { removed: true, cleanup: 'partial' } });
      expect(b).toEqual({ statusCode: 200, body: { removed: true, cleanup: 'partial' } });
      // Both slots were still attempted.
      expect(credentialDeletes).toHaveLength(2);
      expect(lines.length).toBeGreaterThan(0);
      expect(JSON.stringify(lines)).not.toContain('corrupt');
    });

    it('no remove-shared-sign-in / no credentials:delete hook: the remove stands, cleanup partial', async () => {
      const old = bus;
      bus = new HookBus();
      for (const name of [
        'auth:require-user',
        'agents:resolve',
        'connectors:list-effective',
        'agents:detach-connector',
        'tool-policy:list-agent-overrides',
        'tool-policy:set-agent-override',
        'skills:approved-caps-list',
        'skills:approved-caps-revoke',
      ]) {
        bus.registerService(name, 'x', (c, i) => old.call(name, c, i));
      }
      expect((await remove('figma')).body).toEqual({ removed: true, cleanup: 'partial' });
      expect((await remove('multi')).body).toEqual({ removed: true, cleanup: 'partial' });
      expect((await remove('linear')).body).toEqual({ removed: true, cleanup: 'complete' });
    });

    it('deletes nothing when the detach is refused', async () => {
      detachRefusal = new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
      expect((await remove('figma')).statusCode).toBe(403);
      expect((await remove('multi')).statusCode).toBe(403);
      expect(sharedSignOuts).toEqual([]);
      expect(credentialDeletes).toEqual([]);
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

    it("turns the hook's forbidden refusal into an opaque 403", async () => {
      attachRefusal = new PluginError({
        code: 'forbidden',
        plugin: 'agents',
        message: 'forbidden',
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

    // Slice 3 — Add is all or nothing, and what a connector needs decides how:
    //   - an OAuth connector is added by the sign-in callback, never here (409);
    //   - a per-agent key connector brings its keys in this request: they are
    //     written ON the agent, then attached, and deleted if the attach fails;
    //   - a shared-key or no-auth connector takes no keys; a shared key must
    //     already exist (TASK-827).
    // No credential of the agent's is ever READ before the attach any more:
    // that pre-attach read (TASK-761) is the bug the slice-3 spec names.
    describe('what a connector needs, in one request (slice 3)', () => {
      const SECRET_A = 'sk-AAAA-SUPERSECRET';
      const SECRET_B = 'sk-BBBB-SUPERSECRET';
      const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');
      let order: string[];
      let sets: Array<{ input: Record<string, unknown>; agentId: string; userId: string }>;
      let setFailsOn: string | null;
      let deletes: Array<Record<string, unknown>>;
      let deleteThrows: boolean;
      let authorize: 'allow' | 'deny' | 'throw';
      let authorizeCalls: Array<Record<string, unknown>>;
      let logged: unknown[][];

      beforeEach(() => {
        order = [];
        sets = [];
        setFailsOn = null;
        deletes = [];
        deleteThrows = false;
        authorize = 'allow';
        authorizeCalls = [];
        logged = [];
        catalog.set('multi', {
          id: 'multi',
          name: 'multi',
          keyMode: 'personal',
          capabilities: {
            credentials: [
              { slot: 'A_KEY', kind: 'api-key' },
              { slot: 'B_KEY', kind: 'api-key' },
            ],
          },
        });
        bus.registerService('credentials:authorize-agent:account', 'connectors', async (_c, i: unknown) => {
          authorizeCalls.push(i as Record<string, unknown>);
          if (authorize === 'throw') throw new Error('connector store row 3 is corrupt');
          return { allowed: authorize === 'allow' };
        });
        bus.registerService('credentials:set', 'credentials', async (c, i: unknown) => {
          const input = i as Record<string, unknown>;
          order.push(`set:${String(input.ref)}`);
          sets.push({ input, agentId: c.agentId, userId: c.userId });
          if (setFailsOn === input.ref) throw new Error(`vault refused ${SECRET_B}`);
          return undefined;
        });
        bus.registerService('credentials:delete', 'credentials', async (_c, i: unknown) => {
          const input = i as Record<string, unknown>;
          order.push(`delete:${String(input.ref)}`);
          deletes.push(input);
          if (deleteThrows) throw new Error(`vault delete failed near ${SECRET_A}`);
          return undefined;
        });
        // Order of attach relative to the writes.
        const old = bus;
        bus = new HookBus();
        for (const name of [
          'auth:require-user',
          'agents:resolve',
          'agents:can-manage-connectors',
          'agents:can-set-shared-credential',
          'connectors:get',
          'connectors:list-effective',
          'credentials:get',
          'credentials:authorize-agent:account',
          'credentials:set',
          'credentials:delete',
        ]) {
          bus.registerService(name, 'x', (c, i) => old.call(name, c, i));
        }
        bus.registerService('agents:attach-connector', 'agents', async (c, i: unknown) => {
          order.push('attach');
          return old.call('agents:attach-connector', c, i);
        });
        for (const level of ['info', 'warn', 'error', 'debug'] as const) {
          vi.spyOn(initCtx.logger, level).mockImplementation((...args: unknown[]) => {
            logged.push(args);
          });
        }
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      const keysFor = (a = SECRET_A, b = SECRET_B) => [
        { slot: 'A_KEY', payloadB64: b64(a) },
        { slot: 'B_KEY', payloadB64: b64(b) },
      ];

      function expectNoLeak(r: Captured): void {
        const all = JSON.stringify(r.body) + JSON.stringify(logged);
        for (const s of [SECRET_A, SECRET_B, b64(SECRET_A), b64(SECRET_B)]) expect(all).not.toContain(s);
      }

      it('a per-agent key connector: every slot written ON the agent, then attached — 200', async () => {
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 200, body: { attached: true, changed: true } });
        expect(order).toEqual(['set:account:multi:A_KEY', 'set:account:multi:B_KEY', 'attach']);
        expect(sets.map((s) => ({ ...s.input, payload: Buffer.from(s.input.payload as Uint8Array).toString('utf-8') }))).toEqual([
          { scope: 'agent', ownerId: 'a1', ref: 'account:multi:A_KEY', kind: 'api-key', payload: SECRET_A },
          { scope: 'agent', ownerId: 'a1', ref: 'account:multi:B_KEY', kind: 'api-key', payload: SECRET_B },
        ]);
        expect(sets.map((s) => [s.agentId, s.userId])).toEqual([
          ['a1', 'u1'],
          ['a1', 'u1'],
        ]);
        // The agent-store question, per ref, before any write.
        expect(authorizeCalls).toEqual([
          { userId: 'u1', agentId: 'a1', ref: 'account:multi:A_KEY', purpose: 'store' },
          { userId: 'u1', agentId: 'a1', ref: 'account:multi:B_KEY', purpose: 'store' },
        ]);
        // Owner check on a personal agent: the admin bit grants nothing here.
        expect(canManageCalls).toEqual([{ actor: { userId: 'u1', isAdmin: false }, agentId: 'a1' }]);
        // No credential of the agent's is read before the attach.
        expect(credentialReads).toEqual([]);
        expect(deletes).toEqual([]);
        expectNoLeak(r);
      });

      // REVIEW FOCUS — the attach is refused after the keys were written (say,
      // the person stopped being a team admin mid-request): no key survives.
      it('the attach is refused: both written slots are deleted, and the answer is the attach error', async () => {
        attachRefusal = new PluginError({ code: 'forbidden', plugin: 'agents', message: 'not a team admin' });
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
        expect(order).toEqual([
          'set:account:multi:A_KEY',
          'set:account:multi:B_KEY',
          'attach',
          'delete:account:multi:A_KEY',
          'delete:account:multi:B_KEY',
        ]);
        expect(deletes).toEqual([
          { scope: 'agent', ownerId: 'a1', ref: 'account:multi:A_KEY' },
          { scope: 'agent', ownerId: 'a1', ref: 'account:multi:B_KEY' },
        ]);
        expectNoLeak(r);
      });

      it('the attach throws something unclassified: the keys are deleted and the fault still propagates (5xx)', async () => {
        attachRefusal = new Error('agents store down') as PluginError;
        const { res } = mkRes();
        await expect(
          handlers().attachConnector(mkReq({ agentId: 'a1' }, { connectorId: 'multi', keys: keysFor() }), res),
        ).rejects.toThrow('agents store down');
        expect(deletes.map((d) => d.ref)).toEqual(['account:multi:A_KEY', 'account:multi:B_KEY']);
      });

      it('the second slot write fails: the first is deleted, nothing is attached — 502, never the key', async () => {
        setFailsOn = 'account:multi:B_KEY';
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 502, body: { error: 'connector-key-not-saved' } });
        expect(order).not.toContain('attach');
        expect(deletes.map((d) => d.ref)).toContain('account:multi:A_KEY');
        expect(deletes.every((d) => d.scope === 'agent' && d.ownerId === 'a1')).toBe(true);
        expect(attachCalls).toEqual([]);
        expectNoLeak(r);
      });

      it('a rollback delete that fails is logged by error NAME only, and the answer is still the original error', async () => {
        attachRefusal = new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
        deleteThrows = true;
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
        // Every slot is still attempted.
        expect(deletes).toHaveLength(2);
        const line = logged.find((l) => l[0] === 'workspace_connector_key_rollback_failed');
        expect(line?.[1]).toEqual({ agentId: 'a1', connectorId: 'multi', name: expect.any(String) });
        // The summary line says the rollback did NOT fully land.
        const done = logged.find((l) => l[0] === 'workspace_connector_key_rolled_back');
        expect(done?.[1]).toEqual({ agentId: 'a1', connectorId: 'multi', complete: false });
        expectNoLeak(r);
      });

      it('a rollback whose every delete lands is logged complete', async () => {
        attachRefusal = new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
        await attach({ connectorId: 'multi', keys: keysFor() });
        const done = logged.find((l) => l[0] === 'workspace_connector_key_rolled_back');
        expect(done?.[1]).toEqual({ agentId: 'a1', connectorId: 'multi', complete: true });
      });

      it.each([
        ['no keys at all', undefined],
        ['an empty list', []],
        ['one slot of two', [{ slot: 'A_KEY', payloadB64: b64(SECRET_A) }]],
      ])('a per-agent key connector missing a slot (%s): 400 connector-needs-key, nothing written', async (_l, keys) => {
        const r = await attach(keys === undefined ? { connectorId: 'multi' } : { connectorId: 'multi', keys });
        expect(r.statusCode).toBe(400);
        expect(r.body).toMatchObject({ error: 'connector-needs-key' });
        expect(sets).toEqual([]);
        expect(attachCalls).toEqual([]);
      });

      it.each([
        ['a slot the connector does not have', [...keysFor(), { slot: 'C_KEY', payloadB64: b64('x') }], 'unknown-slot'],
        ['the same slot twice', [{ slot: 'A_KEY', payloadB64: b64('x') }, { slot: 'A_KEY', payloadB64: b64('y') }], 'invalid-body'],
        ['not base64', [{ slot: 'A_KEY', payloadB64: 'not base64!!' }, keysFor()[1]], 'invalid-key'],
        ['over 16 KiB', [{ slot: 'A_KEY', payloadB64: 'A'.repeat(16 * 1024 + 4) }, keysFor()[1]], 'invalid-key'],
        ['a client-chosen ref', [{ slot: 'A_KEY', payloadB64: b64('x'), ref: 'provider:anthropic' }, keysFor()[1]], 'invalid-body'],
        ['not a list', { A_KEY: b64('x') }, 'invalid-body'],
      ])('malformed keys (%s): 400, nothing written', async (_l, keys, error) => {
        const r = await attach({ connectorId: 'multi', keys });
        expect(r).toEqual({ statusCode: 400, body: { error } });
        expect(sets).toEqual([]);
        expect(attachCalls).toEqual([]);
        expectNoLeak(r);
      });

      it('a body carrying anything besides connectorId and keys is refused 400', async () => {
        const r = await attach({ connectorId: 'linear', agentId: 'a-theirs' });
        expect(r).toEqual({ statusCode: 400, body: { error: 'invalid-body' } });
        expect(attachCalls).toEqual([]);
      });

      it('keys for a shared-key or a no-auth connector: 400 keys-not-accepted, nothing written', async () => {
        vault.add('account:company');
        for (const connectorId of ['company', 'linear']) {
          const r = await attach({ connectorId, keys: [{ slot: 'KEY', payloadB64: b64(SECRET_A) }] });
          expect(r).toEqual({ statusCode: 400, body: { error: 'keys-not-accepted' } });
        }
        expect(sets).toEqual([]);
        expect(attachCalls).toEqual([]);
      });

      it('an OAuth connector is added by its sign-in, never here: 409 connector-needs-sign-in, even when signed in', async () => {
        vault.add('account:figma');
        const r = await attach({ connectorId: 'figma' });
        expect(r.statusCode).toBe(409);
        expect(r.body).toMatchObject({ error: 'connector-needs-sign-in' });
        expect(await attach({ connectorId: 'figma', keys: keysFor() })).toMatchObject({ statusCode: 409 });
        expect(credentialReads).toEqual([]);
        expect(sets).toEqual([]);
        expect(attachCalls).toEqual([]);
      });

      it('an OAuth connector with an admin client secret is still OAuth: 409', async () => {
        catalog.set('gsuite', {
          id: 'gsuite',
          name: 'gsuite',
          keyMode: 'personal',
          capabilities: {
            credentials: [
              { slot: 'MCP_OAUTH', kind: 'oauth', server: 'gsuite', clientSecretRef: 'account:gsuite:OAUTH_CLIENT_SECRET' },
              { slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' },
            ],
          },
        });
        expect((await attach({ connectorId: 'gsuite' })).statusCode).toBe(409);
        expect(attachCalls).toEqual([]);
      });

      it('SECURITY: a team member who may not manage the agent: 403 and NO credentials:set', async () => {
        agentRow = { ...agentRow, visibility: 'team' };
        canManage = 'deny';
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
        expect(sets).toEqual([]);
        expect(authorizeCalls).toEqual([]);
        expect(attachCalls).toEqual([]);
      });

      it('SECURITY: a personal agent someone else owns (the owner check says no): 403, nothing written', async () => {
        caller = { id: 'u1', isAdmin: true };
        canManage = 'deny';
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
        // The admin bit is not passed on: only the owner may put a key on it.
        expect(canManageCalls).toEqual([{ actor: { userId: 'u1', isAdmin: false }, agentId: 'a1' }]);
        expect(sets).toEqual([]);
      });

      it('SECURITY: on a team agent only a team admin may put a key on it — a workspace admin who is not one is refused', async () => {
        agentRow = { ...agentRow, visibility: 'team' };
        caller = { id: 'u1', isAdmin: true };
        canSetShared = 'deny';
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
        expect(canSetSharedCalls).toEqual([{ actor: { userId: 'u1', isAdmin: true }, agentId: 'a1' }]);
        expect(sets).toEqual([]);
        canSetShared = 'allow';
        expect((await attach({ connectorId: 'multi', keys: keysFor() })).statusCode).toBe(200);
      });

      it('SECURITY: the agent-store question says no: 403 agent-store-refused, nothing written', async () => {
        authorize = 'deny';
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 403, body: { error: 'agent-store-refused' } });
        expect(sets).toEqual([]);
        expect(attachCalls).toEqual([]);
      });

      it('an agent-store question that faults fails closed: 503, nothing written, logged by name only', async () => {
        authorize = 'throw';
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 503, body: { error: 'connector-check-failed' } });
        expect(sets).toEqual([]);
        expect(JSON.stringify(logged)).not.toContain('corrupt');
      });

      it.each([
        'agents:can-manage-connectors',
        'credentials:authorize-agent:account',
        'credentials:set',
        'credentials:delete',
        'connectors:list-effective',
      ])('no %s: 503, nothing written, nothing attached', async (omit) => {
        const old = bus;
        bus = new HookBus();
        for (const name of [
          'auth:require-user',
          'agents:resolve',
          'agents:can-manage-connectors',
          'agents:can-set-shared-credential',
          'agents:attach-connector',
          'connectors:get',
          'connectors:list-effective',
          'credentials:authorize-agent:account',
          'credentials:set',
          'credentials:delete',
        ]) {
          if (name !== omit) bus.registerService(name, 'x', (c, i) => old.call(name, c, i));
        }
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r.statusCode).toBe(503);
        expect(sets).toEqual([]);
        expect(attachCalls).toEqual([]);
      });

      // Review Minor 1 — re-adding a key connector the agent already has would
      // overwrite its working key (and a refused attach would then delete it).
      it('a per-agent key connector already on the agent: 409 already-attached, credentials:set never called', async () => {
        effective.push({
          summary: { id: 'multi', name: 'multi', keyMode: 'personal' },
          source: 'attached',
          toolNamespaces: [],
        });
        const r = await attach({ connectorId: 'multi', keys: keysFor() });
        expect(r).toEqual({ statusCode: 409, body: { error: 'already-attached' } });
        expect(sets).toEqual([]);
        expect(deletes).toEqual([]);
        expect(attachCalls).toEqual([]);
        expectNoLeak(r);
      });

      it('a shared-key or no-auth re-add stays idempotent (changed: false), not 409', async () => {
        attachChanged = false;
        vault.add('account:company');
        for (const connectorId of ['linear', 'company']) {
          expect(await attach({ connectorId })).toEqual({
            statusCode: 200,
            body: { attached: true, changed: false },
          });
        }
      });

      it('a single-slot key connector writes the collapsed ref account:<id>', async () => {
        const r = await attach({ connectorId: 'stripe', keys: [{ slot: 'STRIPE_KEY', payloadB64: b64(SECRET_A) }] });
        expect(r.statusCode).toBe(200);
        expect(sets.map((s) => s.input.ref)).toEqual(['account:stripe']);
      });

      it('attaches a connector that needs nothing without reading the vault', async () => {
        expect((await attach({ connectorId: 'linear' })).statusCode).toBe(200);
        expect(credentialReads).toHaveLength(0);
        expect(sets).toEqual([]);
      });

      it('fails closed on the shared-key check: an unexpected vault error, or no vault, refuses the attach', async () => {
        credentialError = new Error('db down');
        expect((await attach({ connectorId: 'company' })).statusCode).toBe(503);
        const old = bus;
        bus = new HookBus();
        for (const name of ['auth:require-user', 'agents:resolve', 'agents:attach-connector', 'connectors:get']) {
          bus.registerService(name, 'x', (c, i) => old.call(name, c, i));
        }
        expect((await attach({ connectorId: 'company' })).statusCode).toBe(503);
        expect(attachCalls).toHaveLength(0);
      });

      it('logs a fail-closed shared-key check by step and error NAME only — never the message', async () => {
        credentialError = new Error('vault row 42 for account:company is corrupt');
        expect((await attach({ connectorId: 'company' })).statusCode).toBe(503);
        const call = logged.find((c) => c[0] === 'workspace_connector_attach_check_failed');
        expect(call?.[1]).toEqual({ connectorId: 'company', step: 'credential', name: expect.any(String) });
        expect(JSON.stringify(call?.[1])).not.toContain('corrupt');
      });

      it('404s a connector the caller cannot see, and attaches nothing', async () => {
        const r = await attach({ connectorId: 'someone-elses' });
        expect(r.statusCode).toBe(404);
        expect(attachCalls).toHaveLength(0);
      });

      // TASK-827 — a shared-key connector is one anyone may add to their own
      // agent: no key prompt, the agent spends the admin's shared key. Whether
      // this person may READ that key is the vault's read-time question
      // (credentials:authorize-global:account, TASK-697), asked here as them.
      it('lets a non-admin attach a shared-key connector once the shared key exists', async () => {
        const missing = await attach({ connectorId: 'company' });
        expect(missing.statusCode).toBe(409);
        expect(missing.body).toMatchObject({
          error: 'connector-needs-shared-key',
          message: expect.stringMatching(/ask a workspace admin/i),
        });
        expect(attachCalls).toHaveLength(0);
        vault.add('account:company');
        const r = await attach({ connectorId: 'company' });
        expect(r.statusCode).toBe(200);
        expect(credentialReads.map((c) => [c.ref, c.userId])).toEqual([
          ['account:company', caller.id],
          ['account:company', caller.id],
        ]);
        expect(attachCalls).toEqual([
          { actor: { userId: caller.id, isAdmin: false }, agentId: 'a1', connectorId: 'company' },
        ]);
        expect(sets).toEqual([]);
      });

      it('lets an admin attach a company-key connector once the company key exists', async () => {
        caller = { id: 'u1', isAdmin: true };
        const missing = await attach({ connectorId: 'company' });
        expect(missing.statusCode).toBe(409);
        expect(missing.body).toMatchObject({ error: 'connector-needs-shared-key' });
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
