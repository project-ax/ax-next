import { sql, type Kysely } from 'kysely';
import type { UsageLimitsDatabase } from './migrations.js';
import type { UsageLimits } from './config.js';

// ---------------------------------------------------------------------------
// Every query against `usage_limits_v1_*` lives in this file.
//
// Windows are computed in JS from the caller's injected `now`, floored to the
// minute. Flooring the START of a window pulls in the whole bucket that
// straddles it, so a window can only ever count slightly MORE than the exact
// rolling period, never less: the limit errs strict.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type AdmitRefusal = 'usage-suspended' | 'usage-limit-daily' | 'usage-limit-rate';
export type AdmitResult = { ok: true } | { ok: false; reason: AdmitRefusal };

export interface RecordedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
}

export interface Suspension {
  at: Date;
  by: string;
  note: string | null;
}

export interface UserUsageSummary {
  userId: string;
  turnsLastHour: number;
  turnsLast24h: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  spendMicros: number;
  suspended: Suspension | null;
}

export interface UsageSummary {
  users: UserUsageSummary[];
  totals: { turns: number; spendMicros: number; users: number };
  truncated: boolean;
}

export interface UsageStore {
  admit(input: { userId: string; limits: UsageLimits; now: Date }): Promise<AdmitResult>;
  record(input: { userId: string; usage: RecordedUsage; now: Date }): Promise<void>;
  summary(input: { now: Date; limit?: number; limits: UsageLimits }): Promise<UsageSummary>;
  getSuspension(userId: string): Promise<Suspension | null>;
  suspend(input: { userId: string; by: string; note: string | null; now: Date }): Promise<Suspension>;
  resume(userId: string): Promise<void>;
  prune(olderThan: Date): Promise<number>;
}

function floorToMinute(ms: number): Date {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS);
}

