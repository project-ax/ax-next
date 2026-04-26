import { randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import type {
  MembershipRow,
  TeamRow,
  TeamsDatabase,
} from './migrations.js';
import { scopedTeams } from './scope.js';
import type { Membership, Team, TeamRole } from './types.js';

const PLUGIN_NAME = '@ax/teams';

// ---------------------------------------------------------------------------
// Validation
//
// All caller-supplied strings are bounded BEFORE INSERT. The DB's CHECK
// constraint enforces role IN ('admin', 'member'); everything else
// (length caps, leading/trailing whitespace) is enforced here because
// length limits don't translate cleanly to SQL TEXT columns.
//
// `team_id` and `user_id` are opaque tokens minted by other plugins
// (auth/agents) — we don't enforce a specific format, just length-cap
// at 256 chars to bound row size.
// ---------------------------------------------------------------------------

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 128;
const ID_MAX = 256;
const VALID_ROLES: ReadonlySet<TeamRole> = new Set(['admin', 'member']);

function invalid(message: string): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    message,
  });
}

export function validateDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalid('displayName must be a string');
  }
  if (value.length < DISPLAY_NAME_MIN || value.length > DISPLAY_NAME_MAX) {
    throw invalid(
      `displayName must be ${DISPLAY_NAME_MIN}-${DISPLAY_NAME_MAX} chars`,
    );
  }
  if (value !== value.trim()) {
    throw invalid('displayName must not have leading or trailing whitespace');
  }
  // Regex check: at least one non-whitespace char. The trim equality above
  // already implies no leading/trailing whitespace; this catches the
  // edge case of an all-whitespace string of length ≥ 1 (which would
  // pass the trim check IF the trim equals itself, but " " trims to "" so
  // it actually fails the trim check — still, be explicit).
  if (!/\S/.test(value)) {
    throw invalid('displayName must contain at least one non-whitespace char');
  }
  return value;
}

export function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw invalid(`${label} must be a string`);
  }
  if (value.length === 0 || value.length > ID_MAX) {
    throw invalid(`${label} must be 1-${ID_MAX} chars`);
  }
  return value;
}

