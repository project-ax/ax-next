import { SafeToolError } from '@ax/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
import { createRoutinesStore, type RoutinesStore } from './store.js';
import type { StoredRoutine, AcceptedDispatch, FireStatus } from './types.js';
import { engineFor } from './engines/index.js';
import { advanceToNextActiveWindow } from './active-hours.js';
import { durationToSeconds } from '@ax/routines-contract';
import type { Clock } from './clock.js';

export interface FireResult {
  status: FireStatus;
  conversationId?: string | null;
  error: string | null;
  /** The rendered user prompt, or null if execution authorization/setup failed. */
  renderedPrompt: string | null;
  /** Exact agents:resolve not-found: the shared purge path has removed the agent's routines. */
  agentGone?: true;
  /** Invocation started; the pending correlation owner records its terminal outcome. */
  recordedAtTurnEnd?: boolean;
}

export type FireRoutineFn = (accepted: AcceptedDispatch) => Promise<FireResult>;

export interface TickOnceInput {
  store: RoutinesStore;
  fire: FireRoutineFn;
  /**
   * Returns each personal agent the tick loop should consider, paired with
   * its owner user id. That pairing does two jobs:
   *
   *   1. lazy materialization of default-sourced rows, and
   *   2. TASK-397 — `reconcileOwners`, which re-asserts the owner on EVERY
   *      routine of a user-owned agent, authored ones included.
   *
   * The owner id is what `fire.ts` passes to `agents:resolve` (whose ACL gate
   * has no concept of a system actor), so it has to be a real user. Optional
   * so existing callers can omit it; when absent, materialize / reconcile /
   * refresh are all skipped and only pre-existing rows are claimed.
   *
   * Plugin wiring is in plugin.ts — it adapts the
   * `agents:list-personal-owners` service hook into this callback
   * shape so tick.ts stays free of HookBus imports. Team agents retain their
   * creator as execution owner and are excluded from
   * personal-owner reconciliation.
   */
  getAgents?: () => Promise<Array<{ agentId: string; ownerUserId: string }>>;
  now: Date;
  claimBatchSize: number;
  claimWindowMinutes: number;
  cleanup?: () => Promise<void>;
}