/** pg returns SUM(bigint) as a numeric string (or null over zero rows). */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A clamp for values written to the counters: whole, non-negative, finite. */
function whole(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function createUsageStore(db: Kysely<UsageLimitsDatabase>): UsageStore {
  return {
    async admit({ userId, limits, now }) {
      const t = now.getTime();
      const dayStart = floorToMinute(t - DAY_MS);
      const hourStart = floorToMinute(t - HOUR_MS);
      const bucket = floorToMinute(t);
      const capMicros = Math.round(limits.dailySpendUsd * 1_000_000);

      return db.transaction().execute(async (trx) => {
        // Per-user lock for the rest of this transaction: two messages from
        // ONE user queue here, so both cannot read "under the cap" and both
        // count. Different users hash to different keys and never wait on
        // each other (a hash collision only costs a brief wait, never a
        // wrong answer).
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`.execute(trx);

        const suspended = await trx
          .selectFrom('usage_limits_v1_suspensions')
          .select('user_id')
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (suspended !== undefined) return { ok: false, reason: 'usage-suspended' } as const;

        const sums = await sql<{ spend: string | null; turns_hour: string | null }>`
          SELECT
            SUM(cost_micros) AS spend,
            SUM(turns) FILTER (WHERE bucket_start >= ${hourStart}) AS turns_hour
          FROM usage_limits_v1_buckets
          WHERE user_id = ${userId} AND bucket_start >= ${dayStart}
        `.execute(trx);
        const row = sums.rows[0];
        if (num(row?.spend) >= capMicros) return { ok: false, reason: 'usage-limit-daily' } as const;
        if (num(row?.turns_hour) >= limits.turnsPerHour) {
          return { ok: false, reason: 'usage-limit-rate' } as const;
        }

        await trx
          .insertInto('usage_limits_v1_buckets')
          .values({ user_id: userId, bucket_start: bucket, turns: 1 })
          .onConflict((oc) =>
            oc.columns(['user_id', 'bucket_start']).doUpdateSet({
              turns: sql<number>`usage_limits_v1_buckets.turns + 1`,
            }),
          )
          .execute();
        return { ok: true } as const;
      });
    },

    async record({ userId, usage, now }) {
      const bucket = floorToMinute(now.getTime());
      await db
        .insertInto('usage_limits_v1_buckets')
        .values({
          user_id: userId,
          bucket_start: bucket,
          input_tokens: whole(usage.inputTokens),
          output_tokens: whole(usage.outputTokens),
          cache_read_tokens: whole(usage.cacheReadTokens),
          cache_write_tokens: whole(usage.cacheWriteTokens),
          cost_micros: whole(usage.costMicros),
        })
        .onConflict((oc) =>
          oc.columns(['user_id', 'bucket_start']).doUpdateSet({
            input_tokens: sql`usage_limits_v1_buckets.input_tokens + EXCLUDED.input_tokens`,
            output_tokens: sql`usage_limits_v1_buckets.output_tokens + EXCLUDED.output_tokens`,
            cache_read_tokens: sql`usage_limits_v1_buckets.cache_read_tokens + EXCLUDED.cache_read_tokens`,
            cache_write_tokens: sql`usage_limits_v1_buckets.cache_write_tokens + EXCLUDED.cache_write_tokens`,
            cost_micros: sql`usage_limits_v1_buckets.cost_micros + EXCLUDED.cost_micros`,
          }),
        )
        .execute();
    },

    async summary({ now, limit = 200 }) {
      const t = now.getTime();
      const dayStart = floorToMinute(t - DAY_MS);
      const hourStart = floorToMinute(t - HOUR_MS);
      // At least one row, so the window totals always have a row to ride on.
      const cap = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 200));

      // Window functions run BEFORE the LIMIT, so the totals cover every user
      // even when the returned rows are capped.
      const res = await sql<{
        user_id: string;
        turns_hour: string | null;
        turns_day: string | null;
        input_tokens: string | null;
        output_tokens: string | null;
        cache_read_tokens: string | null;
        cache_write_tokens: string | null;
        spend: string | null;
        suspended_at: Date | null;
        suspended_by: string | null;
        note: string | null;
        total_users: string;
        total_turns: string | null;
        total_spend: string | null;
      }>`
        WITH usage AS (
          SELECT
            user_id,
            SUM(turns) FILTER (WHERE bucket_start >= ${hourStart}) AS turns_hour,
            SUM(turns) AS turns_day,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(cost_micros) AS spend
          FROM usage_limits_v1_buckets
          WHERE bucket_start >= ${dayStart}
          GROUP BY user_id
        ),
        merged AS (
          SELECT
            COALESCE(u.user_id, s.user_id) AS user_id,
            COALESCE(u.turns_hour, 0) AS turns_hour,
            COALESCE(u.turns_day, 0) AS turns_day,
            COALESCE(u.input_tokens, 0) AS input_tokens,
            COALESCE(u.output_tokens, 0) AS output_tokens,
            COALESCE(u.cache_read_tokens, 0) AS cache_read_tokens,
            COALESCE(u.cache_write_tokens, 0) AS cache_write_tokens,
            COALESCE(u.spend, 0) AS spend,
            s.suspended_at,
            s.suspended_by,
            s.note
          FROM usage u
          FULL OUTER JOIN usage_limits_v1_suspensions s ON s.user_id = u.user_id
        )
        SELECT
          m.*,
          COUNT(*) OVER () AS total_users,
          SUM(m.turns_day) OVER () AS total_turns,
          SUM(m.spend) OVER () AS total_spend
        FROM merged m
        ORDER BY m.spend DESC, m.user_id ASC
        LIMIT ${cap}
      `.execute(db);

      let totals = { turns: 0, spendMicros: 0, users: 0 };
      const first = res.rows[0];
      if (first !== undefined) {
        totals = {
          turns: num(first.total_turns),
          spendMicros: num(first.total_spend),
          users: num(first.total_users),
        };
      }

      return {
        users: res.rows.map((r) => ({
          userId: r.user_id,
          turnsLastHour: num(r.turns_hour),
          turnsLast24h: num(r.turns_day),
          inputTokens: num(r.input_tokens),
          outputTokens: num(r.output_tokens),
          cacheReadTokens: num(r.cache_read_tokens),
          cacheWriteTokens: num(r.cache_write_tokens),
          spendMicros: num(r.spend),
          suspended:
            r.suspended_at !== null && r.suspended_by !== null
              ? { at: new Date(r.suspended_at), by: r.suspended_by, note: r.note }
              : null,
        })),
        totals,
        truncated: totals.users > res.rows.length,
      };
    },

    async getSuspension(userId) {
      const row = await db
        .selectFrom('usage_limits_v1_suspensions')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return { at: new Date(row.suspended_at), by: row.suspended_by, note: row.note };
    },

    async suspend({ userId, by, note, now }) {
      const row = await db
        .insertInto('usage_limits_v1_suspensions')
        .values({ user_id: userId, suspended_at: now, suspended_by: by, note })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            suspended_at: now,
            suspended_by: by,
            note,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return { at: new Date(row.suspended_at), by: row.suspended_by, note: row.note };
    },

    async resume(userId) {
      await db.deleteFrom('usage_limits_v1_suspensions').where('user_id', '=', userId).execute();
    },

    async prune(olderThan) {
      const res = await db
        .deleteFrom('usage_limits_v1_buckets')
        .where('bucket_start', '<', olderThan)
        .executeTakeFirst();
      return Number(res.numDeletedRows);
    },
  };
}
