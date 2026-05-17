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
