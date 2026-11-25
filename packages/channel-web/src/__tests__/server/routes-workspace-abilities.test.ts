// @vitest-environment node
/**
 * `GET`/`PUT /api/workspace/agents/:agentId/abilities` (TASK-738) — the
 * Connectors tab's "Other abilities" switches.
 *
 * What the tests are for, most expensive first:
 *
 *   1. THE ACL. A caller `agents:resolve` refuses gets a 404 and the verdict
 *      store is never touched — a switch on someone else's agent is a write
 *      to someone else's reach. Someone a personal agent is only shared with
 *      (TASK-1246) may read the switches but gets a 403 on a write.
 *   2. THE CLOSED KEY TABLE. The browser names a product word; only
 *      `web_search` / `web_extract` / `Bash` can ever reach the store, and
 *      "on" CLEARS (never writes `allow`), so a switch cannot loosen.
 *   3. NO FALSE "SAVED". A refused write is reported, and the answer is the
 *      store's re-read state, not an echo of the request.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { ABILITY_TOOL_KEYS, makeWorkspaceHandlers } from '../../server/routes-workspace.js';
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

interface SetCall {
  agentId: string;
  toolKey: string;
  verdict: string | null;
  ctxUserId: string;
}

describe('abilities routes', () => {
  let bus: HookBus;
  /** agentId → owner. */
  let owners: Map<string, string>;
  /** TASK-1246 — agentId → the people a personal agent is shared with. */
  let sharedWith: Map<string, string[]>;
  /** agentId → the members of the team that owns it. */
  let teamMembers: Map<string, string[]>;
  /** `${agentId}\0${toolKey}` → verdict: a stand-in verdict store. */
  let store: Map<string, string>;
  let setCalls: SetCall[];
  let listCalls: number;
  let refuseWrites: boolean;

  function handlers() {
    return makeWorkspaceHandlers({ bus, initCtx });
  }

  function registerPolicy(): void {
    bus.registerService('tool-policy:set-agent-override', 'policy', async (ctx, i: unknown) => {
      const input = i as { agentId: string; toolKey: string; verdict: string | null };
      setCalls.push({ ...input, ctxUserId: ctx.userId });
      if (refuseWrites) return { ok: false, reason: 'invalid-key' };
      const k = `${input.agentId}\0${input.toolKey}`;
      if (input.verdict === null) store.delete(k);
      else store.set(k, input.verdict);
      return { ok: true };
    });
    bus.registerService('tool-policy:list-agent-overrides', 'policy', async (_c, i: unknown) => {
      listCalls += 1;
      const { agentId } = i as { agentId: string };
      const overrides = [...store.entries()]
        .filter(([k]) => k.startsWith(`${agentId}\0`))
        .map(([k, verdict]) => ({
          toolKey: k.slice(agentId.length + 1),
          verdict,
          ceiling: 'allow',
          origin: 'user',
        }));
      return { overrides };
    });
  }

  beforeEach(() => {
    bus = new HookBus();
    owners = new Map([
      ['a1', 'u1'],
      ['a-theirs', 'u2'],
      ['a-shared', 'u2'],
    ]);
    sharedWith = new Map([['a-shared', ['u1']]]);
    teamMembers = new Map([['t1', ['u1']]]);
    store = new Map();
    setCalls = [];
    listCalls = 0;
    refuseWrites = false;
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    // @ax/agents' ACL in miniature (TASK-1246): a personal agent admits its
    // owner and the people it is shared with, a team agent its members, and
    // the answer says whether the caller is one of its owners.
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId, userId } = i as { agentId: string; userId: string };
      const base = { id: agentId, displayName: 'Quill' };
      if (owners.get(agentId) === userId) {
        return { agent: { ...base, ownerId: userId, visibility: 'personal', isOwner: true } };
      }
      if (sharedWith.get(agentId)?.includes(userId) === true) {
        return {
          agent: { ...base, ownerId: owners.get(agentId), visibility: 'personal', isOwner: false },
        };
      }
      if (teamMembers.get(agentId)?.includes(userId) === true) {
        return { agent: { ...base, ownerId: 'team-1', visibility: 'team', isOwner: false } };
      }
      throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
    });
    registerPolicy();
  });

  async function get(agentId = 'a1'): Promise<Captured> {
    const { res, captured } = mkRes();
    await handlers().abilities(mkReq({ agentId }), res);
    return captured;
  }
  async function put(body: unknown, agentId = 'a1', raw?: string): Promise<Captured> {
    const { res, captured } = mkRes();
    await handlers().setAbility(mkReq({ agentId }, body, raw), res);
    return captured;
  }

  it('maps the three product words onto exactly three tool keys', () => {
    expect(ABILITY_TOOL_KEYS).toEqual({
      webSearch: 'web_search',
      readPages: 'web_extract',
      runCode: 'Bash',
    });
  });

  it('reads all three as on when nothing is overridden', async () => {
    const out = await get();
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ abilities: { webSearch: true, readPages: true, runCode: true } });
  });

  it('turning a switch off writes deny on that tool, as the caller, and persists', async () => {
    const out = await put({ ability: 'runCode', enabled: false });
    expect(out.statusCode).toBe(200);
    expect(setCalls).toEqual([
      { agentId: 'a1', toolKey: 'Bash', verdict: 'deny', ctxUserId: 'u1' },
    ]);
    expect(out.body).toEqual({ abilities: { webSearch: true, readPages: true, runCode: false } });
    // A fresh read sees it — the store, not the response, is the truth.
    expect((await get()).body).toEqual({
      abilities: { webSearch: true, readPages: true, runCode: false },
    });
  });

  it('turning a switch back on CLEARS the override — it never writes allow', async () => {
    await put({ ability: 'readPages', enabled: false });
    const out = await put({ ability: 'readPages', enabled: true });
    expect(out.statusCode).toBe(200);
    expect(setCalls.map((c) => c.verdict)).toEqual(['deny', null]);
    expect(setCalls.every((c) => c.toolKey === 'web_extract')).toBe(true);
    expect(store.size).toBe(0);
  });

  it('reads a hold override as on — only deny is off', async () => {
    store.set('a1\0web_search', 'hold');
    store.set('a1\0Bash', 'deny');
    expect((await get()).body).toEqual({
      abilities: { webSearch: true, readPages: true, runCode: false },
    });
  });

  it('ignores overrides that are not one of the three abilities', async () => {
    store.set('a1\0mcp.c0123456789.send', 'deny');
    expect((await get()).body).toEqual({
      abilities: { webSearch: true, readPages: true, runCode: true },
    });
  });

  it.each([
    [{ ability: 'WebFetch', enabled: false }],
    [{ ability: 'Bash', enabled: false }],
    [{ ability: 'mcp.c0123456789.send', enabled: true }],
    [{ ability: 'webSearch', enabled: 'false' }],
    [{ ability: 'webSearch' }],
    [null],
  ])('400s a body that is not one of the three abilities: %j', async (body) => {
    const out = await put(body);
    expect(out.statusCode).toBe(400);
    expect(setCalls).toEqual([]);
  });

  it('400s a body that is not JSON', async () => {
    const out = await put(undefined, 'a1', '{nope');
    expect(out.statusCode).toBe(400);
    expect(setCalls).toEqual([]);
  });

  it('404s another user’s agent on read and write, before touching the store', async () => {
    expect((await get('a-theirs')).statusCode).toBe(404);
    expect((await put({ ability: 'webSearch', enabled: false }, 'a-theirs')).statusCode).toBe(404);
    expect(setCalls).toEqual([]);
    expect(listCalls).toBe(0);
  });

  // TASK-1246 — agents:resolve now also admits someone a personal agent is
  // shared with, so "resolved, and personal" no longer means "owner". A
  // switch changes what the agent may do on every run, its owners' included:
  // only an owner flips one. Off or on, the store is never asked.
  it('PUT on a personal agent shared with the caller → 403, tool-policy:set-agent-override never called', async () => {
    for (const enabled of [false, true]) {
      const out = await put({ ability: 'runCode', enabled }, 'a-shared');
      expect(out).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
    }
    expect(setCalls).toEqual([]);
    expect(listCalls).toBe(0);
  });

  it('someone a personal agent is shared with still reads its switches', async () => {
    store.set('a-shared\0Bash', 'deny');
    const out = await get('a-shared');
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ abilities: { webSearch: true, readPages: true, runCode: false } });
  });

  it('a team agent’s member still flips a switch, as before', async () => {
    const out = await put({ ability: 'webSearch', enabled: false }, 't1');
    expect(out.statusCode).toBe(200);
    expect(setCalls).toEqual([
      { agentId: 't1', toolKey: 'web_search', verdict: 'deny', ctxUserId: 'u1' },
    ]);
  });

  it('an agent that does not say it is a team agent, or that the caller owns it, is refused', async () => {
    // `team` is the one answer that lets a non-owner write, so it is never
    // assumed from silence; nor is `isOwner`.
    for (const answer of [{}, { visibility: 'personal' }, { isOwner: true }]) {
      bus = new HookBus();
      bus.registerService('auth:require-user', 'auth', async () => ({
        user: { id: 'u1', isAdmin: false },
      }));
      bus.registerService('agents:resolve', 'agents', async () => ({
        agent: { id: 'a1', displayName: 'Quill', ownerId: 'u1', ...answer },
      }));
      registerPolicy();
      const out = await put({ ability: 'webSearch', enabled: false });
      expect(out, JSON.stringify(answer)).toEqual({ statusCode: 403, body: { error: 'forbidden' } });
    }
    expect(setCalls).toEqual([]);
  });

  it('401s an unauthenticated caller', async () => {
    bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => {
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no' });
    });
    registerPolicy();
    expect((await get()).statusCode).toBe(401);
    expect((await put({ ability: 'webSearch', enabled: false })).statusCode).toBe(401);
    expect(setCalls).toEqual([]);
  });

  it('reports a refused write instead of saying it saved', async () => {
    refuseWrites = true;
    const out = await put({ ability: 'webSearch', enabled: false });
    expect(out.statusCode).toBe(409);
    expect(out.body).toEqual({ error: 'ability-not-saved', reason: 'invalid-key' });
  });

  it('503s both routes when no verdict store is loaded', async () => {
    bus = new HookBus();
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('agents:resolve', 'agents', async () => ({
      agent: { id: 'a1', displayName: 'Quill', ownerId: 'u1', visibility: 'personal', isOwner: true },
    }));
    expect((await get()).statusCode).toBe(503);
    expect((await put({ ability: 'webSearch', enabled: false })).statusCode).toBe(503);
  });
});
