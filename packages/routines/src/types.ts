import type { CheckInMiss, RoutineDefinition, RoutineKind, RoutineReportStatus } from '@ax/routines-contract';
export type { ActiveHours, CheckInMiss, RoutineTrigger as TriggerSpec } from '@ax/routines-contract';
export type FireSource = 'tick' | 'webhook' | 'manual';
export type FireStatus = 'ok' | 'silenced' | 'error';
/**
 * TASK-907. A task's latest report and the notes it keeps between check-ins
 * (`agentNotes`, the `agent_notes` column; the report's input calls them
 * `notes`). Agent-written text.
 */
export type StoredTaskState = { status: RoutineReportStatus; update: string; ask: string | null; agentNotes: string | null; reportedAt: Date };
/**
 * TASK-930. A task's check-ins in a row that ended without a report: how many,
 * the last one's reason and start, and when the host paused the task for them
 * (null if it hasn't). Host-written: counts, closed codes and instants, never
 * agent text.
 */
export type StoredNoRecentUpdate = { inARow: number; reason: CheckInMiss; at: Date; autoPausedAt: Date | null };
/** Below the hook bus. Owner identity is pinned independently from the editing actor. */
export type StoredRoutine = RoutineDefinition & {
  agentId: string; routineId: string; revision: string; ownerUserId: string;
  definitionId: string | null; definitionUpdatedAt: Date | null;
  nextRunAt: Date | null; lastRunAt: Date | null;
  lastStatus: FireStatus | null; lastError: string | null; lastWarning: string | null;
  /** TASK-907. Null until the first report, and again after an edit that changes the routine's kind. */
  task: StoredTaskState | null;
  /**
   * TASK-930. Null when there are none: the latest check-in reported, or none
   * has finished, and again after a person's Resume or a kind change. Written
   * only by `finishDispatch` and `updateAuthored`.
   */
  noRecentUpdate: StoredNoRecentUpdate | null;
};
export interface FireRow {
  id: number; agentId: string; routineId: string; firedAt: Date;
  triggerSource: FireSource; conversationId: string | null;
  status: FireStatus; error: string | null; renderedPrompt: string | null; warning: string | null;
  /** TASK-907. Null when the run made no report. */
  report: DispatchReport | null;
}
export interface RoutinesConfig {
  tickIntervalMs?: number; claimBatchSize?: number;
  claimWindowMinutes?: number; electionRetryMs?: number;
}
export type AcceptedDispatch = {
  dispatchId: string; reqId: string; row: StoredRoutine; source: FireSource; acceptedAt: Date;
};
/**
 * TASK-930. Why an `error` run left no report, set by the code that recorded it,
 * which knows (never parsed from the error's text). Absent: `failed`. A run
 * that didn't end in an error left no report because it didn't send one
 * (`no-report`), and only the store says so.
 */
export type DispatchMiss = Exclude<CheckInMiss, 'no-report'>;
export type DispatchOutcome = {
  status: FireStatus; conversationId: string | null; error: string | null;
  renderedPrompt: string | null; warning: string | null;
  /**
   * TASK-930. Read only for a task's `error` run that left no report. `| undefined`
   * because `DispatchOutcomeSchema`'s parse (as `getDispatchOutcome` returns it) says so.
   */
  miss?: DispatchMiss | undefined;
};
/** TASK-907. One run's report: kept on its dispatch, then on its fire row. The notes stay on the task. */
export type DispatchReport = { status: RoutineReportStatus; update: string; ask: string | null };
/** TASK-907. The one open run in a conversation, as `routine_report` finds it. */
export type OpenCheckIn = { dispatchId: string; routineId: string; kind: RoutineKind; ownerUserId: string };
/** TASK-907. What `routine_report`'s lookup found in a conversation: its one open run, or why there's none to report on. */
export type OpenCheckInLookup = { run: OpenCheckIn } | { run: null; reason: 'no-open-run' | 'ambiguous' | 'routine-gone' };
/** TASK-907. Why `recordReport` wrote nothing, decided under the run's locks: fixed words an operator's log can carry. */
export type ReportRefusal = 'agent-retired' | 'run-closed' | 'not-bound' | 'routine-gone' | 'kind' | 'owner';
/**
 * TASK-907. `conversationId` is the conversation the report came from (host-set
 * context); the run must be bound to it. `notes` left out keeps the task's
 * notes; null clears them. A run accepted at or before the last clear can't
 * change the notes (TASK-910).
 */
export type RecordReportInput = {
  agentId: string; dispatchId: string; conversationId: string; actorUserId: string;
  report: DispatchReport; notes?: string | null; now: Date;
};
