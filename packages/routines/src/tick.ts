import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
import type { RoutinesStore } from './store.js';
import type { RoutineRow, FireStatus } from './types.js';
import { engineFor } from './engines/index.js';
import { advanceToNextActiveWindow } from './active-hours.js';
import { durationToSeconds } from '@ax/validator-routine';
import type { Clock } from './clock.js';

export interface FireResult {
  status: FireStatus;
  conversationId?: string | null;
  error: string | null;
}

export type FireRoutineFn = (
  row: RoutineRow,
  source: 'tick' | 'manual',
) => Promise<FireResult>;

export interface TickOnceInput {
  store: RoutinesStore;
  fire: FireRoutineFn;
  now: Date;
  claimBatchSize: number;
  claimWindowMinutes: number;
}

export async function runTickOnce(input: TickOnceInput): Promise<void> {
  const claimed = await input.store.claimDue({
    now: input.now,
    limit: input.claimBatchSize,
    claimWindowMinutes: input.claimWindowMinutes,
  });

  for (const row of claimed) {
    if (row.activeHours !== null) {
      const adjusted = advanceToNextActiveWindow(input.now, row.activeHours);
      if (adjusted.getTime() > input.now.getTime()) {
        await input.store.advance({
          agentId: row.agentId, path: row.path,
          nextRunAt: adjusted,
          lastRunAt: input.now,
          lastStatus: row.lastStatus ?? 'ok',
          lastError: row.lastError ?? null,
        });
        continue;
      }
    }

    let result: FireResult;
    try {
      result = await input.fire(row, 'tick');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { status: 'error', error: msg, conversationId: null };
    }

    await input.store.recordFire({
      agentId: row.agentId, path: row.path,
      triggerSource: 'tick',
      conversationId: result.conversationId ?? null,
      status: result.status,
      error: result.error,
    });

    // row.nextRunAt has been bumped by claimWindowMinutes by claimDue; recover the
    // original scheduled time so drift control advances from the right baseline.
    const claimOffsetMs = input.claimWindowMinutes * 60 * 1000;
    const originalNextRunAt = row.nextRunAt != null
      ? new Date(row.nextRunAt.getTime() - claimOffsetMs)
      : null;
    const nextAt = computeNextRunAt(row, originalNextRunAt, input.now);
    await input.store.advance({
      agentId: row.agentId, path: row.path,
      nextRunAt: nextAt,
      lastRunAt: input.now,
      lastStatus: result.status,
      lastError: result.error,
    });
  }
}

function computeNextRunAt(row: RoutineRow, originalNextRunAt: Date | null, now: Date): Date | null {
  if (row.trigger.kind === 'webhook') return null;
  const eng = engineFor(row.trigger);
  if (eng === null) return null;

  if (row.trigger.kind === 'interval') {
    const seconds = durationToSeconds(row.trigger.every) ?? 0;
    const prevTarget = originalNextRunAt ?? now;
    const candidate = new Date(prevTarget.getTime() + seconds * 1000);
    const isMoreThanOneBehind =
      now.getTime() - prevTarget.getTime() > seconds * 1000;
    const oneIntervalAhead = new Date(now.getTime() + seconds * 1000);
    return isMoreThanOneBehind ? oneIntervalAhead : candidate;
  }

  return eng.nextRun(row.trigger, now);
}

export interface TickLoopInput {
  db: Kysely<RoutinesDatabase>;
  store: RoutinesStore;
  fire: FireRoutineFn;
  clock: Clock;
  signal: AbortSignal;
  tickIntervalMs: number;
  electionRetryMs: number;
  claimBatchSize: number;
  claimWindowMinutes: number;
}

const ADVISORY_LOCK_KEY = 'ax/routines.tick';

export async function runTickLoop(input: TickLoopInput): Promise<void> {
  while (!input.signal.aborted) {
    // Connection-pin the entire lifetime of one election attempt + tick
    // burst. pg_try_advisory_lock is session-scoped; the lock acquired
    // here is held only for the duration of the callback (Kysely returns
    // the connection to the pool on exit, which also releases the lock).
    //
    // Note: store operations inside runTickOnce still go through the pool
    // (not the pinned connection). That's fine — claimDue's correctness
    // comes from FOR UPDATE SKIP LOCKED (row-level, not session-level).
    // The advisory lock just gates which replica is the active "ticker."
    await input.db.connection().execute(async (pinned) => {
      const acquired = await tryAcquireAdvisoryLock(pinned);
      if (!acquired) {
        await input.clock.sleep(input.electionRetryMs, input.signal);
        return;
      }
      try {
        while (!input.signal.aborted) {
          try {
            await runTickOnce({
              store: input.store, fire: input.fire,
              now: input.clock.now(),
              claimBatchSize: input.claimBatchSize,
              claimWindowMinutes: input.claimWindowMinutes,
            });
          } catch (err) {
            process.stderr.write(
              `[ax/routines] tick error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
          await input.clock.sleep(input.tickIntervalMs, input.signal);
        }
      } finally {
        await releaseAdvisoryLock(pinned);
      }
    });
  }
}

async function tryAcquireAdvisoryLock(db: Kysely<RoutinesDatabase>): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT pg_try_advisory_lock(hashtext(${ADVISORY_LOCK_KEY})) AS ok
  `.execute(db);
  return r.rows[0]?.ok === true;
}

async function releaseAdvisoryLock(db: Kysely<RoutinesDatabase>): Promise<void> {
  try {
    await sql`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK_KEY}))`.execute(db);
  } catch {
    // disconnect handles it
  }
}
