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
    // W3e: behaves like @ax/projects' set-member — can't use → not-found, can't
    // manage → forbidden, the owner agent → forbidden, an agent the person
    // doesn't manage (W2's "same owner only") → forbidden.
    bus.registerService('projects:set-member', 'projects', async (ctx, input) => {
      record('projects:set-member', ctx, input);
      const { projectId, agentId, role } = input as { projectId: string; agentId: string; role: 'editor' | 'viewer' | null };
      if (!canUse(ctx.userId, projectId)) throw err('not-found', 'projects:set-member');
      if (!canManageProject(ctx.userId, projectId)) throw err('forbidden', 'projects:set-member');
      const p = projects.get(projectId)!;
      if (p.members.some((m) => m.role === 'owner' && m.agentId === agentId)) throw err('forbidden', 'projects:set-member');
      if (!(MANAGES[ctx.userId] ?? []).includes(agentId)) throw err('forbidden', 'projects:set-member');
      p.members = p.members.filter((m) => m.agentId !== agentId);
      if (role !== null) p.members.push({ agentId, role });
      // A stray field the route must not pass through.
      return { members: p.members.map((m) => ({ ...m, folderId: 'fld_secret' })) };
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

  describe('members (W3e)', () => {
    beforeEach(() => {
      // Alice manages a-team (the owner) and a-alice; both hers, same owner.
      projects.get('prj_1')!.members.push({ agentId: 'a-hidden', role: 'viewer' });
    });

    it('PUT adds one of the person\u2019s agents as the person, answering members with names and no folder id', async () => {
      const { res, captured } = mkRes();
      await h().setProjectMember(mkReq({ projectId: 'prj_1', agentId: 'a-alice' }, { role: 'editor' }), res);
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({
        members: [
          { agentId: 'a-team', role: 'owner', displayName: 'Team agent' },
          { agentId: 'a-hidden', role: 'viewer' },
          { agentId: 'a-alice', role: 'editor', displayName: 'Alice personal' },
        ],
      });
      expect(JSON.stringify(captured.body)).not.toContain('fld_secret');
      expect(JSON.stringify(captured.body)).not.toContain('folderId');
      expect(calls.filter((c) => c.hook === 'projects:set-member')).toEqual([
        { hook: 'projects:set-member', userId: 'u-alice', input: { projectId: 'prj_1', agentId: 'a-alice', role: 'editor' } },
      ]);
    });

    it('PUT changes a role; DELETE removes with role null', async () => {
      projects.get('prj_1')!.members.push({ agentId: 'a-alice', role: 'editor' });
      const change = mkRes();
      await h().setProjectMember(mkReq({ projectId: 'prj_1', agentId: 'a-alice' }, { role: 'viewer' }), change.res);
      expect(change.captured.statusCode).toBe(200);
      expect(projects.get('prj_1')!.members.find((m) => m.agentId === 'a-alice')?.role).toBe('viewer');

      const remove = mkRes();
      await h().removeProjectMember(mkReq({ projectId: 'prj_1', agentId: 'a-alice' }), remove.res);
      expect(remove.captured.statusCode).toBe(200);
      expect((remove.captured.body as { members: Array<{ agentId: string }> }).members.map((m) => m.agentId)).toEqual([
        'a-team',
        'a-hidden',
      ]);
      expect(calls.filter((c) => c.hook === 'projects:set-member').at(-1)?.input).toEqual({
        projectId: 'prj_1',
        agentId: 'a-alice',
        role: null,
      });
    });

    it('the owner agent is refused 403', async () => {
      const put = mkRes();
      await h().setProjectMember(mkReq({ projectId: 'prj_1', agentId: 'a-team' }, { role: 'viewer' }), put.res);
      expect(put.captured).toMatchObject({ statusCode: 403, body: { error: 'forbidden' } });
      const del = mkRes();
      await h().removeProjectMember(mkReq({ projectId: 'prj_1', agentId: 'a-team' }), del.res);
      expect(del.captured).toMatchObject({ statusCode: 403, body: { error: 'forbidden' } });
      expect(projects.get('prj_1')!.members[0]).toEqual({ agentId: 'a-team', role: 'owner' });
    });

    it('a member who can use but not manage the project gets 403', async () => {
      user = 'u-bob';
      const { res, captured } = mkRes();
      await h().setProjectMember(mkReq({ projectId: 'prj_1', agentId: 'a-bob' }, { role: 'editor' }), res);
      expect(captured).toMatchObject({ statusCode: 403, body: { error: 'forbidden' } });
      expect(projects.get('prj_1')!.members.some((m) => m.agentId === 'a-bob')).toBe(false);
    });

    it('an agent the person does not manage (W2 refusal) is a 403', async () => {
      const { res, captured } = mkRes();
      await h().setProjectMember(mkReq({ projectId: 'prj_1', agentId: 'a-bob' }, { role: 'editor' }), res);
      expect(captured).toMatchObject({ statusCode: 403, body: { error: 'forbidden' } });
    });

    it('foreign, missing and oversized projects are the same 404, for PUT and DELETE', async () => {
      user = 'u-eve';
      for (const pick of [(x: ReturnType<typeof h>) => x.setProjectMember, (x: ReturnType<typeof h>) => x.removeProjectMember]) {
        const outs = [];
        for (const projectId of ['prj_1', 'prj_nope', 'p'.repeat(500)]) {
          const { res, captured } = mkRes();
          await pick(h())(mkReq({ projectId, agentId: 'a-alice' }, { role: 'editor' }), res);
          outs.push(captured);
        }
        for (const c of outs) expect(c).toEqual({ statusCode: 404, body: { error: 'project-not-found' }, ended: false });
      }
    });

    it.each([
      ['no role', {}],
      ['role owner', { role: 'owner' }],
      ['role null on PUT (DELETE removes)', { role: null }],
      ['an extra field (strict)', { role: 'editor', userId: 'u-bob' }],
    ])('PUT: 400 for %s, before any hook', async (_n, body) => {
      const { res, captured } = mkRes();
      await h().setProjectMember(mkReq({ projectId: 'prj_1', agentId: 'a-alice' }, body), res);
      expect(captured).toEqual({ statusCode: 400, body: { error: 'invalid-payload' }, ended: false });
      expect(calls).toEqual([]);
    });

    it.each([[''], ['a'.repeat(257)]])('a malformed agent id (%j) is a 400, before any hook', async (agentId) => {
      for (const pick of [(x: ReturnType<typeof h>) => x.setProjectMember, (x: ReturnType<typeof h>) => x.removeProjectMember]) {
        const { res, captured } = mkRes();
        await pick(h())(mkReq({ projectId: 'prj_1', agentId }, { role: 'editor' }), res);
        expect(captured).toEqual({ statusCode: 400, body: { error: 'invalid-payload' }, ended: false });
      }
      expect(calls).toEqual([]);
    });

    it('401 with no hook call past auth', async () => {
      user = null;
      for (const pick of [(x: ReturnType<typeof h>) => x.setProjectMember, (x: ReturnType<typeof h>) => x.removeProjectMember]) {
        const { res, captured } = mkRes();
        await pick(h())(mkReq({ projectId: 'prj_1', agentId: 'a-alice' }, { role: 'editor' }), res);
        expect(captured).toMatchObject({ statusCode: 401, body: { error: 'unauthenticated' } });
      }
      expect(calls).toEqual([]);
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
      ['set-member', mkReq({ projectId: 'prj_1', agentId: 'a-alice' }, { role: 'editor' })],
      ['remove-member', mkReq({ projectId: 'prj_1', agentId: 'a-alice' })],
    ] as const)('%s answers 503 projects-unavailable', async (which, req) => {
      const x = makeProjectsHandlers({ bus: bare, initCtx });
      const fn = {
        create: x.createProject,
        get: x.getProject,
        update: x.updateProject,
        delete: x.deleteProject,
        conversations: x.projectConversations,
        'set-member': x.setProjectMember,
        'remove-member': x.removeProjectMember,
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

  it('registers the fifteen routes, owner-candidates as an exact path, PATCH included, the file splats last', async () => {
    const reg = new HookBus();
    const routes: Array<{ method: string; path: string; maxBodyBytes?: number; bypassCsrf?: boolean }> = [];
    reg.registerService('http:register-route', 'http', async (_c, input) => {
      const { method, path, maxBodyBytes, bypassCsrf } = input as {
        method: string;
        path: string;
        maxBodyBytes?: number;
        bypassCsrf?: boolean;
      };
      routes.push({
        method,
        path,
        ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
        ...(bypassCsrf !== undefined ? { bypassCsrf } : {}),
      });
      return { unregister: () => {} };
    });
    const unregs = await registerProjectsRoutes(reg, initCtx);
    expect(unregs).toHaveLength(15);
    expect(routes).toEqual([
      { method: 'GET', path: '/api/workspace/projects' },
      { method: 'POST', path: '/api/workspace/projects' },
      { method: 'GET', path: '/api/workspace/projects/owner-candidates' },
      { method: 'GET', path: '/api/workspace/projects/:projectId' },
      { method: 'PATCH', path: '/api/workspace/projects/:projectId' },
      { method: 'DELETE', path: '/api/workspace/projects/:projectId' },
      { method: 'GET', path: '/api/workspace/projects/:projectId/conversations' },
      { method: 'PUT', path: '/api/workspace/projects/:projectId/members/:agentId' },
      { method: 'DELETE', path: '/api/workspace/projects/:projectId/members/:agentId' },
      { method: 'GET', path: '/api/workspace/projects/:projectId/files' },
      { method: 'GET', path: '/api/workspace/projects/:projectId/files/*' },
      { method: 'GET', path: '/api/workspace/projects/:projectId/download/*' },
      // W3c: the write's body is the file, so its cap is the 10 MiB file cap.
      // No route opts out of CSRF.
      { method: 'PUT', path: '/api/workspace/projects/:projectId/files/*', maxBodyBytes: 10 * 1024 * 1024 },
      { method: 'DELETE', path: '/api/workspace/projects/:projectId/files/*' },
      { method: 'POST', path: '/api/workspace/projects/:projectId/folders/*' },
    ]);
  });
});
