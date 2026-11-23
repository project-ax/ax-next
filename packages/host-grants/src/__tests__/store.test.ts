import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runHostGrantsMigration, type HostGrantsDatabase } from '../migrations.js';
import { createHostGrantsStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<HostGrantsDatabase>[] = [];
function makeKysely(): Kysely<HostGrantsDatabase> {
  const k = new Kysely<HostGrantsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(k);
  return k;
}
beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);
afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('host_grants_v1_grants').ifExists().execute();
    } catch {
      /* */
    }
    await k.destroy().catch(() => {});
  }
});
afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

async function freshStore() {
  return (await freshDb()).s;
}

/** The store plus its db, for tests that plant rows `grant` no longer writes:
 *  one host under two adders, as rows from before TASK-1212 (or two people
 *  adding it at once) can leave. */
async function freshDb() {
  const db = makeKysely();
  await runHostGrantsMigration(db);
  return { db, s: createHostGrantsStore(db) };
}

// TASK-1212 — an agent's allowed sites belong to the agent. `owner_user_id`
// records who added a row; list, revoke, the duplicate check and the cap are
// keyed by agent. On a team agent that is every member's adds; on a personal
// agent only its owner ever adds, so its list is the owner's.
describe('host-grants store', () => {
  it("list is the agent's: every adder's hosts, once each, ordered by host", async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'mel', agentId: 'agt_team', host: 'b.example.com' });
    await s.grant({ ownerUserId: 'mel', agentId: 'agt_team', host: 'a.example.com' });
    await s.grant({ ownerUserId: 'ada', agentId: 'agt_team', host: 'c.example.com' });
    await s.grant({ ownerUserId: 'mel', agentId: 'agt_other', host: 'z.example.com' });

    expect((await s.list('agt_team')).map((h) => h.host)).toEqual([
      'a.example.com',
      'b.example.com',
      'c.example.com',
    ]);
    expect((await s.list('agt_other')).map((h) => h.host)).toEqual(['z.example.com']);
  });

  it('a host already on the agent is a no-op for anyone', async () => {
    const s = await freshStore();
    expect(await s.grant({ ownerUserId: 'mel', agentId: 'agt_team', host: 'x.example.com' })).toEqual({
      created: true,
    });
    // The person who added it, then a teammate: neither files a second row.
    expect(await s.grant({ ownerUserId: 'mel', agentId: 'agt_team', host: 'x.example.com' })).toEqual({
      created: false,
    });
    expect(await s.grant({ ownerUserId: 'ada', agentId: 'agt_team', host: 'x.example.com' })).toEqual({
      created: false,
    });
    expect(await s.listForUser('ada')).toEqual([]);
  });

  it('rows from before (one host under two adders) read as one site with the earliest grantedAt', async () => {
    const { db, s } = await freshDb();
    // ada's LATER row goes in first, and 'ada' sorts before 'mel', so neither
    // insertion order nor adder order lands on the earliest time by luck.
    await db
      .insertInto('host_grants_v1_grants')
      .values([
        {
          owner_user_id: 'ada',
          agent_id: 'agt_team',
          host: 'x.example.com',
          created_at: new Date('2026-11-02T10:00:00.000Z'),
        },
        {
          owner_user_id: 'mel',
          agent_id: 'agt_team',
          host: 'x.example.com',
          created_at: new Date('2026-11-01T10:00:00.000Z'),
        },
      ])
      .execute();

    expect(await s.list('agt_team')).toEqual([
      { host: 'x.example.com', grantedAt: '2026-11-01T10:00:00.000Z' },
    ]);
  });

  it('revoke takes the host off the agent for everyone, and only on that agent', async () => {
    const { db, s } = await freshDb();
    await s.grant({ ownerUserId: 'mel', agentId: 'agt_team', host: 'x.example.com' });
    await s.grant({ ownerUserId: 'mel', agentId: 'agt_team', host: 'y.example.com' });
    await s.grant({ ownerUserId: 'mel', agentId: 'agt_other', host: 'x.example.com' });
    // ada's own row for the same host, as one from before TASK-1212 would be.
    await db
      .insertInto('host_grants_v1_grants')
      .values({ owner_user_id: 'ada', agent_id: 'agt_team', host: 'x.example.com', created_at: new Date() })
      .execute();

    expect(await s.revoke({ agentId: 'agt_team', host: 'x.example.com' })).toEqual({ revoked: true });

    // Both adders' rows are gone; the agent's other site and the other agent stay.
    expect((await s.list('agt_team')).map((h) => h.host)).toEqual(['y.example.com']);
    expect((await s.list('agt_other')).map((h) => h.host)).toEqual(['x.example.com']);
    expect(await s.revoke({ agentId: 'agt_team', host: 'x.example.com' })).toEqual({ revoked: false });
  });

  it('the 256 cap is per agent, counted once per host whoever added it', async () => {
    const { db, s } = await freshDb();
    const row = (ownerUserId: string, host: string) => ({
      owner_user_id: ownerUserId,
      agent_id: 'agt_team',
      host,
      created_at: new Date(),
    });
    // 255 distinct hosts across two adders, plus ada's own row for one of
    // mel's (as from before TASK-1212): 256 rows, but 255 sites.
    await db
      .insertInto('host_grants_v1_grants')
      .values([
        ...Array.from({ length: 128 }, (_, i) => row('mel', `m${i}.example.com`)),
        ...Array.from({ length: 127 }, (_, i) => row('ada', `a${i}.example.com`)),
        row('ada', 'm0.example.com'),
      ])
      .execute();

    // The duplicate counts once, so a 256th site still fits...
    expect(await s.grant({ ownerUserId: 'ada', agentId: 'agt_team', host: 'last.example.com' })).toEqual({
      created: true,
    });
    // ...and then the agent is full, whoever asks — including someone who has
    // added nothing to it.
    for (const ownerUserId of ['mel', 'ada', 'kit']) {
      await expect(
        s.grant({ ownerUserId, agentId: 'agt_team', host: 'overflow.example.com' }),
      ).rejects.toMatchObject({ code: 'grant-limit' });
    }
    // A site the full agent already has is still a no-op, never an error.
    expect(await s.grant({ ownerUserId: 'kit', agentId: 'agt_team', host: 'm5.example.com' })).toEqual({
      created: false,
    });
    // Another agent has its own cap.
    expect(await s.grant({ ownerUserId: 'mel', agentId: 'agt_other', host: 'overflow.example.com' })).toEqual({
      created: true,
    });
  }, 30_000);

  it("a personal agent's list is exactly what its owner kept (unchanged)", async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'mel', agentId: 'agt_mine', host: 'b.example.com' });
    await s.grant({ ownerUserId: 'mel', agentId: 'agt_mine', host: 'a.example.com' });
    expect((await s.list('agt_mine')).map((h) => h.host)).toEqual(['a.example.com', 'b.example.com']);

    expect(await s.revoke({ agentId: 'agt_mine', host: 'a.example.com' })).toEqual({ revoked: true });
    expect((await s.list('agt_mine')).map((h) => h.host)).toEqual(['b.example.com']);
  });

  it('listForUser returns every grant across the user’s agents (each row carries agentId), owner-scoped', async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'u1', agentId: 'a2', host: 'b.example.com' });
    await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'b.example.com' });
    await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'a.example.com' });
    await s.grant({ ownerUserId: 'u2', agentId: 'a1', host: 'leak.example.com' });

    const rows = await s.listForUser('u1');
    // Ordered host asc, then agentId asc — deterministic for the UI grouping.
    expect(rows.map((r) => ({ host: r.host, agentId: r.agentId }))).toEqual([
      { host: 'a.example.com', agentId: 'a1' },
      { host: 'b.example.com', agentId: 'a1' },
      { host: 'b.example.com', agentId: 'a2' },
    ]);
    expect(typeof rows[0]?.grantedAt).toBe('string');
    // u2's grant never leaks into u1's view.
    expect(rows.some((r) => r.host === 'leak.example.com')).toBe(false);
  });

  it('rejects an invalid host', async () => {
    const s = await freshStore();
    for (const host of [
      '',
      'UPPER.example.com',
      'has space',
      '*.example.com',
      'host:8080',
      'http://x.example.com',
    ]) {
      await expect(s.grant({ ownerUserId: 'u1', agentId: 'a1', host })).rejects.toThrow(
        /invalid host/i,
      );
    }
  });
});

