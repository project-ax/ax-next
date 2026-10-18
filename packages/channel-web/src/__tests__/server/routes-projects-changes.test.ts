// @vitest-environment node
/**
 * W3c — people change a project's files over HTTP: PUT (save) and DELETE on
 * `files/*`, and POST on `folders/*`. Driven against a real HookBus with stub
 * `projects:write-file` / `delete-file` / `create-folder` services that refuse
 * the way `@ax/projects` does: the actor is `ctx.userId`; an unknown project
 * and one the actor can't use are the same `not-found`; a person who can use
 * only viewer agents is `forbidden`; and the rule refusals carry their own code.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeProjectsHandlers } from '../../server/routes-projects.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

const initCtx: AgentContext = makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' });
const HASH = 'a'.repeat(64);
const SECRET = 'fld_secret_folder_id';

function mkReq(params: Record<string, string>, headers: Record<string, string> = {}, body: Buffer = Buffer.alloc(0)): RouteRequest {
  return { headers, body, cookies: {}, query: {}, params, signedCookie: () => null };
}

interface Captured {
  statusCode: number;
  json: unknown;
  ended: boolean;
}

function mkRes(): { res: RouteResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, json: undefined, ended: false };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.json = v;
    },
    text() {},
    end() {
      captured.ended = true;
    },
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

describe('project file change routes (W3c)', () => {
  let bus: HookBus;
  let user: string | null;
  let calls: Array<{ hook: string; userId: string; input: Record<string, unknown> }>;
  /** The next refusal the change hooks throw, past the access check. */
  let nextRefusal: string | null;

  function gate(hook: string, ctx: AgentContext, input: Record<string, unknown>): void {
    calls.push({ hook, userId: ctx.userId, input });
    const access = ACCESS[ctx.userId]?.[input.projectId as string];
    if (access === undefined) throw refusal('not-found', hook);
    if (access === 'view') throw refusal('forbidden', hook);
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
    bus.registerService('projects:write-file', 'projects', async (ctx, input) => {
      gate('projects:write-file', ctx, input as Record<string, unknown>);
      return { sha256: HASH, folderId: SECRET };
    });
    bus.registerService('projects:delete-file', 'projects', async (ctx, input) => {
      gate('projects:delete-file', ctx, input as Record<string, unknown>);
      return { folderId: SECRET };
    });
    bus.registerService('projects:create-folder', 'projects', async (ctx, input) => {
      gate('projects:create-folder', ctx, input as Record<string, unknown>);
      return { folderId: SECRET };
    });
  });

  const h = () => makeProjectsHandlers({ bus, initCtx });
  const put = async (projectId: string, splat: string, body: string | Uint8Array, headers: Record<string, string> = {}) => {
    const { res, captured } = mkRes();
    await h().writeProjectFile(mkReq({ projectId, '*': splat }, headers, typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)), res);
    return captured;
  };
  const del = async (projectId: string, splat: string) => {
    const { res, captured } = mkRes();
    await h().deleteProjectFile(mkReq({ projectId, '*': splat }), res);
    return captured;
  };
  const mkdir = async (projectId: string, splat: string) => {
    const { res, captured } = mkRes();
    await h().createProjectFolder(mkReq({ projectId, '*': splat }), res);
    return captured;
  };

  describe('authentication', () => {
    it.each([
      ['PUT', () => put('prj_1', 'work/a.md', 'x')],
      ['DELETE', () => del('prj_1', 'work/a.md')],
      ['POST folder', () => mkdir('prj_1', 'work/new')],
    ])('%s: 401 with no projects:* call', async (_n, run) => {
      user = null;
      const out = await run();
      expect(out).toMatchObject({ statusCode: 401, json: { error: 'unauthenticated' } });
      expect(calls).toEqual([]);
    });
  });

  describe('PUT files/*', () => {
    it('saves the raw body as the person, decoding the splat once, and answers the new hash', async () => {
      const out = await put('prj_1', encodeURIComponent('work/a b.md'), Buffer.from([0x68, 0x69, 0x00, 0xff]));
      expect(out).toMatchObject({ statusCode: 200, json: { sha256: HASH } });
      expect(out.json).toEqual({ sha256: HASH });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.userId).toBe('u-alice');
      expect(calls[0]!.input).toEqual({
        projectId: 'prj_1',
        path: 'work/a b.md',
        content: new Uint8Array([0x68, 0x69, 0x00, 0xff]),
      });
      expect(calls[0]!.input.content).toBeInstanceOf(Uint8Array);
    });

    it('If-Match "<sha256>" is the base hash', async () => {
      await put('prj_1', 'work/a.md', 'x', { 'if-match': `"${HASH}"` });
      expect(calls[0]!.input).toMatchObject({ baseHash: HASH });
      expect(calls[0]!.input).not.toHaveProperty('ifAbsent');
    });

    it('If-None-Match * is create-only', async () => {
      await put('prj_1', 'work/a.md', 'x', { 'if-none-match': '*' });
      expect(calls[0]!.input).toMatchObject({ ifAbsent: true });
      expect(calls[0]!.input).not.toHaveProperty('baseHash');
    });

    it.each([
      ['both', { 'if-match': `"${HASH}"`, 'if-none-match': '*' }],
      ['an unquoted If-Match', { 'if-match': HASH }],
      ['a weak If-Match', { 'if-match': `W/"${HASH}"` }],
      ['an uppercase hash', { 'if-match': `"${HASH.toUpperCase()}"` }],
      ['a short hash', { 'if-match': '"abc"' }],
      ['an If-None-Match tag', { 'if-none-match': `"${HASH}"` }],
    ])('%s: 400 invalid-precondition, no call', async (_n, headers) => {
      const out = await put('prj_1', 'work/a.md', 'x', headers);
      expect(out).toMatchObject({ statusCode: 400, json: { error: 'invalid-precondition' } });
      expect(calls).toEqual([]);
    });

    it.each([
      ['conflict', 409, 'conflict'],
      ['exists', 409, 'exists'],
      ['read-only-path', 403, 'read-only-path'],
      ['protected-path', 403, 'protected-path'],
      ['too-large', 413, 'file-too-large'],
      ['files-unavailable', 503, 'project-files-unavailable'],
      ['invalid-payload', 400, 'invalid-payload'],
    ])('a %s refusal is %i %s', async (code, status, error) => {
      nextRefusal = code;
      const out = await put('prj_1', 'work/a.md', 'x');
      expect(out).toMatchObject({ statusCode: status, json: { error } });
    });
  });

  describe('DELETE files/*', () => {
    it('deletes as the person: 204', async () => {
      const out = await del('prj_1', encodeURIComponent('work/old.md'));
      expect(out).toMatchObject({ statusCode: 204, ended: true });
      expect(calls).toEqual([
        { hook: 'projects:delete-file', userId: 'u-alice', input: { projectId: 'prj_1', path: 'work/old.md' } },
      ]);
    });

    it.each([
      ['protected-path', 403, 'protected-path'],
      ['read-only-path', 403, 'read-only-path'],
      ['files-unavailable', 503, 'project-files-unavailable'],
      // A provider refusal (a non-empty folder, a symlink) arrives as this.
      ['invalid-payload', 400, 'invalid-payload'],
    ])('a %s refusal is %i %s', async (code, status, error) => {
      nextRefusal = code;
      expect(await del('prj_1', 'instructions.md')).toMatchObject({ statusCode: status, json: { error } });
    });

    it('a missing file and a foreign project are the same 404', async () => {
      nextRefusal = 'not-found';
      const missing = await del('prj_1', 'gone.md');
      nextRefusal = null;
      user = 'u-eve';
      const foreign = await del('prj_1', 'gone.md');
      const unknown = await del('prj_nope', 'gone.md');
      for (const out of [missing, foreign, unknown]) {
        expect(out).toMatchObject({ statusCode: 404, json: { error: 'file-not-found' } });
      }
    });
  });

  describe('POST folders/*', () => {
    it('makes the folder as the person: 204', async () => {
      const out = await mkdir('prj_1', encodeURIComponent('work/drafts'));
      expect(out).toMatchObject({ statusCode: 204, ended: true });
      expect(calls).toEqual([
        { hook: 'projects:create-folder', userId: 'u-alice', input: { projectId: 'prj_1', path: 'work/drafts' } },
      ]);
    });

    it('under sources/ is 403 read-only-path', async () => {
      nextRefusal = 'read-only-path';
      expect(await mkdir('prj_1', 'sources/x')).toMatchObject({ statusCode: 403, json: { error: 'read-only-path' } });
    });
  });

  describe('who may', () => {
    it('a person with only viewer agents is 403 forbidden on every change', async () => {
      user = 'u-vic';
      for (const out of [await put('prj_1', 'work/a.md', 'x'), await del('prj_1', 'work/a.md'), await mkdir('prj_1', 'work/n')]) {
        expect(out).toMatchObject({ statusCode: 403, json: { error: 'forbidden' } });
      }
    });

    it('a stranger gets the same 404 as for a project that does not exist', async () => {
      user = 'u-eve';
      const foreign = [await put('prj_1', 'work/a.md', 'x'), await mkdir('prj_1', 'work/n')];
      const unknown = [await put('prj_nope', 'work/a.md', 'x'), await mkdir('prj_nope', 'work/n')];
      expect(foreign.map((c) => [c.statusCode, c.json])).toEqual(unknown.map((c) => [c.statusCode, c.json]));
      expect(foreign[0]).toMatchObject({ statusCode: 404, json: { error: 'project-not-found' } });
    });

    it('an id over the bound is a 404 with no call', async () => {
      expect(await put('p'.repeat(129), 'a.md', 'x')).toMatchObject({ statusCode: 404, json: { error: 'project-not-found' } });
      expect(calls).toEqual([]);
    });
  });

  describe('bad paths', () => {
    it.each(['', '..', '..%2Fsecret', 'work%2F..%2F..%2Fetc', '%2Fetc%2Fpasswd', 'work%2F%2Fa', 'a%00b', 'a'.repeat(4097)])(
      '%j: 400 invalid-path before any call, on every change route',
      async (splat) => {
        for (const out of [await put('prj_1', splat, 'x'), await del('prj_1', splat), await mkdir('prj_1', splat)]) {
          expect(out).toMatchObject({ statusCode: 400, json: { error: 'invalid-path' } });
        }
        expect(calls).toEqual([]);
      },
    );
  });

  describe('without @ax/projects', () => {
    it('every change route answers 503 projects-unavailable', async () => {
      const bare = new HookBus();
      bare.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      const x = makeProjectsHandlers({ bus: bare, initCtx });
      for (const fn of [x.writeProjectFile, x.deleteProjectFile, x.createProjectFolder]) {
        const { res, captured } = mkRes();
        await fn(mkReq({ projectId: 'prj_1', '*': 'work/a.md' }), res);
        expect(captured).toMatchObject({ statusCode: 503, json: { error: 'projects-unavailable' } });
      }
    });
  });

  it('a real fault is not dressed up as a refusal', async () => {
    const b = new HookBus();
    b.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
    b.registerService('projects:write-file', 'projects', async () => {
      throw new Error('nfs down');
    });
    const x = makeProjectsHandlers({ bus: b, initCtx });
    await expect(x.writeProjectFile(mkReq({ projectId: 'prj_1', '*': 'a.md' }), mkRes().res)).rejects.toThrow('nfs down');
  });

  it('the folder id never reaches a response', async () => {
    const outs = [await put('prj_1', 'work/a.md', 'x'), await del('prj_1', 'work/a.md'), await mkdir('prj_1', 'work/n')];
    for (const out of outs) expect(JSON.stringify(out.json ?? null)).not.toContain(SECRET);
  });
});
