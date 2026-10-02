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
//
// Estimated spend (the number every cap and the admin view use) is, per user
// over the window:
//
//   GREATEST(SUM(cost_micros), SUM(provider_cost_micros)) + SUM(helper_cost_micros)
//
// `cost_micros` (what the runner reported) and `provider_cost_micros` (what the
// credential proxy measured) are two independent measurements of the SAME
// model traffic, so the larger one is taken and they are NEVER added: adding
// would bill every honest turn twice. A direct call from user code in the
// sandbox is seen only by the proxy, so it shows up as the excess of the second
// over the first; a proxy that failed to read a response falls back to the
// runner's figure. `helper_cost_micros` is host-side helper calls, which never
// cross the proxy, so it rides on top. Sums are taken over the whole window
// first and compared after, not compared bucket by bucket.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The credential proxy stops splicing the operator's key into a user's
 * requests once their estimated spend reaches this multiple of the daily
 * limit. `chat:start` refuses a NEW turn at 1x; a turn that was admitted may
 * run past that, and cutting it off mid-flight would strand honest work, so
 * the sandbox only loses the key at 2x. A loop of direct calls has no turn to
 * finish and is stopped there too.
 */
export const PROVIDER_CEILING_MULTIPLE = 2;

export type AdmitRefusal =
  | 'usage-suspended'
  | 'usage-limit-daily'
  | 'usage-limit-rate'
  | 'usage-limit-fleet';
export type AdmitResult = { ok: true } | { ok: false; reason: AdmitRefusal };

/**
 * The answer the credential proxy acts on: is this user's key still unlocked?
 * `usage-check-unavailable` is produced by the service when the check itself
 * broke (fail closed); the store only ever yields the first two reasons.
 */
export type ProviderVerdict =
  | { blocked: false }
  | {
      blocked: true;
      reason:
        | 'usage-suspended'
        | 'usage-limit-daily'
        | 'usage-limit-fleet'
        | 'usage-check-unavailable';
    };

/** The spend expression above, as an aggregate over a user's buckets. */
const SPEND_MICROS_SQL = sql`
  GREATEST(COALESCE(SUM(cost_micros), 0), COALESCE(SUM(provider_cost_micros), 0))
    + COALESCE(SUM(helper_cost_micros), 0)
`;

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

export interface UserLimits {
  dailySpendUsd?: number;
  turnsPerHour?: number;
}

export interface UsageStore {
  getUserLimits(userId: string): Promise<UserLimits | null>;
  setUserLimits(userId: string, overrides: UserLimits | null): Promise<void>;
  userSummary(input: { userId: string; now: Date }): Promise<UserUsageSummary>;
  fleetSpend(now: Date): Promise<number>;
  /** Atomic completion of an admitted turn, ignoring duplicate/error-after-success events. */
  settleTurn(input: {
    userId: string;
    reqId: string;
    usage: RecordedUsage;
    now: Date;
    allowUnadmitted?: boolean;
  }): Promise<void>;
  /** Gate a new turn: refuse at 1x the daily limit, else count it. */
  admit(input: {
    userId: string;
    limits: UsageLimits;
    now: Date;
    reqId?: string;
  }): Promise<AdmitResult>;
  /** Runner-reported turn usage: tokens, and the cost into `cost_micros`. */
  record(input: { userId: string; usage: RecordedUsage; now: Date }): Promise<void>;
  /** A host-side helper call: tokens as `record`, but the cost into `helper_cost_micros`. */
  recordHelper(input: { userId: string; usage: RecordedUsage; now: Date }): Promise<void>;
  /**
   * What the credential proxy measured for one model response. Touches ONLY
   * `provider_cost_micros`: tokens are not recorded here, the runner-reported
   * path already carries them.
   */
  recordProvider(input: { userId: string; costMicros: number; now: Date }): Promise<void>;
  /**
   * Should the credential proxy still unlock this user's key? Read-only: takes
   * no advisory lock and never counts a turn, because the proxy asks on every
   * provider call.
   */
  providerStatus(input: {
    userId: string;
    limits: UsageLimits;
    now: Date;
  }): Promise<ProviderVerdict>;
  summary(input: { now: Date; limit?: number; limits: UsageLimits }): Promise<UsageSummary>;
  getSuspension(userId: string): Promise<Suspension | null>;
  suspend(input: {
    userId: string;
    by: string;
    note: string | null;
    now: Date;
  }): Promise<Suspension>;
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

/** What one write adds to a bucket. Every field is a delta; 0 leaves a column alone. */
interface BucketDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  providerCostMicros: number;
  helperCostMicros: number;
}

/**
 * Add `delta` into the user's bucket for the minute of `now`, creating it if
 * needed. Does NOT touch `turns`: only `admit` counts a turn.
 */