// TASK-718 — deleting an agent must take its rows with it. The store method
// keys on `agent_id` ALONE: a team agent has grants under several owners, and a
// delete scoped to one owner would strand the rest.
describe('host-grants store — deleteAllForAgent (TASK-718)', () => {
  it('deletes the agent’s grants under EVERY owner and leaves other agents’ rows alone', async () => {
    const s = await freshStore();
    for (const [ownerUserId, agentId, host] of [
      ['u1', 'gone', 'a.example.com'],
      ['u1', 'gone', 'b.example.com'],
      // A host of its own: since TASK-1212 a host already on the agent is a
      // no-op for anyone, so u2 adding a.example.com would file no row.
      ['u2', 'gone', 'd.example.com'],
      ['u3', 'gone', 'c.example.com'],
      ['u1', 'kept', 'a.example.com'],
      ['u2', 'kept', 'z.example.com'],
    ] as const) {
      await s.grant({ ownerUserId, agentId, host });
    }

    expect(await s.deleteAllForAgent('gone')).toEqual({ deleted: 4 });

    for (const u of ['u1', 'u2', 'u3']) {
      expect((await s.listForUser(u)).filter((g) => g.agentId === 'gone')).toEqual([]);
    }
    expect((await s.list('kept')).map((h) => h.host)).toEqual(['a.example.com', 'z.example.com']);
  });

  it('is a no-op the second time (nothing left to delete, nothing thrown)', async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'u1', agentId: 'gone', host: 'a.example.com' });
    expect(await s.deleteAllForAgent('gone')).toEqual({ deleted: 1 });
    expect(await s.deleteAllForAgent('gone')).toEqual({ deleted: 0 });
  });

  it('refuses an empty agentId — never runs a delete with an empty key', async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'u1', agentId: 'kept', host: 'a.example.com' });
    for (const bad of ['', undefined as unknown as string, null as unknown as string]) {
      await expect(s.deleteAllForAgent(bad)).rejects.toThrow(/agentId is required/);
    }
    expect((await s.list('kept')).map((h) => h.host)).toEqual(['a.example.com']);
  });
});
