import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runAgentsMigration, type AgentsDatabase } from '../migrations.js';
import { createAgentStore, validateCreateInput, type AgentStore } from '../store.js';
import { createSharingStore, type SharingStore } from '../sharing/store.js';

// TASK-1246 — the owner and audience-member rows behind sharing. Plain storage:
// no ACL, no validation of who may be named (the sharing service does that).

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AgentsDatabase>[] = [];

const ALLOWED = ['anthropic/claude-opus-4-7'];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('agents_v1_identity').ifExists().execute();
      await k.schema.dropTable('agents_v1_owners').ifExists().execute();
      await k.schema.dropTable('agents_v1_audience_members').ifExists().execute();
      await k.schema.dropTable('agents_v1_agents').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

interface Setup {
  db: Kysely<AgentsDatabase>;
  agents: AgentStore;
  sharing: SharingStore;
  /** A personal agent created by `creator`, through the real store. */
  personal(creator: string): Promise<string>;
}

async function setup(): Promise<Setup> {
  const db = new Kysely<AgentsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(db);
  await runAgentsMigration(db);
  const agents = createAgentStore(db);
  return {
    db,
    agents,
    sharing: createSharingStore(db),
    async personal(creator) {
      const agent = await agents.create({
        ownerId: creator,
        ownerType: 'user',
        validated: validateCreateInput(
          {
            displayName: 'Fern',
            allowedTools: ['bash.run'],
            mcpConfigIds: [],
            model: 'anthropic/claude-opus-4-7',
            visibility: 'personal',
          },
          { allowedModels: ALLOWED },
        ),
      });
      return agent.id;
    },
  };
}

/** Every member row of an agent, of any type, straight from the table. */
async function memberRows(db: Kysely<AgentsDatabase>, agentId: string): Promise<string[]> {
  const r = await sql<{ member_type: string; member_id: string }>`
    SELECT member_type, member_id FROM agents_v1_audience_members
     WHERE agent_id = ${agentId} ORDER BY member_type, member_id
  `.execute(db);
  return r.rows.map((m) => `${m.member_type}:${m.member_id}`);
}

