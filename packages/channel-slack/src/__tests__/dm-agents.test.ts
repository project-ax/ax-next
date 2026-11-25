import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDmAgentStore, type DmAgentStore } from '../dm-agents.js';
import { runMigrations, type ChannelSlackDatabase } from '../migrations.js';
import { memoryDmAgentStore } from './memory-dm-agent-store.js';

/*
  Which personal agent answers a person's direct messages to the shared Slack
  app (TASK-1238): one row per AX user. The store answers what is stored and
  nothing more. Whether that agent is still the person's own personal agent
  is the reader's to check, on every read (router.ts). So what is pinned here
  is the shape of the rows: one per person, a second choice replaces the
  first, and a deleted agent's choices go with it (agents-deleted.test.ts
  fires the delete).

  The in-memory copy Tasks 2-3's tests use (memory-dm-agent-store.ts) is held
  to the same answers at the end, so a test on it proves what the real store
  would do.
*/

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<ChannelSlackDatabase>;
let dmAgents: DmAgentStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  // Room for the racing choices below to each hold their own connection.
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });
  db = new Kysely<ChannelSlackDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(db);
  dmAgents = createDmAgentStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE channel_slack_v1_dm_agents`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

const PAT = 'usr_pat';

/** How many rows the table holds for this person, read straight from it. */
async function rowsFor(userId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM channel_slack_v1_dm_agents WHERE user_id = ${userId}
  `.execute(db);
  return r.rows[0]!.n;
}

describe("the store of each person's Slack DM agent choice (TASK-1238)", () => {
  it('get answers null for someone who never chose', async () => {
    await dmAgents.set('usr_mel', 'agt_mels');

    expect(await dmAgents.get(PAT)).toBeNull();
  });

  it('set then get answers the choice; a second set replaces it, one row per person', async () => {
    await dmAgents.set(PAT, 'agt_first');
    expect(await dmAgents.get(PAT)).toBe('agt_first');
    // A day old, so the replace is seen to move it.
    await sql`
      UPDATE channel_slack_v1_dm_agents SET updated_at = now() - interval '1 day' WHERE user_id = ${PAT}
    `.execute(db);

    await dmAgents.set(PAT, 'agt_second');

    expect(await dmAgents.get(PAT)).toBe('agt_second');
    expect(await rowsFor(PAT)).toBe(1);
    const r = await sql<{ moved: boolean }>`
      SELECT updated_at > now() - interval '1 hour' AS moved FROM channel_slack_v1_dm_agents WHERE user_id = ${PAT}
    `.execute(db);
    expect(r.rows[0]?.moved).toBe(true);

    // Choosing the one already chosen is fine, and still one row.
    await dmAgents.set(PAT, 'agt_second');
    expect(await dmAgents.get(PAT)).toBe('agt_second');
    expect(await rowsFor(PAT)).toBe(1);
  });

  it("two people's choices are independent", async () => {
    await dmAgents.set(PAT, 'agt_pats');
    await dmAgents.set('usr_mel', 'agt_mels');
    await dmAgents.set(PAT, 'agt_pats_later');

    expect(await dmAgents.get(PAT)).toBe('agt_pats_later');
    expect(await dmAgents.get('usr_mel')).toBe('agt_mels');
  });

  it('removeForAgent forgets every choice naming the agent and nothing else', async () => {
    await dmAgents.set('usr_a', 'agt_x');
    await dmAgents.set('usr_b', 'agt_x');
    await dmAgents.set('usr_c', 'agt_y');

    expect(await dmAgents.removeForAgent('agt_x')).toBe(2);

    expect(await dmAgents.get('usr_a')).toBeNull();
    expect(await dmAgents.get('usr_b')).toBeNull();
    expect(await dmAgents.get('usr_c')).toBe('agt_y');
    // A second delete event finds nothing.
    expect(await dmAgents.removeForAgent('agt_x')).toBe(0);
  });

  it('of many choices one person makes at once, one row is left, naming one of them', async () => {
    // One statement per choice, so two clicks at once can't make two rows,
    // or fail one of them on the primary key.
    const agents = Array.from({ length: 8 }, (_, i) => `agt_${i}`);

    await Promise.all(agents.map((agentId) => dmAgents.set(PAT, agentId)));

    expect(await rowsFor(PAT)).toBe(1);
    expect(agents).toContain(await dmAgents.get(PAT));
  });

  it('runMigrations twice keeps the table and its rows', async () => {
    await dmAgents.set(PAT, 'agt_kept');

    await runMigrations(db);

    expect(await dmAgents.get(PAT)).toBe('agt_kept');
    expect(await rowsFor(PAT)).toBe(1);
    // The person's key, and the index the agents:deleted cleanup reads by.
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'channel_slack_v1_dm_agents' ORDER BY indexname
    `.execute(db);
    expect(r.rows.map((row) => row.indexname)).toEqual([
      'channel_slack_v1_dm_agents_agent',
      'channel_slack_v1_dm_agents_pkey',
    ]);
  });
});

describe('memoryDmAgentStore, the copy the router and route tests use, keeps the real rules', () => {
  /** The same calls against either store: what each one answered, in order. */
  async function script(store: DmAgentStore): Promise<unknown[]> {
    const answers: unknown[] = [];
    answers.push(await store.get('usr_a'));
    await store.set('usr_a', 'agt_x');
    await store.set('usr_b', 'agt_x');
    await store.set('usr_c', 'agt_y');
    answers.push(await store.get('usr_a'));
    await store.set('usr_a', 'agt_z');
    await store.set('usr_a', 'agt_x');
    answers.push(await store.get('usr_a'));
    answers.push(await store.removeForAgent('agt_x'));
    answers.push(await store.get('usr_a'), await store.get('usr_b'), await store.get('usr_c'));
    answers.push(await store.removeForAgent('agt_x'));
    return answers;
  }

  it('the same calls give the same answers as the store on Postgres', async () => {
    const real = await script(dmAgents);
    const fake = memoryDmAgentStore();

    expect(await script(fake.store)).toEqual(real);
    expect(real).toEqual([null, 'agt_x', 'agt_x', 2, null, null, 'agt_y', 0]);
    expect(fake.rows).toEqual(new Map([['usr_c', 'agt_y']]));
  });

  it('records every call, and a fault rejects the method it names and changes nothing', async () => {
    const m = memoryDmAgentStore();
    // Planted, as a test does.
    m.rows.set(PAT, 'agt_pats');
    const fault = Object.assign(new Error('db down'), { code: 'ECONNRESET' });
    m.faults.get = fault;
    m.faults.set = fault;
    m.faults.removeForAgent = fault;

    await expect(m.store.get(PAT)).rejects.toBe(fault);
    await expect(m.store.set(PAT, 'agt_other')).rejects.toBe(fault);
    await expect(m.store.removeForAgent('agt_pats')).rejects.toBe(fault);

    expect(m.rows).toEqual(new Map([[PAT, 'agt_pats']]));
    expect(m.calls).toEqual([
      { method: 'get', args: [PAT] },
      { method: 'set', args: [PAT, 'agt_other'] },
      { method: 'removeForAgent', args: ['agt_pats'] },
    ]);

    // Cleared, it answers again.
    delete m.faults.get;
    expect(await m.store.get(PAT)).toBe('agt_pats');
  });
});
