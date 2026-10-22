import type { RoutineDefinition, RoutineKind, RoutineReportStatus } from '@ax/routines-contract';
export type { ActiveHours, RoutineTrigger as TriggerSpec } from '@ax/routines-contract';
export type FireSource = 'tick' | 'webhook' | 'manual';
export type FireStatus = 'ok' | 'silenced' | 'error';
/**
 * TASK-907. A task's latest report and the notes it keeps between check-ins
 * (`agentNotes`, the `agent_notes` column; the report's input calls them
 * `notes`). Agent-written text.
 */
export type StoredTaskState = { status: RoutineReportStatus; update: string; ask: string | null; agentNotes: string | null; reportedAt: Date };
/** Below the hook bus. Owner identity is pinned independently from the editing actor. */
export type StoredRoutine = RoutineDefinition & {
  agentId: string; routineId: string; revision: string; ownerUserId: string;
  definitionId: string | null; definitionUpdatedAt: Date | null;
  nextRunAt: Date | null; lastRunAt: Date | null;
  lastStatus: FireStatus | null; lastError: string | null; lastWarning: string | null;
  /** TASK-907. Null until the first report, and again after an edit that changes the routine's kind. */
  task: StoredTaskState | null;
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
export type DispatchOutcome = {
  status: FireStatus; conversationId: string | null; error: string | null;
  renderedPrompt: string | null; warning: string | null;
};
/** TASK-907. One run's report: kept on its dispatch, then on its fire row. The notes stay on the task. */
export type DispatchReport = { status: RoutineReportStatus; update: string; ask: string | null };
/** TASK-907. The one open run in a conversation, as `routine_report` finds it. */
export type OpenCheckIn = { dispatchId: string; routineId: string; kind: RoutineKind; ownerUserId: string };
/**
 * TASK-907. `conversationId` is the conversation the report came from (host-set
 * context); the run must be bound to it. `notes` left out keeps the task's
 * notes; null clears them.
 */
export type RecordReportInput = {
  agentId: string; dispatchId: string; conversationId: string; actorUserId: string;
  report: DispatchReport; notes?: string | null; now: Date;
};
