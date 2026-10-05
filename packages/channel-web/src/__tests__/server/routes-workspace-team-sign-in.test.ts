// @vitest-environment node
/**
 * TASK-858 — a team admin removes a TEAM agent's shared sign-in (OAuth):
 *
 *   DELETE /api/workspace/agents/:agentId/connectors/:connectorId/team-sign-in
 *
 * plus the `teamSignIn: true` row flag on the Connectors list that offers it.
 *
 * What the tests are for, most expensive first:
 *
 *   1. ONLY A TEAM ADMIN REMOVES IT. The same gate as the team-key routes
 *      (`agents:can-set-shared-credential`, no workspace-admin bypass); the
 *      removal hook is never called before every check said yes.
 *   2. THE HOOK GETS EXACTLY {agentId, connectorId}. The vault ref and the
 *      reconnect marker are @ax/mcp-oauth's business, not the client's.
 *   3. THE FLAG IS HONEST. Shown only to a team admin, only when the removal
 *      hook exists, and only when an agent-scope row sits under the
 *      connector's sign-in ref — a failed list hides it, never the list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeWorkspaceHandlers } from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function mkReq(params: Record<string, string>, body?: unknown): RouteRequest {
  return {
    headers: {},
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf-8'),
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

type Verdict = 'allow' | 'deny' | 'throw' | 'not-found';
type Slot = { slot: string; kind: 'oauth' | 'api-key'; server?: string };

const oauth = (server: string): Slot => ({ slot: 'MCP_OAUTH', kind: 'oauth', server });
const key = (slot: string): Slot => ({ slot, kind: 'api-key' });

describe('team sign-in removal (TASK-858)', () => {
  let bus: HookBus;
  let caller: { id: string; isAdmin: boolean };
  let reach: Map<string, Set<string>>;
  let visibility: 'team' | 'personal';
  let canSet: Verdict;
  let canSetCalls: Array<Record<string, unknown>>;
  let catalog: Map<string, { id: string; name: string; keyMode: string; capabilities: { credentials: Slot[] } }>;
  let removeCalls: Array<{ input: Record<string, unknown>; agentId: string; userId: string }>;
  let removeThrows: boolean;
  /** agent-scope vault rows, `${ownerId}|${ref}`. */
  let vault: Set<string>;
  let listCalls: Array<Record<string, unknown>>;
  let listThrows: boolean;
  let logged: unknown[][];

  const conn = (id: string, keyMode: string, credentials: Slot[]) => ({
    id,
    name: id,
    keyMode,
    capabilities: { credentials },
  });

  const ALL_HOOKS = [
    'auth:require-user',
    'agents:resolve',
    'agents:can-set-shared-credential',
    'connectors:get',
    'connectors:list-effective',
    'credentials:list',
    'mcp-oauth:remove-shared-sign-in',
  ] as const;

  beforeEach(() => {
    bus = new HookBus();
    caller = { id: 'admin-of-team', isAdmin: false };
    reach = new Map([['team-agent', new Set(['admin-of-team', 'ws-admin', 'member'])]]);
    visibility = 'team';
    canSet = 'allow';
    canSetCalls = [];
    catalog = new Map([
      ['gmail', conn('gmail', 'personal', [oauth('gmail')])],
      ['figma', conn('figma', 'workspace', [oauth('figma')])],
      ['stripe', conn('stripe', 'personal', [key('STRIPE_KEY')])],
      ['notes', conn('notes', 'personal', [])],
    ]);
    removeCalls = [];
    removeThrows = false;
    vault = new Set();
    listCalls = [];
    listThrows = false;
    logged = [];

    bus.registerService('auth:require-user', 'auth', async () => ({ user: caller }));
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId, userId } = i as { agentId: string; userId: string };
      if (reach.get(agentId)?.has(userId) !== true) {
        throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
      }
      return {
        agent: {
          id: agentId,
          displayName: 'Quill',
          visibility,
          connectorAttachments: [...catalog.keys()],
          connectorExclusions: [],
        },
      };
    });
    bus.registerService('agents:can-set-shared-credential', 'agents', async (_c, i: unknown) => {
      canSetCalls.push(i as Record<string, unknown>);
      if (canSet === 'throw') throw new Error('teams store row 9 is corrupt');
      if (canSet === 'not-found') {
        throw new PluginError({ code: 'not-found', plugin: 'agents', message: 'gone' });
      }
      return { allowed: canSet === 'allow' };
    });
    bus.registerService('connectors:get', 'connectors', async (_c, i: unknown) => {
      const { connectorId } = i as { connectorId: string };
      const found = catalog.get(connectorId);
      if (found === undefined) {
        throw new PluginError({ code: 'not-found', plugin: 'connectors', message: 'nope' });
      }
      return { connector: found };
    });
    bus.registerService('connectors:list-effective', 'connectors', async () => ({
      connectors: [...catalog.values()].map((c) => ({
        summary: { id: c.id, name: c.name, canEdit: false, keyMode: c.keyMode },
        source: 'attached',
        toolNamespaces: [],
        capabilities: c.capabilities,
      })),
    }));
    bus.registerService('credentials:list', 'credentials', async (_c, i: unknown) => {
      listCalls.push(i as Record<string, unknown>);
      if (listThrows) throw new Error('vault list failed near row 7');
      const { scope, ownerId } = i as { scope: string; ownerId: string };
      return {
        credentials: [...vault]
          .map((k) => k.split('|') as [string, string])
          .filter(([owner]) => scope === 'agent' && owner === ownerId)
          .map(([owner, ref]) => ({ scope: 'agent', ownerId: owner, ref, kind: 'mcp-oauth' })),
      };
    });
    bus.registerService('mcp-oauth:remove-shared-sign-in', 'mcp-oauth', async (c, i: unknown) => {
      removeCalls.push({ input: i as Record<string, unknown>, agentId: c.agentId, userId: c.userId });
      if (removeThrows) throw new Error('vault delete failed near token abc');
      return { removed: true };
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

  function rewire(omit: string): void {
    const old = bus;
    bus = new HookBus();
    for (const name of ALL_HOOKS) {
      if (name === omit) continue;
      bus.registerService(name, 'x', (c, i) => old.call(name, c, i));
    }
  }

  async function del(connectorId = 'gmail', agentId = 'team-agent', body?: unknown): Promise<Captured> {
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).removeTeamSignIn(
      mkReq({ agentId, connectorId }, body),
      res,
    );
    return captured;
  }

  describe('DELETE …/team-sign-in', () => {
    it('a team admin removes it: 200 { removed: true }, the hook gets exactly {agentId, connectorId}', async () => {
      const r = await del();
      expect(r).toEqual({ statusCode: 200, body: { removed: true } });
      expect(canSetCalls).toEqual([
        { actor: { userId: 'admin-of-team', isAdmin: false }, agentId: 'team-agent' },
      ]);
      expect(removeCalls).toEqual([
        {
          input: { agentId: 'team-agent', connectorId: 'gmail' },
          agentId: 'team-agent',
          userId: 'admin-of-team',
        },
      ]);
      expect(logged.some((l) => l[0] === 'workspace_team_sign_in_removed')).toBe(true);
    });

    it('a body is ignored — the client never names a ref', async () => {
      const r = await del('gmail', 'team-agent', { ref: 'provider:anthropic', agentId: 'other' });
      expect(r.statusCode).toBe(200);
      expect(removeCalls.map((c) => c.input)).toEqual([{ agentId: 'team-agent', connectorId: 'gmail' }]);
    });

    it('a shared-key (keyMode workspace) OAuth connector is still a team sign-in: 200', async () => {
      const r = await del('figma');
      expect(r).toEqual({ statusCode: 200, body: { removed: true } });
      expect(removeCalls.map((c) => c.input)).toEqual([{ agentId: 'team-agent', connectorId: 'figma' }]);
    });

    it('a plain member is refused 403; the hook is never called', async () => {
      caller = { id: 'member', isAdmin: false };
      canSet = 'deny';
      expect(await del()).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
      expect(removeCalls).toEqual([]);
    });

    it('a workspace admin who is not a team admin is refused 403; the hook is never called', async () => {
      caller = { id: 'ws-admin', isAdmin: true };
      canSet = 'deny';
      expect(await del()).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
      expect(canSetCalls).toEqual([{ actor: { userId: 'ws-admin', isAdmin: true }, agentId: 'team-agent' }]);
      expect(removeCalls).toEqual([]);
    });

    it('unauthenticated: 401, nothing runs', async () => {
      bus = new HookBus();
      bus.registerService('auth:require-user', 'auth', async () => {
        throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no' });
      });
      bus.registerService('mcp-oauth:remove-shared-sign-in', 'mcp-oauth', async () => {
        removeCalls.push({ input: {}, agentId: '', userId: '' });
        return { removed: true };
      });
      const r = await del();
      expect(r.statusCode).toBe(401);
      expect(removeCalls).toEqual([]);
    });

    it('a non-member is refused 404 before any hook runs', async () => {
      caller = { id: 'stranger', isAdmin: true };
      expect((await del()).statusCode).toBe(404);
      expect(canSetCalls).toEqual([]);
      expect(removeCalls).toEqual([]);
    });

    it('a personal agent: 409 not-a-team-agent, the hook is never called', async () => {
      visibility = 'personal';
      expect(await del()).toEqual({ statusCode: 409, body: { error: 'not-a-team-agent' } });
      expect(canSetCalls).toEqual([]);
      expect(removeCalls).toEqual([]);
    });

    it.each([
      ['an api-key-only connector', 'stripe'],
      ['a connector with no credentials', 'notes'],
    ])('%s: 409 team-sign-in-unavailable, the hook is never called', async (_label, connectorId) => {
      expect(await del(connectorId)).toEqual({ statusCode: 409, body: { error: 'team-sign-in-unavailable' } });
      expect(removeCalls).toEqual([]);
    });

    it('an unknown connector 404; a bad id 400', async () => {
      expect(await del('ghost')).toEqual({ statusCode: 404, body: { error: 'connector-not-found' } });
      expect((await del('../etc')).statusCode).toBe(400);
      expect(removeCalls).toEqual([]);
    });

    it('a rejecting permission hook: 503 team-key-check-failed, logged by name only', async () => {
      canSet = 'throw';
      expect(await del()).toEqual({ statusCode: 503, body: { error: 'team-key-check-failed' } });
      expect(JSON.stringify(logged)).not.toContain('corrupt');
      expect(removeCalls).toEqual([]);
    });

    it.each([
      ['agents:can-set-shared-credential'],
      ['connectors:get'],
      ['mcp-oauth:remove-shared-sign-in'],
    ])('no %s: 503 connectors-unavailable', async (omit) => {
      rewire(omit);
      expect(await del()).toEqual({ statusCode: 503, body: { error: 'connectors-unavailable' } });
      expect(removeCalls).toEqual([]);
    });

    it('the hook throws: 502 team-sign-in-not-removed, logged by error NAME only', async () => {
      removeThrows = true;
      const r = await del();
      expect(r).toEqual({ statusCode: 502, body: { error: 'team-sign-in-not-removed' } });
      const line = logged.find((l) => l[0] === 'workspace_team_sign_in_remove_failed');
      expect(line?.[1]).toEqual({ agentId: 'team-agent', connectorId: 'gmail', name: expect.any(String) });
      expect(JSON.stringify(logged)).not.toContain('token abc');
      expect(logged.some((l) => l[0] === 'workspace_team_sign_in_removed')).toBe(false);
    });
  });

  describe('the list row flag teamSignIn', () => {
    async function list(): Promise<Captured> {
      const { res, captured } = mkRes();
      await makeWorkspaceHandlers({ bus, initCtx }).connectors(mkReq({ agentId: 'team-agent' }), res);
      return captured;
    }
    function rowsById(r: Captured): Record<string, Record<string, unknown>> {
      const rows = (r.body as { connectors: Array<Record<string, unknown>> }).connectors;
      return Object.fromEntries(rows.map((x) => [x.id as string, x]));
    }
    function flagged(r: Captured): string[] {
      return Object.values(rowsById(r))
        .filter((row) => 'teamSignIn' in row)
        .map((row) => {
          expect(row.teamSignIn).toBe(true);
          return row.id as string;
        });
    }

    it('a team admin sees it on a connector whose sign-in is saved on the agent', async () => {
      vault = new Set(['team-agent|account:gmail', 'team-agent|account:figma', 'team-agent|account:stripe']);
      const r = await list();
      expect(r.statusCode).toBe(200);
      // stripe has a saved row too, but it is a key, not a sign-in.
      expect(flagged(r).sort()).toEqual(['figma', 'gmail']);
      expect(listCalls).toEqual([{ scope: 'agent', ownerId: 'team-agent' }]);
    });

    it('absent when nothing is saved on the agent (a row on another agent does not count)', async () => {
      vault = new Set(['other-agent|account:gmail']);
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(flagged(r)).toEqual([]);
    });

    it('absent for a member — and the vault is not asked', async () => {
      vault = new Set(['team-agent|account:gmail']);
      caller = { id: 'member', isAdmin: false };
      canSet = 'deny';
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(flagged(r)).toEqual([]);
      expect(listCalls).toEqual([]);
    });

    it('absent on a personal agent', async () => {
      vault = new Set(['team-agent|account:gmail']);
      visibility = 'personal';
      expect(flagged(await list())).toEqual([]);
      expect(listCalls).toEqual([]);
    });

    it('absent when the removal hook is not registered', async () => {
      vault = new Set(['team-agent|account:gmail']);
      rewire('mcp-oauth:remove-shared-sign-in');
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(flagged(r)).toEqual([]);
    });

    it('absent when credentials:list is not registered; the list still loads', async () => {
      vault = new Set(['team-agent|account:gmail']);
      rewire('credentials:list');
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(flagged(r)).toEqual([]);
    });

    it('a failing credentials:list hides the flag, logged by error NAME only — the rest of the list is 200', async () => {
      vault = new Set(['team-agent|account:gmail']);
      listThrows = true;
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(Object.keys(rowsById(r)).sort()).toEqual(['figma', 'gmail', 'notes', 'stripe']);
      expect(flagged(r)).toEqual([]);
      const line = logged.find((l) => l[0] === 'workspace_team_sign_in_list_failed');
      expect(line?.[1]).toEqual({ agentId: 'team-agent', name: expect.any(String) });
      expect(JSON.stringify(logged)).not.toContain('row 7');
    });

    it('not asked when no row has a sign-in', async () => {
      catalog = new Map([['stripe', conn('stripe', 'personal', [key('STRIPE_KEY')])]]);
      const r = await list();
      expect(r.statusCode).toBe(200);
      expect(listCalls).toEqual([]);
    });
  });
});
