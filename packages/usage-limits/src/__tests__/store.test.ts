import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runUsageLimitsMigration, type UsageLimitsDatabase } from '../migrations.js';
import { createUsageStore, PROVIDER_CEILING_MULTIPLE, type UsageStore } from '../store.js';
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

// ---------------------------------------------------------------------------
// TASK-715: a second, independent measurement of the same traffic.
//
//   cost_micros           runner-reported turn cost (record)
//   provider_cost_micros  what the credential proxy measured, ALL model traffic
//                         from the sandbox: the runner's own calls AND any
//                         direct ones (recordProvider)
//   helper_cost_micros    host-side helper calls; they never cross the proxy
//                         (recordHelper)
//
// Estimated spend, per user over the window:
//   GREATEST(SUM(cost), SUM(provider)) + SUM(helper)
// The first two describe the SAME requests, so the larger wins and they are
// never added; helper calls are different requests and ride on top.
// ---------------------------------------------------------------------------

async function bucketRows(userId: string) {
  return db
    .selectFrom('usage_limits_v1_buckets')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('bucket_start')
    .execute();
}

async function spendOf(userId: string): Promise<number> {
  const s = await store.summary({ now: NOW, limits: LIMITS });
  return s.users.find((u) => u.userId === userId)?.spendMicros ?? 0;
}

describe('UsageStore.recordHelper', () => {
  it('lands the cost in helper_cost_micros (NOT cost_micros) and the tokens in the token columns', async () => {
    // Pre-change the helper path called record(), which put the cost in
    // cost_micros; this pins the move.
    const u = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costMicros: 50 };
    await store.recordHelper({ userId: 'u1', usage: u, now: NOW });
    await store.recordHelper({ userId: 'u1', usage: u, now: NOW });
    const rows = await bucketRows('u1');
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.turns).toBe(0);
    expect(Number(r.helper_cost_micros)).toBe(100);
    expect(Number(r.cost_micros)).toBe(0);
    expect(Number(r.provider_cost_micros)).toBe(0);
    expect(Number(r.input_tokens)).toBe(20);
    expect(Number(r.output_tokens)).toBe(40);
    expect(Number(r.cache_read_tokens)).toBe(60);
    expect(Number(r.cache_write_tokens)).toBe(80);
  });

  it('clamps hostile figures to whole, non-negative numbers', async () => {
    await store.recordHelper({
      userId: 'u1',
      usage: { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 1.9, cacheWriteTokens: 0, costMicros: -1 },
      now: NOW,
    });
    const r = (await bucketRows('u1'))[0]!;
    expect(Number(r.helper_cost_micros)).toBe(0);
    expect(Number(r.input_tokens)).toBe(0);
    expect(Number(r.output_tokens)).toBe(0);
    expect(Number(r.cache_read_tokens)).toBe(1);
  });

  it('leaves record() alone: turn usage still goes to cost_micros', async () => {
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 70 }, now: NOW });
    const r = (await bucketRows('u1'))[0]!;
    expect(Number(r.cost_micros)).toBe(70);
    expect(Number(r.helper_cost_micros)).toBe(0);
    expect(Number(r.provider_cost_micros)).toBe(0);
  });
});

describe('UsageStore.recordProvider', () => {
  it('touches ONLY provider_cost_micros: no tokens, no turn, no other cost column', async () => {
    await store.recordProvider({ userId: 'u1', costMicros: 40, now: NOW });
    await store.recordProvider({ userId: 'u1', costMicros: 2, now: NOW });
    const rows = await bucketRows('u1');
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(Number(r.provider_cost_micros)).toBe(42);
    expect(r.turns).toBe(0);
    expect(Number(r.cost_micros)).toBe(0);
    expect(Number(r.helper_cost_micros)).toBe(0);
    expect(Number(r.input_tokens)).toBe(0);
    expect(Number(r.output_tokens)).toBe(0);
    expect(Number(r.cache_read_tokens)).toBe(0);
    expect(Number(r.cache_write_tokens)).toBe(0);
  });

  it('adds into a bucket other writers already created, without disturbing their columns', async () => {
    await store.admit({ userId: 'u1', limits: LIMITS, now: NOW });
    await store.record({
      userId: 'u1',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costMicros: 5 },
      now: NOW,
    });
    await store.recordHelper({ userId: 'u1', usage: { ...zeroUsage, costMicros: 6 }, now: NOW });
    await store.recordProvider({ userId: 'u1', costMicros: 7, now: NOW });
    const rows = await bucketRows('u1');
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.turns).toBe(1);
    expect(Number(r.cost_micros)).toBe(5);
    expect(Number(r.helper_cost_micros)).toBe(6);
    expect(Number(r.provider_cost_micros)).toBe(7);
    expect(Number(r.input_tokens)).toBe(1);
  });

  it('clamps hostile figures to a whole, non-negative number', async () => {
    await store.recordProvider({ userId: 'u1', costMicros: -100, now: NOW });
    await store.recordProvider({ userId: 'u1', costMicros: Number.NaN, now: NOW });
    await store.recordProvider({ userId: 'u1', costMicros: 3.9, now: NOW });
    expect(Number((await bucketRows('u1'))[0]!.provider_cost_micros)).toBe(3);
  });
});

