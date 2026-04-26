import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createTeamsPlugin } from '../plugin.js';
import type {
  AddMemberInput,
  AddMemberOutput,
  CreateTeamInput,
  CreateTeamOutput,
  IsMemberInput,
  IsMemberOutput,
  ListForUserInput,
  ListForUserOutput,
  ListMembersInput,
  ListMembersOutput,
  RemoveMemberInput,
  RemoveMemberOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createTeamsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Drop tables between tests to keep cases isolated. Drop memberships
  // first because the prefix-shared name is the cleanup pattern even
  // though we have no FK between them.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS teams_v1_memberships');
    await cleanup.query('DROP TABLE IF EXISTS teams_v1_teams');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('@ax/teams plugin manifest + lifecycle', () => {
  it('manifest matches the documented surface', () => {
    const plugin = createTeamsPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/teams',
      version: '0.0.0',
      registers: [
        'teams:create',
        'teams:list-for-user',
        'teams:is-member',
        'teams:add-member',
        'teams:remove-member',
        'teams:list-members',
      ],
      // database:get-instance is the ONLY hard dep. teams:* hooks are
      // owned by this plugin (registers).
      calls: ['database:get-instance'],
      subscribes: [],
    });
  });

  it('init runs the migration so teams_v1_* tables are reachable', async () => {
    const h = await makeHarness();
    const { sql } = await import('kysely');
    const { db } = await h.bus.call<unknown, { db: import('kysely').Kysely<unknown> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM teams_v1_teams
    `.execute(db);
    expect(result.rows[0]?.count).toBe('0');
    const memCount = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM teams_v1_memberships
    `.execute(db);
    expect(memCount.rows[0]?.count).toBe('0');
  });
});

describe('teams:create', () => {
  it('inserts the team and makes the actor an admin', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        displayName: 'Engineering',
      },
    );
    expect(out.team.id).toMatch(/^team_/);
    expect(out.team.displayName).toBe('Engineering');
    expect(out.team.createdBy).toBe('u1');

    // Verify the creator membership row via teams:is-member.
    const member = await h.bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      h.ctx(),
      { teamId: out.team.id, userId: 'u1' },
    );
    expect(member).toEqual({ member: true, role: 'admin' });
  });

  it('rejects empty displayName', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<CreateTeamInput, CreateTeamOutput>(
        'teams:create',
        h.ctx(),
        { actor: { userId: 'u1' }, displayName: '' },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('rejects displayName with leading whitespace', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<CreateTeamInput, CreateTeamOutput>(
        'teams:create',
        h.ctx(),
        { actor: { userId: 'u1' }, displayName: ' Engineering' },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('invalid-payload');
  });
});

describe('teams:list-for-user', () => {
  it('returns only teams the user belongs to', async () => {
    const h = await makeHarness();
    const t1 = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Alpha' },
    );
    await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u2' }, displayName: 'Beta' },
    );
    // u1 only sees Alpha.
    const u1Teams = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'teams:list-for-user',
      h.ctx(),
      { userId: 'u1' },
    );
    expect(u1Teams.teams.map((t) => t.displayName)).toEqual(['Alpha']);

    // After u1 is added to Beta, list reflects both.
    // Find Beta first.
    const u2Teams = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'teams:list-for-user',
      h.ctx(),
      { userId: 'u2' },
    );
    const beta = u2Teams.teams[0]!;
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      { actor: { userId: 'u2' }, teamId: beta.id, userId: 'u1', role: 'member' },
    );
    const u1Teams2 = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'teams:list-for-user',
      h.ctx(),
      { userId: 'u1' },
    );
    expect(u1Teams2.teams.map((t) => t.displayName).sort()).toEqual([
      'Alpha',
      'Beta',
    ]);
    void t1;
  });

  it('returns empty list for a user with no memberships', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<ListForUserInput, ListForUserOutput>(
      'teams:list-for-user',
      h.ctx(),
      { userId: 'u-ghost' },
    );
    expect(out.teams).toEqual([]);
  });
});

describe('teams:is-member', () => {
  it('returns true + role=admin for the creator', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    const out = await h.bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      h.ctx(),
      { teamId: team.team.id, userId: 'u1' },
    );
    expect(out).toEqual({ member: true, role: 'admin' });
  });

  it('returns true + role=member for a regular member', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
        role: 'member',
      },
    );
    const out = await h.bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      h.ctx(),
      { teamId: team.team.id, userId: 'u2' },
    );
    expect(out).toEqual({ member: true, role: 'member' });
  });

  it('returns false (no role) for non-members', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    const out = await h.bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      h.ctx(),
      { teamId: team.team.id, userId: 'u-ghost' },
    );
    expect(out.member).toBe(false);
    expect(out.role).toBeUndefined();
  });
});