export async function runTickOnce(input: TickOnceInput): Promise<void> {
  // Materialize + refresh BEFORE claim so newly-created agents and
  // edited defaults are visible in the same tick.
  //
  // I-R10: a failure here MUST NOT crash the tick — authored-row
  // claims happen unconditionally below. We log to stderr and
  // continue; the next tick will retry.
  if (input.getAgents !== undefined) {
    try {
      // getAgents hits the shared pg pool via
      // agents:list-personal-owners. Same connection-checkout
      // dependency on pool.max > 1 as input.fire() — when
      // pool.max === 1, both block waiting on the pinned
      // advisory-lock session. Production defaults poolMax=10
      // (packages/database-postgres/src/plugin.ts).
      const agents = await input.getAgents();
      await input.store.materializeMissing({ agents, now: input.now });
      // TASK-397: re-assert agent ownership BEFORE the claim below, so a row
      // whose stored identity has drifted (created by a teammate, or written
      // before this became agent-derived) fires under the agent's owner in
      // THIS tick rather than the next one.
      await input.store.reconcileOwners({ agents });
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
    // A queued reply is the person's explicit request to check now, like its
    // immediate manual path. App updates and scheduled checks still wait for
    // the next active window.
    const requested = row.kind !== 'repeat' && row.activeHours !== null
      && await input.store.hasTaskCheckInRequest({ agentId: row.agentId, routineId: row.routineId });
    if (row.activeHours !== null && !requested) {
      const adjusted = advanceToNextActiveWindow(input.now, row.activeHours);
      if (adjusted === null || adjusted.getTime() > input.now.getTime()) {
        await input.store.advance({
          agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision,
          nextRunAt: row.definitionId === null ? adjusted : null,
          ...(row.kind === 'repeat' ? { lastRunAt: row.definitionId === null ? input.now : adjusted ?? input.now } : {}),
        });
        continue;
      }
    }
    let dispatch;
    try {
      dispatch = await input.store.acceptDispatch({
        agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision,
        actorUserId: row.ownerUserId, source: 'tick', requestId: crypto.randomUUID(), now: input.now,
      });
    } catch (err) {
      // A previous row in this batch may have discovered and purged the same agent.
      if (err instanceof SafeToolError && err.toolCode === 'not-found') continue;
      if (err instanceof SafeToolError && err.toolCode === 'busy') {
        // An active task's finish recalculates its next due time. Restoring an
        // older claim here could overwrite a finish that just acquired the
        // task lock. Repeat retains its independently scheduled capacity retry.
        if (row.kind === 'repeat') await input.store.advance({agentId:row.agentId,routineId:row.routineId,expectedRevision:row.revision,nextRunAt:row.nextRunAt===null?null:new Date(row.nextRunAt.getTime()-input.claimWindowMinutes*60_000)});
        continue;
      }
      throw err;
    }
    if (!dispatch || dispatch.replayed) continue;
    const originalNextRunAt = row.nextRunAt === null ? null
      : new Date(row.nextRunAt.getTime() - input.claimWindowMinutes * 60_000);
    // Advance scheduling independently of terminal status, and only for this revision.
    // Task acceptance already resets its full-check timer and snapshots its
    // FIFO batch under the task lock. Advancing here could overwrite a nudge
    // that arrived after that transaction. Repeat keeps its existing cadence.
    if (row.kind === 'repeat') await input.store.advance({
      agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision,
      nextRunAt: computeNextRunAt(row, originalNextRunAt, input.now), lastRunAt: input.now,
    });
    try { await input.fire(dispatch.accepted); }
    catch (err) {
      await input.store.finishDispatch({ dispatchId: dispatch.accepted.dispatchId, outcome: {
        status: 'error', error: err instanceof Error ? err.message : String(err),
        conversationId: null, renderedPrompt: null, warning: row.lastWarning,
      } });
    }
  }
  await input.cleanup?.();
}

function computeNextRunAt(row: StoredRoutine, originalNextRunAt: Date | null, now: Date): Date | null {
  // Default-sourced rows MUST keep next_run_at NULL — the claim SQL
  // computes due-ness from last_run_at + d.interval_seconds, and the
  // routines_v1_default_next_run_at_chk CHECK constraint forbids a
  // non-null next_run_at when definition_id IS NOT NULL. Returning
  // null here keeps the row eligible for the next default-branch
  // claim without tripping the constraint.
  if (row.definitionId !== null) return null;
  if (row.schedule === null) return null;
  const eng = engineFor(row.schedule);
  if (eng === null) return null;

  if (row.schedule.kind === 'interval') {
    const seconds = durationToSeconds(row.schedule.every) ?? 0;
    const prevTarget = originalNextRunAt ?? now;
    const candidate = new Date(prevTarget.getTime() + seconds * 1000);
    const isMoreThanOneBehind =
      now.getTime() - prevTarget.getTime() > seconds * 1000;
    const oneIntervalAhead = new Date(now.getTime() + seconds * 1000);
    return isMoreThanOneBehind ? oneIntervalAhead : candidate;
  }

  return eng.nextRun(row.schedule, now);
}

export interface TickLoopInput {
  db: Kysely<RoutinesDatabase>;
  executorId?: string;
  fire: FireRoutineFn;
  /**
   * Threaded straight through to `runTickOnce`. Optional for the same
   * reason — existing tests can omit it and only exercise the
   * authored-row path.
   */
  getAgents?: () => Promise<Array<{ agentId: string; ownerUserId: string }>>;
  cleanup?: () => Promise<void>;
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
      const pinnedStore = createRoutinesStore(pinned,input.executorId);
      try {
        while (!input.signal.aborted) {
          try {
            const tickInput: Parameters<typeof runTickOnce>[0] = {
              store: pinnedStore, fire: input.fire,
              ...(input.cleanup ? { cleanup: input.cleanup } : {}),
              now: input.clock.now(),
              claimBatchSize: input.claimBatchSize,
              claimWindowMinutes: input.claimWindowMinutes,
            };
            if (input.getAgents !== undefined) {
              tickInput.getAgents = input.getAgents;
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
