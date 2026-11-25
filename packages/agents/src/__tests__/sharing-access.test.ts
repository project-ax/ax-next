import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { sql, type Kysely } from 'kysely';
import { createAgentsPlugin } from '../plugin.js';
import type { AgentsDatabase } from '../migrations.js';
import { createSharingStore, type SharingStore } from '../sharing/store.js';
import type {
  Agent,
  AgentInput,
  CreateInput,
  CreateOutput,
  ListForUserInput,
  ListForUserOutput,
  ResolveInput,
  ResolveOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-1246 — who can use a personal agent, end to end through the hooks.
// `agents:resolve` runs `checkAccess`; `agents:list-for-user` runs its SQL
// mirror. They must agree for every agent and every caller (Review Focus 4),
// and `everyone` must never admit an id that isn't an AX account (Review
// Focus 2). The sharing rows are seeded with the real sharing store, on the
// same database the plugin uses.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

/** The AX accounts `auth:get-user` knows. Anyone else is null. */
const ACCOUNTS = ['alice', 'bob', 'carol', 'dave'];

interface Stack {
  db: Kysely<AgentsDatabase>;
  sharing: SharingStore;
  /** Every id `auth:get-user` was asked about, in order. */
  authAsked: string[];
  /** A personal agent created by alice (or a team agent, with `visibility`/`teamId`). */
  create(name: string, input?: Partial<AgentInput>): Promise<string>;
  /** `agents:resolve`'s agent, or `'forbidden'`. */
  resolve(agentId: string, userId: string): Promise<Agent | 'forbidden'>;
  list(userId: string, teamIds?: string[]): Promise<Agent[]>;
}

async function boot(opts: { auth?: boolean } = {}): Promise<Stack> {
  const authAsked: string[] = [];
  const services: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>> = {
    'http:register-route': async () => ({ unregister: () => {} }),
    'auth:require-user': async () => {
      throw new Error('auth:require-user is not used by sharing-access.test.ts');
    },
    'teams:is-member': async (_ctx, raw) => {
      const { teamId } = raw as { teamId: string; userId: string };
      return teamId === 'team-1' ? { member: true, role: 'member' } : { member: false };
    },
  };
  if (opts.auth !== false) {
    services['auth:get-user'] = async (_ctx, raw) => {
      const { userId } = raw as { userId: string };
      authAsked.push(userId);
      return ACCOUNTS.includes(userId)
        ? { id: userId, email: `${userId}@example.com`, displayName: userId, isAdmin: false }
        : null;
    };
  }
  const h = await createTestHarness({
    services,
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAgentsPlugin()],
  });
  harnesses.push(h);
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>('database:get-instance', h.ctx(), {});
  const agentsDb = db as Kysely<AgentsDatabase>;
  const ctxFor = (userId: string) => (userId.length > 0 ? h.ctx({ userId }) : h.ctx());
  return {
    db: agentsDb,
    sharing: createSharingStore(agentsDb),
    authAsked,
    async create(name, input = {}) {
      const out = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctxFor('alice'), {
        actor: { userId: 'alice', isAdmin: false },
        input: {
          displayName: name,
          allowedTools: ['bash.run'],
          mcpConfigIds: [],
          model: 'anthropic/claude-opus-4-7',
          visibility: 'personal',
          ...input,
        },
      });
      return out.agent.id;
    },
    async resolve(agentId, userId) {
      try {
        const out = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctxFor(userId), {
          agentId,
          userId,
        });
        return out.agent;
      } catch (err) {
        if (err instanceof PluginError && err.code === 'forbidden') return 'forbidden';
        throw err;
      }
    },
    async list(userId, teamIds) {
      const input: ListForUserInput = teamIds === undefined ? { userId } : { userId, teamIds };
      const out = await h.bus.call<ListForUserInput, ListForUserOutput>(
        'agents:list-for-user',
        ctxFor(userId),
        input,
      );
      return out.agents;
    },
  };
}

