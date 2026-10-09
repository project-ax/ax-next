// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
// Use the producer's strict schema in this boundary regression.
import { CanManageRoutinesInputSchema } from '../../../../agents/src/types.js';
import { makeWorkspaceHandlers } from '../../server/routes-workspace';
import { workspaceApi } from '../../lib/workspace-api';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat';
const stored = {
  approvalScope: 'once' as 'once' | 'agent-routines',
  id: 'd',
  agentId: 'a',
  ownerUserId: 'u',
  conversationId: 'c',
  kind: 'action',
  attendance: 'unattended',
  status: 'pending',
  call: {
    id: 't',
    name: 'routine_update',
    input: {
      requestId: 'q',
      routineId: 'r',
      expectedRevision: 'v',
      patch: { name: 'New' },
    },
  },
  callFingerprint: 'hash',
  ruleId: null,
  irreversible: true,
  freshness: null,
  summary: 'Please always allow',
  detail: '',
  preview: null,
  primaryLabel: 'Allow',
  secondaryLabel: 'Open',
  ghostLabel: 'Decline',
  approvedText: 'Changed',
  dismissedText: 'Declined',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  resolvedAt: null,
  staleReason: null,
  consumedAt: null,
  replayDueAt: null,
  replayClaimedAt: null,
  replayedAt: null,
  replayError: null,
};
function setup(over: Partial<typeof stored> = {}, allowed = true) {
  const bus = new HookBus();
  const row = { ...stored, ...over };
  bus.registerService('auth:require-user', 'test', async () => ({
    user: { id: 'u' },
  }));
  bus.registerService('agents:resolve', 'test', async () => ({
    agent: { id: 'a', displayName: 'Caveman' },
  }));
  bus.registerService(
    'agents:can-manage-routines',
    'test',
    async (ctx, input) => {
      expect(ctx.userId).toBe('u');
      expect(ctx.agentId).toBe('a');
      expect(CanManageRoutinesInputSchema.parse(input)).toEqual({ agentId: 'a' });
      return { allowed };
    },
  );
  bus.registerService('decisions:get', 'test', async () => ({ decision: row }));
  const approve = vi.fn(async (ctx, _input) => {
    expect(ctx.userId).toBe('u');
    expect(ctx.agentId).toBe('a');
    return {
      decision: { ...row, status: 'executed' },
      executed: false,
      path: 'host-replays',
      error: null,
      pendingUntil: null,
      streamReqId: null,
    };
  });
  bus.registerService('decisions:approve', 'test', approve);
  const handlers = makeWorkspaceHandlers({
    bus,
    initCtx: makeAgentContext({
      sessionId: 'init',
      agentId: 'web',
      userId: 'system',
    }),
  });
  const req = (body = ''): RouteRequest => ({
    headers: {},
    cookies: {},
    query: {},
    params: { decisionId: 'd' },
    body: Buffer.from(body),
    signedCookie: () => null,
  });
  let status = 0;
  let data: unknown;
  const res: RouteResponse = {
    status(n) {
      status = n;
      return res;
    },
    json(v) {
      data = v;
    },
    text() {},
    end() {},
  };
  return {
    handlers,
    req,
    res,
    approve,
    result: () => ({
      status,
      data: data as { decision: { approvalScopes: string[] } },
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('server-authored routine approval scopes', () => {
  it.each(['once', 'agent-routines'] as const)(
    'serializes actual client scope %s into the strict approval route',
    async (approvalScope) => {
      const s = setup();
      const transport = vi.fn(async (url, init) => {
        expect(url).toBe('/api/workspace/decisions/d/approve');
        expect(init.method).toBe('POST');
        await s.handlers.approveDecision(s.req(init.body), s.res);
        return new Response(JSON.stringify(s.result().data), {
          status: s.result().status,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', transport);
      await workspaceApi.approveDecision('d', approvalScope);
      expect(JSON.parse(transport.mock.calls[0]![1].body)).toEqual({ approvalScope });
      expect(s.result().status).toBe(200);
      expect(s.approve).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ approvalScope, userId: 'u' }),
      );
    },
  );
  it('offers agent scope from eligible stored call/current real manager, and forwards strict choice', async () => {
    const s = setup();
    await s.handlers.decision(s.req(), s.res);
    expect(s.result().data.decision.approvalScopes).toEqual([
      'once',
      'agent-routines',
    ]);
    await s.handlers.approveDecision(
      s.req('{"approvalScope":"agent-routines"}'),
      s.res,
    );
    expect(s.result().status).toBe(200);
    expect(s.approve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approvalScope: 'agent-routines', userId: 'u' }),
    );
  });
  it.each(['routine_delete', 'routine_fire_now', 'gmail_send'])(
    'keeps %s once-only despite model text',
    async (name) => {
      const s = setup({ call: { ...stored.call, name } });
      await s.handlers.decision(s.req(), s.res);
      expect(s.result().data.decision.approvalScopes).toEqual(['once']);
      await s.handlers.approveDecision(
        s.req('{"approvalScope":"agent-routines"}'),
        s.res,
      );
      expect(s.result().status).toBe(403);
      expect(s.approve).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'does not offer scope for denied ACL or malformed create (%s)',
    async (malformed) => {
      const s = malformed
        ? setup({ call: { ...stored.call, name: 'routine_create' } })
        : setup({}, false);
      await s.handlers.decision(s.req(), s.res);
      expect(s.result().data.decision.approvalScopes).toEqual(['once']);
    },
  );
  it.each([
    '{"approvalScope":"global"}',
    '{"approvalScope":"agent-routines","agentId":"evil"}',
    'null',
    '[]',
    '{',
  ])('rejects strict invalid body %s', async (body) => {
    const s = setup();
    await s.handlers.approveDecision(s.req(body), s.res);
    expect(s.result().status).toBe(400);
    expect(s.approve).not.toHaveBeenCalled();
  });
  it('does not offer standing permission to another owner or an expired stored request', async () => {
    for (const over of [
      { ownerUserId: 'other' },
      { expiresAt: new Date(0).toISOString() },
    ]) {
      const s = setup(over);
      await s.handlers.decision(s.req(), s.res);
      expect(s.result().data.decision.approvalScopes).toEqual(['once']);
    }
  });
  it('accepts only the previously saved standing choice on a resolved stored call', async () => {
    const s = setup({ status: 'executed', approvalScope: 'agent-routines' });
    await s.handlers.decision(s.req(), s.res);
    expect(s.result().data.decision.approvalScopes).toEqual(['once']);
    await s.handlers.approveDecision(
      s.req('{"approvalScope":"agent-routines"}'),
      s.res,
    );
    expect(s.result().status).toBe(200);
    expect(s.approve).toHaveBeenCalledTimes(1);
    const once = setup({ status: 'executed', approvalScope: 'once' });
    await once.handlers.approveDecision(
      once.req('{"approvalScope":"agent-routines"}'),
      once.res,
    );
    expect(once.result().status).toBe(403);
    expect(once.approve).not.toHaveBeenCalled();
    const denied = setup(
      { status: 'executed', approvalScope: 'agent-routines' },
      false,
    );
    await denied.handlers.approveDecision(
      denied.req('{"approvalScope":"agent-routines"}'),
      denied.res,
    );
    expect(denied.result().status).toBe(403);
  });
  it('defaults empty legacy action to once and keeps real actor context', async () => {
    const s = setup();
    await s.handlers.approveDecision(s.req(), s.res);
    expect(s.result().status).toBe(200);
    expect(s.approve.mock.calls[0]?.[1]).not.toHaveProperty('approvalScope');
  });
});