async function addToBucket(
  db: Kysely<UsageLimitsDatabase>,
  userId: string,
  now: Date,
  delta: BucketDelta,
): Promise<void> {
  await db
    .insertInto('usage_limits_v1_buckets')
    .values({
      user_id: userId,
      bucket_start: floorToMinute(now.getTime()),
      input_tokens: whole(delta.inputTokens),
      output_tokens: whole(delta.outputTokens),
      cache_read_tokens: whole(delta.cacheReadTokens),
      cache_write_tokens: whole(delta.cacheWriteTokens),
      cost_micros: whole(delta.costMicros),
      provider_cost_micros: whole(delta.providerCostMicros),
      helper_cost_micros: whole(delta.helperCostMicros),
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'bucket_start']).doUpdateSet({
        input_tokens: sql`usage_limits_v1_buckets.input_tokens + EXCLUDED.input_tokens`,
        output_tokens: sql`usage_limits_v1_buckets.output_tokens + EXCLUDED.output_tokens`,
        cache_read_tokens: sql`usage_limits_v1_buckets.cache_read_tokens + EXCLUDED.cache_read_tokens`,
        cache_write_tokens: sql`usage_limits_v1_buckets.cache_write_tokens + EXCLUDED.cache_write_tokens`,
        cost_micros: sql`usage_limits_v1_buckets.cost_micros + EXCLUDED.cost_micros`,
        provider_cost_micros: sql`usage_limits_v1_buckets.provider_cost_micros + EXCLUDED.provider_cost_micros`,
        helper_cost_micros: sql`usage_limits_v1_buckets.helper_cost_micros + EXCLUDED.helper_cost_micros`,
      }),
    )
    .execute();
}

async function fleetSpend(connection: Kysely<UsageLimitsDatabase>, now: Date): Promise<number> {
  const start = floorToMinute(now.getTime() - DAY_MS);
  // Compare the two measurements PER USER, then sum. Comparing fleet
  // totals would let one user's missing runner report hide another's calls.
  const result = await sql<{ spend: string }>`
        SELECT COALESCE(SUM(spend), 0) AS spend FROM (
          SELECT ${SPEND_MICROS_SQL} AS spend FROM usage_limits_v1_buckets
          WHERE bucket_start >= ${start} GROUP BY user_id
        ) users
      `.execute(connection);
  return num(result.rows[0]?.spend);
}