export function validateRole(value: unknown): TeamRole {
  if (value !== 'admin' && value !== 'member') {
    throw invalid("role must be 'admin' or 'member'");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Persistence
//
// We use crypto.randomBytes-derived ids prefixed `team_` rather than
// pulling a `ulid` dep — matches @ax/agents' `agt_` minting and
// @ax/auth's `usr_`. 16 bytes (128 bits) of randomness is collision-free
// for our scale.
// ---------------------------------------------------------------------------

export function mintTeamId(): string {
  return `team_${randomBytes(16).toString('base64url')}`;
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.team_id,
    displayName: row.display_name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function rowToMembership(row: MembershipRow): Membership {
  // The DB CHECK constraint guarantees `role IN ('admin', 'member')`.
  // If a raw-SQL bypass produced something else, refuse rather than
  // surface a corrupt union — same posture as @ax/agents' rowToAgent.
  if (!VALID_ROLES.has(row.role as TeamRole)) {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `teams_v1_memberships row (team='${row.team_id}', user='${row.user_id}') has invalid role`,
    });
  }
  return {
    teamId: row.team_id,
    userId: row.user_id,
    role: row.role as TeamRole,
    joinedAt: row.joined_at,
  };
}

export interface CreateTeamArgs {
  displayName: string;
  createdBy: string;
}

export interface TeamStore {
  /** Look up a single team by id, or null if missing. */
  getById(teamId: string): Promise<Team | null>;

  /**
   * List teams the user is a member of, ordered by joined_at desc.
   * Implementation MUST go through `scopedTeams` (Invariant I7).
   */
  listForUser(userId: string): Promise<Team[]>;

  /**
   * Atomically: insert the team row, then insert a membership row for
   * `createdBy` with role='admin'. If either insert fails, both are
   * rolled back — we never want a team with no admin (that's the
   * "orphan team" failure mode the last-admin guard prevents).
   */
  create(args: CreateTeamArgs): Promise<Team>;

  /**
   * Look up the user's role in a team. Returns null if no membership
   * row exists. Internally hot — used by every authz gate. Single-row
   * primary-key lookup, so it's not a "scoped read" the lint rule cares
   * about (it's targeted, not a list).
   */
  getMembershipRole(teamId: string, userId: string): Promise<TeamRole | null>;

  /**
   * List all members of a team, ordered by joined_at asc. Caller MUST
   * have already verified team-admin authz before calling.
   */
  listMembers(teamId: string): Promise<Membership[]>;

  /**
   * Count admin members of a team. Used by the last-admin guard before
   * removing a membership. SELECT COUNT — bounded query, returns a
   * number ≥ 0.
   */
  countAdmins(teamId: string): Promise<number>;

  /**
   * Insert a membership row. Surfaces a `duplicate-membership`
   * PluginError on PK conflict (postgres SQLSTATE 23505).
   */
  addMembership(args: {
    teamId: string;
    userId: string;
    role: TeamRole;
  }): Promise<Membership>;

  /**
   * Idempotent — a missing row returns false. We DO surface 'not-found'
   * at the hook layer (per the task brief preference for clarity) but
   * the store stays neutral so unit tests can exercise both paths.
   */
  removeMembership(teamId: string, userId: string): Promise<boolean>;
}

export function createTeamStore(db: Kysely<TeamsDatabase>): TeamStore {
  return {
    async getById(teamId) {
      const row = await db
        .selectFrom('teams_v1_teams')
        .selectAll('teams_v1_teams')
        .where('team_id', '=', teamId)
        .executeTakeFirst();
      return row === undefined ? null : rowToTeam(row);
    },

    async listForUser(userId) {
      const rows = await scopedTeams(db, { userId })
        .orderBy('teams_v1_teams.created_at', 'desc')
        .execute();
      return rows.map(rowToTeam);
    },

    async create({ displayName, createdBy }) {
      const teamId = mintTeamId();
      const now = new Date();
      // Transaction: team + creator-membership land together. If the
      // membership insert fails (e.g. db drop mid-flight), the team
      // insert rolls back so we never have an orphan team.
      const team = await db.transaction().execute(async (trx) => {
        const teamRow = await trx
          .insertInto('teams_v1_teams')
          .values({
            team_id: teamId,
            display_name: displayName,
            created_by: createdBy,
            created_at: now,
          })
          .returning(['team_id', 'display_name', 'created_by', 'created_at'])
          .executeTakeFirstOrThrow();
          await trx
            .insertInto('teams_v1_memberships')
            .values({
              team_id: teamId,
              user_id: createdBy,
              role: 'admin',
              joined_at: now,
            })
            .execute();
        return teamRow;
      });
      return rowToTeam(team);
    },

    async getMembershipRole(teamId, userId) {
      const row = await db
        .selectFrom('teams_v1_memberships')
        .select('role')
        .where('team_id', '=', teamId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (row === undefined) return null;
      if (row.role !== 'admin' && row.role !== 'member') {
        throw new PluginError({
          code: 'corrupt-row',
          plugin: PLUGIN_NAME,
          message: `teams_v1_memberships row (team='${teamId}', user='${userId}') has invalid role`,
        });
      }
      return row.role;
    },

    async listMembers(teamId) {
      const rows = await db
        .selectFrom('teams_v1_memberships')
        .selectAll('teams_v1_memberships')
        .where('team_id', '=', teamId)
        .orderBy('joined_at', 'asc')
        .execute();
      return rows.map(rowToMembership);
    },

    async countAdmins(teamId) {
      const row = await db
        .selectFrom('teams_v1_memberships')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('team_id', '=', teamId)
        .where('role', '=', 'admin')
        .executeTakeFirstOrThrow();
      // pg returns count as a string for bigint safety; cap at Number
      // since admin counts are tiny (< 100 per team in practice).
      return Number(row.count);
    },

    async addMembership({ teamId, userId, role }) {
      try {
        const row = await db
          .insertInto('teams_v1_memberships')
          .values({
            team_id: teamId,
            user_id: userId,
            role,
            joined_at: new Date(),
          })
          .returning(['team_id', 'user_id', 'role', 'joined_at'])
          .executeTakeFirstOrThrow();
        return rowToMembership(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new PluginError({
            code: 'duplicate-membership',
            plugin: PLUGIN_NAME,
            message: `user '${userId}' is already a member of team '${teamId}'`,
            cause: err,
          });
        }
        throw err;
      }
    },

    async removeMembership(teamId, userId) {
      const result = await db
        .deleteFrom('teams_v1_memberships')
        .where('team_id', '=', teamId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0n) > 0;
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
