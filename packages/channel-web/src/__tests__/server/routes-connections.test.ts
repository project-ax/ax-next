import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';
import { makeConnectionsHandlers } from '../../server/routes-connections.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function mkReq(params: Record<string, string>): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
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

describe('channel-web Connections BFF', () => {
  let bus: HookBus;
  let detachCalls: Array<{ userId: string; agentId: string; skillId: string }>;
  let grantListCalls: Array<{ ownerUserId: string; agentId: string }>;
  let revokeCalls: Array<{ ownerUserId: string; agentId: string; host: string }>;

  beforeEach(() => {
    bus = new HookBus();
    detachCalls = [];
    grantListCalls = [];
    revokeCalls = [];
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const input = i as { agentId: string };
      if (input.agentId !== 'a1') {
        const e = new (await import('@ax/core')).PluginError({
          code: 'not-found',
          plugin: 'agents',
          message: 'nf',
        });
        throw e;
      }
      return {
        agent: {
          id: 'a1',
          displayName: 'Research',
          skillAttachments: [{ skillId: 'memory', credentialBindings: {} }],
        },
      };
    });
    bus.registerService('skills:list-user-attachments', 'skills', async () => ({
      attachments: [{ skillId: 'linear', credentialBindings: {} }],
    }));
    bus.registerService('skills:list', 'skills', async () => ({
      skills: [
        { id: 'web_search', description: 'Search the web', defaultAttached: true },
        { id: 'memory', description: 'Long-term memory', defaultAttached: false },
        {
          id: 'linear',
          description: 'Linear issues',
          defaultAttached: false,
          capabilities: { credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' }] },
        },
        {
          id: 'linear-search',
          description: 'Linear search',
          defaultAttached: false,
          capabilities: { credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', account: 'linear' }] },
        },
      ],
    }));
    bus.registerService('skills:detach-for-user', 'skills', async (_c, i: unknown) => {
      detachCalls.push(i as { userId: string; agentId: string; skillId: string });
      return { removed: true };
    });
    bus.registerService('host-grants:list', 'host-grants', async (_c, i: unknown) => {
      grantListCalls.push(i as { ownerUserId: string; agentId: string });
      return { hosts: [{ host: 'status.example.com', grantedAt: '2026-05-20T00:00:00Z' }] };
    });
    bus.registerService('host-grants:revoke', 'host-grants', async (_c, i: unknown) => {
      revokeCalls.push(i as { ownerUserId: string; agentId: string; host: string });
      return { revoked: true };
    });
  });

  describe('GET /api/chat/connections/:agentId', () => {
    it('merges default + agent-global + per-user with source tags and removable flags', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.get(mkReq({ agentId: 'a1' }), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({
        agentId: 'a1',
        skills: [
          { skillId: 'web_search', description: 'Search the web', source: 'default', removable: false },
          { skillId: 'memory', description: 'Long-term memory', source: 'agent', removable: false },
          { skillId: 'linear', description: 'Linear issues', source: 'user', removable: true },
        ],
      });
    });

    it('404s an agent the caller cannot access (no existence leak)', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.get(mkReq({ agentId: 'nope' }), res);
      expect(captured.statusCode).toBe(404);
    });

    it('401s an unauthenticated caller', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => {
        throw new (await import('@ax/core')).PluginError({
          code: 'unauthenticated',
          plugin: 'auth',
          message: 'no cookie',
        });
      });
      const h = makeConnectionsHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.get(mkReq({ agentId: 'a1' }), res);
      expect(captured.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/chat/connections/:agentId/skills/:skillId', () => {
    it('detaches the caller user-scoped skill and returns 204', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.detach(mkReq({ agentId: 'a1', skillId: 'linear' }), res);
      expect(captured.statusCode).toBe(204);
      // userId is SERVER-FORCED from auth ('u1'), never read from the request.
      expect(detachCalls).toEqual([{ userId: 'u1', agentId: 'a1', skillId: 'linear' }]);
    });

    it('404s an agent the caller cannot access (no cross-user detach)', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.detach(mkReq({ agentId: 'nope', skillId: 'linear' }), res);
      expect(captured.statusCode).toBe(404);
      expect(detachCalls).toEqual([]);
    });
  });

  describe('GET /api/chat/allowed-sites/:agentId (TASK-54)', () => {
    it('lists the per-(user, agent) host grants', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.listAllowedSites(mkReq({ agentId: 'a1' }), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({
        agentId: 'a1',
        hosts: [{ host: 'status.example.com', grantedAt: '2026-05-20T00:00:00Z' }],
      });
      // ownerUserId is SERVER-FORCED from auth ('u1'), never read from the request.
      expect(grantListCalls).toEqual([{ ownerUserId: 'u1', agentId: 'a1' }]);
    });

    it('404s an agent the caller cannot access (no existence leak)', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.listAllowedSites(mkReq({ agentId: 'nope' }), res);
      expect(captured.statusCode).toBe(404);
      expect(grantListCalls).toEqual([]);
    });

    it('401s an unauthenticated caller', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => {
        throw new (await import('@ax/core')).PluginError({
          code: 'unauthenticated',
          plugin: 'auth',
          message: 'no cookie',
        });
      });
      const h = makeConnectionsHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.listAllowedSites(mkReq({ agentId: 'a1' }), res);
      expect(captured.statusCode).toBe(401);
    });

    it('degrades to empty when @ax/host-grants is absent', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => ({
        user: { id: 'u1', isAdmin: false },
      }));
      b.registerService('agents:resolve', 'agents', async () => ({
        agent: { id: 'a1', displayName: 'Research', skillAttachments: [] },
      }));
      const h = makeConnectionsHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.listAllowedSites(mkReq({ agentId: 'a1' }), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({ agentId: 'a1', hosts: [] });
    });
  });

  describe('DELETE /api/chat/allowed-sites/:agentId/:host (TASK-54)', () => {
    it('revokes the durable grant and returns 204', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.revokeAllowedSite(mkReq({ agentId: 'a1', host: 'status.example.com' }), res);
      expect(captured.statusCode).toBe(204);
      // ownerUserId SERVER-FORCED from auth ('u1'); host from the path param.
      expect(revokeCalls).toEqual([
        { ownerUserId: 'u1', agentId: 'a1', host: 'status.example.com' },
      ]);
    });

    it('404s an agent the caller cannot access (no cross-user revoke)', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.revokeAllowedSite(mkReq({ agentId: 'nope', host: 'status.example.com' }), res);
      expect(captured.statusCode).toBe(404);
      expect(revokeCalls).toEqual([]);
    });

    it('is idempotent (204) when @ax/host-grants is absent', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => ({
        user: { id: 'u1', isAdmin: false },
      }));
      b.registerService('agents:resolve', 'agents', async () => ({
        agent: { id: 'a1', displayName: 'Research', skillAttachments: [] },
      }));
      const h = makeConnectionsHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.revokeAllowedSite(mkReq({ agentId: 'a1', host: 'x.example.com' }), res);
      expect(captured.statusCode).toBe(204);
    });
  });

  describe('GET /api/chat/account-usage (TASK-54)', () => {
    it('derives service → referencing skill ids from skills:list', async () => {
      const h = makeConnectionsHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.accountUsage(mkReq({}), res);
      expect(captured.statusCode).toBe(200);
      // Two skills declare account: linear; sorted, deduped per service.
      expect(captured.body).toEqual({ usage: { linear: ['linear', 'linear-search'] } });
    });

    it('401s an unauthenticated caller', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => {
        throw new (await import('@ax/core')).PluginError({
          code: 'unauthenticated',
          plugin: 'auth',
          message: 'no cookie',
        });
      });
      const h = makeConnectionsHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.accountUsage(mkReq({}), res);
      expect(captured.statusCode).toBe(401);
    });

    it('degrades to empty when skills:list is absent', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => ({
        user: { id: 'u1', isAdmin: false },
      }));
      const h = makeConnectionsHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.accountUsage(mkReq({}), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({ usage: {} });
    });
  });
});