export function createUsageStore(db: Kysely<UsageLimitsDatabase>): UsageStore {
  return {
    async getUserLimits(userId) {
      const row = await db
        .selectFrom('usage_limits_v1_user_limits')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row === undefined
        ? null
        : {
            ...(row.daily_spend_usd === null ? {} : { dailySpendUsd: Number(row.daily_spend_usd) }),
            ...(row.turns_per_hour === null ? {} : { turnsPerHour: row.turns_per_hour }),
          };
    },
    async setUserLimits(userId, overrides) {
      if (overrides === null) {
        await db.deleteFrom('usage_limits_v1_user_limits').where('user_id', '=', userId).execute();
        return;
      }
      const values = {
        user_id: userId,
        daily_spend_usd: overrides.dailySpendUsd ?? null,
        turns_per_hour: overrides.turnsPerHour ?? null,
      };
      await db
        .insertInto('usage_limits_v1_user_limits')
        .values(values)
        .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
        .execute();
    },
    async userSummary({ userId, now }) {
      const dayStart = floorToMinute(now.getTime() - DAY_MS);
      const hourStart = floorToMinute(now.getTime() - HOUR_MS);
      const result = await sql<{
        spend: string;
        turns_hour: string;
        turns_day: string;
      }>`
        SELECT ${SPEND_MICROS_SQL} AS spend, COALESCE(SUM(turns),0) AS turns_day,
          COALESCE(SUM(turns) FILTER (WHERE bucket_start >= ${hourStart}),0) AS turns_hour
        FROM usage_limits_v1_buckets WHERE user_id = ${userId} AND bucket_start >= ${dayStart}
      `.execute(db);
      const row = result.rows[0];
      return {
        userId,
        spendMicros: num(row?.spend),
        turnsLastHour: num(row?.turns_hour),
        turnsLast24h: num(row?.turns_day),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        suspended: await this.getSuspension(userId),
      };
    },
    async fleetSpend(now) {
      return fleetSpend(db, now);
    },
    async settleTurn({ userId, reqId, usage, now, allowUnadmitted = false }) {
      await db.transaction().execute(async (trx) => {
        if (allowUnadmitted) {
          await trx
            .insertInto('usage_limits_v1_turns')
            .values({ user_id: userId, request_id: reqId, admitted_at: now })
            .onConflict((oc) => oc.columns(['user_id', 'request_id']).doNothing())
            .execute();
        }
        const claimed = await trx
          .updateTable('usage_limits_v1_turns')
          .set({ settled: true })
          .where('user_id', '=', userId)
          .where('request_id', '=', reqId)
          .where('settled', '=', false)
          .returning('request_id')
          .executeTakeFirst();
        if (claimed)
          await addToBucket(trx, userId, now, {
            ...usage,
            providerCostMicros: 0,
            helperCostMicros: 0,
          });
      });
    },
    async admit({ userId, limits, now, reqId }) {
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

        const sums = await sql<{
          spend: string | null;
          turns_hour: string | null;
        }>`
          SELECT
            ${SPEND_MICROS_SQL} AS spend,
            SUM(turns) FILTER (WHERE bucket_start >= ${hourStart}) AS turns_hour
          FROM usage_limits_v1_buckets
          WHERE user_id = ${userId} AND bucket_start >= ${dayStart}
        `.execute(trx);
        const row = sums.rows[0];
        if (num(row?.spend) >= capMicros)
          return { ok: false, reason: 'usage-limit-daily' } as const;
        if (num(row?.turns_hour) >= limits.turnsPerHour) {
          return { ok: false, reason: 'usage-limit-rate' } as const;
        }

        if ((await fleetSpend(trx, now)) >= Math.round(limits.fleetDailySpendUsd * 1_000_000)) {
          return { ok: false, reason: 'usage-limit-fleet' } as const;
        }
        if (reqId !== undefined) {
          const row = await trx
            .insertInto('usage_limits_v1_turns')
            .values({ user_id: userId, request_id: reqId, admitted_at: now })
            .onConflict((oc) => oc.columns(['user_id', 'request_id']).doNothing())
            .returning('request_id')
            .executeTakeFirst();
          if (!row) return { ok: true } as const;
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
      await addToBucket(db, userId, now, {
        ...usage,
        providerCostMicros: 0,
        helperCostMicros: 0,
      });
    },

    async recordHelper({ userId, usage, now }) {
      await addToBucket(db, userId, now, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costMicros: 0,
        providerCostMicros: 0,
        helperCostMicros: usage.costMicros,
      });
    },

    async recordProvider({ userId, costMicros, now }) {
      await addToBucket(db, userId, now, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicros: 0,
        providerCostMicros: costMicros,
        helperCostMicros: 0,
      });
    },

    async providerStatus({ userId, limits, now }) {
      const dayStart = floorToMinute(now.getTime() - DAY_MS);
      // Read-only on purpose (no advisory lock, no turn counted): the proxy
      // asks on every provider call, and a stale-by-a-few-milliseconds answer
      // costs at most one more call, which the in-flight cap already bounds.
      const suspended = await db
        .selectFrom('usage_limits_v1_suspensions')
        .select('user_id')
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (suspended !== undefined) return { blocked: true, reason: 'usage-suspended' };

      const res = await sql<{ spend: string | null }>`
        SELECT ${SPEND_MICROS_SQL} AS spend
        FROM usage_limits_v1_buckets
        WHERE user_id = ${userId} AND bucket_start >= ${dayStart}
      `.execute(db);
      const ceilingMicros = Math.round(
        limits.dailySpendUsd * 1_000_000 * PROVIDER_CEILING_MULTIPLE,
      );
      if (num(res.rows[0]?.spend) >= ceilingMicros) {
        return { blocked: true, reason: 'usage-limit-daily' };
      }
      if ((await this.fleetSpend(now)) >= Math.round(limits.fleetDailySpendUsd * 1_000_000)) {
        return { blocked: true, reason: 'usage-limit-fleet' };
      }
      return { blocked: false };
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
            ${SPEND_MICROS_SQL} AS spend
          FROM usage_limits_v1_buckets
          WHERE bucket_start >= ${dayStart}
          GROUP BY user_id
        ),
        merged AS (
          SELECT
            COALESCE(u.user_id, s.user_id, l.user_id) AS user_id,
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
          FULL OUTER JOIN usage_limits_v1_user_limits l ON l.user_id = COALESCE(u.user_id, s.user_id)
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
              ? {
                  at: new Date(r.suspended_at),
                  by: r.suspended_by,
                  note: r.note,
                }
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
      return {
        at: new Date(row.suspended_at),
        by: row.suspended_by,
        note: row.note,
      };
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
      return {
        at: new Date(row.suspended_at),
        by: row.suspended_by,
        note: row.note,
      };
    },

    async resume(userId) {
      await db.deleteFrom('usage_limits_v1_suspensions').where('user_id', '=', userId).execute();
    },

    async prune(olderThan) {
      await db.deleteFrom('usage_limits_v1_turns').where('admitted_at', '<', olderThan).execute();
      const res = await db
        .deleteFrom('usage_limits_v1_buckets')
        .where('bucket_start', '<', olderThan)
        .executeTakeFirst();
      return Number(res.numDeletedRows);
    },
  };
}