async function ownerRows(db: Kysely<AgentsDatabase>, agentId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM agents_v1_owners WHERE agent_id = ${agentId}
  `.execute(db);
  return r.rows[0]!.n;
}

const user = (id: string) => ({ type: 'user' as const, id });

describe('sharing store (TASK-1246)', () => {
  it('callerFacts reports owner and listed separately', async () => {
    const { sharing, personal } = await setup();
    const fern = await personal('alice');
    const other = await personal('alice');
    await sharing.setOwners(fern, ['alice', 'bob']);
    await sharing.setAudience(fern, { kind: 'list', members: [user('bob'), user('carol')] });

    expect(await sharing.callerFacts(fern, 'alice')).toEqual({ owner: true, listed: false });
    expect(await sharing.callerFacts(fern, 'bob')).toEqual({ owner: true, listed: true });
    expect(await sharing.callerFacts(fern, 'carol')).toEqual({ owner: false, listed: true });
    expect(await sharing.callerFacts(fern, 'dave')).toEqual({ owner: false, listed: false });
    // Facts are per agent: carol is listed on Fern only, and bob owns Fern only.
    expect(await sharing.callerFacts(other, 'carol')).toEqual({ owner: false, listed: false });
    expect(await sharing.callerFacts(other, 'bob')).toEqual({ owner: false, listed: false });
  });

  it('setAudience(list) stores the members; setAudience(everyone) and setAudience(just-me) leave no member rows', async () => {
    const { db, agents, sharing, personal } = await setup();
    const fern = await personal('alice');
    const other = await personal('alice');
    await sharing.setAudience(other, { kind: 'list', members: [user('erin')] });

    await sharing.setAudience(fern, { kind: 'list', members: [user('dave'), user('carol')] });
    expect(await sharing.listMembers(fern)).toEqual([user('carol'), user('dave')]);
    expect(await agents.getById(fern)).toMatchObject({ audience: 'list', shared: true });

    // A group row (phase 2 writes these) goes with every other member row.
    await sql`
      INSERT INTO agents_v1_audience_members (agent_id, member_type, member_id)
      VALUES (${fern}, 'group', 'g1')
    `.execute(db);
    await sharing.setAudience(fern, { kind: 'everyone' });
    expect(await memberRows(db, fern)).toEqual([]);
    expect(await agents.getById(fern)).toMatchObject({ audience: 'everyone', shared: true });

    await sharing.setAudience(fern, { kind: 'list', members: [user('carol')] });
    await sharing.setAudience(fern, { kind: 'just-me' });
    expect(await memberRows(db, fern)).toEqual([]);
    expect(await agents.getById(fern)).toMatchObject({ audience: 'just-me', shared: false });

    // Back to a list with someone new: carol, listed before, does not come back.
    await sharing.setAudience(fern, { kind: 'list', members: [user('dave')] });
    expect(await sharing.listMembers(fern)).toEqual([user('dave')]);
    expect(await sharing.callerFacts(fern, 'carol')).toEqual({ owner: false, listed: false });

    // None of this touched the other agent's list.
    expect(await memberRows(db, other)).toEqual(['user:erin']);
  });

  it('setAudience(list) over a list replaces every member row, group rows included', async () => {
    const { db, sharing, personal } = await setup();
    const fern = await personal('alice');
    await sharing.setAudience(fern, { kind: 'list', members: [user('dave'), user('carol')] });
    await sql`
      INSERT INTO agents_v1_audience_members (agent_id, member_type, member_id)
      VALUES (${fern}, 'group', 'g1')
    `.execute(db);

    await sharing.setAudience(fern, { kind: 'list', members: [user('erin')] });
    expect(await memberRows(db, fern)).toEqual(['user:erin']);
  });

  it('setAudience(list) tolerates a member named twice', async () => {
    const { db, sharing, personal } = await setup();
    const fern = await personal('alice');
    await sharing.setAudience(fern, {
      kind: 'list',
      members: [user('carol'), user('dave'), user('carol')],
    });
    expect(await memberRows(db, fern)).toEqual(['user:carol', 'user:dave']);
    expect(await sharing.listMembers(fern)).toEqual([user('carol'), user('dave')]);
  });

  it('setOwners replaces the owner set', async () => {
    const { sharing, personal } = await setup();
    const fern = await personal('zoe');
    const other = await personal('zoe');
    expect(await sharing.listOwners(fern)).toEqual(['zoe']);

    await sharing.setOwners(fern, ['zoe', 'carol', 'adam']);
    // The creator's row is the oldest, so it stays first although 'zoe' sorts
    // last; owners added together follow by id.
    expect(await sharing.listOwners(fern)).toEqual(['zoe', 'adam', 'carol']);

    await sharing.setOwners(fern, ['zoe', 'carol']);
    expect(await sharing.listOwners(fern)).toEqual(['zoe', 'carol']);
    expect(await sharing.callerFacts(fern, 'adam')).toEqual({ owner: false, listed: false });

    expect(await sharing.listOwners(other)).toEqual(['zoe']);
  });

  it('setAudience and setOwners on a deleted agent reject not-found and write no rows', async () => {
    const { db, agents, sharing, personal } = await setup();
    const fern = await personal('alice');
    expect(await agents.deleteById(fern)).toBe(true);

    await expect(
      sharing.setAudience(fern, { kind: 'list', members: [user('carol')] }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(sharing.setOwners(fern, ['alice', 'bob'])).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(await memberRows(db, fern)).toEqual([]);
    expect(await ownerRows(db, fern)).toBe(0);

    await expect(sharing.setAudience('agt_never', { kind: 'everyone' })).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(sharing.setOwners('agt_never', ['alice'])).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(await ownerRows(db, 'agt_never')).toBe(0);
  });

  it('listMembers ignores a raw-inserted group row, and so does callerFacts', async () => {
    const { db, sharing, personal } = await setup();
    const fern = await personal('alice');
    await sharing.setAudience(fern, { kind: 'list', members: [user('carol')] });
    await sql`
      INSERT INTO agents_v1_audience_members (agent_id, member_type, member_id)
      VALUES (${fern}, 'group', 'g1'), (${fern}, 'group', 'dave')
    `.execute(db);

    expect(await sharing.listMembers(fern)).toEqual([user('carol')]);
    expect(await sharing.callerFacts(fern, 'dave')).toEqual({ owner: false, listed: false });
  });
});
