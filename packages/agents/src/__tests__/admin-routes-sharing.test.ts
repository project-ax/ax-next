import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_BODY_MAX_BYTES } from '../admin-routes.js';
import type {
  AgentInput,
  ListForUserInput,
  ListForUserOutput,
  SharingView,
} from '../types.js';
import {
  bootStack,
  dropAllTables,
  http,
  mintSecondUserCookie,
  query,
  signIn,
  useAdminRoutesPostgres,
  type BootedStack,
  type JsonResponse,
} from './admin-routes-harness.js';

// ---------------------------------------------------------------------------
// TASK-1246 — who can use a personal agent and who owns it, over HTTP:
//   PUT /admin/agents/:id/audience  { kind: 'just-me' | 'everyone' }
//                                   | { kind: 'list', members: [{ type: 'user', id }] }
//   PUT /admin/agents/:id/owners    { userIds } (the creator among them)
//   GET /admin/agents/:id           gains `shared`, `isOwner`, and `sharing` for owners
//   GET /admin/agents               lists only what the caller manages
//
// Only an agent's owners (its creator and co-owners) change either setting.
// Nobody else does: not a plain AX user, not someone the agent is shared
// with (everyone or a list), not a workspace admin. A co-owner is trusted with
// everything else, but can't remove the creator.
//
// The real @ax/http-server (CSRF, body cap), @ax/auth-better (sign-in and
// `auth:get-user`, so the names are real) and Postgres, via the harness.
// "Test Admin" <admin@example.com> signs in as a workspace admin; the others
// are minted plain users.
// ---------------------------------------------------------------------------

useAdminRoutesPostgres();

const TEAM = 'team-1';
const TEAM_AGENT = 'agt_team_1';
const ADMIN_NAME = 'Test Admin';
const ADMIN_EMAIL = 'admin@example.com';

interface SerializedAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  displayName: string;
  shared: boolean;
  isOwner?: boolean;
  sharing?: SharingView;
}

function makeBody(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'Fern',
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'anthropic/claude-opus-4-7',
    visibility: 'personal',
    ...overrides,
  };
}