describe('estimated spend: GREATEST(runner, proxy) + helper', () => {
  // Each case is a (runner, proxy, helper) triple and the spend it must give.
  // "Both equal" and "proxy larger" fail against a plain SUM(cost_micros) or a
  // plain sum of the three columns.
  const cases: Array<{ name: string; runner: number; proxy: number; helper: number; spend: number }> = [
    { name: 'runner only', runner: 300, proxy: 0, helper: 0, spend: 300 },
    { name: 'proxy only', runner: 0, proxy: 400, helper: 0, spend: 400 },
    { name: 'both equal (the same traffic, counted once)', runner: 500, proxy: 500, helper: 0, spend: 500 },
    { name: 'proxy larger (a direct call shows up as the excess)', runner: 200, proxy: 700, helper: 0, spend: 700 },
    { name: 'runner larger (a proxy parse miss falls back to the runner figure)', runner: 900, proxy: 100, helper: 0, spend: 900 },
    { name: 'helper alone', runner: 0, proxy: 0, helper: 60, spend: 60 },
    { name: 'helper on top of runner only', runner: 300, proxy: 0, helper: 50, spend: 350 },
    { name: 'helper on top of proxy only', runner: 0, proxy: 400, helper: 50, spend: 450 },
    { name: 'helper on top of both equal', runner: 500, proxy: 500, helper: 50, spend: 550 },
    { name: 'helper on top of proxy larger', runner: 200, proxy: 700, helper: 50, spend: 750 },
  ];

  for (const c of cases) {
    it(`summary: ${c.name}`, async () => {
      if (c.runner > 0) await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: c.runner }, now: NOW });
      if (c.proxy > 0) await store.recordProvider({ userId: 'u1', costMicros: c.proxy, now: NOW });
      if (c.helper > 0) await store.recordHelper({ userId: 'u1', usage: { ...zeroUsage, costMicros: c.helper }, now: NOW });
      expect(await spendOf('u1')).toBe(c.spend);
    });
  }

  it('takes the larger of the two SUMS over the window, not the larger per bucket', async () => {
    // Minute A: runner 100, proxy 0. Minute B: runner 0, proxy 100. The sums
    // are 100 and 100, so the spend is 100. A per-bucket GREATEST would say 200.
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 100 }, now: ago(minutes(10)) });
    await store.recordProvider({ userId: 'u1', costMicros: 100, now: ago(minutes(5)) });
    expect(await spendOf('u1')).toBe(100);
  });

  it('admit refuses at 1x on a spend that is ONLY proxy-measured', async () => {
    // A user who never had a runner turn reported, but whose sandbox called the
    // provider directly: pre-change admit saw zero and let the next turn in.
    await store.recordProvider({ userId: 'u1', costMicros: 999_999, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ ok: true });
    await store.recordProvider({ userId: 'u1', costMicros: 1, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({
      ok: false,
      reason: 'usage-limit-daily',
    });
  });

  it('admit still counts helper spend toward the cap (it moved columns, not meaning)', async () => {
    await store.recordHelper({ userId: 'u1', usage: { ...zeroUsage, costMicros: 1_000_000 }, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({
      ok: false,
      reason: 'usage-limit-daily',
    });
  });

  it('admit does not double-count the same traffic seen by both meters', async () => {
    // 600k by the runner and 600k by the proxy is 600k of spend, under a 1M
    // cap. Summing them (1.2M) would refuse an honest user.
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 600_000 }, now: NOW });
    await store.recordProvider({ userId: 'u1', costMicros: 600_000, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ ok: true });
  });

  it('admit adds helper spend on top of the larger measurement', async () => {
    await store.recordProvider({ userId: 'u1', costMicros: 600_000, now: NOW });
    await store.record({ userId: 'u1', usage: { ...zeroUsage, costMicros: 500_000 }, now: NOW });
    await store.recordHelper({ userId: 'u1', usage: { ...zeroUsage, costMicros: 400_000 }, now: NOW });
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toMatchObject({
      reason: 'usage-limit-daily',
    });
  });

  it('summary: per-user spend uses the formula and totals stay the sum of the per-user figures', async () => {
    // a: runner 100, proxy 300, helper 10 -> 310
    await store.record({ userId: 'a', usage: { ...zeroUsage, costMicros: 100 }, now: NOW });
    await store.recordProvider({ userId: 'a', costMicros: 300, now: NOW });
    await store.recordHelper({ userId: 'a', usage: { ...zeroUsage, costMicros: 10 }, now: NOW });
    // b: runner 500, proxy 500 -> 500 (not 1000)
    await store.record({ userId: 'b', usage: { ...zeroUsage, costMicros: 500 }, now: NOW });
    await store.recordProvider({ userId: 'b', costMicros: 500, now: NOW });
    // c: helper only -> 40
    await store.recordHelper({ userId: 'c', usage: { ...zeroUsage, costMicros: 40 }, now: NOW });
    // d: proxy only -> 20
    await store.recordProvider({ userId: 'd', costMicros: 20, now: NOW });

    const s = await store.summary({ now: NOW, limits: LIMITS });
    expect(s.users.map((u) => [u.userId, u.spendMicros])).toEqual([
      ['b', 500],
      ['a', 310],
      ['c', 40],
      ['d', 20],
    ]);
    expect(s.totals.spendMicros).toBe(870);
    // Truncation must not change the totals (they ride a window function).
    const cut = await store.summary({ now: NOW, limits: LIMITS, limit: 1 });
    expect(cut.users.map((u) => u.userId)).toEqual(['b']);
    expect(cut.totals.spendMicros).toBe(870);
  });

  it('summary: token columns behave as before (helper adds tokens, proxy adds none)', async () => {
    await store.record({
      userId: 'u1',
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costMicros: 5 },
      now: NOW,
    });
    await store.recordHelper({
      userId: 'u1',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 6 },
      now: NOW,
    });
    await store.recordProvider({ userId: 'u1', costMicros: 9_999, now: NOW });
    const u = (await store.summary({ now: NOW, limits: LIMITS })).users[0]!;
    expect(u).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    expect(u.spendMicros).toBe(9_999 + 6);
  });
});

