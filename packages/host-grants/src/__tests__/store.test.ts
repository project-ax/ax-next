import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
  if (container) await container.stop();
});

async function freshStore() {
  const db = makeKysely();
  await runHostGrantsMigration(db);
  return createHostGrantsStore(db);
}

describe('host-grants store', () => {
  it('grant inserts; re-grant of the same host is idempotent (created:false)', async () => {
    const s = await freshStore();
    expect(await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' })).toEqual({
      created: true,
    });
    expect(await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' })).toEqual({
      created: false,
    });
    const hosts = await s.list('u1', 'a1');
    expect(hosts.map((h) => h.host)).toEqual(['x.example.com']);
    expect(typeof hosts[0]?.grantedAt).toBe('string'); // ISO timestamp for the settings mirror (TASK-42)
  });

  it('list is scoped to (user, agent) and ordered by host', async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'b.example.com' });
    await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'a.example.com' });
    await s.grant({ ownerUserId: 'u1', agentId: 'a2', host: 'other.example.com' });
    await s.grant({ ownerUserId: 'u2', agentId: 'a1', host: 'leak.example.com' });
    expect((await s.list('u1', 'a1')).map((h) => h.host)).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  it('revoke deletes only the matching (user, agent, host) row', async () => {
    const s = await freshStore();
    await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' });
    expect(await s.revoke({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' })).toEqual({
      revoked: true,
    });
    expect(await s.revoke({ ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' })).toEqual({
      revoked: false,
    });
    expect(await s.list('u1', 'a1')).toEqual([]);
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

  it('enforces the 256-host cap per (user, agent)', async () => {
    const s = await freshStore();
    for (let i = 0; i < 256; i++)
      await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: `h${i}.example.com` });
    await expect(
      s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'overflow.example.com' }),
    ).rejects.toThrow(/grant-limit|at most 256/i);
    // Re-granting an existing host at the cap is still a no-op, never an error.
    expect(await s.grant({ ownerUserId: 'u1', agentId: 'a1', host: 'h0.example.com' })).toEqual({
      created: false,
    });
    // 257 sequential awaited postgres inserts blow the default 5s timeout under
    // the wide-affected-set CI load (testcontainer pool contention). Give it
    // headroom — this is a throughput test, not a latency one.
  }, 30_000);
});
