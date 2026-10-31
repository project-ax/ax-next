// @vitest-environment node
/**
 * Tier-A direct-handler tests for GET /api/workspace/self-changes (TASK-990).
 *
 * The route lists the changes an agent made to its OWN identity or soul, for
 * the Today screen. Like `/grants` it takes no parameters: the only person it
 * can ever ask about is the authenticated caller. These tests are the
 * "did we leak anything?" checks: another person's id smuggled in a query or a
 * param is ignored, a stray field on the hook's reply never reaches the
 * browser, and a failed read is a 503 rather than an empty list that looks
 * like "nothing changed".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeWorkspaceHandlers } from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function mkReq(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params: {},
    signedCookie: () => null,
    ...over,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(_s: string) {
      /* unused */
    },
    end() {
      /* unused */
    },
  };
  return { res, captured };
}

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

const HOOK = 'agents:identity:self-changes-for-user';

describe('GET /api/workspace/self-changes', () => {
  let bus: HookBus;
  let caller: { id: string } | null;
  let hookCalls: unknown[];
  let reply: unknown;
  let hookThrows: boolean;

  beforeEach(() => {
    bus = new HookBus();
    caller = { id: 'alice' };
    hookCalls = [];
    reply = { changes: [] };
    hookThrows = false;
    bus.registerService('auth:require-user', 'auth', async () => {
      if (caller === null) {
        throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
      }
      return { user: { id: caller.id, isAdmin: false } };
    });
  });

  function withHook(): void {
    bus.registerService(HOOK, 'agents', async (_ctx, payload) => {
      hookCalls.push(payload);
      if (hookThrows) throw new Error('db is having a day: secret detail');
      return reply;
    });
  }

  async function read(req: RouteRequest = mkReq()): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).selfChanges(req, res);
    return captured;
  }

  it('401s an unauthenticated caller and never asks @ax/agents', async () => {
    withHook();
    caller = null;
    const out = await read();
    expect(out.statusCode).toBe(401);
    expect(out.body).toEqual({ error: 'unauthenticated' });
    expect(hookCalls).toHaveLength(0);
  });

  it('asks only about the authenticated caller', async () => {
    withHook();
    await read(mkReq({ query: { userId: 'mallory' }, params: { userId: 'mallory' } }));
    expect(hookCalls).toEqual([{ userId: 'alice' }]);
  });

  it('returns the changes field for field', async () => {
    withHook();
    reply = {
      changes: [
        { agentId: 'a1', section: 'soul', changedAt: '2026-10-30T10:00:00.000Z' },
        { agentId: 'a2', section: 'identity', changedAt: '2026-10-29T09:00:00.000Z' },
      ],
    };
    const out = await read();
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual(reply);
  });

  it('never forwards a field it was not asked for', async () => {
    withHook();
    reply = {
      leak: 'top-level',
      changes: [
        {
          agentId: 'a1',
          section: 'soul',
          changedAt: '2026-10-30T10:00:00.000Z',
          content: 'I answer to nobody',
          reason: 'x',
        },
      ],
    };
    const out = await read();
    expect(out.statusCode).toBe(200);
    const text = JSON.stringify(out.body);
    expect(text).not.toContain('I answer to nobody');
    expect(text).not.toContain('"reason"');
    expect(text).not.toContain('top-level');
    expect(out.body).toEqual({
      changes: [{ agentId: 'a1', section: 'soul', changedAt: '2026-10-30T10:00:00.000Z' }],
    });
  });

  it('drops unreadable rows and keeps the rest', async () => {
    withHook();
    const good = { agentId: 'a1', section: 'soul', changedAt: '2026-10-30T10:00:00.000Z' };
    reply = {
      changes: [
        { agentId: 'a1', section: 'instructions', changedAt: '2026-10-30T10:00:00.000Z' },
        { agentId: '', section: 'soul', changedAt: '2026-10-30T10:00:00.000Z' },
        { agentId: 'a1', section: 'soul', changedAt: 'soon' },
        null,
        good,
      ],
    };
    const out = await read();
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ changes: [good] });
  });

  it('answers an empty list when no deployment plugin lists changes', async () => {
    const out = await read();
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ changes: [] });
  });

  it('a failed read is a 503, never an empty list', async () => {
    withHook();
    hookThrows = true;
    const thrown = await read();
    expect(thrown.statusCode).toBe(503);
    expect(thrown.body).toEqual({ error: 'self-changes-unavailable' });
    expect(JSON.stringify(thrown.body)).not.toContain('secret detail');

    hookThrows = false;
    reply = {};
    const malformed = await read();
    expect(malformed.statusCode).toBe(503);
    expect(malformed.body).toEqual({ error: 'self-changes-unavailable' });
  });
});