describe('UsageStore.providerStatus', () => {
  // LIMITS.dailySpendUsd is 1 -> the ceiling is 2x = 2_000_000 micros.
  const CEILING = 2_000_000;

  it('documents the multiple it uses', () => {
    expect(PROVIDER_CEILING_MULTIPLE).toBe(2);
  });

  it('is not blocked for a user with no usage at all', async () => {
    expect(await store.providerStatus({ userId: 'nobody', limits: LIMITS, now: NOW })).toEqual({
      blocked: false,
    });
  });

  it('is not blocked between 1x and 2x (an admitted turn may finish), blocked at exactly 2x', async () => {
    await store.recordProvider({ userId: 'u1', costMicros: CEILING - 1, now: NOW });
    expect(await store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ blocked: false });
    // ...even though admit already refuses this user for a NEW turn.
    expect(await store.admit({ userId: 'u1', limits: LIMITS, now: NOW })).toMatchObject({
      reason: 'usage-limit-daily',
    });
    await store.recordProvider({ userId: 'u1', costMicros: 1, now: NOW });
    expect(await store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({
      blocked: true,
      reason: 'usage-limit-daily',
    });
  });

  it('applies the same spend formula (runner-only spend at 2x also blocks; equal figures are not summed)', async () => {
    await store.record({ userId: 'r', usage: { ...zeroUsage, costMicros: CEILING }, now: NOW });
    expect(await store.providerStatus({ userId: 'r', limits: LIMITS, now: NOW })).toMatchObject({ blocked: true });
    // 1.5M seen by both meters is 1.5M, under the 2M ceiling.
    await store.record({ userId: 'same', usage: { ...zeroUsage, costMicros: 1_500_000 }, now: NOW });
    await store.recordProvider({ userId: 'same', costMicros: 1_500_000, now: NOW });
    expect(await store.providerStatus({ userId: 'same', limits: LIMITS, now: NOW })).toEqual({ blocked: false });
    // Helper spend rides on top and tips it over.
    await store.recordHelper({ userId: 'same', usage: { ...zeroUsage, costMicros: 500_000 }, now: NOW });
    expect(await store.providerStatus({ userId: 'same', limits: LIMITS, now: NOW })).toMatchObject({
      blocked: true,
      reason: 'usage-limit-daily',
    });
  });

  it('scales the ceiling with the configured daily limit', async () => {
    const small: UsageLimits = { ...LIMITS, dailySpendUsd: 0.01 };
    await store.recordProvider({ userId: 'u1', costMicros: 19_999, now: NOW });
    expect(await store.providerStatus({ userId: 'u1', limits: small, now: NOW })).toEqual({ blocked: false });
    await store.recordProvider({ userId: 'u1', costMicros: 1, now: NOW });
    expect(await store.providerStatus({ userId: 'u1', limits: small, now: NOW })).toMatchObject({ blocked: true });
  });

  it('a suspended user is blocked with usage-suspended, and suspension wins over spend', async () => {
    await store.suspend({ userId: 'u1', by: 'admin', note: null, now: NOW });
    expect(await store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({
      blocked: true,
      reason: 'usage-suspended',
    });
    await store.recordProvider({ userId: 'u1', costMicros: CEILING * 2, now: NOW });
    expect(await store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({
      blocked: true,
      reason: 'usage-suspended',
    });
    await store.resume('u1');
    expect(await store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW })).toMatchObject({
      reason: 'usage-limit-daily',
    });
  });

  it('the window rolls: spend 25h old no longer blocks, 23h old still does', async () => {
    await store.recordProvider({ userId: 'u1', costMicros: 5_000_000, now: ago(minutes(25 * 60)) });
    expect(await store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW })).toEqual({ blocked: false });
    await store.recordProvider({ userId: 'u1', costMicros: 5_000_000, now: ago(minutes(23 * 60)) });
    expect(await store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW })).toMatchObject({ blocked: true });
  });

  it('isolates users', async () => {
    await store.recordProvider({ userId: 'a', costMicros: CEILING, now: NOW });
    expect(await store.providerStatus({ userId: 'a', limits: LIMITS, now: NOW })).toMatchObject({ blocked: true });
    expect(await store.providerStatus({ userId: 'b', limits: LIMITS, now: NOW })).toEqual({ blocked: false });
  });

  it('is read-only: it writes nothing and never counts a turn', async () => {
    for (let i = 0; i < 3; i++) await store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW });
    expect(await bucketRows('u1')).toEqual([]);
    expect(await turnsFor('u1')).toBe(0);
  });

  it('takes no advisory lock: it answers while another transaction holds the user lock', async () => {
    // admit() serialises a user's turn-starts on pg_advisory_xact_lock. The
    // proxy asks for a verdict on every provider call, so this read must never
    // queue behind that lock.
    const holder = await db.startTransaction().execute();
    try {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'u1'}, 0))`.execute(holder);
      const raced = await Promise.race([
        store.providerStatus({ userId: 'u1', limits: LIMITS, now: NOW }),
        new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 3_000)),
      ]);
      expect(raced).toEqual({ blocked: false });
    } finally {
      await holder.rollback().execute();
    }
  });
});

describe('usage-limits migration: provider_cost_micros and helper_cost_micros', () => {
  async function columnInfo(d: Kysely<UsageLimitsDatabase>) {
    const r = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'usage_limits_v1_buckets'
        AND column_name IN ('provider_cost_micros', 'helper_cost_micros')
      ORDER BY column_name
    `.execute(d);
    return r.rows;
  }

  it('is idempotent and creates both columns as BIGINT NOT NULL DEFAULT 0', async () => {
    await runUsageLimitsMigration(db);
    await runUsageLimitsMigration(db);
    expect(await columnInfo(db)).toEqual([
      { column_name: 'helper_cost_micros', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
      { column_name: 'provider_cost_micros', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
    ]);
  });

  it('upgrades a table created WITHOUT the new columns and keeps its rows', async () => {
    const d = makeKysely(2);
    extra.push(d);
    await sql`DROP TABLE usage_limits_v1_buckets`.execute(d);
    // The pre-TASK-715 shape, verbatim.
    await sql`
      CREATE TABLE usage_limits_v1_buckets (
        user_id             TEXT NOT NULL,
        bucket_start        TIMESTAMPTZ NOT NULL,
        turns               INTEGER NOT NULL DEFAULT 0,
        input_tokens        BIGINT NOT NULL DEFAULT 0,
        output_tokens       BIGINT NOT NULL DEFAULT 0,
        cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
        cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
        cost_micros         BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, bucket_start)
      )
    `.execute(d);
    await sql`
      INSERT INTO usage_limits_v1_buckets (user_id, bucket_start, turns, input_tokens, cost_micros)
      VALUES ('legacy', ${ago(minutes(5))}, 2, 77, 123456)
    `.execute(d);
    expect(await columnInfo(d)).toEqual([]);

    await runUsageLimitsMigration(d);
    await runUsageLimitsMigration(d);

    expect((await columnInfo(d)).map((c) => c.column_name)).toEqual([
      'helper_cost_micros',
      'provider_cost_micros',
    ]);
    const r = (await bucketRows('legacy'))[0]!;
    expect(r.turns).toBe(2);
    expect(Number(r.input_tokens)).toBe(77);
    expect(Number(r.cost_micros)).toBe(123_456);
    expect(Number(r.provider_cost_micros)).toBe(0);
    expect(Number(r.helper_cost_micros)).toBe(0);
    // ...and the old row still counts as runner-reported spend.
    expect(await spendOf('legacy')).toBe(123_456);
  });
});