describe('@ax/agents sharing routes (TASK-1246)', () => {
  let stack: BootedStack;
  /** The users `teams:is-member` puts in team-1. */
  const teamMembers = new Set<string>();

  beforeEach(async () => {
    teamMembers.clear();
    stack = await bootStack({
      'teams:is-member': async (_ctx, input) => {
        const { teamId, userId } = input as { teamId: string; userId: string };
        return teamId === TEAM && teamMembers.has(userId)
          ? { member: true, role: 'member' }
          : { member: false };
      },
    });
  });

  afterEach(async () => {
    if (stack !== undefined) await stack.harness.close({ onError: () => {} });
    await dropAllTables();
  });

  // --- helpers -------------------------------------------------------------

  async function createAgent(
    cookie: string,
    overrides: Partial<AgentInput> = {},
  ): Promise<SerializedAgent> {
    const r = await http(stack.port, 'POST', '/admin/agents', { cookie, body: makeBody(overrides) });
    expect(r.status).toBe(201);
    return (r.body as { agent: SerializedAgent }).agent;
  }

  function putAudience(cookie: string, agentId: string, body: unknown): Promise<JsonResponse> {
    return http(stack.port, 'PUT', `/admin/agents/${agentId}/audience`, { cookie, body });
  }

  function putOwners(cookie: string, agentId: string, body: unknown): Promise<JsonResponse> {
    return http(stack.port, 'PUT', `/admin/agents/${agentId}/owners`, { cookie, body });
  }

  function show(cookie: string, agentId: string): Promise<JsonResponse> {
    return http(stack.port, 'GET', `/admin/agents/${agentId}`, { cookie });
  }

  async function expectOk(pending: Promise<JsonResponse>): Promise<SharingView> {
    const r = await pending;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body as { sharing: SharingView }).sharing;
  }

  /** The sharing settings `cookie`'s owner sees on GET /admin/agents/:id. */
  async function sharingOf(cookie: string, agentId: string): Promise<SharingView> {
    const r = await show(cookie, agentId);
    expect(r.status).toBe(200);
    const { sharing } = (r.body as { agent: SerializedAgent }).agent;
    expect(sharing).toBeDefined();
    return sharing!;
  }

  /** The ids `agents:list-for-user` answers for `userId` (no teams). */
  async function listedFor(userId: string): Promise<string[]> {
    const out = await stack.harness.bus.call<ListForUserInput, ListForUserOutput>(
      'agents:list-for-user',
      stack.harness.ctx(),
      { userId, teamIds: [] },
    );
    return out.agents.map((a) => a.id);
  }

  /** The creator as the settings show them ("Test Admin" signed in by signIn). */
  function adminAsCreator(id: string) {
    return { id, displayName: ADMIN_NAME, email: ADMIN_EMAIL, creator: true };
  }

  // --- who can use it ------------------------------------------------------

  it('audience everyone: another AX user can open the agent and finds it in agents:list-for-user', async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const agent = await createAgent(alice);
    expect(agent).toMatchObject({ shared: false });
    expect((await show(bob.cookie, agent.id)).status).toBe(403);

    const sharing = await expectOk(putAudience(alice, agent.id, { kind: 'everyone' }));
    expect(sharing).toEqual({
      audience: { kind: 'everyone' },
      owners: [adminAsCreator(agent.ownerId)],
    });

    const seen = await show(bob.cookie, agent.id);
    expect(seen.status).toBe(200);
    const bobsView = (seen.body as { agent: SerializedAgent }).agent;
    expect(bobsView).toMatchObject({ id: agent.id, shared: true, isOwner: false });
    expect(bobsView).not.toHaveProperty('sharing');
    expect(await listedFor(bob.userId)).toContain(agent.id);

    const alicesView = (await show(alice, agent.id)).body as { agent: SerializedAgent };
    expect(alicesView.agent).toMatchObject({ shared: true, isOwner: true, sharing });
  });

  it('audience list admits only the listed people, and a new list replaces the old one', async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const carol = await mintSecondUserCookie('Carol Singer');
    const agent = await createAgent(alice);

    await expectOk(putAudience(alice, agent.id, { kind: 'list', members: [{ type: 'user', id: bob.userId }] }));
    expect((await show(bob.cookie, agent.id)).status).toBe(200);
    expect(await listedFor(bob.userId)).toContain(agent.id);
    expect((await show(carol.cookie, agent.id)).status).toBe(403);
    expect(await listedFor(carol.userId)).not.toContain(agent.id);

    await expectOk(putAudience(alice, agent.id, { kind: 'list', members: [{ type: 'user', id: carol.userId }] }));
    expect((await show(carol.cookie, agent.id)).status).toBe(200);
    expect((await show(bob.cookie, agent.id)).status).toBe(403);
    expect(await listedFor(bob.userId)).not.toContain(agent.id);
  });

  // --- only owners change it -------------------------------------------------

  describe('only owners change the audience or the owners', () => {
    it.each([
      ['a plain AX user (the agent is just-me)', 'just-me', 403],
      ["someone in the 'everyone' audience", 'everyone', 200],
      ['someone on the list', 'list', 200],
    ] as const)('%s: 403 forbidden on every write, and nothing changes', async (_label, audience, canOpen) => {
      const alice = await signIn(stack);
      const caller = await mintSecondUserCookie('Mallory');
      const bob = await mintSecondUserCookie('Bob Builder');
      const agent = await createAgent(alice);
      if (audience === 'everyone') await expectOk(putAudience(alice, agent.id, { kind: 'everyone' }));
      if (audience === 'list') {
        await expectOk(
          putAudience(alice, agent.id, { kind: 'list', members: [{ type: 'user', id: caller.userId }] }),
        );
      }
      // The premise: the caller uses the agent exactly when its audience says so.
      expect((await show(caller.cookie, agent.id)).status).toBe(canOpen);
      const before = await sharingOf(alice, agent.id);

      const attempts: Array<['audience' | 'owners', unknown]> = [
        ['audience', { kind: 'everyone' }],
        ['audience', { kind: 'just-me' }],
        ['audience', { kind: 'list', members: [{ type: 'user', id: caller.userId }] }],
        ['owners', { userIds: [agent.ownerId, caller.userId] }],
        ['owners', { userIds: [agent.ownerId, bob.userId] }],
        ['owners', { userIds: [agent.ownerId] }],
        // A body the owner check never gets past: a non-owner learns nothing about it.
        ['audience', { kind: 'friends' }],
        ['owners', { userIds: [caller.userId] }],
      ];
      for (const [route, body] of attempts) {
        const r = await http(stack.port, 'PUT', `/admin/agents/${agent.id}/${route}`, {
          cookie: caller.cookie,
          body,
        });
        expect(r.status, `${route} ${JSON.stringify(body)}`).toBe(403);
        expect(r.body).toEqual({ error: 'forbidden' });
      }

      expect(await sharingOf(alice, agent.id)).toEqual(before);
      expect((await show(caller.cookie, agent.id)).status).toBe(canOpen);
    });

    it.each(['just-me', 'everyone'] as const)(
      "a workspace admin who isn't an owner can't change the audience or the owners (403), even when it is shared with them (%s)",
      async (audience) => {
        const admin = await signIn(stack);
        const adminId = (await createAgent(admin, { displayName: 'Admin Own' })).ownerId;
        const bob = await mintSecondUserCookie('Bob Builder');
        const bobs = await createAgent(bob.cookie);
        if (audience === 'everyone') await expectOk(putAudience(bob.cookie, bobs.id, { kind: 'everyone' }));
        expect((await show(admin, bobs.id)).status).toBe(audience === 'everyone' ? 200 : 403);
        const before = await sharingOf(bob.cookie, bobs.id);

        for (const [route, body] of [
          ['audience', { kind: 'list', members: [{ type: 'user', id: adminId }] }],
          ['audience', { kind: 'just-me' }],
          ['owners', { userIds: [bobs.ownerId, adminId] }],
        ] as const) {
          const r = await http(stack.port, 'PUT', `/admin/agents/${bobs.id}/${route}`, {
            cookie: admin,
            body,
          });
          expect(r.status, `${route} ${JSON.stringify(body)}`).toBe(403);
          expect(r.body).toEqual({ error: 'forbidden' });
        }

        expect(await sharingOf(bob.cookie, bobs.id)).toEqual(before);
      },
    );
  });

  // --- the audience body -------------------------------------------------------

  it.each([
    ['an unknown kind', { kind: 'friends' }],
    ['no kind at all', {}],
    ['a list without members', { kind: 'list' }],
    ['an empty list', { kind: 'list', members: [] }],
    ['a group member (phase 2)', { kind: 'list', members: [{ type: 'group', id: 'g1' }] }],
    ['an extra key', { kind: 'everyone', extra: true }],
    ['an extra key on a member', { kind: 'list', members: [{ type: 'user', id: 'u1', role: 'admin' }] }],
    ['an empty member id', { kind: 'list', members: [{ type: 'user', id: '' }] }],
    ['a member id over 128 characters', { kind: 'list', members: [{ type: 'user', id: 'u'.repeat(129) }] }],
    [
      '51 members',
      { kind: 'list', members: Array.from({ length: 51 }, (_, i) => ({ type: 'user', id: `u${i}` })) },
    ],
    ['a bare string', 'everyone'],
  ])('an unknown audience is refused and nothing changes: %s', async (_label, body) => {
    const alice = await signIn(stack);
    const agent = await createAgent(alice);
    const r = await putAudience(alice, agent.id, body);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid-audience' });
    expect(await sharingOf(alice, agent.id)).toEqual({
      audience: { kind: 'just-me' },
      owners: [adminAsCreator(agent.ownerId)],
    });
  });

  it("listing someone who isn't an AX account → 400 unknown-person with the id, on either route", async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const agent = await createAgent(alice);
    for (const nobody of ['usr_nobody', 'system', 'ownerless:s1']) {
      const listed = await putAudience(alice, agent.id, {
        kind: 'list',
        members: [
          { type: 'user', id: bob.userId },
          { type: 'user', id: nobody },
        ],
      });
      expect(listed.status, nobody).toBe(400);
      expect(listed.body).toEqual({ error: 'unknown-person', id: nobody });

      const owned = await putOwners(alice, agent.id, { userIds: [agent.ownerId, nobody] });
      expect(owned.status, nobody).toBe(400);
      expect(owned.body).toEqual({ error: 'unknown-person', id: nobody });
    }
    expect(await sharingOf(alice, agent.id)).toEqual({
      audience: { kind: 'just-me' },
      owners: [adminAsCreator(agent.ownerId)],
    });
  });

  it('a duplicate person → 400 duplicate-person', async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const agent = await createAgent(alice);
    const r = await putAudience(alice, agent.id, {
      kind: 'list',
      members: [
        { type: 'user', id: bob.userId },
        { type: 'user', id: bob.userId },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'duplicate-person' });
    expect((await sharingOf(alice, agent.id)).audience).toEqual({ kind: 'just-me' });
  });

  // --- owners --------------------------------------------------------------

  it("owners: the creator must stay; adding bob makes him an owner who sees sharing and can PATCH; bob can remove himself; carol can't add herself", async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const carol = await mintSecondUserCookie('Carol Singer');
    const agent = await createAgent(alice);
    const creator = agent.ownerId;

    const withoutCreator = await putOwners(alice, agent.id, { userIds: [bob.userId] });
    expect(withoutCreator.status).toBe(400);
    expect(withoutCreator.body).toEqual({ error: 'creator-required' });

    const added = await expectOk(putOwners(alice, agent.id, { userIds: [creator, bob.userId] }));
    expect(added.owners).toEqual([
      adminAsCreator(creator),
      { id: bob.userId, displayName: 'Bob Builder', email: bob.email, creator: false },
    ]);

    const bobsView = await show(bob.cookie, agent.id);
    expect(bobsView.status).toBe(200);
    // Co-owned is not shared: nobody but its owners uses it.
    expect((bobsView.body as { agent: SerializedAgent }).agent).toMatchObject({
      isOwner: true,
      shared: false,
      sharing: added,
    });
    const renamed = await http(stack.port, 'PATCH', `/admin/agents/${agent.id}`, {
      cookie: bob.cookie,
      body: { displayName: 'Fern by Bob' },
    });
    expect(renamed.status).toBe(200);

    const carolAdds = await putOwners(carol.cookie, agent.id, {
      userIds: [creator, bob.userId, carol.userId],
    });
    expect(carolAdds.status).toBe(403);
    expect(carolAdds.body).toEqual({ error: 'forbidden' });

    const left = await expectOk(putOwners(bob.cookie, agent.id, { userIds: [creator] }));
    expect(left.owners).toEqual([adminAsCreator(creator)]);
    expect((await show(bob.cookie, agent.id)).status).toBe(403);
    expect((await sharingOf(alice, agent.id)).owners).toEqual([adminAsCreator(creator)]);
  });

  it("a co-owner can't remove the creator: 400 creator-required, and the owners stay as they were", async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const carol = await mintSecondUserCookie('Carol Singer');
    const agent = await createAgent(alice);
    await expectOk(putOwners(alice, agent.id, { userIds: [agent.ownerId, bob.userId] }));
    const before = await sharingOf(alice, agent.id);

    for (const userIds of [[bob.userId], [bob.userId, carol.userId], [carol.userId]]) {
      const r = await putOwners(bob.cookie, agent.id, { userIds });
      expect(r.status, JSON.stringify(userIds)).toBe(400);
      expect(r.body).toEqual({ error: 'creator-required' });
    }

    expect(await sharingOf(alice, agent.id)).toEqual(before);
    expect(before.owners.map((o) => o.id)).toEqual([agent.ownerId, bob.userId]);
    expect((await show(carol.cookie, agent.id)).status).toBe(403);
  });

  it('11 owners → 400 invalid-owners; [alice, alice] → 400 duplicate-person', async () => {
    const alice = await signIn(stack);
    const agent = await createAgent(alice);
    const creator = agent.ownerId;

    const eleven = [creator, ...Array.from({ length: 10 }, (_, i) => `usr_extra_${i}`)];
    for (const body of [
      { userIds: eleven },
      { userIds: [] },
      {},
      { userIds: [creator], extra: true },
      { userIds: [creator, ''] },
      { userIds: [creator, 'u'.repeat(129)] },
      { userIds: creator },
    ]) {
      const r = await putOwners(alice, agent.id, body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(r.body).toEqual({ error: 'invalid-owners' });
    }

    const twice = await putOwners(alice, agent.id, { userIds: [creator, creator] });
    expect(twice.status).toBe(400);
    expect(twice.body).toEqual({ error: 'duplicate-person' });

    expect((await sharingOf(alice, agent.id)).owners).toEqual([adminAsCreator(creator)]);
  });

  it('a team agent → 403 team-agent for a member and 403 forbidden for a non-member', async () => {
    const admin = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const carol = await mintSecondUserCookie('Carol Singer');
    teamMembers.add(bob.userId);
    await query(
      `INSERT INTO agents_v1_agents
         (agent_id, owner_id, owner_type, visibility, display_name, allowed_tools, mcp_config_ids, model)
       VALUES ($1, $2, 'team', 'team', 'Team Fern', '["bash.run"]', '[]', 'anthropic/claude-opus-4-7')`,
      [TEAM_AGENT, TEAM],
    );
    const seen = await show(bob.cookie, TEAM_AGENT);
    expect(seen.status).toBe(200);
    const bobsView = (seen.body as { agent: SerializedAgent }).agent;
    expect(bobsView).toMatchObject({ shared: true, isOwner: false });
    expect(bobsView).not.toHaveProperty('sharing');

    const writes = [
      ['audience', { kind: 'everyone' }],
      ['owners', { userIds: [bob.userId] }],
    ] as const;
    for (const [route, body] of writes) {
      const asMember = await http(stack.port, 'PUT', `/admin/agents/${TEAM_AGENT}/${route}`, {
        cookie: bob.cookie,
        body,
      });
      expect(asMember.status, route).toBe(403);
      expect(asMember.body).toEqual({ error: 'team-agent' });
      for (const cookie of [carol.cookie, admin]) {
        const asOutsider = await http(stack.port, 'PUT', `/admin/agents/${TEAM_AGENT}/${route}`, {
          cookie,
          body,
        });
        expect(asOutsider.status, route).toBe(403);
        expect(asOutsider.body).toEqual({ error: 'forbidden' });
      }
    }

    expect(
      await query('SELECT audience FROM agents_v1_agents WHERE agent_id = $1', [TEAM_AGENT]),
    ).toEqual([{ audience: 'just-me' }]);
    expect(await query('SELECT user_id FROM agents_v1_owners WHERE agent_id = $1', [TEAM_AGENT])).toEqual([]);
    expect(
      await query('SELECT member_id FROM agents_v1_audience_members WHERE agent_id = $1', [TEAM_AGENT]),
    ).toEqual([]);
  });

  // --- transport ------------------------------------------------------------

  it('writes keep CSRF: a PUT with no X-Requested-With and no Origin → 403 and nothing changes', async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const agent = await createAgent(alice);
    const before = await sharingOf(alice, agent.id);

    for (const headers of [{}, { origin: 'https://elsewhere.example' }]) {
      const audience = await http(stack.port, 'PUT', `/admin/agents/${agent.id}/audience`, {
        cookie: alice,
        body: { kind: 'everyone' },
        headers,
      });
      expect(audience.status).toBe(403);
      expect(String(audience.body?.error)).toMatch(/^csrf-failed/);
      const owners = await http(stack.port, 'PUT', `/admin/agents/${agent.id}/owners`, {
        cookie: alice,
        body: { userIds: [agent.ownerId, bob.userId] },
        headers,
      });
      expect(owners.status).toBe(403);
      expect(String(owners.body?.error)).toMatch(/^csrf-failed/);
    }

    expect(await sharingOf(alice, agent.id)).toEqual(before);
  });

  it('a body over 64 KiB → 413 and nothing changes', async () => {
    const alice = await signIn(stack);
    const agent = await createAgent(alice);
    const before = await sharingOf(alice, agent.id);
    const pad = 'x'.repeat(ADMIN_BODY_MAX_BYTES);

    const audience = await putAudience(alice, agent.id, { kind: 'everyone', pad });
    expect(audience.status).toBe(413);
    const owners = await putOwners(alice, agent.id, { userIds: [agent.ownerId], pad });
    expect(owners.status).toBe(413);

    expect(await sharingOf(alice, agent.id)).toEqual(before);
  });

  it('signed out → 401; an unknown agent → 404 not-found', async () => {
    const alice = await signIn(stack);
    const agent = await createAgent(alice);
    for (const route of ['audience', 'owners']) {
      const anonymous = await http(stack.port, 'PUT', `/admin/agents/${agent.id}/${route}`, {
        body: route === 'audience' ? { kind: 'everyone' } : { userIds: [agent.ownerId] },
      });
      expect(anonymous.status, route).toBe(401);
      expect(anonymous.body).toEqual({ error: 'unauthenticated' });

      const missing = await http(stack.port, 'PUT', `/admin/agents/agt_nope/${route}`, {
        cookie: alice,
        body: route === 'audience' ? { kind: 'everyone' } : { userIds: [agent.ownerId] },
      });
      expect(missing.status, route).toBe(404);
      expect(missing.body).toEqual({ error: 'not-found' });
    }
    expect((await sharingOf(alice, agent.id)).audience).toEqual({ kind: 'just-me' });
  });

  // --- what the settings pages read ---------------------------------------------

  it('GET /admin/agents lists only agents the caller manages', async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const alices = await createAgent(alice, { displayName: 'Alice Everyone' });
    await expectOk(putAudience(alice, alices.id, { kind: 'everyone' }));
    const bobs = await createAgent(bob.cookie, { displayName: 'Bob Own' });

    // bob may use alice's agent...
    expect(await listedFor(bob.userId)).toEqual(expect.arrayContaining([alices.id, bobs.id]));
    // ...but Settings › Agents lists only the one he manages.
    const before = await http(stack.port, 'GET', '/admin/agents', { cookie: bob.cookie });
    expect(before.status).toBe(200);
    const listed = (before.body as { agents: SerializedAgent[] }).agents;
    expect(listed.map((a) => a.id)).toEqual([bobs.id]);
    expect(listed[0]).toMatchObject({ isOwner: true, shared: false });

    // Once alice makes him an owner, hers is his to manage too.
    await expectOk(putOwners(alice, alices.id, { userIds: [alices.ownerId, bob.userId] }));
    const after = await http(stack.port, 'GET', '/admin/agents', { cookie: bob.cookie });
    const managed = (after.body as { agents: SerializedAgent[] }).agents;
    expect(managed.map((a) => a.id).sort()).toEqual([alices.id, bobs.id].sort());
    expect(managed.find((a) => a.id === alices.id)).toMatchObject({ isOwner: true, shared: true });
  });

  it("the owner's settings payload names people", async () => {
    const alice = await signIn(stack);
    const bob = await mintSecondUserCookie('Bob Builder');
    const carol = await mintSecondUserCookie('Carol Singer');
    const agent = await createAgent(alice);
    await expectOk(
      putAudience(alice, agent.id, {
        kind: 'list',
        members: [
          { type: 'user', id: carol.userId },
          { type: 'user', id: bob.userId },
        ],
      }),
    );
    // The creator leads the owners whatever order the body names them in.
    await expectOk(putOwners(alice, agent.id, { userIds: [bob.userId, agent.ownerId] }));

    const sharing = await sharingOf(alice, agent.id);
    expect(sharing.owners).toEqual([
      { id: agent.ownerId, displayName: ADMIN_NAME, email: ADMIN_EMAIL, creator: true },
      { id: bob.userId, displayName: 'Bob Builder', email: bob.email, creator: false },
    ]);
    expect(sharing.audience.kind).toBe('list');
    const members = sharing.audience.kind === 'list' ? sharing.audience.members : [];
    expect([...members].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { type: 'user', id: carol.userId, displayName: 'Carol Singer', email: carol.email },
        { type: 'user', id: bob.userId, displayName: 'Bob Builder', email: bob.email },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    // A co-owner reads the same settings.
    expect(await sharingOf(bob.cookie, agent.id)).toEqual(sharing);
  });
});
