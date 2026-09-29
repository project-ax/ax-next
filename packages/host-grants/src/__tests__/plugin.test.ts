import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createLogger } from '@ax/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createHostGrantsPlugin } from '../plugin.js';
import type {
  HostGrantsGrantInput,
  HostGrantsGrantOutput,
  HostGrantsListInput,
  HostGrantsListOutput,
  HostGrantsListForUserInput,
  HostGrantsListForUserOutput,
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
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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

describe('@ax/host-grants plugin', () => {
  it('manifest matches the documented surface', () => {
    expect(createHostGrantsPlugin().manifest).toEqual({
      name: '@ax/host-grants',
      version: '0.0.0',
      registers: [
        'host-grants:grant',
        'host-grants:list',
        'host-grants:list-for-user',
        'host-grants:revoke',
      ],
      calls: ['database:get-instance'],
      // TASK-718: a deleted agent's grants go with it.
      subscribes: ['agents:deleted'],
    });
  });

  it('host-grants:list-for-user returns the user’s grants across agents over the bus', async () => {
    const h = await makeHarness();
    for (const [agentId, host] of [
      ['a1', 'a.example.com'],
      ['a2', 'a.example.com'],
      ['a1', 'b.example.com'],
    ] as const) {
      await h.bus.call<HostGrantsGrantInput, HostGrantsGrantOutput>('host-grants:grant', h.ctx(), {
        ownerUserId: 'u1',
        agentId,
        host,
      });
    }
    // A different user's grant must not leak.
    await h.bus.call<HostGrantsGrantInput, HostGrantsGrantOutput>('host-grants:grant', h.ctx(), {
      ownerUserId: 'u2',
      agentId: 'a1',
      host: 'leak.example.com',
    });

    const out = await h.bus.call<HostGrantsListForUserInput, HostGrantsListForUserOutput>(
      'host-grants:list-for-user',
      h.ctx(),
      { ownerUserId: 'u1' },
    );
    expect(out.grants.map((g) => ({ host: g.host, agentId: g.agentId }))).toEqual([
      { host: 'a.example.com', agentId: 'a1' },
      { host: 'a.example.com', agentId: 'a2' },
      { host: 'b.example.com', agentId: 'a1' },
    ]);
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

// TASK-718 — `@ax/agents` fires `agents:deleted` AFTER the agent row is gone.
// host_grants_v1_grants has no FK to the agents table (deliberately), so nothing
// but this subscriber ever removes an agent's grants.
describe('@ax/host-grants agents:deleted subscriber (TASK-718)', () => {
  async function countRows(agentId: string): Promise<number> {
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      const r = await c.query(
        'SELECT COUNT(*)::int AS n FROM host_grants_v1_grants WHERE agent_id = $1',
        [agentId],
      );
      return r.rows[0].n as number;
    } finally {
      await c.end().catch(() => {});
    }
  }

  async function seed(h: TestHarness): Promise<void> {
    for (const [ownerUserId, agentId, host] of [
      ['u1', 'agt_del', 'a.example.com'],
      ['u1', 'agt_del', 'b.example.com'],
      ['u2', 'agt_del', 'a.example.com'],
      ['u3', 'agt_del', 'c.example.com'],
      ['u1', 'agt_keep', 'a.example.com'],
      ['u2', 'agt_keep', 'z.example.com'],
    ] as const) {
      await h.bus.call<HostGrantsGrantInput, HostGrantsGrantOutput>('host-grants:grant', h.ctx(), {
        ownerUserId,
        agentId,
        host,
      });
    }
  }

  /** A ctx whose logger writes into `lines`, so a test can read what was logged. */
  function loggedCtx(h: TestHarness, lines: string[]) {
    return h.ctx({ logger: createLogger({ reqId: 'req-del', writer: (l) => lines.push(l) }) });
  }

  const parse = (lines: string[]): Array<Record<string, unknown>> =>
    lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  const deleted = (agentId: unknown) => ({ agentId, ownerId: 'u1', ownerType: 'user' });

  it('manifest.subscribes lists agents:deleted', () => {
    expect(createHostGrantsPlugin().manifest.subscribes).toContain('agents:deleted');
  });

  it('removes every grant for the deleted agent under every owner, and only those', async () => {
    const h = await makeHarness();
    await seed(h);
    expect(await countRows('agt_del')).toBe(4);
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    expect(await countRows('agt_del')).toBe(0);
    expect(await countRows('agt_keep')).toBe(2);
    // Through the service surface too: no owner still sees the deleted agent.
    for (const ownerUserId of ['u1', 'u2', 'u3']) {
      const out = await h.bus.call<HostGrantsListForUserInput, HostGrantsListForUserOutput>(
        'host-grants:list-for-user',
        h.ctx(),
        { ownerUserId },
      );
      expect(out.grants.filter((g) => g.agentId === 'agt_del')).toEqual([]);
    }
    expect(
      parse(lines).find((e) => e.msg === 'host_grants_purged_for_deleted_agent'),
    ).toMatchObject({ level: 'info', agentId: 'agt_del', deleted: 4 });
  });

  it('firing again for the same agent is a no-op that neither throws nor touches other agents', async () => {
    const h = await makeHarness();
    await seed(h);
    await h.bus.fire('agents:deleted', loggedCtx(h, []), deleted('agt_del'));
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    expect(await countRows('agt_del')).toBe(0);
    expect(await countRows('agt_keep')).toBe(2);
    const events = parse(lines);
    expect(events.find((e) => e.msg === 'host_grants_purged_for_deleted_agent')).toMatchObject({
      deleted: 0,
    });
    expect(events.some((e) => e.level === 'error')).toBe(false);
  });

  it('a malformed payload deletes nothing, warns, and does not throw', async () => {
    const h = await makeHarness();
    await seed(h);
    for (const bad of [{}, { agentId: '' }, { agentId: 42 }, { agentId: null }, null, 'agt_del']) {
      const lines: string[] = [];
      const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), bad);
      expect(res.rejected).toBe(false);
      const events = parse(lines);
      expect(events.filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual([
        'host_grants_purge_for_deleted_agent_skipped',
      ]);
      // The subscriber handled it itself: the bus never had to catch a throw.
      expect(events.some((e) => e.msg === 'hook_subscriber_failed')).toBe(false);
    }
    expect(await countRows('agt_del')).toBe(4);
    expect(await countRows('agt_keep')).toBe(2);
  });

  it('a failing store is logged at error and swallowed — the subscriber never throws', async () => {
    const h = await makeHarness();
    await seed(h);
    // Break the store out from under the subscriber: the DELETE now fails with
    // "relation does not exist".
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      await c.query('DROP TABLE host_grants_v1_grants');
    } finally {
      await c.end().catch(() => {});
    }
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    const events = parse(lines);
    expect(events.filter((e) => e.level === 'error').map((e) => e.msg)).toEqual([
      'host_grants_purge_for_deleted_agent_failed',
    ]);
    expect(events.find((e) => e.level === 'error')).toMatchObject({ agentId: 'agt_del' });
    // The bus's own isolation did NOT have to catch anything: we swallowed it.
    expect(events.some((e) => e.msg === 'hook_subscriber_failed')).toBe(false);
  });
});
