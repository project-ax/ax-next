import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { makeRememberedSitesHandlers } from '../../server/routes-remembered-sites.js';
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

const SITES = [
  { host: 'docs.example.com', scope: 'user' as const, rememberedAt: '2026-09-01T00:00:00Z' },
  { host: 'operator-wide.example.com', scope: 'global' as const, rememberedAt: '2026-01-01T00:00:00Z' },
];

describe('channel-web Remembered-sites BFF (TASK-406)', () => {
  let bus: HookBus;
  let listCallCtxUserIds: string[];
  let listCallInputs: unknown[];
  let revokeCallCtxUserIds: string[];
  let revokeCallInputs: Array<{ host: string }>;

  beforeEach(() => {
    bus = new HookBus();
    listCallCtxUserIds = [];
    listCallInputs = [];
    revokeCallCtxUserIds = [];
    revokeCallInputs = [];
    bus.registerService('auth:require-user', 'auth', async () => ({
      user: { id: 'u1', isAdmin: false },
    }));
    bus.registerService('egress-allowlist:list', 'tool-policy', async (c, i: unknown) => {
      listCallCtxUserIds.push(c.userId);
      listCallInputs.push(i);
      return { status: 'ok', sites: SITES };
    });
    bus.registerService('egress-allowlist:revoke', 'tool-policy', async (c, i: unknown) => {
      revokeCallCtxUserIds.push(c.userId);
      revokeCallInputs.push(i as { host: string });
      const { host } = i as { host: string };
      // A global entry (or one already gone) is not revocable by a user.
      return { revoked: host !== 'operator-wide.example.com' };
    });
  });

  describe('GET /api/chat/remembered-sites', () => {
    it('returns the hook sites verbatim, including scope + rememberedAt', async () => {
      const h = makeRememberedSitesHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.list(mkReq({}), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({ sites: SITES });
      // Guard against a mirror type dropping a field.
      const body = captured.body as { sites: Array<Record<string, unknown>> };
      for (const site of body.sites) {
        expect(Object.keys(site).sort()).toEqual(['host', 'rememberedAt', 'scope'].sort());
      }
    });

    it('calls the hook with the AUTHENTICATED caller ctx and no owner field on the payload', async () => {
      const h = makeRememberedSitesHandlers({ bus, initCtx });
      const { res } = mkRes();
      await h.list(mkReq({}), res);
      expect(listCallCtxUserIds).toEqual(['u1']);
      expect(listCallInputs).toHaveLength(1);
      const input = listCallInputs[0] as Record<string, unknown>;
      expect(Object.keys(input)).not.toContain('ownerId');
      expect(Object.keys(input)).not.toContain('userId');
      expect(Object.keys(input)).not.toContain('user');
      expect(Object.keys(input)).toEqual([]);
    });

    it('401s an unauthenticated caller', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => {
        throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no cookie' });
      });
      const h = makeRememberedSitesHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.list(mkReq({}), res);
      expect(captured.statusCode).toBe(401);
    });

    it('returns 200 { sites: [] } when the hook is not registered', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => ({
        user: { id: 'u1', isAdmin: false },
      }));
      const h = makeRememberedSitesHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.list(mkReq({}), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({ sites: [] });
    });

    /*
     * TASK-464 — the route's half of "empty is not unknown".
     *
     * Three cases arrive here and two of them used to leave by the same door.
     * "No allowlist plugin in this preset" and "the allowlist could not be
     * read" are different claims, and only the first one licenses an empty
     * array. Each test below is paired with the 200 it must NOT be, because an
     * assertion on a status code alone cannot tell you the route distinguishes
     * anything — it only tells you what it did once.
     */
    function busAnswering(list: unknown): HookBus {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => ({
        user: { id: 'u1', isAdmin: false },
      }));
      b.registerService('egress-allowlist:list', 'tool-policy', async () => list);
      return b;
    }

    it('503s when the hook says `unknown` — and does NOT send an empty list', async () => {
      const h = makeRememberedSitesHandlers({ bus: busAnswering({ status: 'unknown' }), initCtx });
      const { res, captured } = mkRes();
      await h.list(mkReq({}), res);
      expect(captured.statusCode).toBe(503);
      expect(captured.body).toEqual({ error: 'remembered-sites-unreadable' });
      // The assertion that carries the card. A body with a `sites` key — of any
      // length — is the route telling a browser something about this person's
      // allowlist that it does not know.
      expect(captured.body).not.toHaveProperty('sites');
    });

    it('still 200s a genuinely empty list, so the 503 above means something', async () => {
      const h = makeRememberedSitesHandlers({
        bus: busAnswering({ status: 'ok', sites: [] }),
        initCtx,
      });
      const { res, captured } = mkRes();
      await h.list(mkReq({}), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({ sites: [] });
    });

    it('503s a hook answer it does not recognise, rather than reading it as empty', async () => {
      // The mirror type is hand-declared, so a producer that grows a third arm
      // (or reverts to the pre-TASK-464 `{ sites: [...] }`) cannot be caught by
      // tsc. Unknown is the safe reading of a shape we cannot describe; empty
      // is the unsafe one, and it is the reading the old code picked.
      for (const odd of [{ sites: SITES }, { status: 'degraded' }, {}]) {
        const h = makeRememberedSitesHandlers({ bus: busAnswering(odd), initCtx });
        const { res, captured } = mkRes();
        await h.list(mkReq({}), res);
        expect(captured.statusCode, JSON.stringify(odd)).toBe(503);
        expect(captured.body).not.toHaveProperty('sites');
      }
    });

    it('503s a hook that throws, rather than letting the framework decide', async () => {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => ({
        user: { id: 'u1', isAdmin: false },
      }));
      b.registerService('egress-allowlist:list', 'tool-policy', async () => {
        throw new Error('bus is having a day');
      });
      const h = makeRememberedSitesHandlers({ bus: b, initCtx });
      const { res, captured } = mkRes();
      await h.list(mkReq({}), res);
      expect(captured.statusCode).toBe(503);
      expect(captured.body).toEqual({ error: 'remembered-sites-unreadable' });
    });
  });

  describe('DELETE /api/chat/remembered-sites/:host', () => {
    it('passes { host } through and answers 200 { revoked: true }', async () => {
      const h = makeRememberedSitesHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.revoke(mkReq({ host: 'docs.example.com' }), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({ revoked: true });
      expect(revokeCallInputs).toEqual([{ host: 'docs.example.com' }]);
    });

    it('answers 200 { revoked: false } for an already-gone / global entry, not an error', async () => {
      const h = makeRememberedSitesHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.revoke(mkReq({ host: 'operator-wide.example.com' }), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({ revoked: false });
    });

    it('400s an empty :host param', async () => {
      const h = makeRememberedSitesHandlers({ bus, initCtx });
      const { res, captured } = mkRes();
      await h.revoke(mkReq({ host: '' }), res);
      expect(captured.statusCode).toBe(400);
      expect(captured.body).toEqual({ error: 'missing-host' });
      expect(revokeCallInputs).toEqual([]);
    });

    it('401s unauthenticated, and 200 { revoked: false } when the hook is absent', async () => {
      const b1 = new HookBus();
      b1.registerService('auth:require-user', 'auth', async () => {
        throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no cookie' });
      });
      const h1 = makeRememberedSitesHandlers({ bus: b1, initCtx });
      const { res: res1, captured: captured1 } = mkRes();
      await h1.revoke(mkReq({ host: 'docs.example.com' }), res1);
      expect(captured1.statusCode).toBe(401);

      const b2 = new HookBus();
      b2.registerService('auth:require-user', 'auth', async () => ({
        user: { id: 'u1', isAdmin: false },
      }));
      const h2 = makeRememberedSitesHandlers({ bus: b2, initCtx });
      const { res: res2, captured: captured2 } = mkRes();
      await h2.revoke(mkReq({ host: 'docs.example.com' }), res2);
      expect(captured2.statusCode).toBe(200);
      expect(captured2.body).toEqual({ revoked: false });
    });

    it('binds the ctx to the authenticated user — a forged body cannot name an owner', async () => {
      const h = makeRememberedSitesHandlers({ bus, initCtx });
      const { res } = mkRes();
      await h.revoke(mkReq({ host: 'docs.example.com' }), res);
      expect(revokeCallCtxUserIds).toEqual(['u1']);
    });
  });
});
