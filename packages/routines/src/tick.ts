import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
import { createRoutinesStore, type RoutinesStore } from './store.js';
import type { RoutineRow, FireStatus } from './types.js';
import { engineFor } from './engines/index.js';
import { advanceToNextActiveWindow } from './active-hours.js';
import { durationToSeconds } from '@ax/validator-routine';
import type { Clock } from './clock.js';

export interface FireResult {
  status: FireStatus;
  conversationId?: string | null;
  error: string | null;
  /**
   * The prompt that was actually rendered and sent to the agent.
   * `null` when fireRoutine returned before reaching the render step
   * (e.g., agents:resolve or conversations:create failed). Non-null on
   * `'ok'` and `'silenced'`, and on `'error'` paths that errored after
   * rendering.
   */
  renderedPrompt: string | null;
}

export type FireRoutineFn = (
  row: RoutineRow,
  source: 'tick' | 'manual',
) => Promise<FireResult>;

export interface TickOnceInput {
  store: RoutinesStore;
  fire: FireRoutineFn;
  /**
   * Returns every agent id the tick loop should consider for lazy
   * materialization of default-sourced rows. Optional so existing
   * callers (tests that don't exercise the defaults path) can omit it;
   * when absent, materialize/refresh is skipped and only pre-existing
   * rows are claimed.
   *
   * Plugin wiring is in plugin.ts — it adapts the `agents:list-ids`
   * service hook into this callback shape so tick.ts stays free of
   * HookBus imports.
   */
  getAgentIds?: () => Promise<string[]>;
  now: Date;
  claimBatchSize: number;
  claimWindowMinutes: number;
}

export async function runTickOnce(input: TickOnceInput): Promise<void> {
  // Materialize + refresh BEFORE claim so newly-created agents and
  // edited defaults are visible in the same tick.
  //
  // I-R10: a failure here MUST NOT crash the tick — workspace-row
  // claims happen unconditionally below. We log to stderr and
  // continue; the next tick will retry.
  if (input.getAgentIds !== undefined) {
    try {
      // getAgentIds hits the shared pg pool via agents:list-ids. Same
      // connection-checkout dependency on pool.max > 1 as input.fire()
      // — when pool.max === 1, both block waiting on the pinned
      // advisory-lock session. Production defaults poolMax=10
      // (packages/database-postgres/src/plugin.ts).
      const agentIds = await input.getAgentIds();
      await input.store.materializeMissing({ agentIds, now: input.now });
      await input.store.refreshStale({ now: input.now });
    } catch (err) {
      process.stderr.write(
        `[ax/routines] materialize/refresh error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const claimed = await input.store.claimDue({
    now: input.now,
    limit: input.claimBatchSize,
    claimWindowMinutes: input.claimWindowMinutes,
  });

  for (const row of claimed) {
    if (row.activeHours !== null) {
      const adjusted = advanceToNextActiveWindow(input.now, row.activeHours);
      if (adjusted.getTime() > input.now.getTime()) {
        // Default-sourced rows MUST keep next_run_at NULL (the
        // routines_v1_default_next_run_at_chk CHECK constraint).
        // Their next-due computation is COALESCE(last_run_at,
        // created_at) + d.interval_seconds, so setting last_run_at
        // to the next active-window boundary defers the next claim
        // past the inactive period — the next active window's claim
        // re-evaluates activeHours from scratch.
        //
        // Workspace rows keep the legacy behaviour: next_run_at is
        // bumped explicitly and last_run_at stays at `now`.
        const isDefaultSourced = row.definitionId !== null;
        await input.store.advance({
          agentId: row.agentId, path: row.path,
          nextRunAt: isDefaultSourced ? null : adjusted,
          lastRunAt: isDefaultSourced ? adjusted : input.now,
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
      result = { status: 'error', error: msg, conversationId: null, renderedPrompt: null };
    }

    await input.store.recordFire({
      agentId: row.agentId, path: row.path,
      triggerSource: 'tick',
      conversationId: result.conversationId ?? null,
      status: result.status,
      error: result.error,
      renderedPrompt: result.renderedPrompt,
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
  // Default-sourced rows MUST keep next_run_at NULL — the claim SQL
  // computes due-ness from last_run_at + d.interval_seconds, and the
  // routines_v1_default_next_run_at_chk CHECK constraint forbids a
  // non-null next_run_at when definition_id IS NOT NULL. Returning
  // null here keeps the row eligible for the next default-branch
  // claim without tripping the constraint.
  if (row.definitionId !== null) return null;
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
  fire: FireRoutineFn;
  /**
   * Threaded straight through to `runTickOnce`. Optional for the same
   * reason — existing tests can omit it and only exercise the
   * workspace-row path.
   */
  getAgentIds?: () => Promise<string[]>;
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
    // Connection-pin the elected ticker's whole lifetime. Both the advisory
    // lock and the store ops it gates must run on the same backend session
    // (pg_try_advisory_lock is session-scoped, and routing store ops to
    // other pool connections would self-deadlock when pool.max === 1 since
    // the only free connection is the one we just pinned).
    //
    // Losing replicas DO NOT sleep inside execute() — they return early so
    // the connection rejoins the pool during electionRetryMs backoff,
    // keeping idle backend count = (active tickers), not (replica count).
    const acquired = await input.db.connection().execute(async (pinned) => {
      const locked = await tryAcquireAdvisoryLock(pinned);
      if (!locked) return false;
      const pinnedStore = createRoutinesStore(pinned);
      try {
        while (!input.signal.aborted) {
          try {
            const tickInput: Parameters<typeof runTickOnce>[0] = {
              store: pinnedStore, fire: input.fire,
              now: input.clock.now(),
              claimBatchSize: input.claimBatchSize,
              claimWindowMinutes: input.claimWindowMinutes,
            };
            if (input.getAgentIds !== undefined) {
              tickInput.getAgentIds = input.getAgentIds;
            }
            await runTickOnce(tickInput);
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
      return true;
    });

    if (!acquired) {
      await input.clock.sleep(input.electionRetryMs, input.signal);
    }
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
