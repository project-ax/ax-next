// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeConnectionsHandlers } from '../../server/routes-connections.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

// ---------------------------------------------------------------------------
// TASK-126 (Skills app-store): the user-facing global-catalog read
// (GET /api/chat/catalog-skills) + the self-install attach route
// (POST /api/chat/connections/:agentId/skills). Both stub the bus directly —
// the full-stack mirror lives in connections-mirror.test.ts; here we pin the
// route contract: identity is server-forced, the agent ACL gates (404 no-leak),
// and a self-install is rejected unless the skillId is a real GLOBAL catalog id.
// ---------------------------------------------------------------------------

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

function mkReq(
  params: Record<string, string>,
  body?: unknown,
): RouteRequest {
  return {
    headers: {},
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8'),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
  ended: boolean;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined, ended: false };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text() {},
    end() {
      captured.ended = true;
    },
  };
  return { res, captured };
}

/** A bus whose `call` dispatches on hook name to a per-test stub map. */
function fakeBus(stubs: Record<string, (input: unknown) => unknown>) {
  return {
    call: vi.fn(async (hook: string, _ctx: unknown, input: unknown) => {
      const fn = stubs[hook];
      if (!fn) throw new Error(`unexpected hook: ${hook}`);
      return fn(input);
    }),
    hasService: (name: string) => name in stubs,
  } as unknown as Parameters<typeof makeConnectionsHandlers>[0]['bus'];
}

const AUTH_OK = { 'auth:require-user': () => ({ user: { id: 'u1', isAdmin: false } }) };
const RESOLVE_A1 = {
  'agents:resolve': (input: unknown) => {
    const i = input as { agentId: string };
    if (i.agentId !== 'a1') {
      throw new PluginError({ code: 'not-found', plugin: 'test', message: 'nf' });
    }
    return { agent: { id: 'a1', skillAttachments: [] } };
  },
};
const GLOBAL_CATALOG = {
  'skills:list': (input: unknown) => {
    const i = input as { scope?: string };
    if (i.scope === 'global') {
      return {
        skills: [
          { id: 'web-search', description: 'Search the web.', defaultAttached: true, connectors: ['serp'] },
          { id: 'pdf-tools', description: 'Work with PDFs.', defaultAttached: false, connectors: [] },
        ],
      };
    }
    return { skills: [] };
  },
};

describe('TASK-126 catalog-skills read', () => {
  it('GET /api/chat/catalog-skills returns the global catalog as installable listings', async () => {
    const bus = fakeBus({ ...AUTH_OK, ...GLOBAL_CATALOG });
    const handlers = makeConnectionsHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await handlers.listCatalog(mkReq({}), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as { skills: Array<{ skillId: string; connectors: string[]; defaultAttached: boolean }> };
    expect(body.skills).toEqual([
      { skillId: 'web-search', description: 'Search the web.', defaultAttached: true, connectors: ['serp'] },
      { skillId: 'pdf-tools', description: 'Work with PDFs.', defaultAttached: false, connectors: [] },
    ]);
  });

  it('GET /api/chat/catalog-skills → 401 when unauthenticated', async () => {
    const bus = fakeBus({
      'auth:require-user': () => {
        throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no' });
      },
    });
    const handlers = makeConnectionsHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await handlers.listCatalog(mkReq({}), res);
    expect(captured.statusCode).toBe(401);
  });
});

describe('TASK-126 self-install attach route', () => {
  it('POST attaches a catalog skill and returns 201 {created}', async () => {
    const attach = vi.fn((_input: unknown) => ({ created: true }));
    const bus = fakeBus({
      ...AUTH_OK,
      ...RESOLVE_A1,
      ...GLOBAL_CATALOG,
      'skills:attach-for-user': attach,
    });
    const handlers = makeConnectionsHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await handlers.attach(mkReq({ agentId: 'a1' }, { skillId: 'web-search' }), res);
    expect(captured.statusCode).toBe(201);
    expect(captured.body).toEqual({ created: true });
    // userId is SERVER-FORCED from auth, never from the body; bindings empty.
    expect(attach).toHaveBeenCalledWith({
      userId: 'u1',
      agentId: 'a1',
      skillId: 'web-search',
      credentialBindings: {},
    });
  });

  it('POST → 404 for an agent the caller cannot access (no existence leak)', async () => {
    const attach = vi.fn();
    const bus = fakeBus({
      ...AUTH_OK,
      ...RESOLVE_A1,
      ...GLOBAL_CATALOG,
      'skills:attach-for-user': attach,
    });
    const handlers = makeConnectionsHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await handlers.attach(mkReq({ agentId: 'other' }, { skillId: 'web-search' }), res);
    expect(captured.statusCode).toBe(404);
    expect(attach).not.toHaveBeenCalled();
  });

  it('POST → 404 when the skillId is NOT a global catalog id (capability-min)', async () => {
    const attach = vi.fn();
    const bus = fakeBus({
      ...AUTH_OK,
      ...RESOLVE_A1,
      ...GLOBAL_CATALOG,
      'skills:attach-for-user': attach,
    });
    const handlers = makeConnectionsHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await handlers.attach(mkReq({ agentId: 'a1' }, { skillId: 'not-in-catalog' }), res);
    expect(captured.statusCode).toBe(404);
    expect(attach).not.toHaveBeenCalled();
  });

  it('POST → 400 for a missing/blank skillId', async () => {
    const attach = vi.fn();
    const bus = fakeBus({ ...AUTH_OK, ...RESOLVE_A1, ...GLOBAL_CATALOG, 'skills:attach-for-user': attach });
    const handlers = makeConnectionsHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    await handlers.attach(mkReq({ agentId: 'a1' }, {}), res);
    expect(captured.statusCode).toBe(400);
    expect(attach).not.toHaveBeenCalled();
  });
});
