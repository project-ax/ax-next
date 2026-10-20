// @vitest-environment node
/**
 * W3d — a project file's history over HTTP: the version list, one version's
 * preview, and restore. Driven against a real HookBus with stub
 * `projects:file-history` / `read-version` / `restore-version` services that
 * refuse the way `@ax/projects` does: the actor is `ctx.userId`; an unknown
 * project and one the actor can't use are the same `not-found`; a person who
 * can use only viewer agents may read history but restoring is `forbidden`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeProjectsHandlers, registerProjectsRoutes } from '../../server/routes-projects.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

const initCtx: AgentContext = makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' });
const HASH = 'b'.repeat(64);

function mkReq(params: Record<string, string>): RouteRequest {
  return { headers: {}, body: Buffer.alloc(0), cookies: {}, query: {}, params, signedCookie: () => null };
}

interface Captured {
  statusCode: number;
  json: unknown;
}

function mkRes(): { res: RouteResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, json: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.json = v;
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

const refusal = (code: string, hook: string) =>
  new PluginError({ code, reasonCode: code, plugin: 'stub', hookName: hook, message: `${hook}: ${code}` });

/** Alice edits prj_1; Vic can use it only through a viewer agent; Eve uses nothing. */
const ACCESS: Record<string, Record<string, 'edit' | 'view'>> = {
  'u-alice': { prj_1: 'edit' },
  'u-vic': { prj_1: 'view' },
  'u-eve': {},
};

const V = (over: Record<string, unknown>) => ({
  versionId: 'v',
  kind: 'write',
  label: 'edit',
  size: 3,
  tooLarge: false,
  authorUserId: null,
  authorAgentId: null,
  conversationId: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  ...over,
});

const VERSIONS = [
  V({ versionId: 'v6', label: 'restore', authorUserId: 'u-alice', createdAt: '2026-10-18T16:00:00.000Z' }),
  V({ versionId: 'v5', label: 'edit', authorUserId: 'u-bob', createdAt: '2026-10-18T15:00:00.000Z' }),
  V({ versionId: 'v4', label: 'edit', authorUserId: 'u-carol', createdAt: '2026-10-18T14:00:00.000Z' }),
  V({
    versionId: 'v3',
    label: 'agent',
    authorAgentId: 'ag-scout',
    conversationId: 'conv-mine',
    createdAt: '2026-10-18T13:00:00.000Z',
  }),
  V({
    versionId: 'v2',
    label: 'agent',
    authorAgentId: 'ag-hidden',
    conversationId: 'conv-bobs',
    createdAt: '2026-10-18T12:00:00.000Z',
  }),
  V({ versionId: 'v1', label: 'agent', conversationId: null, createdAt: '2026-10-18T11:00:00.000Z' }),
  V({ versionId: 'v0', label: 'baseline', size: 2_000_000, tooLarge: true, createdAt: '2026-10-18T10:00:00.000Z' }),
];

