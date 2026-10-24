import type { CheckInMiss, RoutineDefinition, RoutineKind, RoutineReportStatus, RoutineStepAuthor, RoutineStepOp } from '@ax/routines-contract';
export type { ActiveHours, CheckInMiss, RoutineTrigger as TriggerSpec } from '@ax/routines-contract';
export type FireSource = 'tick' | 'webhook' | 'manual';
export type FireStatus = 'ok' | 'silenced' | 'error';
/**
 * TASK-952. One number an agent read at a check-in, with the label it gave it.
 * Agent-written. Kept in columns of its own beside a report, never in the
 * dispatch's report JSON (`DispatchReportSchema` is strict, card decision 4).
 */
export type StoredReading = { value: number; label: string };
/**
 * TASK-907. A task's latest report and the notes it keeps between check-ins
 * (`agentNotes`, the `agent_notes` column; the report's input calls them
 * `notes`). Agent-written text. TASK-952: `reading` is the reading that report
 * sent, or null when it sent none.
 */
export type StoredTaskState = { status: RoutineReportStatus; update: string; ask: string | null; agentNotes: string | null; reportedAt: Date; reading: StoredReading | null };
/**
 * TASK-930. A task's check-ins in a row that ended without a report: how many,
 * the last one's reason and start, and when the host paused the task for them
 * (null if it hasn't). Host-written: counts, closed codes and instants, never
 * agent text.
 */
export type StoredNoRecentUpdate = { inARow: number; reason: CheckInMiss; at: Date; autoPausedAt: Date | null };
/** TASK-948. One step of a "get-done" task's checklist, as stored. The id is host-made; the text is agent- or person-written. */
export type StoredStep = { id: string; text: string; done: boolean; addedBy: RoutineStepAuthor };
/** Below the hook bus. Owner identity is pinned independently from the editing actor. */
export type StoredRoutine = RoutineDefinition & {
  agentId: string; routineId: string; revision: string; ownerUserId: string;
  definitionId: string | null; definitionUpdatedAt: Date | null;
  nextRunAt: Date | null; lastRunAt: Date | null;
  lastStatus: FireStatus | null; lastError: string | null; lastWarning: string | null;
  /**
   * TASK-907. Null until the first report, and again after an edit that changes
   * the routine's kind or a change of owner (`reconcileOwners`, TASK-936).
   */
  task: StoredTaskState | null;
  /**
   * TASK-930. Null when there are none: the latest check-in reported, or none
   * has finished, and again after a person's Resume, a kind change or a change
   * of owner. Written only by `finishDispatch`, `updateAuthored` and
   * `reconcileOwners` (TASK-936); the last two only clear them.
   */
  noRecentUpdate: StoredNoRecentUpdate | null;
  /**
   * TASK-948. A "get-done" task's checklist, in order. Empty for any other
   * kind, until the agent drafts it or its owner adds a step (TASK-949), and
   * after a change of kind or of owner.
   */
  steps: StoredStep[];
  /**
   * TASK-951. A "get-done" task's finish date, `YYYY-MM-DD`, set only by a
   * person (`setFinishBy`); null when none, for any other kind, and after a
   * change of kind. A change of owner keeps it. A stored value the contract's
   * rule refuses reads as null.
   */
  finishBy: string | null;
};
export interface FireRow {
  id: number; agentId: string; routineId: string; firedAt: Date;
  triggerSource: FireSource; conversationId: string | null;
  status: FireStatus; error: string | null; renderedPrompt: string | null; warning: string | null;
  /** TASK-907. Null when the run made no report. */
  report: FireReport | null;
  /**
   * TASK-936. The routine's owner as the history read found it, in the same
   * statement. That read lists a live routine's runs only when they ran as its
   * owner, so this is also who the run ran as. Null when the routine is gone.
   * Who may see the run's report (`fireViews`); it never reaches a view.
   */
  routineOwnerUserId: string | null;
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
/** TASK-931. A person's reply on a task, as stored. Person-written. */
export type StoredReply = { replyId: string; authorUserId: string; text: string; sentAt: Date };
/**
 * TASK-931. What `addReply` did. `replayed`: this person's same request on this
 * routine stored a reply before, and `replyId` is that one. Either way `row` is
 * the routine as read under its row lock.
 */
export type AddReplyResult = { outcome: 'added' | 'replayed'; replyId: string; row: StoredRoutine } | 'not-found' | 'forbidden';
/**
 * TASK-949. What `setSteps` did with a person's changes to a get-done task's
 * steps: the steps after them, as read under the routine's row lock, and how
 * many of the changes were skipped. A replay answers the first try's count
 * with the steps as they are now. `replayed`: the store answered from the
 * request's receipt (the same request again), for the log line only.
 */
export type SetStepsResult = { steps: StoredStep[]; skipped: number; replayed: boolean } | 'not-found' | 'forbidden';
/**
 * TASK-907. One run's report: kept on its dispatch as JSON (`DispatchReportSchema`,
 * strict), then on its fire row. The notes stay on the task. TASK-952: this is
 * the JSON's shape, so it never holds the run's reading, which has columns of
 * its own; history reads the two together as `FireReport`.
 */
export type DispatchReport = { status: RoutineReportStatus; update: string; ask: string | null };
/** TASK-952. A finished run's report as history reads it: the dispatch's report plus the reading its run sent, or null. */
export type FireReport = DispatchReport & { reading: StoredReading | null };
/** TASK-907. The one open run in a conversation, as `routine_report` finds it. */
export type OpenCheckIn = { dispatchId: string; routineId: string; kind: RoutineKind; ownerUserId: string };
/** TASK-907. What `routine_report`'s lookup found in a conversation: its one open run, or why there's none to report on. */
export type OpenCheckInLookup = { run: OpenCheckIn } | { run: null; reason: 'no-open-run' | 'ambiguous' | 'routine-gone' };
/**
 * TASK-907. Why `recordReport` wrote nothing, decided under the run's locks:
 * fixed words an operator's log can carry. `kind`: the routine isn't a task
 * kind (`TASK_KINDS`, TASK-948).
 */
export type ReportRefusal = 'agent-retired' | 'run-closed' | 'not-bound' | 'routine-gone' | 'kind' | 'owner';
/**
 * TASK-907. `conversationId` is the conversation the report came from (host-set
 * context); the run must be bound to it. `notes` left out keeps the task's
 * notes; null clears them. A run accepted at or before the last clear can't
 * change the notes (TASK-910). TASK-952: `reading` left out or null means none
 * this time, so the task's latest reading becomes none, unlike `notes`.
 * TASK-948: `steps`, the report's changes to a get-done task's checklist,
 * applied in order as the agent's (`changeStoredSteps`, TASK-949); left out,
 * the checklist is left alone.
 */
export type RecordReportInput = {
  agentId: string; dispatchId: string; conversationId: string; actorUserId: string;
  report: DispatchReport; notes?: string | null; reading?: StoredReading | null; steps?: readonly RoutineStepOp[]; now: Date;
};
/**
 * TASK-948. A report that sent step changes landed: how many of them applied
 * and how many were skipped. Counts only, never a step's text.
 */
export type RecordedSteps = { outcome: 'recorded'; applied: number; skipped: number };
