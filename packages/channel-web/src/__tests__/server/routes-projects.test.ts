// @vitest-environment node
/**
 * W3a — the project routes (W3 spec §4.8), driven directly against a real
 * HookBus with stub hooks that behave like `@ax/projects`: the actor is
 * `ctx.userId`, an unknown project and one the actor can't use are the same
 * `not-found`, and `forbidden` only when they can use but not manage it.
 *
 * The memory-preset canary covers the same routes over real HTTP + Postgres.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeProjectsHandlers, registerProjectsRoutes } from '../../server/routes-projects.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

const initCtx: AgentContext = makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' });

function mkReq(params: Record<string, string> = {}, body?: unknown, raw?: string): RouteRequest {
  return {
    headers: {},
    body: raw !== undefined ? Buffer.from(raw) : body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

function mkRes() {
  const captured: { statusCode: number; body: unknown; ended: boolean } = { statusCode: 0, body: undefined, ended: false };
  const res: RouteResponse = {
    status(n) {
      captured.statusCode = n;
      return res;
    },
    json(v) {
      captured.body = v;
    },
    text(s) {
      captured.body = s;
    },
    end() {
      captured.ended = true;
    },
  };
  return { res, captured };
}

const err = (code: string, hook: string) => new PluginError({ code, plugin: 'stub', hookName: hook, message: `${hook}: ${code}` });

/**
 * Alice (u-alice) uses + manages agent a-alice and team agent a-team.
 * Bob (u-bob) uses a-team (member, not admin) and his own a-bob.
 * Project prj_1 is owned by a-team. Eve uses nothing.
 */
const USES: Record<string, string[]> = { 'u-alice': ['a-alice', 'a-team'], 'u-bob': ['a-bob', 'a-team'], 'u-eve': [] };
const MANAGES: Record<string, string[]> = { 'u-alice': ['a-alice', 'a-team'], 'u-bob': ['a-bob'], 'u-eve': [] };
const NAMES: Record<string, string> = { 'a-alice': 'Alice personal', 'a-team': 'Team agent', 'a-bob': 'Bob personal' };
const CREATED: Record<string, string> = {
  'a-alice': '2026-01-01T00:00:00.000Z',
  'a-team': '2026-03-01T00:00:00.000Z',
  'a-bob': '2026-02-01T00:00:00.000Z',
};