describe('project file history routes (W3d)', () => {
  let bus: HookBus;
  let user: string | null;
  let calls: Array<{ hook: string; userId: string; input: Record<string, unknown> }>;
  let nextRefusal: string | null;

  function gate(hook: string, ctx: AgentContext, input: Record<string, unknown>, needsEdit: boolean): void {
    calls.push({ hook, userId: ctx.userId, input });
    const access = ACCESS[ctx.userId]?.[input.projectId as string];
    if (access === undefined) throw refusal('not-found', hook);
    if (needsEdit && access === 'view') throw refusal('forbidden', hook);
    if (nextRefusal !== null) throw refusal(nextRefusal, hook);
  }

  beforeEach(() => {
    bus = new HookBus();
    user = 'u-alice';
    calls = [];
    nextRefusal = null;
    bus.registerService('auth:require-user', 'auth', async () => {
      if (user === null) throw refusal('unauthenticated', 'auth:require-user');
      return { user: { id: user, isAdmin: false } };
    });
    bus.registerService('projects:file-history', 'projects', async (ctx, input) => {
      gate('projects:file-history', ctx, input as Record<string, unknown>, false);
      return {
        versions: VERSIONS,
        gaps: [{ at: '2026-10-18T12:30:00.000Z', reason: 'snapshot-timeout' }],
      };
    });
    bus.registerService('projects:read-version', 'projects', async (ctx, input) => {
      gate('projects:read-version', ctx, input as Record<string, unknown>, false);
      const id = (input as { versionId: string }).versionId;
      if (id === 'v-bin') return { contents: new Uint8Array([0x00, 0x01, 0x02]), size: 3 };
      if (id === 'v-bidi') return { contents: new TextEncoder().encode('a‮b'), size: 5 };
      if (id !== 'v6') throw refusal('not-found', 'projects:read-version');
      return { contents: new TextEncoder().encode('hello'), size: 5 };
    });
    bus.registerService('projects:restore-version', 'projects', async (ctx, input) => {
      gate('projects:restore-version', ctx, input as Record<string, unknown>, true);
      return { sha256: HASH, folderId: 'fld_secret' };
    });
    bus.registerService('projects:undo-change', 'projects', async (ctx, input) => {
      gate('projects:undo-change', ctx, input as Record<string, unknown>, true);
      return { folderId: 'fld_secret' };
    });
    bus.registerService('agents:list-for-user', 'agents', async () => ({
      agents: [{ id: 'ag-scout', displayName: 'Scout' }],
    }));
    bus.registerService('teams:list-for-user', 'teams', async () => ({ teams: [] }));
    bus.registerService('auth:get-user', 'auth', async (_c, input) => {
      const id = (input as { userId: string }).userId;
      return id === 'u-bob' ? { id, displayName: 'Bob Builder', email: 'bob@example.com' } : null;
    });
    bus.registerService('conversations:list', 'conversations', async (ctx, input) => {
      calls.push({ hook: 'conversations:list', userId: ctx.userId, input: input as Record<string, unknown> });
      return [{ conversationId: 'conv-mine', agentId: 'ag-scout', title: 't', createdAt: '2026-10-18T13:00:00.000Z' }];
    });
  });

  const h = () => makeProjectsHandlers({ bus, initCtx });
  const history = async (projectId: string, splat: string) => {
    const { res, captured } = mkRes();
    await h().projectFileHistory(mkReq({ projectId, '*': splat }), res);
    return captured;
  };
  const preview = async (projectId: string, versionId: string) => {
    const { res, captured } = mkRes();
    await h().projectFileVersion(mkReq({ projectId, versionId }), res);
    return captured;
  };
  const restore = async (projectId: string, versionId: string) => {
    const { res, captured } = mkRes();
    await h().restoreProjectFileVersion(mkReq({ projectId, versionId }), res);
    return captured;
  };

  const undo = async (projectId: string, versionId: string) => {
    const { res, captured } = mkRes();
    await h().undoProjectChange(mkReq({ projectId, versionId }), res);
    return captured;
  };

  describe('authentication', () => {
    it.each([
      ['history', () => history('prj_1', 'work/a.md')],
      ['preview', () => preview('prj_1', 'v6')],
      ['restore', () => restore('prj_1', 'v6')],
      ['undo', () => undo('prj_1', 'v6')],
    ])('%s: 401 with no projects:* call', async (_n, run) => {
      user = null;
      expect(await run()).toMatchObject({ statusCode: 401, json: { error: 'unauthenticated' } });
      expect(calls).toEqual([]);
    });
  });

  describe('GET history/*', () => {
    it('asks as the person, decoding the splat once', async () => {
      const out = await history('prj_1', encodeURIComponent('work/a b.md'));
      expect(out.statusCode).toBe(200);
      expect(calls[0]).toEqual({
        hook: 'projects:file-history',
        userId: 'u-alice',
        input: { projectId: 'prj_1', path: 'work/a b.md' },
      });
    });

    it('names each author without ever carrying another person’s user id', async () => {
      const out = await history('prj_1', 'work/a.md');
      const body = out.json as { versions: Array<Record<string, unknown>>; gaps: unknown[] };
      expect(body.versions.map((v) => [v.versionId, v.author])).toEqual([
        ['v6', { kind: 'you' }],
        ['v5', { kind: 'person', displayName: 'Bob Builder' }],
        ['v4', { kind: 'person', displayName: null }],
        ['v3', { kind: 'agent', displayName: 'Scout', removed: false }],
        // An agent this person can't see stays unnamed, and isn't called removed.
        ['v2', { kind: 'agent', displayName: null, removed: false }],
        ['v1', { kind: 'agent', displayName: null, removed: true }],
        ['v0', { kind: 'none' }],
      ]);
      const raw = JSON.stringify(out.json);
      expect(raw).not.toContain('u-bob');
      expect(raw).not.toContain('u-carol');
      expect(raw).not.toContain('u-alice');
      expect(raw).not.toContain('bob@example.com');
      expect(raw).not.toContain('snapshot-timeout');
    });

    it('links only the person’s own chats in the project', async () => {
      const out = await history('prj_1', 'work/a.md');
      const body = out.json as { versions: Array<{ versionId: string; chat: unknown }> };
      expect(body.versions.find((v) => v.versionId === 'v3')!.chat).toEqual({
        conversationId: 'conv-mine',
        agentId: 'ag-scout',
      });
      expect(body.versions.find((v) => v.versionId === 'v2')!.chat).toBeNull();
      expect(JSON.stringify(out.json)).not.toContain('conv-bobs');
      expect(calls.find((c) => c.hook === 'conversations:list')!.input).toEqual({ userId: 'u-alice', projectId: 'prj_1' });
    });

    it('rebuilds each version field by field, with the gaps', async () => {
      const out = await history('prj_1', 'work/a.md');
      const body = out.json as { versions: Array<Record<string, unknown>>; gaps: unknown[] };
      expect(body.versions[6]).toEqual({
        versionId: 'v0',
        kind: 'write',
        label: 'baseline',
        size: 2_000_000,
        tooLarge: true,
        author: { kind: 'none' },
        chat: null,
        createdAt: '2026-10-18T10:00:00.000Z',
      });
      expect(body.gaps).toEqual([{ at: '2026-10-18T12:30:00.000Z' }]);
    });

    it('a viewer reads history too', async () => {
      user = 'u-vic';
      expect((await history('prj_1', 'work/a.md')).statusCode).toBe(200);
    });

    it('a stranger and an unknown project are the same 404', async () => {
      user = 'u-eve';
      const theirs = await history('prj_1', 'work/a.md');
      const none = await history('prj_nope', 'work/a.md');
      expect(theirs).toEqual({ statusCode: 404, json: { error: 'project-not-found' } });
      expect(none).toEqual(theirs);
    });

    it.each(['', '..%2Fx', 'a%2F..%2F..%2Fx', '%2Fetc%2Fpasswd'])('a bad path %j is a 400 before any lookup', async (splat) => {
      expect(await history('prj_1', splat)).toEqual({ statusCode: 400, json: { error: 'invalid-path' } });
      expect(calls).toEqual([]);
    });

    it('auth:get-user throwing or absent leaves people unnamed; the list still loads', async () => {
      bus = new HookBus();
      bus.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      bus.registerService('projects:file-history', 'projects', async () => ({ versions: VERSIONS.slice(1, 2), gaps: [] }));
      const out = await history('prj_1', 'work/a.md');
      expect(out.statusCode).toBe(200);
      expect((out.json as { versions: Array<{ author: unknown }> }).versions[0]!.author).toEqual({
        kind: 'person',
        displayName: null,
      });
    });

    it('503 without @ax/projects', async () => {
      const bare = new HookBus();
      bare.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      const { res, captured } = mkRes();
      await makeProjectsHandlers({ bus: bare, initCtx }).projectFileHistory(mkReq({ projectId: 'prj_1', '*': 'a.md' }), res);
      expect(captured).toEqual({ statusCode: 503, json: { error: 'projects-unavailable' } });
    });
  });

  describe('GET versions/:versionId', () => {
    it('answers the decoded text, never the raw bytes', async () => {
      const out = await preview('prj_1', 'v6');
      expect(out).toEqual({ statusCode: 200, json: { body: 'hello', clipped: null, size: 5 } });
      expect(calls[0]).toMatchObject({ userId: 'u-alice', input: { projectId: 'prj_1', versionId: 'v6' } });
    });

    it('a binary version is "no preview"', async () => {
      expect(await preview('prj_1', 'v-bin')).toEqual({ statusCode: 200, json: { body: null, clipped: 'binary', size: 3 } });
    });

    it('fences bidi controls like a file preview', async () => {
      const out = await preview('prj_1', 'v-bidi');
      expect((out.json as { body: string }).body).not.toContain('‮');
    });

    it('a viewer can preview', async () => {
      user = 'u-vic';
      expect((await preview('prj_1', 'v6')).statusCode).toBe(200);
    });

    it('a stranger, an unknown project and an unknown version are one 404', async () => {
      const missing = await preview('prj_1', 'v-gone');
      user = 'u-eve';
      const theirs = await preview('prj_1', 'v6');
      const none = await preview('prj_nope', 'v6');
      expect(missing).toEqual({ statusCode: 404, json: { error: 'version-not-found' } });
      expect(theirs).toEqual(missing);
      expect(none).toEqual(missing);
    });

    it('an over-long version id is a 404 with no lookup', async () => {
      expect(await preview('prj_1', 'x'.repeat(129))).toEqual({ statusCode: 404, json: { error: 'version-not-found' } });
      expect(calls).toEqual([]);
    });
  });

  describe('POST versions/:versionId/restore', () => {
    it('restores as the person and answers only the hash', async () => {
      const out = await restore('prj_1', 'v5');
      expect(out).toEqual({ statusCode: 200, json: { sha256: HASH } });
      expect(calls[0]).toEqual({
        hook: 'projects:restore-version',
        userId: 'u-alice',
        input: { projectId: 'prj_1', versionId: 'v5' },
      });
    });

    it('a viewer is a 403; a stranger and an unknown project are one 404', async () => {
      user = 'u-vic';
      expect(await restore('prj_1', 'v5')).toEqual({ statusCode: 403, json: { error: 'forbidden' } });
      user = 'u-eve';
      const theirs = await restore('prj_1', 'v5');
      expect(theirs).toEqual({ statusCode: 404, json: { error: 'version-not-found' } });
      expect(await restore('prj_nope', 'v5')).toEqual(theirs);
    });

    it.each([
      ['not-restorable', 409, 'not-restorable'],
      ['read-only-path', 403, 'read-only-path'],
      ['protected-path', 403, 'protected-path'],
      ['files-unavailable', 503, 'project-files-unavailable'],
      ['too-large', 413, 'file-too-large'],
      ['invalid-payload', 400, 'invalid-payload'],
      ['not-found', 404, 'version-not-found'],
    ])('%s → %i %s', async (code, status, error) => {
      nextRefusal = code;
      expect(await restore('prj_1', 'v5')).toEqual({ statusCode: status, json: { error } });
    });

    it('a real fault is not dressed up as a refusal', async () => {
      const faulty = new HookBus();
      faulty.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      faulty.registerService('projects:restore-version', 'projects', async () => {
        throw new Error('db down');
      });
      const { res } = mkRes();
      await expect(
        makeProjectsHandlers({ bus: faulty, initCtx }).restoreProjectFileVersion(mkReq({ projectId: 'prj_1', versionId: 'v5' }), res),
      ).rejects.toThrow('db down');
    });

    it('is registered CSRF-gated (no bypass)', async () => {
      const reg = new HookBus();
      const routes: Array<Record<string, unknown>> = [];
      reg.registerService('http:register-route', 'http', async (_c, input) => {
        routes.push(input as Record<string, unknown>);
        return { unregister: () => {} };
      });
      await registerProjectsRoutes(reg, initCtx);
      const r = routes.find((x) => x.path === '/api/workspace/projects/:projectId/versions/:versionId/restore');
      expect(r).toMatchObject({ method: 'POST' });
      expect(r!.bypassCsrf).toBeUndefined();
    });
  });

  describe('POST versions/:versionId/undo (W3d-2)', () => {
    it('undoes as the person and answers an empty body (nothing from the hook rides along)', async () => {
      expect(await undo('prj_1', 'v3')).toEqual({ statusCode: 200, json: {} });
      expect(calls).toEqual([
        { hook: 'projects:undo-change', userId: 'u-alice', input: { projectId: 'prj_1', versionId: 'v3' } },
      ]);
    });

    it('a viewer is a 403; a stranger and an unknown project are one 404', async () => {
      user = 'u-vic';
      expect(await undo('prj_1', 'v3')).toEqual({ statusCode: 403, json: { error: 'forbidden' } });
      user = 'u-eve';
      const theirs = await undo('prj_1', 'v3');
      expect(theirs).toEqual({ statusCode: 404, json: { error: 'version-not-found' } });
      expect(await undo('prj_nope', 'v3')).toEqual(theirs);
    });

    it.each([
      ['changed-since', 409, 'changed-since'],
      ['not-undoable', 409, 'not-undoable'],
      ['not-found', 404, 'version-not-found'],
      ['read-only-path', 403, 'read-only-path'],
      ['protected-path', 403, 'protected-path'],
      ['conflict', 409, 'conflict'],
      ['files-unavailable', 503, 'project-files-unavailable'],
      ['invalid-payload', 400, 'invalid-payload'],
    ])('%s → %i %s', async (code, status, error) => {
      nextRefusal = code;
      expect(await undo('prj_1', 'v3')).toEqual({ statusCode: status, json: { error } });
    });

    it('an over-long version id is a 404 with no call', async () => {
      expect(await undo('prj_1', 'x'.repeat(129))).toEqual({ statusCode: 404, json: { error: 'version-not-found' } });
      expect(calls).toEqual([]);
    });

    it('without the hook it is a 503, never a false success', async () => {
      const bare = new HookBus();
      bare.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      const { res, captured } = mkRes();
      await makeProjectsHandlers({ bus: bare, initCtx }).undoProjectChange(
        mkReq({ projectId: 'prj_1', versionId: 'v3' }),
        res,
      );
      expect(captured).toEqual({ statusCode: 503, json: { error: 'projects-unavailable' } });
    });

    it('a real fault is not dressed up as a refusal', async () => {
      const faulty = new HookBus();
      faulty.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      faulty.registerService('projects:undo-change', 'projects', async () => {
        throw new Error('db down');
      });
      const { res } = mkRes();
      await expect(
        makeProjectsHandlers({ bus: faulty, initCtx }).undoProjectChange(mkReq({ projectId: 'prj_1', versionId: 'v3' }), res),
      ).rejects.toThrow('db down');
    });

    it('is registered CSRF-gated (no bypass)', async () => {
      const reg = new HookBus();
      const routes: Array<Record<string, unknown>> = [];
      reg.registerService('http:register-route', 'http', async (_c, input) => {
        routes.push(input as Record<string, unknown>);
        return { unregister: () => {} };
      });
      await registerProjectsRoutes(reg, initCtx);
      const r = routes.find((x) => x.path === '/api/workspace/projects/:projectId/versions/:versionId/undo');
      expect(r).toMatchObject({ method: 'POST' });
      expect(r!.bypassCsrf).toBeUndefined();
    });
  });
});
