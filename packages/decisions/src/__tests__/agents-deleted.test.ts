/**
 * TASK-718 — deleting an agent must take its decisions with it.
 *
 * `@ax/agents` fires `agents:deleted` AFTER the agent row is gone.
 * `decisions_v1_decisions` keys on `agent_id` with NO foreign key to the agents
 * table (deliberately — see the migration header), so nothing but this
 * subscriber ever removes the rows. Driven through a real bus and a real
 * Postgres; the store method's own contract is in `store.test.ts`.
 */
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createLogger } from '@ax/core';
import { createTestHarness, startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import type { TestHarness } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DecisionsDatabase } from '../migrations.js';
import { createDecisionsPlugin } from '../plugin.js';
import { createDecisionsStore } from '../store.js';
import { DecisionStatusSchema, type Decision } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function boot(): Promise<TestHarness> {
  const h = await createTestHarness({
    // `tool-policy:evaluate` is a hard `call` of the plugin, so a producer has
    // to exist for the boot to verify. It is never invoked here: nothing in
    // this file raises a hold, it only seeds rows and deletes an agent.
    services: {
      'tool-policy:evaluate': async () => ({ verdict: 'allow' }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      // `sweepIntervalMs: 0` — no background timer racing an assertion.
      createDecisionsPlugin({ sweepIntervalMs: 0 }),
    ],
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
    await c.query('DROP TABLE IF EXISTS decisions_v1_decisions');
  } finally {
    await c.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

function decision(over: Partial<Decision>): Decision {
  return {
    id: 'dec_1',
    agentId: 'agt_del',
    ownerUserId: 'u1',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'attended',
    status: 'pending',
    call: { id: 'call-1', name: 'request_capability', input: { reason: 'need a key' } },
    callFingerprint: 'fp-1',
    ruleId: 'skills.request-capability',
    irreversible: false,
    freshness: null,
    summary: 'Wants to gain access to a new service or key',
    detail: 'It stopped before running request_capability.',
    preview: null,
    primaryLabel: 'Yes, go ahead',
    secondaryLabel: 'Show me the details',
    ghostLabel: "No — I'll handle it",
    approvedText: 'You said yes.',
    dismissedText: 'You turned this down. Nothing ran.',
    createdAt: '2026-08-20T09:00:00.000Z',
    expiresAt: '2026-08-22T09:00:00.000Z',
    resolvedAt: null,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    replayedAt: null,
    replayAbandonedAt: null,
    replayError: null,
    deliveryDueAt: null,
    deliveredAt: null,
    ...over,
  };
}

/**
 * One row per status for each of the two agents, split over two owners and two
 * conversations: the shape a team agent leaves behind.
 */
async function seed(h: TestHarness): Promise<void> {
  const { db } = await h.bus.call<unknown, { db: Kysely<DecisionsDatabase> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  const store = createDecisionsStore(db);
  for (const agentId of ['agt_del', 'agt_keep']) {
    let i = 0;
    for (const status of DecisionStatusSchema.options) {
      await store.create(
        decision({
          id: `dec_${agentId}_${status}`,
          agentId,
          status,
          ownerUserId: i % 2 === 0 ? 'u1' : 'u2',
          conversationId: i % 2 === 0 ? 'c1' : 'c2',
          callFingerprint: `fp-${agentId}-${status}`,
        }),
      );
      i += 1;
    }
  }
}

const ROWS_PER_AGENT = DecisionStatusSchema.options.length;

async function countRows(agentId: string): Promise<number> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    const r = await c.query(
      'SELECT COUNT(*)::int AS n FROM decisions_v1_decisions WHERE agent_id = $1',
      [agentId],
    );
    return r.rows[0].n as number;
  } finally {
    await c.end().catch(() => {});
  }
}

/** A ctx whose logger writes into `lines`, so a test can read what was logged. */
function loggedCtx(h: TestHarness, lines: string[]) {
  return h.ctx({ logger: createLogger({ reqId: 'req-del', writer: (l) => lines.push(l) }) });
}

const parse = (lines: string[]): Array<Record<string, unknown>> =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>);

const deleted = (agentId: unknown) => ({ agentId, ownerId: 'u1', ownerType: 'user' });

describe('@ax/decisions agents:deleted subscriber (TASK-718)', () => {
  it('manifest.subscribes lists agents:deleted alongside tool:pre-call', () => {
    const { subscribes } = createDecisionsPlugin({ sweepIntervalMs: 0 }).manifest;
    expect(subscribes).toContain('agents:deleted');
    expect(subscribes).toContain('tool:pre-call');
  });

  it('removes every decision for the deleted agent — every status, owner and conversation — and only those', async () => {
    const h = await boot();
    await seed(h);
    expect(await countRows('agt_del')).toBe(ROWS_PER_AGENT);
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    expect(await countRows('agt_del')).toBe(0);
    expect(await countRows('agt_keep')).toBe(ROWS_PER_AGENT);
    expect(
      parse(lines).find((e) => e.msg === 'decisions_purged_for_deleted_agent'),
    ).toMatchObject({ level: 'info', agentId: 'agt_del', deleted: ROWS_PER_AGENT });
  });

  it('firing again for the same agent is a no-op that neither throws nor touches other agents', async () => {
    const h = await boot();
    await seed(h);
    await h.bus.fire('agents:deleted', loggedCtx(h, []), deleted('agt_del'));
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    expect(await countRows('agt_del')).toBe(0);
    expect(await countRows('agt_keep')).toBe(ROWS_PER_AGENT);
    const events = parse(lines);
    expect(events.find((e) => e.msg === 'decisions_purged_for_deleted_agent')).toMatchObject({
      deleted: 0,
    });
    expect(events.some((e) => e.level === 'error')).toBe(false);
  });

  it('a malformed payload deletes nothing, warns, and does not throw', async () => {
    const h = await boot();
    await seed(h);
    for (const bad of [{}, { agentId: '' }, { agentId: 42 }, { agentId: null }, null, 'agt_del']) {
      const lines: string[] = [];
      const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), bad);
      expect(res.rejected).toBe(false);
      const events = parse(lines);
      expect(events.filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual([
        'decisions_purge_for_deleted_agent_skipped',
      ]);
      // The subscriber handled it itself: the bus never had to catch a throw.
      expect(events.some((e) => e.msg === 'hook_subscriber_failed')).toBe(false);
    }
    expect(await countRows('agt_del')).toBe(ROWS_PER_AGENT);
    expect(await countRows('agt_keep')).toBe(ROWS_PER_AGENT);
  });

  it('a failing store is logged at error and swallowed — the subscriber never throws', async () => {
    const h = await boot();
    await seed(h);
    // Break the store out from under the subscriber: the DELETE now fails with
    // "relation does not exist".
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      await c.query('DROP TABLE decisions_v1_decisions');
    } finally {
      await c.end().catch(() => {});
    }
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    const events = parse(lines);
    expect(events.filter((e) => e.level === 'error').map((e) => e.msg)).toEqual([
      'decisions_purge_for_deleted_agent_failed',
    ]);
    expect(events.find((e) => e.level === 'error')).toMatchObject({ agentId: 'agt_del' });
    // The bus's own isolation did NOT have to catch anything: we swallowed it.
    expect(events.some((e) => e.msg === 'hook_subscriber_failed')).toBe(false);
  });
});
