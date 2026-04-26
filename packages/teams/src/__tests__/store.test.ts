import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { PluginError } from '@ax/core';
import { runTeamsMigration, type TeamsDatabase } from '../migrations.js';
import {
  createTeamStore,
  validateDisplayName,
  validateId,
  validateRole,
} from '../store.js';
import { scopedTeams } from '../scope.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<TeamsDatabase>[] = [];

function makeKysely(): Kysely<TeamsDatabase> {
  const k = new Kysely<TeamsDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 4 }),
    }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('teams_v1_memberships').ifExists().execute();
      await k.schema.dropTable('teams_v1_teams').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('validation', () => {
  it('rejects displayName that is empty', () => {
    expect(() => validateDisplayName('')).toThrow(/displayName must be 1-128/);
  });

  it('rejects displayName > 128', () => {
    expect(() => validateDisplayName('x'.repeat(129))).toThrow(
      /displayName must be 1-128/,
    );
  });

  it('rejects displayName with leading whitespace', () => {
    expect(() => validateDisplayName(' Team')).toThrow(
      /leading or trailing whitespace/,
    );
  });

  it('rejects displayName with trailing whitespace', () => {
    expect(() => validateDisplayName('Team ')).toThrow(
      /leading or trailing whitespace/,
    );
  });

  it('rejects displayName that is not a string', () => {
    expect(() => validateDisplayName(123)).toThrow(/must be a string/);
  });

  it('accepts a valid displayName', () => {
    expect(validateDisplayName('My Team')).toBe('My Team');
  });

  it('rejects empty id', () => {
    expect(() => validateId('', 'teamId')).toThrow(/teamId must be 1-256/);
  });

  it('rejects id > 256 chars', () => {
    expect(() => validateId('x'.repeat(257), 'teamId')).toThrow(
      /teamId must be 1-256/,
    );
  });

  it('rejects non-string id', () => {
    expect(() => validateId(undefined, 'teamId')).toThrow(/must be a string/);
  });

  it('rejects bad role', () => {
    expect(() => validateRole('owner')).toThrow(/role must be/);
  });

  it('accepts both valid roles', () => {
    expect(validateRole('admin')).toBe('admin');
    expect(validateRole('member')).toBe('member');
  });
});

describe('store', () => {
  it('create() inserts team + admin membership atomically', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);

    const team = await store.create({
      displayName: 'My Team',
      createdBy: 'u1',
    });
    expect(team.id).toMatch(/^team_/);
    expect(team.displayName).toBe('My Team');
    expect(team.createdBy).toBe('u1');

    // Round-trip the team.
    const round = await store.getById(team.id);
    expect(round?.displayName).toBe('My Team');

    // And the creator membership row landed with role=admin.
    const role = await store.getMembershipRole(team.id, 'u1');
    expect(role).toBe('admin');
  });

  it('getById returns null for a missing team', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);
    expect(await store.getById('team_missing')).toBeNull();
  });

  it('listForUser uses scopedTeams — only returns user-membered teams', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);

    // Two separate teams owned by different creators.
    const t1 = await store.create({
      displayName: 'Alpha',
      createdBy: 'u1',
    });
    const t2 = await store.create({
      displayName: 'Beta',
      createdBy: 'u2',
    });
    // Add u1 as member of t2.
    await store.addMembership({ teamId: t2.id, userId: 'u1', role: 'member' });

    const u1Teams = await store.listForUser('u1');
    expect(u1Teams.map((t) => t.displayName).sort()).toEqual(['Alpha', 'Beta']);

    const u2Teams = await store.listForUser('u2');
    expect(u2Teams.map((t) => t.displayName)).toEqual(['Beta']);

    const ghostTeams = await store.listForUser('u-ghost');
    expect(ghostTeams).toEqual([]);

    // sanity: t1 is unreachable from u-ghost via scopedTeams directly.
    const rows = await scopedTeams(db, { userId: 'u-ghost' }).execute();
    expect(rows).toHaveLength(0);

    // and the listForUser ordering is created_at desc — t1 was created
    // before t2, so for u1 they should come back in [Beta, Alpha] order.
    void t1;
    const ordered = await store.listForUser('u1');
    expect(ordered.map((t) => t.displayName)).toEqual(['Beta', 'Alpha']);
  });

  it('addMembership returns the new row', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);
    const team = await store.create({
      displayName: 'My Team',
      createdBy: 'u1',
    });
    const m = await store.addMembership({
      teamId: team.id,
      userId: 'u2',
      role: 'member',
    });
    expect(m.teamId).toBe(team.id);
    expect(m.userId).toBe('u2');
    expect(m.role).toBe('member');
  });

  it('addMembership surfaces duplicate-membership on PK conflict', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);
    const team = await store.create({
      displayName: 'My Team',
      createdBy: 'u1',
    });
    let caught: unknown;
    try {
      await store.addMembership({
        teamId: team.id,
        userId: 'u1', // already inserted by create() with role=admin
        role: 'member',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('duplicate-membership');
  });

  it('removeMembership is idempotent at the store layer', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);
    const team = await store.create({
      displayName: 'My Team',
      createdBy: 'u1',
    });
    await store.addMembership({
      teamId: team.id,
      userId: 'u2',
      role: 'member',
    });
    expect(await store.removeMembership(team.id, 'u2')).toBe(true);
    expect(await store.removeMembership(team.id, 'u2')).toBe(false);
  });

  it('getMembershipRole returns null when no row exists', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);
    const team = await store.create({
      displayName: 'My Team',
      createdBy: 'u1',
    });
    expect(await store.getMembershipRole(team.id, 'u-ghost')).toBeNull();
  });

  it('listMembers returns rows in joined_at order', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);
    const team = await store.create({
      displayName: 'My Team',
      createdBy: 'u1',
    });
    // u1 already a member from create(); add a couple more.
    await store.addMembership({ teamId: team.id, userId: 'u2', role: 'member' });
    await store.addMembership({ teamId: team.id, userId: 'u3', role: 'admin' });

    const members = await store.listMembers(team.id);
    expect(members.map((m) => m.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(members.find((m) => m.userId === 'u1')?.role).toBe('admin');
    expect(members.find((m) => m.userId === 'u2')?.role).toBe('member');
  });

  it('countAdmins returns the number of admin rows', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);
    const team = await store.create({
      displayName: 'My Team',
      createdBy: 'u1',
    });
    expect(await store.countAdmins(team.id)).toBe(1);
    await store.addMembership({ teamId: team.id, userId: 'u2', role: 'admin' });
    await store.addMembership({ teamId: team.id, userId: 'u3', role: 'member' });
    expect(await store.countAdmins(team.id)).toBe(2);
  });
});
