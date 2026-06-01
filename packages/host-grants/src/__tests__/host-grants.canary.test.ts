import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createHostGrantsPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
async function boot() {
  const h = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), createHostGrantsPlugin()],
  });
  harnesses.push(h);
  return h;
}
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query('DROP TABLE IF EXISTS host_grants_v1_grants');
  } finally {
    await c.end().catch(() => {});
  }
});
afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('host-grants canary', () => {
  it('grant → list → revoke is durable and (user, agent)-scoped', async () => {
    const h = await boot();
    await h.bus.call('host-grants:grant', h.ctx(), {
      ownerUserId: 'u1',
      agentId: 'a1',
      host: 'status.example.com',
    });
    await h.bus.call('host-grants:grant', h.ctx(), {
      ownerUserId: 'u1',
      agentId: 'a1',
      host: 'api.linear.app',
    });
    // Another agent / another user never see u1/a1's grants.
    await h.bus.call('host-grants:grant', h.ctx(), {
      ownerUserId: 'u1',
      agentId: 'a2',
      host: 'other.example.com',
    });

    const listed = await h.bus.call('host-grants:list', h.ctx(), { ownerUserId: 'u1', agentId: 'a1' });
    expect((listed as { hosts: { host: string }[] }).hosts.map((x) => x.host)).toEqual([
      'api.linear.app',
      'status.example.com',
    ]);

    expect(
      await h.bus.call('host-grants:revoke', h.ctx(), {
        ownerUserId: 'u1',
        agentId: 'a1',
        host: 'api.linear.app',
      }),
    ).toEqual({ revoked: true });
    expect(
      (
        (await h.bus.call('host-grants:list', h.ctx(), { ownerUserId: 'u1', agentId: 'a1' })) as {
          hosts: { host: string }[];
        }
      ).hosts.map((x) => x.host),
    ).toEqual(['status.example.com']);

    // A bad host never lands.
    await expect(
      h.bus.call('host-grants:grant', h.ctx(), {
        ownerUserId: 'u1',
        agentId: 'a1',
        host: '*.evil.com',
      }),
    ).rejects.toThrow(/invalid host/i);
  });
});
