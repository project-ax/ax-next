import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createHostGrantsPlugin } from '../plugin.js';
import type {
  HostGrantsGrantInput,
  HostGrantsGrantOutput,
  HostGrantsListInput,
  HostGrantsListOutput,
  HostGrantsRevokeInput,
  HostGrantsRevokeOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
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
  if (container) await container.stop();
});

describe('@ax/host-grants plugin', () => {
  it('manifest matches the documented surface', () => {
    expect(createHostGrantsPlugin().manifest).toEqual({
      name: '@ax/host-grants',
      version: '0.0.0',
      registers: ['host-grants:grant', 'host-grants:list', 'host-grants:revoke'],
      calls: ['database:get-instance'],
      subscribes: [],
    });
  });

  it('grant → list → revoke round-trips over the bus', async () => {
    const h = await makeHarness();
    const g = await h.bus.call<HostGrantsGrantInput, HostGrantsGrantOutput>(
      'host-grants:grant',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' },
    );
    expect(g).toEqual({ created: true });

    const l = await h.bus.call<HostGrantsListInput, HostGrantsListOutput>(
      'host-grants:list',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(l.hosts.map((x) => x.host)).toEqual(['x.example.com']);

    const r = await h.bus.call<HostGrantsRevokeInput, HostGrantsRevokeOutput>(
      'host-grants:revoke',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', host: 'x.example.com' },
    );
    expect(r).toEqual({ revoked: true });
    expect(
      (
        await h.bus.call<HostGrantsListInput, HostGrantsListOutput>('host-grants:list', h.ctx(), {
          ownerUserId: 'u1',
          agentId: 'a1',
        })
      ).hosts,
    ).toEqual([]);
  });

  it('host-grants:grant rejects an invalid host', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('host-grants:grant', h.ctx(), {
        ownerUserId: 'u1',
        agentId: 'a1',
        host: '*.evil.com',
      }),
    ).rejects.toThrow(/invalid host/i);
  });
});
