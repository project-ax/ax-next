// @vitest-environment node
/**
 * TASK-813 / TASK-854 — a TEAM agent's shared ("team") connector key:
 *
 *   PUT    /api/workspace/agents/:agentId/connectors/:connectorId/team-key
 *          { slot, payloadB64 }   (save; saving again replaces)
 *   GET    …/team-key            ({ slots: [{ slot, saved }] })
 *   DELETE …/team-key { slot }   (remove)
 *
 * What the tests are for, most expensive first:
 *
 *   1. ONLY A TEAM ADMIN WRITES, READS OR REMOVES IT. `agents:can-set-shared-credential` is the
 *      one rule, and a workspace admin who is not an admin of the owning team
 *      is refused exactly like a member. No vault write happens before every
 *      check said yes.
 *   2. THE REF IS THE SERVER'S. It comes from the connector's credential plan
 *      for the named api-key slot — never from the client — and an OAuth slot
 *      or the admin's OAuth client secret is not a team key.
 *   3. THE KEY NEVER LEAVES. Not in the response, not in a log line. The GET
 *      answers a boolean per slot — never a ref, kind or date.
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

const SECRET = 'sk-team-SUPERSECRET-123';
const SECRET_B64 = Buffer.from(SECRET, 'utf-8').toString('base64');

type Verdict = 'allow' | 'deny' | 'throw' | 'not-found';

describe('PUT …/connectors/:connectorId/team-key (TASK-813)', () => {
  let bus: HookBus;
  let caller: { id: string; isAdmin: boolean };
  /** agentId → the user ids `agents:resolve` lets through. */
  let reach: Map<string, Set<string>>;
  let visibility: 'team' | 'personal';
  let canSet: Verdict;
  let canSetCalls: Array<Record<string, unknown>>;
  let catalog: Map<
    string,
    { id: string; name: string; keyMode: string; capabilities: { credentials: Array<Record<string, unknown>> } }
  >;
  let authorize: 'allow' | 'deny' | 'throw';
  let authorizeCalls: Array<Record<string, unknown>>;
  let setCalls: Array<{ input: Record<string, unknown>; agentId: string; userId: string }>;
  let setThrows: boolean;
  let logged: unknown[][];
  /** TASK-854 — the agent-scope vault rows, `${ownerId}|${ref}` → value. */
  let vault: Map<string, string>;
  let listCalls: Array<Record<string, unknown>>;
  let listThrows: boolean;
  let deleteCalls: Array<Record<string, unknown>>;
  let deleteThrows: boolean;

  const conn = (id: string, keyMode: string, credentials: Array<Record<string, unknown>>) => ({
    id,
    name: id,
    keyMode,
    capabilities: { credentials },
  });

  beforeEach(() => {
    bus = new HookBus();
    caller = { id: 'admin-of-team', isAdmin: false };
    reach = new Map([['team-agent', new Set(['admin-of-team', 'ws-admin', 'member'])]]);
    visibility = 'team';
    canSet = 'allow';
    canSetCalls = [];
    catalog = new Map([
      ['stripe', conn('stripe', 'personal', [{ slot: 'STRIPE_KEY', kind: 'api-key' }])],
      [
        'multi',
        conn('multi', 'personal', [
          { slot: 'A_KEY', kind: 'api-key' },
          { slot: 'B_KEY', kind: 'api-key' },
        ]),
      ],
      [
        'figma',
        conn('figma', 'personal', [
          { slot: 'MCP_OAUTH', kind: 'oauth', server: 'figma' },
          { slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' },
        ]),
      ],
      ['company', conn('company', 'workspace', [{ slot: 'KEY', kind: 'api-key' }])],
    ]);
    authorize = 'allow';
    authorizeCalls = [];
    setCalls = [];
    setThrows = false;
    logged = [];
    vault = new Map();
    listCalls = [];
    listThrows = false;
    deleteCalls = [];
    deleteThrows = false;

    bus.registerService('auth:require-user', 'auth', async () => ({ user: caller }));
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId, userId } = i as { agentId: string; userId: string };
      if (reach.get(agentId)?.has(userId) !== true) {
        throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
      }
      return { agent: { id: agentId, displayName: 'Quill', visibility } };
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
    bus.registerService('credentials:authorize-agent:account', 'connectors', async (_c, i: unknown) => {
      authorizeCalls.push(i as Record<string, unknown>);
      if (authorize === 'throw') throw new Error('connector store down');
      return { allowed: authorize === 'allow' };
    });
    bus.registerService('credentials:set', 'credentials', async (c, i: unknown) => {
      setCalls.push({ input: i as Record<string, unknown>, agentId: c.agentId, userId: c.userId });
      if (setThrows) throw new Error(`vault refused ${SECRET}`);
      const { ownerId, ref, payload } = i as { ownerId: string; ref: string; payload: Uint8Array };
      vault.set(`${ownerId}|${ref}`, Buffer.from(payload).toString('utf-8'));
      return undefined;
    });
    bus.registerService('credentials:list', 'credentials', async (_c, i: unknown) => {
      listCalls.push(i as Record<string, unknown>);
      if (listThrows) throw new Error(`vault list failed near ${SECRET}`);
      const { scope, ownerId } = i as { scope: string; ownerId: string };
      return {
        credentials: [...vault.keys()]
          .map((k) => k.split('|') as [string, string])
          .filter(([owner]) => scope === 'agent' && owner === ownerId)
          .map(([owner, ref]) => ({
            scope: 'agent',
            ownerId: owner,
            ref,
            kind: 'api-key',
            createdAt: '2026-10-04T00:00:00.000Z',
          })),
      };
    });
    bus.registerService('credentials:delete', 'credentials', async (_c, i: unknown) => {
      deleteCalls.push(i as Record<string, unknown>);
      if (deleteThrows) throw new Error(`vault delete failed near ${SECRET}`);
      const { ownerId, ref } = i as { ownerId: string; ref: string };
      vault.delete(`${ownerId}|${ref}`);
      return undefined;
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

  async function put(
    body: unknown,
    connectorId = 'stripe',
    agentId = 'team-agent',
    raw?: string,
  ): Promise<Captured> {
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).setTeamKey(
      mkReq({ agentId, connectorId }, body, raw),
      res,
    );
    return captured;
  }

  function expectNoLeak(r: Captured): void {
    const all = JSON.stringify(r.body) + JSON.stringify(logged);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(SECRET_B64);
  }

  it('a team admin saves the key on the agent, under the plan ref — 200 { saved: true }', async () => {
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ saved: true });
    expect(canSetCalls).toEqual([
      { actor: { userId: 'admin-of-team', isAdmin: false }, agentId: 'team-agent' },
    ]);
    expect(authorizeCalls).toEqual([
      { userId: 'admin-of-team', agentId: 'team-agent', ref: 'account:stripe' },
    ]);
    expect(setCalls).toHaveLength(1);
    const { input } = setCalls[0]!;
    expect(input).toMatchObject({
      scope: 'agent',
      ownerId: 'team-agent',
      ref: 'account:stripe',
      kind: 'api-key',
    });
    expect(input.payload).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(input.payload as Uint8Array).toString('utf-8')).toBe(SECRET);
    expectNoLeak(r);
  });

  it('a multi-slot connector writes the per-slot ref account:<id>:<slotTag>', async () => {
    const r = await put({ slot: 'B_KEY', payloadB64: SECRET_B64 }, 'multi');
    expect(r.statusCode).toBe(200);
    expect(setCalls.map((c) => c.input.ref)).toEqual(['account:multi:B_KEY']);
  });

  it('passes the real admin bit to the hook; a workspace admin who is not a team admin is refused 403', async () => {
    caller = { id: 'ws-admin', isAdmin: true };
    canSet = 'deny';
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: 'forbidden' });
    expect(canSetCalls).toEqual([{ actor: { userId: 'ws-admin', isAdmin: true }, agentId: 'team-agent' }]);
    expect(setCalls).toEqual([]);
    expect(authorizeCalls).toEqual([]);
  });

  it('a plain member is refused 403, nothing written', async () => {
    caller = { id: 'member', isAdmin: false };
    canSet = 'deny';
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(403);
    expect(setCalls).toEqual([]);
  });

  it('a non-member (agents:resolve refuses) is refused before any hook runs', async () => {
    caller = { id: 'stranger', isAdmin: true };
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(404);
    expect(canSetCalls).toEqual([]);
    expect(setCalls).toEqual([]);
  });

  it('a personal agent has no team key: 409 not-a-team-agent, the hook is never asked', async () => {
    visibility = 'personal';
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: 'not-a-team-agent' });
    expect(canSetCalls).toEqual([]);
    expect(setCalls).toEqual([]);
  });

  it('a workspace-key connector: 409 team-key-unavailable, nothing written', async () => {
    const r = await put({ slot: 'KEY', payloadB64: SECRET_B64 }, 'company');
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: 'team-key-unavailable' });
    expect(setCalls).toEqual([]);
  });

  it.each([
    ['a slot the connector does not have', 'stripe', 'NOPE_KEY'],
    ['an OAuth (sign-in) slot', 'figma', 'MCP_OAUTH'],
    ["the admin's OAuth client secret", 'figma', 'OAUTH_CLIENT_SECRET'],
  ])('%s: 400 unknown-slot, nothing written', async (_label, connectorId, slot) => {
    const r = await put({ slot, payloadB64: SECRET_B64 }, connectorId);
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'unknown-slot' });
    expect(setCalls).toEqual([]);
  });

  it('a body carrying anything besides slot and payloadB64 (say, a ref) is refused 400 — the ref is never the client\'s', async () => {
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64, ref: 'provider:anthropic' });
    expect(r.statusCode).toBe(400);
    expect(setCalls).toEqual([]);
  });

  it('an unknown connector: 404 connector-not-found', async () => {
    const r = await put({ slot: 'X', payloadB64: SECRET_B64 }, 'ghost');
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ error: 'connector-not-found' });
    expect(setCalls).toEqual([]);
  });

  it('an invalid connector id: 400 before any hook runs', async () => {
    const r = await put({ slot: 'X', payloadB64: SECRET_B64 }, '../etc');
    expect(r.statusCode).toBe(400);
    expect(canSetCalls).toEqual([]);
  });

  it('the vault would not let the agent read this ref (TASK-788): 409, nothing written', async () => {
    authorize = 'deny';
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: 'team-key-unavailable' });
    expect(setCalls).toEqual([]);
  });

  it('an authorize fault fails closed: 503, nothing written, logged by name only', async () => {
    authorize = 'throw';
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(503);
    expect(setCalls).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain('store down');
  });

  it('a rejecting permission hook: 503, nothing written, logged by error NAME only', async () => {
    canSet = 'throw';
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(503);
    expect(setCalls).toEqual([]);
    const line = logged.find((l) => l[0] === 'workspace_team_key_check_failed');
    expect(line?.[1]).toEqual({ agentId: 'team-agent', connectorId: 'stripe', step: 'permission', name: expect.any(String) });
    expect(JSON.stringify(logged)).not.toContain('corrupt');
    expectNoLeak(r);
  });

  it('no permission hook / no authorize hook / no vault: 503, nothing written', async () => {
    const fresh = (omit: string): void => {
      const old = bus;
      bus = new HookBus();
      for (const name of [
        'auth:require-user',
        'agents:resolve',
        'agents:can-set-shared-credential',
        'connectors:get',
        'credentials:authorize-agent:account',
        'credentials:set',
      ]) {
        if (name === omit) continue;
        bus.registerService(name, 'x', (c, i) => old.call(name, c, i));
      }
    };
    const base = bus;
    for (const omit of [
      'agents:can-set-shared-credential',
      'connectors:get',
      'credentials:authorize-agent:account',
      'credentials:set',
    ]) {
      bus = base;
      fresh(omit);
      const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
      expect({ omit, status: r.statusCode }).toEqual({ omit, status: 503 });
    }
    expect(setCalls).toEqual([]);
  });

  it.each([
    ['not base64', { slot: 'STRIPE_KEY', payloadB64: 'not base64!!' }],
    ['bad padding', { slot: 'STRIPE_KEY', payloadB64: 'abc' }],
    ['empty', { slot: 'STRIPE_KEY', payloadB64: '' }],
    ['over 16 KiB', { slot: 'STRIPE_KEY', payloadB64: 'A'.repeat(16 * 1024 + 4) }],
    ['no slot', { payloadB64: SECRET_B64 }],
    ['payload not a string', { slot: 'STRIPE_KEY', payloadB64: 42 }],
  ])('a malformed body (%s): 400, nothing written', async (_label, body) => {
    const r = await put(body);
    expect(r.statusCode).toBe(400);
    expect(setCalls).toEqual([]);
  });

  it('invalid JSON: 400 invalid-json', async () => {
    const r = await put(undefined, 'stripe', 'team-agent', `{"slot":"STRIPE_KEY","payloadB64":"${SECRET_B64}"`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'invalid-json' });
    expectNoLeak(r);
  });

  it('a vault failure on the write: 502 team-key-not-saved, logged by name only — never the key', async () => {
    setThrows = true;
    const r = await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 });
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'team-key-not-saved' });
    expect(logged.some((l) => l[0] === 'workspace_team_key_save_failed')).toBe(true);
    expectNoLeak(r);
  });

  // ---------------------------------------------------------------------
  // TASK-854 — GET (is a team key saved?) and DELETE (remove it), behind the
  // same team-admin gate as the PUT.
  // ---------------------------------------------------------------------

  async function get(connectorId = 'stripe', agentId = 'team-agent'): Promise<Captured> {
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).getTeamKeys(mkReq({ agentId, connectorId }), res);
    return captured;
  }

  async function del(
    body: unknown,
    connectorId = 'stripe',
    agentId = 'team-agent',
    raw?: string,
  ): Promise<Captured> {
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).removeTeamKey(
      mkReq({ agentId, connectorId }, body, raw),
      res,
    );
    return captured;
  }

  function rewire(names: readonly string[], omit: string): void {
    const old = bus;
    bus = new HookBus();
    for (const name of names) {
      if (name === omit) continue;
      bus.registerService(name, 'x', (c, i) => old.call(name, c, i));
    }
  }

  describe('GET …/team-key (TASK-854)', () => {
    it('a team admin reads one entry per api-key slot, saved true/false — never a ref, kind or date', async () => {
      vault.set('team-agent|account:multi:B_KEY', SECRET);
      vault.set('other-agent|account:multi:A_KEY', SECRET);
      const r = await get('multi');
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({
        slots: [
          { slot: 'A_KEY', saved: false },
          { slot: 'B_KEY', saved: true },
        ],
      });
      expect(listCalls).toEqual([{ scope: 'agent', ownerId: 'team-agent' }]);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain('account:');
      expect(text).not.toContain('api-key');
      expect(text).not.toContain('2026-10-04');
      expectNoLeak(r);
    });

    it('a saved single-slot key reads saved: true; OAuth slots and the client secret are not listed', async () => {
      vault.set('team-agent|account:stripe', SECRET);
      expect((await get('stripe')).body).toEqual({ slots: [{ slot: 'STRIPE_KEY', saved: true }] });
      expect((await get('figma')).body).toEqual({ slots: [] });
    });

    it('a workspace admin who is not a team admin is refused 403; the vault is never read', async () => {
      caller = { id: 'ws-admin', isAdmin: true };
      canSet = 'deny';
      const r = await get();
      expect(r.statusCode).toBe(403);
      expect(r.body).toEqual({ error: 'forbidden' });
      expect(canSetCalls).toEqual([{ actor: { userId: 'ws-admin', isAdmin: true }, agentId: 'team-agent' }]);
      expect(listCalls).toEqual([]);
    });

    it('a plain member is refused 403', async () => {
      caller = { id: 'member', isAdmin: false };
      canSet = 'deny';
      expect((await get()).statusCode).toBe(403);
      expect(listCalls).toEqual([]);
    });

    it('a non-member is refused 404 before any hook runs', async () => {
      caller = { id: 'stranger', isAdmin: true };
      expect((await get()).statusCode).toBe(404);
      expect(canSetCalls).toEqual([]);
      expect(listCalls).toEqual([]);
    });

    it('a personal agent: 409 not-a-team-agent', async () => {
      visibility = 'personal';
      const r = await get();
      expect(r.statusCode).toBe(409);
      expect(r.body).toEqual({ error: 'not-a-team-agent' });
      expect(listCalls).toEqual([]);
    });

    it('the agent vanished between resolve and the permission check: 404 agent-not-found', async () => {
      canSet = 'not-found';
      expect(await get()).toEqual({ statusCode: 404, body: { error: 'agent-not-found' } });
    });

    it('a rejecting permission hook: 503 team-key-check-failed, logged by name only', async () => {
      canSet = 'throw';
      const r = await get();
      expect(r.statusCode).toBe(503);
      expect(r.body).toEqual({ error: 'team-key-check-failed' });
      expect(JSON.stringify(logged)).not.toContain('corrupt');
      expect(listCalls).toEqual([]);
    });

    it('an unknown connector 404; a workspace-key connector 409 team-key-unavailable; a bad id 400', async () => {
      expect(await get('ghost')).toEqual({ statusCode: 404, body: { error: 'connector-not-found' } });
      expect(await get('company')).toEqual({ statusCode: 409, body: { error: 'team-key-unavailable' } });
      expect((await get('../etc')).statusCode).toBe(400);
      expect(listCalls).toEqual([]);
    });

    it('a vault list fault: 503 team-key-check-failed, logged by name only', async () => {
      listThrows = true;
      const r = await get();
      expect(r).toEqual({ statusCode: 503, body: { error: 'team-key-check-failed' } });
      const line = logged.find((l) => l[0] === 'workspace_team_key_check_failed');
      expect(line?.[1]).toEqual({ agentId: 'team-agent', connectorId: 'stripe', step: 'list', name: expect.any(String) });
      expectNoLeak(r);
    });

    it.each([
      ['agents:can-set-shared-credential', 'connectors-unavailable'],
      ['connectors:get', 'connectors-unavailable'],
      ['credentials:list', 'credentials-unavailable'],
    ])('no %s: 503 %s', async (omit, error) => {
      rewire(
        ['auth:require-user', 'agents:resolve', 'agents:can-set-shared-credential', 'connectors:get', 'credentials:list'],
        omit,
      );
      expect(await get()).toEqual({ statusCode: 503, body: { error } });
    });
  });

  describe('DELETE …/team-key (TASK-854)', () => {
    it('a team admin removes the key from the agent, under the plan ref — 200 { removed: true }', async () => {
      vault.set('team-agent|account:multi:B_KEY', SECRET);
      vault.set('team-agent|account:multi:A_KEY', SECRET);
      const r = await del({ slot: 'B_KEY' }, 'multi');
      expect(r).toEqual({ statusCode: 200, body: { removed: true } });
      expect(deleteCalls).toEqual([{ scope: 'agent', ownerId: 'team-agent', ref: 'account:multi:B_KEY' }]);
      expect([...vault.keys()]).toEqual(['team-agent|account:multi:A_KEY']);
      // Removing asks no readability question — it only takes access away.
      expect(authorizeCalls).toEqual([]);
      expect(logged.some((l) => l[0] === 'workspace_team_key_removed')).toBe(true);
      expectNoLeak(r);
    });

    it('is idempotent: no saved key is still 200 { removed: true }', async () => {
      expect(await del({ slot: 'STRIPE_KEY' })).toEqual({ statusCode: 200, body: { removed: true } });
      expect(deleteCalls).toHaveLength(1);
    });

    it('replace = a second PUT overwrites the saved key; GET still reads saved', async () => {
      const other = 'sk-team-REPLACEMENT-456';
      expect((await put({ slot: 'STRIPE_KEY', payloadB64: SECRET_B64 })).statusCode).toBe(200);
      expect(
        (await put({ slot: 'STRIPE_KEY', payloadB64: Buffer.from(other).toString('base64') })).statusCode,
      ).toBe(200);
      expect(vault.get('team-agent|account:stripe')).toBe(other);
      expect(setCalls.map((c) => c.input.ref)).toEqual(['account:stripe', 'account:stripe']);
      expect((await get()).body).toEqual({ slots: [{ slot: 'STRIPE_KEY', saved: true }] });
    });

    it('a workspace admin who is not a team admin is refused 403; nothing removed', async () => {
      vault.set('team-agent|account:stripe', SECRET);
      caller = { id: 'ws-admin', isAdmin: true };
      canSet = 'deny';
      expect(await del({ slot: 'STRIPE_KEY' })).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
      expect(canSetCalls).toEqual([{ actor: { userId: 'ws-admin', isAdmin: true }, agentId: 'team-agent' }]);
      expect(deleteCalls).toEqual([]);
      expect(vault.has('team-agent|account:stripe')).toBe(true);
    });

    it('a plain member is refused 403; nothing removed', async () => {
      caller = { id: 'member', isAdmin: false };
      canSet = 'deny';
      expect((await del({ slot: 'STRIPE_KEY' })).statusCode).toBe(403);
      expect(deleteCalls).toEqual([]);
    });

    it('a non-member is refused 404 before any hook runs', async () => {
      caller = { id: 'stranger', isAdmin: true };
      expect((await del({ slot: 'STRIPE_KEY' })).statusCode).toBe(404);
      expect(canSetCalls).toEqual([]);
      expect(deleteCalls).toEqual([]);
    });

    it('a personal agent: 409 not-a-team-agent, nothing removed', async () => {
      visibility = 'personal';
      expect(await del({ slot: 'STRIPE_KEY' })).toEqual({ statusCode: 409, body: { error: 'not-a-team-agent' } });
      expect(deleteCalls).toEqual([]);
    });

    it('a rejecting permission hook: 503 team-key-check-failed, nothing removed', async () => {
      canSet = 'throw';
      expect(await del({ slot: 'STRIPE_KEY' })).toEqual({
        statusCode: 503,
        body: { error: 'team-key-check-failed' },
      });
      expect(deleteCalls).toEqual([]);
    });

    it('a workspace-key connector: 409 team-key-unavailable; an unknown connector: 404', async () => {
      expect(await del({ slot: 'KEY' }, 'company')).toEqual({
        statusCode: 409,
        body: { error: 'team-key-unavailable' },
      });
      expect(await del({ slot: 'X' }, 'ghost')).toEqual({ statusCode: 404, body: { error: 'connector-not-found' } });
      expect(deleteCalls).toEqual([]);
    });

    it.each([
      ['a slot the connector does not have', 'stripe', 'NOPE_KEY'],
      ['an OAuth (sign-in) slot', 'figma', 'MCP_OAUTH'],
      ["the admin's OAuth client secret", 'figma', 'OAUTH_CLIENT_SECRET'],
    ])('%s: 400 unknown-slot, nothing removed', async (_label, connectorId, slot) => {
      expect(await del({ slot }, connectorId)).toEqual({ statusCode: 400, body: { error: 'unknown-slot' } });
      expect(deleteCalls).toEqual([]);
    });

    it.each([
      ['a client-chosen ref', { slot: 'STRIPE_KEY', ref: 'provider:anthropic' }],
      ['a payload', { slot: 'STRIPE_KEY', payloadB64: SECRET_B64 }],
      ['no slot', {}],
      ['an empty slot', { slot: '' }],
      ['a slot over 64 chars', { slot: 'A'.repeat(65) }],
      ['an array', ['STRIPE_KEY']],
    ])('a malformed body (%s): 400 invalid-body, nothing removed', async (_label, body) => {
      expect(await del(body)).toEqual({ statusCode: 400, body: { error: 'invalid-body' } });
      expect(deleteCalls).toEqual([]);
    });

    it('invalid JSON: 400 invalid-json', async () => {
      expect(await del(undefined, 'stripe', 'team-agent', '{"slot":')).toEqual({
        statusCode: 400,
        body: { error: 'invalid-json' },
      });
      expect(deleteCalls).toEqual([]);
    });

    it('a vault failure on the delete: 502 team-key-not-removed, logged by name only', async () => {
      deleteThrows = true;
      const r = await del({ slot: 'STRIPE_KEY' });
      expect(r).toEqual({ statusCode: 502, body: { error: 'team-key-not-removed' } });
      const line = logged.find((l) => l[0] === 'workspace_team_key_remove_failed');
      expect(line?.[1]).toEqual({ agentId: 'team-agent', connectorId: 'stripe', name: expect.any(String) });
      expectNoLeak(r);
    });

    it.each([
      ['agents:can-set-shared-credential', 'connectors-unavailable'],
      ['connectors:get', 'connectors-unavailable'],
      ['credentials:delete', 'credentials-unavailable'],
    ])('no %s: 503 %s, nothing removed', async (omit, error) => {
      rewire(
        ['auth:require-user', 'agents:resolve', 'agents:can-set-shared-credential', 'connectors:get', 'credentials:delete'],
        omit,
      );
      expect(await del({ slot: 'STRIPE_KEY' })).toEqual({ statusCode: 503, body: { error } });
      expect(deleteCalls).toEqual([]);
    });
  });
});
