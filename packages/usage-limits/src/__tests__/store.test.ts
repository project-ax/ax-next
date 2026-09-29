import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runUsageLimitsMigration, type UsageLimitsDatabase } from '../migrations.js';
import { createUsageStore, type UsageStore } from '../store.js';
import type { UsageLimits } from '../config.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
let db: Kysely<UsageLimitsDatabase>;
let store: UsageStore;
const extra: Kysely<UsageLimitsDatabase>[] = [];

function makeKysely(max = 10): Kysely<UsageLimitsDatabase> {
  return new Kysely<UsageLimitsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }),
  });
}

const LIMITS: UsageLimits = { dailySpendUsd: 1, turnsPerHour: 5, assumedTurnCostUsd: 0.25 };
const NOW = new Date('2026-09-29T12:30:30.000Z');
const minutes = (n: number) => n * 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 0,
};

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
  db = makeKysely();
  await runUsageLimitsMigration(db);
  // Idempotent: a second boot must not fail.
  await runUsageLimitsMigration(db);
  store = createUsageStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE usage_limits_v1_buckets, usage_limits_v1_suspensions`.execute(db);
});

afterAll(async () => {
  for (const k of extra) await k.destroy().catch(() => {});
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

async function turnsFor(userId: string): Promise<number> {
  const r = await sql<{ n: string | null }>`
    SELECT SUM(turns) AS n FROM usage_limits_v1_buckets WHERE user_id = ${userId}
  `.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

describe('UsageStore.admit', () => {
  it('admits and counts the turn in the current-minute bucket', async () => {
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ ok: true });
    const rows = await db.selectFrom('usage_limits_v1_buckets').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.turns).toBe(1);
    expect(new Date(rows[0]!.bucket_start).toISOString()).toBe('2026-09-29T12:30:00.000Z');
  });

  it('refuses on the daily cap at exactly the threshold, not before', async () => {
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 999_999 }, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ ok: true });
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 1 }, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({
      ok: false,
      reason: 'usage-limit-daily',
    });
  });

  it('refuses on the hourly turn cap and does not count refused turns', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ ok: true });
    }
    for (let i = 0; i < 3; i++) {
      expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({
        ok: false,
        reason: 'usage-limit-rate',
      });
    }
    expect(await turnsFor('u1')).toBe(5);
  });

  it('checks suspension first, then daily, then rate', async () => {
    for (let i = 0; i < 5; i++) await store.admit({ userId: 'u1', limits: LIMITS, now: NOW });
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 2_000_000 }, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toMatchObject({
      reason: 'usage-limit-daily',
    });
    await store.suspend({ userId: 'u1', by: 'admin', note: null, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({
      ok: false,
      reason: 'usage-suspended',
    });
  });

  it('a bucket 25h old no longer counts against the daily cap', async () => {
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 5_000_000 }, now: ago(minutes(25 * 60)) });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ ok: true });
    // ...but one 23h old does.
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 5_000_000 }, now: ago(minutes(23 * 60)) });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toMatchObject({
      reason: 'usage-limit-daily',
    });
  });

  it('turns 61 minutes old no longer count against the hourly cap', async () => {
    for (let i = 0; i < 5; i++) {
      await store.admit({ userId: 'u1', limits: LIMITS, now: ago(minutes(61)) });
    }
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ ok: true });
    // ...but turns 59 minutes old still do (separate user: from the 59-minute
    // vantage point u1's 61-minute-old turns would still be in its window).
    for (let i = 0; i < 5; i++) {
      expect(await store.admit({ userId: 'u2', limits: LIMITS, now: ago(minutes(59)) })).toEqual({ ok: true });
    }
    expect(await store.admit({ userId: 'u2', limits: LIMITS, now: NOW })).toMatchObject({
      reason: 'usage-limit-rate',
    });
  });

  it('isolates users: one at the cap does not affect another', async () => {
    await store.record({ userId: 'a', usage: { ...zeroUsage, costMicros: 1_000_000 }, now: NOW });
    await store.suspend({ userId: 'c', by: 'admin', note: null, now: NOW });
    expect(await store.admit({ userId: 'a', limits: LIMITS, now: NOW })).toMatchObject({ ok: false });
    expect(await store.admit({ userId: 'b', limits: LIMITS, now: NOW })).toEqual({ ok: true });
  });

  it('serializes concurrent admits for one user: exactly turnsPerHour get through', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.admit({ userId: 'race', limits: LIMITS, now: NOW })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'usage-limit-rate')).toBe(true);
    expect(await turnsFor('race')).toBe(5);
  });
});

describe('UsageStore.record', () => {
  it('adds token counts and cost into the current bucket without counting a turn', async () => {
    const u = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costMicros: 50 };
    await store.record({ userId: 'u1', usage: u, now: NOW });
    await store.record({ userId: 'u1', usage: u, now: NOW });
    const rows = await db.selectFrom('usage_limits_v1_buckets').selectAll().execute();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.turns).toBe(0);
    expect(Number(r.input_tokens)).toBe(20);
    expect(Number(r.output_tokens)).toBe(40);
    expect(Number(r.cache_read_tokens)).toBe(60);
    expect(Number(r.cache_write_tokens)).toBe(80);
    expect(Number(r.cost_micros)).toBe(100);
  });

  it('survives a restart: a second Kysely on the same DB sees the same sums', async () => {
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 1_000_000 }, now: NOW });
    const db2 = makeKysely(2);
    extra.push(db2);
    await runUsageLimitsMigration(db2);
    const store2 = createUsageStore(db2);
    expect(await store2.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toMatchObject({
      reason: 'usage-limit-daily',
    });
    const s = await store2.summary({ now: NOW, limits: LIMITS });
    expect(s.users[0]).toMatchObject({ userId: 'u1', spendMicros: 1_000_000 });
  });
});

describe('UsageStore.summary', () => {
  it('orders by spend, totals over ALL users, truncates and includes suspended users with no usage', async () => {
    await store.admit({ userId: 'low', limits: LIMITS, now: NOW });
    await store.record({ userId: 'low', usage: { ...zeroUsage, costMicros: 10 }, now: NOW });
    await store.admit({ userId: 'high', limits: LIMITS, now: ago(minutes(120)) });
    await store.admit({ userId: 'high', limits: LIMITS, now: NOW });
    await store.record({
      userId: 'high',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costMicros: 500 },
      now: NOW,
    });
    await store.admit({ userId: 'mid', limits: LIMITS, now: NOW });
    await store.record({ userId: 'mid', usage: { ...zeroUsage, costMicros: 100 }, now: NOW });
    await store.suspend({ userId: 'idle', by: 'admin-1', note: 'abuse', now: NOW });
    // Outside the window: excluded from sums.
    await store.record({ userId: 'old', usage: { ...zeroUsage, costMicros: 9_999 }, now: ago(minutes(26 * 60)) });

    const full = await store.summary({ now: NOW, limits: LIMITS });
    expect(full.users.map((u) => u.userId)).toEqual(['high', 'mid', 'low', 'idle']);
    expect(full.truncated).toBe(false);
    expect(full.totals).toEqual({ turns: 4, spendMicros: 610, users: 4 });
    expect(full.users[0]).toEqual({
      userId: 'high',
      turnsLastHour: 1,
      turnsLast24h: 2,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      spendMicros: 500,
      suspended: null,
    });
    const idle = full.users[3]!;
    expect(idle.spendMicros).toBe(0);
    expect(idle.turnsLast24h).toBe(0);
    expect(idle.suspended).toMatchObject({ by: 'admin-1', note: 'abuse' });
    expect(idle.suspended!.at).toBeInstanceOf(Date);

    const cut = await store.summary({ now: NOW, limits: LIMITS, limit: 2 });
    expect(cut.users.map((u) => u.userId)).toEqual(['high', 'mid']);
    expect(cut.truncated).toBe(true);
    expect(cut.totals).toEqual({ turns: 4, spendMicros: 610, users: 4 });
  });

  it('is empty with zero totals when nothing is recorded', async () => {
    expect(await store.summary({ now: NOW, limits: LIMITS })).toEqual({
      users: [],
      totals: { turns: 0, spendMicros: 0, users: 0 },
      truncated: false,
    });
  });
});

describe('UsageStore suspensions + prune', () => {
  it('suspend upserts, getSuspension reads, resume is idempotent', async () => {
    expect(await store.getSuspension('u1')).toBeNull();
    const s1 = await store.suspend({ userId: 'u1', by: 'a1', note: 'first', now: NOW });
    expect(s1).toEqual({ at: NOW, by: 'a1', note: 'first' });
    const later = new Date(NOW.getTime() + 1000);
    const s2 = await store.suspend({ userId: 'u1', by: 'a2', note: null, now: later });
    expect(s2).toEqual({ at: later, by: 'a2', note: null });
    expect(await store.getSuspension('u1')).toEqual(s2);
    await store.resume('u1');
    await store.resume('u1');
    expect(await store.getSuspension('u1')).toBeNull();
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ ok: true });
  });

  it('prune deletes only buckets older than the cutoff', async () => {
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 1 }, now: ago(minutes(9 * 24 * 60)) });
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 1 }, now: ago(minutes(7 * 24 * 60)) });
    await store.record({ userId: 'u2', usage: { ...zeroUsage, costMicros: 1 }, now: NOW });
    const n = await store.prune(ago(minutes(8 * 24 * 60)));
    expect(n).toBe(1);
    const rows = await db.selectFrom('usage_limits_v1_buckets').select('user_id').execute();
    expect(rows).toHaveLength(2);
  });
});