const user = (id: string) => ({ type: 'user' as const, id });

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_identity');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_owners');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_audience_members');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('who can use a personal agent (TASK-1246)', () => {
  it('resolve and list agree for every agent and user', async () => {
    const s = await boot();
    const J = await s.create('J');
    const E = await s.create('E');
    const L = await s.create('L');
    for (const id of [J, E, L]) await s.sharing.setOwners(id, ['alice', 'bob']);
    await s.sharing.setAudience(E, { kind: 'everyone' });
    await s.sharing.setAudience(L, { kind: 'list', members: [user('carol')] });
    const nameOf = new Map([
      [J, 'J'],
      [E, 'E'],
      [L, 'L'],
    ]);

    const USERS = ['alice', 'bob', 'carol', 'dave', 'system', 'ownerless:s1', 'ghost', ''];
    const byResolve: Record<string, string[]> = {};
    const byList: Record<string, string[]> = {};
    const ownedByResolve: Record<string, string[]> = {};
    const ownedByList: Record<string, string[]> = {};
    for (const u of USERS) {
      byResolve[u] = [];
      ownedByResolve[u] = [];
      for (const [id, name] of nameOf) {
        const agent = await s.resolve(id, u);
        if (agent === 'forbidden') continue;
        byResolve[u].push(name);
        // Present on every answer: true or false, never absent.
        expect(typeof agent.isOwner, `${u} ${name}`).toBe('boolean');
        if (agent.isOwner === true) ownedByResolve[u].push(name);
      }
      byResolve[u].sort();
      ownedByResolve[u].sort();
      const listed = await s.list(u);
      for (const a of listed) expect(typeof a.isOwner, `${u} list`).toBe('boolean');
      byList[u] = listed.map((a) => nameOf.get(a.id) ?? a.id).sort();
      ownedByList[u] = listed
        .filter((a) => a.isOwner === true)
        .map((a) => nameOf.get(a.id) ?? a.id)
        .sort();
    }

    expect(byResolve).toEqual({
      alice: ['E', 'J', 'L'],
      bob: ['E', 'J', 'L'],
      carol: ['E', 'L'],
      dave: ['E'],
      system: [],
      'ownerless:s1': [],
      ghost: [],
      '': [],
    });
    expect(byList).toEqual(byResolve);
    expect(ownedByResolve).toEqual({
      alice: ['E', 'J', 'L'],
      bob: ['E', 'J', 'L'],
      carol: [],
      dave: [],
      system: [],
      'ownerless:s1': [],
      ghost: [],
      '': [],
    });
    expect(ownedByList).toEqual(ownedByResolve);

    // `shared` and `audience` ride on the resolve answer.
    expect(await s.resolve(J, 'alice')).toMatchObject({ audience: 'just-me', shared: false, isOwner: true });
    expect(await s.resolve(E, 'dave')).toMatchObject({ audience: 'everyone', shared: true, isOwner: false });
    expect(await s.resolve(L, 'carol')).toMatchObject({ audience: 'list', shared: true, isOwner: false });

    // Neither stand-in was ever looked up as an account.
    expect(s.authAsked).not.toContain('ownerless:s1');
    expect(s.authAsked).not.toContain('');
  });

  it('switching L back to just-me removes carol from resolve and list', async () => {
    const s = await boot();
    const L = await s.create('L');
    await s.sharing.setAudience(L, { kind: 'list', members: [user('carol')] });
    expect(await s.resolve(L, 'carol')).toMatchObject({ id: L, isOwner: false });
    expect((await s.list('carol')).map((a) => a.id)).toEqual([L]);

    await s.sharing.setAudience(L, { kind: 'just-me' });
    expect(await s.resolve(L, 'carol')).toBe('forbidden');
    expect(await s.list('carol')).toEqual([]);
    // Its creator, an owner, keeps it.
    expect(await s.resolve(L, 'alice')).toMatchObject({ id: L, isOwner: true, shared: false });
    expect((await s.list('alice')).map((a) => a.id)).toEqual([L]);
  });

  it('a stray user member row on a just-me agent grants nothing', async () => {
    const s = await boot();
    const J = await s.create('J');
    const E = await s.create('E');
    await s.sharing.setAudience(E, { kind: 'everyone' });
    // Rows a `list` would have written, on agents whose audience isn't `list`.
    // 'ghost' is no AX account, so `everyone` doesn't admit them either.
    await sql`
      INSERT INTO agents_v1_audience_members (agent_id, member_type, member_id)
      VALUES (${J}, 'user', 'dave'), (${E}, 'user', 'ghost')
    `.execute(s.db);
    expect(await s.sharing.callerFacts(J, 'dave')).toEqual({ owner: false, listed: true });

    expect(await s.resolve(J, 'dave')).toBe('forbidden');
    // dave is an AX account, so E (everyone) is his to use; J is not.
    expect((await s.list('dave')).map((a) => a.id)).toEqual([E]);
    expect(await s.resolve(E, 'ghost')).toBe('forbidden');
    expect(await s.list('ghost')).toEqual([]);
  });

  it('a team agent resolves for a member with shared true, isOwner false and no audience; agents:list-for-user returns it only with teamIds', async () => {
    const s = await boot();
    const T = await s.create('T', { visibility: 'team', teamId: 'team-1' });

    for (const u of ['dave', 'alice']) {
      const resolved = await s.resolve(T, u);
      expect(resolved, u).toMatchObject({ id: T, ownerType: 'team', shared: true, isOwner: false });
      expect(resolved, u).not.toHaveProperty('audience');
    }

    expect(await s.list('dave')).toEqual([]);
    const withTeam = await s.list('dave', ['team-1']);
    expect(withTeam.map((a) => a.id)).toEqual([T]);
    expect(withTeam[0]).toMatchObject({ shared: true, isOwner: false });
    expect(withTeam[0]).not.toHaveProperty('audience');
    expect(await s.list('dave', ['team-2'])).toEqual([]);
  });

  it('without auth:get-user, E admits only its owners', async () => {
    const s = await boot({ auth: false });
    const E = await s.create('E');
    await s.sharing.setOwners(E, ['alice', 'bob']);
    await s.sharing.setAudience(E, { kind: 'everyone' });

    expect(await s.resolve(E, 'carol')).toBe('forbidden');
    expect(await s.list('carol')).toEqual([]);
    for (const owner of ['alice', 'bob']) {
      expect(await s.resolve(E, owner), owner).toMatchObject({ id: E, isOwner: true });
      expect((await s.list(owner)).map((a) => a.id), owner).toEqual([E]);
    }
  });

  it('an owner row for an empty user id grants nothing on either hook', async () => {
    // checkAccess refuses an empty id before it reads any row; the list must
    // too, or the two would disagree about this (corrupt) row.
    const s = await boot();
    const J = await s.create('J');
    await sql`INSERT INTO agents_v1_owners (agent_id, user_id) VALUES (${J}, '')`.execute(s.db);
    expect(await s.resolve(J, '')).toBe('forbidden');
    expect(await s.list('')).toEqual([]);
  });
});