describe('teams:add-member', () => {
  it('admin actor can add members', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    const out = await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
        role: 'member',
      },
    );
    expect(out.membership.userId).toBe('u2');
    expect(out.membership.role).toBe('member');
  });

  it('non-admin actor cannot add members (forbidden)', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    // u2 added as a regular member.
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
        role: 'member',
      },
    );
    // u2 (member, not admin) tries to add u3 — should fail.
    let caught: unknown;
    try {
      await h.bus.call<AddMemberInput, AddMemberOutput>(
        'teams:add-member',
        h.ctx(),
        {
          actor: { userId: 'u2' },
          teamId: team.team.id,
          userId: 'u3',
          role: 'member',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('non-member actor cannot add members (forbidden)', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    let caught: unknown;
    try {
      await h.bus.call<AddMemberInput, AddMemberOutput>(
        'teams:add-member',
        h.ctx(),
        {
          actor: { userId: 'u-stranger' },
          teamId: team.team.id,
          userId: 'u3',
          role: 'member',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('rejects bad role', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    let caught: unknown;
    try {
      await h.bus.call<AddMemberInput, AddMemberOutput>(
        'teams:add-member',
        h.ctx(),
        {
          actor: { userId: 'u1' },
          teamId: team.team.id,
          userId: 'u2',
          role: 'owner' as never,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('surfaces duplicate-membership for the same user added twice', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    let caught: unknown;
    try {
      // u1 was added by create() already.
      await h.bus.call<AddMemberInput, AddMemberOutput>(
        'teams:add-member',
        h.ctx(),
        {
          actor: { userId: 'u1' },
          teamId: team.team.id,
          userId: 'u1',
          role: 'member',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('duplicate-membership');
  });
});

describe('teams:remove-member', () => {
  it('admin actor can remove a member', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
        role: 'member',
      },
    );
    await h.bus.call<RemoveMemberInput, RemoveMemberOutput>(
      'teams:remove-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
      },
    );
    const after = await h.bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      h.ctx(),
      { teamId: team.team.id, userId: 'u2' },
    );
    expect(after.member).toBe(false);
  });

  it('non-admin actor cannot remove members (forbidden)', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
        role: 'member',
      },
    );
    let caught: unknown;
    try {
      await h.bus.call<RemoveMemberInput, RemoveMemberOutput>(
        'teams:remove-member',
        h.ctx(),
        {
          actor: { userId: 'u2' },
          teamId: team.team.id,
          userId: 'u1',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('returns not-found when removing a non-member', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    let caught: unknown;
    try {
      await h.bus.call<RemoveMemberInput, RemoveMemberOutput>(
        'teams:remove-member',
        h.ctx(),
        {
          actor: { userId: 'u1' },
          teamId: team.team.id,
          userId: 'u-ghost',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('not-found');
  });

  it('rejects removing the last admin (cannot-remove-last-admin)', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    let caught: unknown;
    try {
      // u1 is the lone admin; trying to remove themselves orphans the team.
      await h.bus.call<RemoveMemberInput, RemoveMemberOutput>(
        'teams:remove-member',
        h.ctx(),
        {
          actor: { userId: 'u1' },
          teamId: team.team.id,
          userId: 'u1',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('cannot-remove-last-admin');
  });

  it('allows removing an admin when another admin remains', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    // Promote u2 to admin so u1 can step down without orphaning.
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
        role: 'admin',
      },
    );
    await h.bus.call<RemoveMemberInput, RemoveMemberOutput>(
      'teams:remove-member',
      h.ctx(),
      {
        actor: { userId: 'u2' },
        teamId: team.team.id,
        userId: 'u1',
      },
    );
    const u1After = await h.bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      h.ctx(),
      { teamId: team.team.id, userId: 'u1' },
    );
    expect(u1After.member).toBe(false);
  });
});

describe('teams:list-members', () => {
  it('admin actor can list members', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
        role: 'member',
      },
    );
    const out = await h.bus.call<ListMembersInput, ListMembersOutput>(
      'teams:list-members',
      h.ctx(),
      { actor: { userId: 'u1' }, teamId: team.team.id },
    );
    expect(out.members.map((m) => m.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('non-admin actor cannot list members (forbidden)', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    await h.bus.call<AddMemberInput, AddMemberOutput>(
      'teams:add-member',
      h.ctx(),
      {
        actor: { userId: 'u1' },
        teamId: team.team.id,
        userId: 'u2',
        role: 'member',
      },
    );
    let caught: unknown;
    try {
      await h.bus.call<ListMembersInput, ListMembersOutput>(
        'teams:list-members',
        h.ctx(),
        { actor: { userId: 'u2' }, teamId: team.team.id },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('forbidden');
  });

  it('non-member actor cannot list members (forbidden)', async () => {
    const h = await makeHarness();
    const team = await h.bus.call<CreateTeamInput, CreateTeamOutput>(
      'teams:create',
      h.ctx(),
      { actor: { userId: 'u1' }, displayName: 'Eng' },
    );
    let caught: unknown;
    try {
      await h.bus.call<ListMembersInput, ListMembersOutput>(
        'teams:list-members',
        h.ctx(),
        { actor: { userId: 'u-stranger' }, teamId: team.team.id },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('forbidden');
  });
});
