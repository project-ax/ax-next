import type { TriggerSpec, ActiveHours } from '@ax/validator-routine';

export type { TriggerSpec, ActiveHours };

export type FireSource = 'tick' | 'webhook' | 'manual';
export type FireStatus = 'ok' | 'silenced' | 'error';

export interface RoutineRow {
  agentId: string;
  path: string;
  authorUserId: string;
  name: string;
  description: string;
  specHash: string;
  trigger: TriggerSpec;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMaxChars: number;
  conversation: 'per-fire' | 'shared';
  promptBody: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastStatus: FireStatus | null;
  lastError: string | null;
  definitionId: string | null;
  definitionUpdatedAt: Date | null;
}

export interface FireRow {
  id: number;
  agentId: string;
  path: string;
  firedAt: Date;
  triggerSource: FireSource;
  conversationId: string | null;
  status: FireStatus;
  error: string | null;
  renderedPrompt: string | null;
}

export interface FireNowInput {
  agentId: string;
  path: string;
  source?: FireSource;
  payload?: unknown;
}
export interface FireNowOutput {
  fireId: number;
  status: FireStatus;
  conversationId: string | null;
}
export interface ListInput {
  agentId?: string;
}
export interface ListOutput {
  routines: RoutineRow[];
}
export interface RecentFiresInput {
  agentId: string;
  path: string;
  limit?: number;
}
export interface RecentFiresOutput {
  fires: FireRow[];
}

export interface RoutinesConfig {
  tickIntervalMs?: number;
  claimBatchSize?: number;
  claimWindowMinutes?: number;
  electionRetryMs?: number;
}

export interface DefaultRoutineSummary {
  defaultRoutineId: string;
  name: string;
  description: string;
  trigger: TriggerSpec;
  enabled: boolean;
  updatedAt: string;
}

export interface DefaultRoutineDetail extends DefaultRoutineSummary {
  sourceMd: string;
  silenceToken: string | null;
  silenceMax: number;
  conversation: 'per-fire' | 'shared';
  activeHours: ActiveHours | null;
  promptBody: string;
}

export type RoutinesListDefaultsInput = Record<string, never>;
export interface RoutinesListDefaultsOutput {
  defaults: DefaultRoutineSummary[];
}

export interface RoutinesGetDefaultInput {
  defaultRoutineId: string;
}
export type RoutinesGetDefaultOutput = DefaultRoutineDetail;

export interface RoutinesUpsertDefaultInput {
  sourceMd: string;
  enabled?: boolean;
}
export interface RoutinesUpsertDefaultOutput {
  defaultRoutineId: string;
  created: boolean;
}

export interface RoutinesDeleteDefaultInput {
  defaultRoutineId: string;
}
export type RoutinesDeleteDefaultOutput = Record<string, never>;
