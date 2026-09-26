import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { PluginError } from '@ax/core';
import { runTeamsMigration, type TeamsDatabase } from '../migrations.js';
import {
  createTeamStore,
  DISPLAY_NAME_FALLBACK,
  fenceStoredDisplayName,
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
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 60_000);

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
  if (container) await stopPostgresContainer(container);
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

  // TASK-561: every member sees a team's name, so the write door refuses the
  // characters that let a name rewrite the surface it is drawn on. Each entry
  // is one family of the canonical @ax/core/surface-text class.
  it.each([
    ['U+202E RIGHT-TO-LEFT OVERRIDE', 'Payroll \u202Ebad.exe'],
    ['U+202A LEFT-TO-RIGHT EMBEDDING', 'Team \u202Aa'],
    ['U+2066 LEFT-TO-RIGHT ISOLATE', 'Team \u2066a'],
    ['U+2069 POP DIRECTIONAL ISOLATE', 'Team \u2069a'],
    ['U+200E LEFT-TO-RIGHT MARK', 'Team\u200Ea'],
    ['U+061C ARABIC LETTER MARK', 'Team\u061Ca'],
    ['U+200B ZERO WIDTH SPACE', 'Adm\u200Bins'],
    ['U+200D ZERO WIDTH JOINER', 'Adm\u200Dins'],
    ['U+2060 WORD JOINER', 'Adm\u2060ins'],
    ['U+FEFF ZERO WIDTH NO-BREAK SPACE', 'Adm\uFEFFins'],
    // A `.test()` door does no \s collapse, so the separators are really
    // exercised here (unlike a fence that collapses whitespace afterwards).
    ['U+2028 LINE SEPARATOR', 'Team\u2028Admins'],
    ['U+2029 PARAGRAPH SEPARATOR', 'Team\u2029Admins'],
    ['a C0 control (LF)', 'Team\nAdmins'],
    ['a C1 control (U+0085)', 'Team\u0085Admins'],
  ])('rejects displayName carrying %s', (_label, value) => {
    expect(() => validateDisplayName(value)).toThrow(
      /must not contain invisible or text-direction control characters/,
    );
  });

  it('rejects a displayName made only of zero-width characters', () => {
    // `/\S/` matches U+200B, so the whitespace check alone let this through.
    expect(() => validateDisplayName('\u200B\u200B')).toThrow(
      /must not contain invisible or text-direction control characters/,
    );
  });

  it('throws invalid-payload for a forbidden character', () => {
    let caught: unknown;
    try {
      validateDisplayName('Team \u202Ex');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('accepts ordinary non-Latin names', () => {
    expect(validateDisplayName('Équipe 東京')).toBe('Équipe 東京');
    expect(validateDisplayName('فريق المبيعات')).toBe('فريق المبيعات');
  });

  it('the fallback name passes the write door', () => {
    expect(validateDisplayName(DISPLAY_NAME_FALLBACK)).toBe(DISPLAY_NAME_FALLBACK);
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

describe('fenceStoredDisplayName', () => {
  it('turns a run of surface-rewriting characters into one space', () => {
    expect(fenceStoredDisplayName('Payroll\u202E\u2066bad.exe')).toBe('Payroll bad.exe');
  });

  it('collapses whitespace and trims the ends', () => {
    expect(fenceStoredDisplayName('\u200B Payroll \u202E  bad \uFEFF')).toBe('Payroll bad');
  });

  it('falls back when nothing legible survives', () => {
    expect(fenceStoredDisplayName('\u202E\u200B\u2066')).toBe(DISPLAY_NAME_FALLBACK);
  });

  it('leaves an ordinary name alone', () => {
    expect(fenceStoredDisplayName('Équipe 東京')).toBe('Équipe 東京');
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

  // TASK-561: a row written before the write door refused these characters
  // is fenced on every read path, not rewritten in place.
  it('fences a pre-existing displayName carrying a bidi override on read', async () => {
    const db = makeKysely();
    await runTeamsMigration(db);
    const store = createTeamStore(db);
    const team = await store.create({ displayName: 'My Team', createdBy: 'u1' });
    const planted = 'Payroll \u202Ebad.exe';
    await sql`UPDATE teams_v1_teams SET display_name = ${planted} WHERE team_id = ${team.id}`.execute(
      db,
    );
    expect((await store.getById(team.id))!.displayName).toBe('Payroll bad.exe');
    const listed = await store.listForUser('u1');
    expect(listed.find((t) => t.id === team.id)!.displayName).toBe('Payroll bad.exe');
    // The stored bytes are untouched — a read fence, not a migration.
    const raw = await db
      .selectFrom('teams_v1_teams')
      .select('display_name')
      .where('team_id', '=', team.id)
      .executeTakeFirstOrThrow();
    expect(raw.display_name).toBe(planted);
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
