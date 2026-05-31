// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createChatRouteHandlers, type RouteRequest, type RouteResponse } from '../../server/routes-chat';

// ---------------------------------------------------------------------------
// TASK-82 — the permission-decision (grant) and conversation-delete routes
// must clear the resolved/abandoned pending approval card from the replay
// buffer, so a later SSE (re)connect doesn't re-prompt for an already-approved
// (or deleted-conversation) skill. We exercise the handler factory directly with
// a minimal bus + a fake req/res, capturing the eviction callbacks. The full
// HTTP integration of these routes is covered in routes-chat.test.ts; here we
// pin the card-eviction wiring specifically.
// ---------------------------------------------------------------------------

const initCtx = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

function fakeReq(body: unknown, params: Record<string, string> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
    cookies: {},
    query: {},
    params,
    signedCookie() {
      return null;
    },
  };
}

function fakeRes(): { res: RouteResponse; captured: { status?: number; json?: unknown } } {
  const captured: { status?: number; json?: unknown } = {};
  const res: RouteResponse = {
    status(n) {
      captured.status = n;
      return res;
    },
    json(v) {
      captured.json = v;
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

/** Bus with the services postPermissionDecision + deleteConversation reach. */
function makeBus(opts: { grantFails?: boolean } = {}): HookBus {
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'mock-auth', async () => ({
    user: { id: 'userA', isAdmin: false },
  }));
  bus.registerService('conversations:get', 'mock-conv', async () => ({
    conversation: {
      conversationId: 'cnv1',
      userId: 'userA',
      agentId: 'agt_test',
      title: null,
      activeSessionId: null,
      activeReqId: null,
      createdAt: 't',
      updatedAt: 't',
    },
    turns: [],
  }));
  bus.registerService('agents:resolve', 'mock-agents', async () => ({
    agent: { id: 'agt_test' },
  }));
  bus.registerService('agent:apply-capability-grant', 'mock-grant', async () => {
    if (opts.grantFails) {
      throw new PluginError({ code: 'internal', plugin: 'mock', message: 'boom' });
    }
    return { attached: true };
  });
  bus.registerService('conversations:delete', 'mock-delete', async () => undefined);
  return bus;
}

describe('TASK-82 — card eviction wiring', () => {
  it('fires onCardResolved with (conversationId, skillId) after a successful catalog grant', async () => {
    const bus = makeBus();
    const resolved: Array<[string, string]> = [];
    const handlers = createChatRouteHandlers({
      bus,
      initCtx,
      onCardResolved: (c, s) => resolved.push([c, s]),
    });
    const { res, captured } = fakeRes();
    await handlers.postPermissionDecision(
      fakeReq({ conversationId: 'cnv1', skillId: 'github-helper' }),
      res,
    );
    expect(captured.status).toBe(200);
    expect(resolved).toEqual([['cnv1', 'github-helper']]);
  });

  it('does NOT fire onCardResolved when the grant fails', async () => {
    const bus = makeBus({ grantFails: true });
    const resolved: Array<[string, string]> = [];
    const handlers = createChatRouteHandlers({
      bus,
      initCtx,
      onCardResolved: (c, s) => resolved.push([c, s]),
    });
    const { res, captured } = fakeRes();
    await handlers.postPermissionDecision(
      fakeReq({ conversationId: 'cnv1', skillId: 'github-helper' }),
      res,
    );
    expect(captured.status).toBe(500);
    expect(resolved).toEqual([]);
  });

  it('fires onConversationDeleted on a successful delete', async () => {
    const bus = makeBus();
    const deleted: string[] = [];
    const handlers = createChatRouteHandlers({
      bus,
      initCtx,
      onConversationDeleted: (c) => deleted.push(c),
    });
    const { res, captured } = fakeRes();
    await handlers.deleteConversation(fakeReq({}, { id: 'cnv1' }), res);
    expect(captured.status).toBe(204);
    expect(deleted).toEqual(['cnv1']);
  });
});
