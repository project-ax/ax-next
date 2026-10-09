import type { RoutineDefinition } from '@ax/routines-contract';
export type { ActiveHours, RoutineTrigger as TriggerSpec } from '@ax/routines-contract';
export type FireSource = 'tick' | 'webhook' | 'manual';
export type FireStatus = 'ok' | 'silenced' | 'error';
/** Below the hook bus. Owner identity is pinned independently from the editing actor. */
export type StoredRoutine = RoutineDefinition & {
  agentId: string; routineId: string; revision: string; ownerUserId: string;
  definitionId: string | null; definitionUpdatedAt: Date | null;
  nextRunAt: Date | null; lastRunAt: Date | null;
  lastStatus: FireStatus | null; lastError: string | null; lastWarning: string | null;
};
export interface FireRow {
  id: number; agentId: string; routineId: string; firedAt: Date;
  triggerSource: FireSource; conversationId: string | null;
  status: FireStatus; error: string | null; renderedPrompt: string | null; warning: string | null;
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