describe('project routes (W3a)', () => {
  let bus: HookBus;
  let user: string | null;
  let calls: Array<{ hook: string; userId: string; input: unknown }>;
  let projects: Map<string, { name: string; description: string | null; members: Array<{ agentId: string; role: 'owner' | 'editor' | 'viewer' }> }>;
  let conversations: Array<{ conversationId: string; userId: string; agentId: string; title: string | null; lastActivityAt: string | null; createdAt: string; projectId: string | null }>;

  const record = (hook: string, ctx: AgentContext, input: unknown) => calls.push({ hook, userId: ctx.userId, input });
  const canUse = (actor: string, projectId: string) =>
    projects.get(projectId)?.members.some((m) => (USES[actor] ?? []).includes(m.agentId)) === true;
  const canManageProject = (actor: string, projectId: string) =>
    projects.get(projectId)?.members.some((m) => m.role === 'owner' && (MANAGES[actor] ?? []).includes(m.agentId)) === true;

  function registerProjects(): void {
    bus.registerService('projects:list', 'projects', async (ctx, input) => {
      record('projects:list', ctx, input);
      return {
        projects: [...projects.entries()]
          .filter(([id]) => canUse(ctx.userId, id))
          .map(([projectId, p]) => ({
            projectId,
            name: p.name,
            description: p.description,
            updatedAt: '2026-10-16T00:00:00.000Z',
            members: p.members.filter((m) => USES[ctx.userId]!.includes(m.agentId)),
            folderId: 'leak-me-not',
          })),
      };
    });
    bus.registerService('projects:create', 'projects', async (ctx, input) => {
      record('projects:create', ctx, input);
      const { ownerAgentId, name } = input as { ownerAgentId: string; name: string };
      if (name.trim() === '') throw err('invalid-payload', 'projects:create');
      if (!(MANAGES[ctx.userId] ?? []).includes(ownerAgentId)) throw err('forbidden', 'projects:create');
      projects.set('prj_new', { name, description: null, members: [{ agentId: ownerAgentId, role: 'owner' }] });
      return { projectId: 'prj_new', folderId: 'fld_secret' };
    });
    bus.registerService('projects:get', 'projects', async (ctx, input) => {
      record('projects:get', ctx, input);
      const { projectId } = input as { projectId: string };
      if (!canUse(ctx.userId, projectId)) throw err('not-found', 'projects:get');
      const p = projects.get(projectId)!;
      return {
        projectId,
        name: p.name,
        description: p.description,
        folderId: 'fld_secret',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-16T00:00:00.000Z',
        members: p.members,
      };
    });
    bus.registerService('projects:update', 'projects', async (ctx, input) => {
      record('projects:update', ctx, input);
      const { projectId, name } = input as { projectId: string; name?: string };
      if (!canUse(ctx.userId, projectId)) throw err('not-found', 'projects:update');
      if (!canManageProject(ctx.userId, projectId)) throw err('forbidden', 'projects:update');
      const p = projects.get(projectId)!;
      if (name !== undefined) p.name = name;
      return { projectId, name: p.name, description: p.description, updatedAt: '2026-10-17T00:00:00.000Z' };
    });
    bus.registerService('projects:delete', 'projects', async (ctx, input) => {
      record('projects:delete', ctx, input);
      const { projectId } = input as { projectId: string };
      if (!canUse(ctx.userId, projectId)) throw err('not-found', 'projects:delete');
      if (!canManageProject(ctx.userId, projectId)) throw err('forbidden', 'projects:delete');
      projects.delete(projectId);
      return { deleted: true };
    });
  }

  beforeEach(() => {
    bus = new HookBus();
    user = 'u-alice';
    calls = [];
    projects = new Map([
      ['prj_1', { name: 'Q4 launch', description: 'Ship it', members: [{ agentId: 'a-team', role: 'owner' }] }],
    ]);
    conversations = [];
    bus.registerService('auth:require-user', 'auth', async () => {
      if (user === null) throw err('unauthenticated', 'auth:require-user');
      return { user: { id: user, isAdmin: false } };
    });
    bus.registerService('agents:list-for-user', 'agents', async (_ctx, input) => {
      const { userId } = input as { userId: string };
      return {
        agents: (USES[userId] ?? []).map((id) => ({ id, displayName: NAMES[id]!, createdAt: new Date(CREATED[id]!) })),
      };
    });
    bus.registerService('agents:can-manage-sharing', 'agents', async (ctx, input) => {
      record('agents:can-manage-sharing', ctx, input);
      const { agentId } = input as { agentId: string };
      if (NAMES[agentId] === undefined) throw err('not-found', 'agents:can-manage-sharing');
      return { allowed: (MANAGES[ctx.userId] ?? []).includes(agentId) };
    });
    bus.registerService('conversations:list', 'conversations', async (ctx, input) => {
      record('conversations:list', ctx, input);
      const { userId, projectId } = input as { userId: string; projectId?: string };
      return conversations.filter((c) => c.userId === userId && (projectId === undefined || c.projectId === projectId));
    });
    registerProjects();
  });

  const h = () => makeProjectsHandlers({ bus, initCtx });

  describe('authentication', () => {
    const routes: Array<[string, (x: ReturnType<typeof h>) => (req: RouteRequest, res: RouteResponse) => Promise<void>, RouteRequest]> = [
      ['GET list', (x) => x.listProjects, mkReq()],
      ['POST create', (x) => x.createProject, mkReq({}, { name: 'X', ownerAgentId: 'a-alice' })],
      ['GET owner-candidates', (x) => x.ownerCandidates, mkReq()],
      ['GET one', (x) => x.getProject, mkReq({ projectId: 'prj_1' })],
      ['PATCH', (x) => x.updateProject, mkReq({ projectId: 'prj_1' }, { name: 'Y' })],
      ['DELETE', (x) => x.deleteProject, mkReq({ projectId: 'prj_1' })],
      ['GET conversations', (x) => x.projectConversations, mkReq({ projectId: 'prj_1' })],
    ];
    it.each(routes)('%s: 401 with no hook call past auth', async (_n, pick, req) => {
      user = null;
      const { res, captured } = mkRes();
      await pick(h())(req, res);
      expect(captured.statusCode).toBe(401);
      expect(captured.body).toEqual({ error: 'unauthenticated' });
      expect(calls).toEqual([]);
    });
  });

  it('GET /projects lists the projects the person can use, as the person, with no folder id', async () => {
    const { res, captured } = mkRes();
    await h().listProjects(mkReq(), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      projects: [
        {
          projectId: 'prj_1',
          name: 'Q4 launch',
          description: 'Ship it',
          updatedAt: '2026-10-16T00:00:00.000Z',
          members: [{ agentId: 'a-team', role: 'owner' }],
        },
      ],
    });
    expect(calls).toEqual([{ hook: 'projects:list', userId: 'u-alice', input: {} }]);
    user = 'u-eve';
    const eve = mkRes();
    await h().listProjects(mkReq(), eve.res);
    expect(eve.captured.body).toEqual({ projects: [] });
  });

  it('POST /projects creates as the person: 201 { projectId } and nothing else', async () => {
    const { res, captured } = mkRes();
    await h().createProject(mkReq({}, { name: 'Launch', description: 'Why', ownerAgentId: 'a-alice' }), res);
    expect(captured.statusCode).toBe(201);
    expect(captured.body).toEqual({ projectId: 'prj_new' });
    expect(calls).toEqual([
      { hook: 'projects:create', userId: 'u-alice', input: { ownerAgentId: 'a-alice', name: 'Launch', description: 'Why' } },
    ]);
  });

  it('POST /projects: 400 for a non-strict or malformed body, before any hook', async () => {
    for (const req of [
      mkReq({}, { name: 'X', ownerAgentId: 'a-alice', userId: 'u-bob' }),
      mkReq({}, { name: 'X' }),
      mkReq({}, { name: 42, ownerAgentId: 'a-alice' }),
      mkReq({}, undefined, '{not json'),
    ]) {
      const { res, captured } = mkRes();
      await h().createProject(req, res);
      expect(captured.statusCode).toBe(400);
      expect(captured.body).toEqual({ error: 'invalid-payload' });
    }
    expect(calls).toEqual([]);
  });

  it('POST /projects: the hook’s invalid-payload is a 400; a team member who is not admin gets 403', async () => {
    const bad = mkRes();
    await h().createProject(mkReq({}, { name: '   ', ownerAgentId: 'a-alice' }), bad.res);
    expect(bad.captured.statusCode).toBe(400);

    user = 'u-bob';
    const bob = mkRes();
    await h().createProject(mkReq({}, { name: 'Mine', ownerAgentId: 'a-team' }), bob.res);
    expect(bob.captured.statusCode).toBe(403);
    expect(bob.captured.body).toEqual({ error: 'forbidden' });
  });

  it('GET /projects/:id returns members with names, canManage, and no folder id', async () => {
    const { res, captured } = mkRes();
    await h().getProject(mkReq({ projectId: 'prj_1' }), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      projectId: 'prj_1',
      name: 'Q4 launch',
      description: 'Ship it',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
      members: [{ agentId: 'a-team', role: 'owner', displayName: 'Team agent' }],
      canManage: true,
    });
    expect(JSON.stringify(captured.body)).not.toContain('fld_secret');
    // Every projects:* and manage check ran AS the person.
    expect(calls.every((c) => c.userId === 'u-alice')).toBe(true);
  });

  it('GET /projects/:id: a member who can use but not manage sees canManage false', async () => {
    user = 'u-bob';
    const { res, captured } = mkRes();
    await h().getProject(mkReq({ projectId: 'prj_1' }), res);
    expect(captured.statusCode).toBe(200);
    expect((captured.body as { canManage: boolean }).canManage).toBe(false);
  });

  it('an agent the person cannot see is listed without a name', async () => {
    projects.get('prj_1')!.members.push({ agentId: 'a-hidden', role: 'editor' });
    const { res, captured } = mkRes();
    await h().getProject(mkReq({ projectId: 'prj_1' }), res);
    expect((captured.body as { members: unknown[] }).members).toEqual([
      { agentId: 'a-team', role: 'owner', displayName: 'Team agent' },
      { agentId: 'a-hidden', role: 'editor' },
    ]);
  });

  describe('foreign and missing are the same 404', () => {
    const cases: Array<[string, (x: ReturnType<typeof h>) => (req: RouteRequest, res: RouteResponse) => Promise<void>, unknown]> = [
      ['GET', (x) => x.getProject, undefined],
      ['PATCH', (x) => x.updateProject, { name: 'Mine now' }],
      ['DELETE', (x) => x.deleteProject, undefined],
      ['GET conversations', (x) => x.projectConversations, undefined],
    ];
    it.each(cases)('%s', async (_n, pick, body) => {
      user = 'u-eve';
      const foreign = mkRes();
      await pick(h())(mkReq({ projectId: 'prj_1' }, body), foreign.res);
      const missing = mkRes();
      await pick(h())(mkReq({ projectId: 'prj_nope' }, body), missing.res);
      const oversized = mkRes();
      await pick(h())(mkReq({ projectId: 'p'.repeat(500) }, body), oversized.res);
      expect(foreign.captured).toEqual({ statusCode: 404, body: { error: 'project-not-found' }, ended: false });
      expect(missing.captured).toEqual(foreign.captured);
      expect(oversized.captured).toEqual(foreign.captured);
      expect(projects.get('prj_1')!.name).toBe('Q4 launch');
      // The chats list is never read for a project the person can't use.
      expect(calls.some((c) => c.hook === 'conversations:list')).toBe(false);
    });
  });

  it('PATCH renames (200 with the new row); a member who cannot manage gets 403', async () => {
    const ok = mkRes();
    await h().updateProject(mkReq({ projectId: 'prj_1' }, { name: 'Q4 launch v2' }), ok.res);
    expect(ok.captured.statusCode).toBe(200);
    expect(ok.captured.body).toEqual({
      projectId: 'prj_1',
      name: 'Q4 launch v2',
      description: 'Ship it',
      updatedAt: '2026-10-17T00:00:00.000Z',
    });
    expect(calls.at(-1)).toEqual({ hook: 'projects:update', userId: 'u-alice', input: { projectId: 'prj_1', name: 'Q4 launch v2' } });

    user = 'u-bob';
    const bob = mkRes();
    await h().updateProject(mkReq({ projectId: 'prj_1' }, { name: 'Bob was here' }), bob.res);
    expect(bob.captured.statusCode).toBe(403);
    expect(projects.get('prj_1')!.name).toBe('Q4 launch v2');
  });

  it('PATCH: 400 for an empty or non-strict body, before any hook', async () => {
    for (const body of [{}, { name: 'X', projectId: 'prj_other' }, { description: 5 }]) {
      const { res, captured } = mkRes();
      await h().updateProject(mkReq({ projectId: 'prj_1' }, body), res);
      expect(captured.statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('DELETE: 204 for a manager; 403 for a member who cannot manage', async () => {
    user = 'u-bob';
    const bob = mkRes();
    await h().deleteProject(mkReq({ projectId: 'prj_1' }), bob.res);
    expect(bob.captured.statusCode).toBe(403);
    expect(projects.has('prj_1')).toBe(true);

    user = 'u-alice';
    const ok = mkRes();
    await h().deleteProject(mkReq({ projectId: 'prj_1' }), ok.res);
    expect(ok.captured).toEqual({ statusCode: 204, body: undefined, ended: true });
    expect(projects.has('prj_1')).toBe(false);
  });

  it('GET /projects/:id/conversations: gated by projects:get, then only the person’s chats, newest first', async () => {
    conversations = [
      { conversationId: 'c-old', userId: 'u-alice', agentId: 'a-team', title: 'Old', lastActivityAt: null, createdAt: '2026-10-01T00:00:00.000Z', projectId: 'prj_1' },
      { conversationId: 'c-new', userId: 'u-alice', agentId: 'a-team', title: null, lastActivityAt: '2026-10-10T00:00:00.000Z', createdAt: '2026-10-02T00:00:00.000Z', projectId: 'prj_1' },
      { conversationId: 'c-bob', userId: 'u-bob', agentId: 'a-team', title: 'Bob', lastActivityAt: null, createdAt: '2026-10-11T00:00:00.000Z', projectId: 'prj_1' },
      { conversationId: 'c-out', userId: 'u-alice', agentId: 'a-team', title: 'Elsewhere', lastActivityAt: null, createdAt: '2026-10-12T00:00:00.000Z', projectId: null },
    ];
    const { res, captured } = mkRes();
    await h().projectConversations(mkReq({ projectId: 'prj_1' }), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      conversations: [
        { conversationId: 'c-new', agentId: 'a-team', title: null, lastActivityAt: '2026-10-10T00:00:00.000Z' },
        { conversationId: 'c-old', agentId: 'a-team', title: 'Old', lastActivityAt: '2026-10-01T00:00:00.000Z' },
      ],
    });
    expect(calls.map((c) => c.hook)).toEqual(['projects:get', 'conversations:list']);
    expect(calls[1]!.input).toEqual({ userId: 'u-alice', projectId: 'prj_1' });
  });

  describe('owner candidates (Q5)', () => {
    it('only agents the person manages, most recently used first; unused after, newest-created first', async () => {
      // Alice manages a-alice and a-team. Neither used → newest-created first.
      const unused = mkRes();
      await h().ownerCandidates(mkReq(), unused.res);
      expect(unused.captured.body).toEqual({
        agents: [
          { agentId: 'a-team', displayName: 'Team agent' },
          { agentId: 'a-alice', displayName: 'Alice personal' },
        ],
      });
      // She used a-alice most recently → it leads.
      conversations = [
        { conversationId: 'c1', userId: 'u-alice', agentId: 'a-team', title: null, lastActivityAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', projectId: null },
        { conversationId: 'c2', userId: 'u-alice', agentId: 'a-alice', title: null, lastActivityAt: null, createdAt: '2026-10-05T00:00:00.000Z', projectId: null },
      ];
      const used = mkRes();
      await h().ownerCandidates(mkReq(), used.res);
      expect((used.captured.body as { agents: Array<{ agentId: string }> }).agents.map((a) => a.agentId)).toEqual([
        'a-alice',
        'a-team',
      ]);
    });

    it('a team member who is not admin gets only their own agent', async () => {
      user = 'u-bob';
      const { res, captured } = mkRes();
      await h().ownerCandidates(mkReq(), res);
      expect(captured.body).toEqual({ agents: [{ agentId: 'a-bob', displayName: 'Bob personal' }] });
      expect(calls.filter((c) => c.hook === 'agents:can-manage-sharing').every((c) => c.userId === 'u-bob')).toBe(true);
    });

    it('without agents:can-manage-sharing nothing is offered', async () => {
      const bare = new HookBus();
      bare.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      bare.registerService('agents:list-for-user', 'agents', async () => ({ agents: [{ id: 'a-alice', displayName: 'A' }] }));
      const { res, captured } = mkRes();
      await makeProjectsHandlers({ bus: bare, initCtx }).ownerCandidates(mkReq(), res);
      expect(captured.body).toEqual({ agents: [] });
    });
  });

  describe('without @ax/projects', () => {
    let bare: HookBus;
    beforeEach(() => {
      bare = new HookBus();
      bare.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
    });

    it('the list is empty (true: there are none)', async () => {
      const { res, captured } = mkRes();
      await makeProjectsHandlers({ bus: bare, initCtx }).listProjects(mkReq(), res);
      expect(captured).toMatchObject({ statusCode: 200, body: { projects: [] } });
    });

    it.each([
      ['create', mkReq({}, { name: 'X', ownerAgentId: 'a' })],
      ['get', mkReq({ projectId: 'prj_1' })],
      ['update', mkReq({ projectId: 'prj_1' }, { name: 'Y' })],
      ['delete', mkReq({ projectId: 'prj_1' })],
      ['conversations', mkReq({ projectId: 'prj_1' })],
    ] as const)('%s answers 503 projects-unavailable', async (which, req) => {
      const x = makeProjectsHandlers({ bus: bare, initCtx });
      const fn = {
        create: x.createProject,
        get: x.getProject,
        update: x.updateProject,
        delete: x.deleteProject,
        conversations: x.projectConversations,
      }[which];
      const { res, captured } = mkRes();
      await fn(req, res);
      expect(captured).toMatchObject({ statusCode: 503, body: { error: 'projects-unavailable' } });
    });
  });

  it('a real fault is not dressed up as a refusal', async () => {
    const faulty = new HookBus();
    faulty.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
    faulty.registerService('projects:get', 'projects', async () => {
      throw new Error('db down');
    });
    const { res } = mkRes();
    await expect(makeProjectsHandlers({ bus: faulty, initCtx }).getProject(mkReq({ projectId: 'prj_1' }), res)).rejects.toThrow();
  });

  it('registers the seven routes, owner-candidates as an exact path, PATCH included', async () => {
    const reg = new HookBus();
    const routes: Array<{ method: string; path: string }> = [];
    reg.registerService('http:register-route', 'http', async (_c, input) => {
      const { method, path } = input as { method: string; path: string };
      routes.push({ method, path });
      return { unregister: () => {} };
    });
    const unregs = await registerProjectsRoutes(reg, initCtx);
    expect(unregs).toHaveLength(7);
    expect(routes).toEqual([
      { method: 'GET', path: '/api/workspace/projects' },
      { method: 'POST', path: '/api/workspace/projects' },
      { method: 'GET', path: '/api/workspace/projects/owner-candidates' },
      { method: 'GET', path: '/api/workspace/projects/:projectId' },
      { method: 'PATCH', path: '/api/workspace/projects/:projectId' },
      { method: 'DELETE', path: '/api/workspace/projects/:projectId' },
      { method: 'GET', path: '/api/workspace/projects/:projectId/conversations' },
    ]);
  });
});
