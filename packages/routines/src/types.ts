import { z, type ZodType } from 'zod';
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

// ---------------------------------------------------------------------------
// Runtime `returns` contracts for the `routines:*` service hooks (ARCH-13).
//
// Same recipe as ARCH-6: per-registration in-process shape assertions
// co-located with the I/O interfaces. The HookBus strips undeclared keys, so
// each schema mirrors its interface faithfully.
//
// `@ax/validator-routine` is hand-rolled (no zod), so `TriggerSpec` /
// `ActiveHours` are mirrored here as zod schemas. Storage-agnostic: every field
// name matches the public interface (no `routines_v1` / column vocab).
//
// Date discipline: `RoutineRow` / `FireRow` carry real `Date` instances from
// the store (`z.date()`, NOT `z.string()`), while the `*Default*` summaries
// project `updatedAt` to an ISO-8601 *string* before returning (`z.string()`).
// Cast to `ZodType<…>` because zod's `.nullable()`/`.optional()` infer union
// shapes `exactOptionalPropertyTypes` won't directly absorb; the drift-guard
// test enforces field-for-field agreement.
// ---------------------------------------------------------------------------
const WebhookHmacSpecSchema = z.object({
  secretRef: z.string(),
  header: z.string(),
  algorithm: z.union([z.literal('sha256'), z.literal('sha1')]),
  prefix: z.string().optional(),
});

const TriggerSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), every: z.string() }),
  z.object({ kind: z.literal('cron'), expr: z.string(), tz: z.string() }),
  z.object({
    kind: z.literal('webhook'),
    path: z.string(),
    events: z.array(z.string()).optional(),
    hmac: WebhookHmacSpecSchema.optional(),
  }),
]);

const ActiveHoursSchema = z.object({
  start: z.string(),
  end: z.string(),
  tz: z.string(),
});

const FireStatusSchema = z.union([
  z.literal('ok'),
  z.literal('silenced'),
  z.literal('error'),
]);

const ConversationModeSchema = z.union([z.literal('per-fire'), z.literal('shared')]);

const RoutineRowSchema = z.object({
  agentId: z.string(),
  path: z.string(),
  authorUserId: z.string(),
  name: z.string(),
  description: z.string(),
  specHash: z.string(),
  trigger: TriggerSpecSchema,
  activeHours: ActiveHoursSchema.nullable(),
  silenceToken: z.string().nullable(),
  silenceMaxChars: z.number(),
  conversation: ConversationModeSchema,
  promptBody: z.string(),
  nextRunAt: z.date().nullable(),
  lastRunAt: z.date().nullable(),
  lastStatus: FireStatusSchema.nullable(),
  lastError: z.string().nullable(),
  definitionId: z.string().nullable(),
  definitionUpdatedAt: z.date().nullable(),
});

const FireRowSchema = z.object({
  id: z.number(),
  agentId: z.string(),
  path: z.string(),
  firedAt: z.date(),
  triggerSource: z.union([z.literal('tick'), z.literal('webhook'), z.literal('manual')]),
  conversationId: z.string().nullable(),
  status: FireStatusSchema,
  error: z.string().nullable(),
  renderedPrompt: z.string().nullable(),
});

const DefaultRoutineSummarySchema = z.object({
  defaultRoutineId: z.string(),
  name: z.string(),
  description: z.string(),
  trigger: TriggerSpecSchema,
  enabled: z.boolean(),
  updatedAt: z.string(),
});

const DefaultRoutineDetailSchema = DefaultRoutineSummarySchema.extend({
  sourceMd: z.string(),
  silenceToken: z.string().nullable(),
  silenceMax: z.number(),
  conversation: ConversationModeSchema,
  activeHours: ActiveHoursSchema.nullable(),
  promptBody: z.string(),
});

export const ListOutputSchema = z.object({
  routines: z.array(RoutineRowSchema),
}) as unknown as ZodType<ListOutput>;

export const RecentFiresOutputSchema = z.object({
  fires: z.array(FireRowSchema),
}) as unknown as ZodType<RecentFiresOutput>;

export const FireNowOutputSchema = z.object({
  fireId: z.number(),
  status: FireStatusSchema,
  conversationId: z.string().nullable(),
}) as unknown as ZodType<FireNowOutput>;

export const RoutinesListDefaultsOutputSchema = z.object({
  defaults: z.array(DefaultRoutineSummarySchema),
}) as unknown as ZodType<RoutinesListDefaultsOutput>;

export const RoutinesGetDefaultOutputSchema =
  DefaultRoutineDetailSchema as unknown as ZodType<RoutinesGetDefaultOutput>;

export const RoutinesUpsertDefaultOutputSchema = z.object({
  defaultRoutineId: z.string(),
  created: z.boolean(),
}) as unknown as ZodType<RoutinesUpsertDefaultOutput>;

export const RoutinesDeleteDefaultOutputSchema = z
  .object({})
  .strict() as unknown as ZodType<RoutinesDeleteDefaultOutput>;
