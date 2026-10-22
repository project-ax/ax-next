import { z } from 'zod';
import { RoutineReportStatusSchema } from '@ax/routines-contract';
import { StoredRoutineSchema } from './definition.js';
export const AcceptedDispatchSchema = z.object({
  dispatchId: z.string(), reqId: z.string(), row: StoredRoutineSchema,
  source: z.enum(['tick', 'manual', 'webhook']), acceptedAt: z.coerce.date(),
}).strict();
export const DispatchOutcomeSchema = z.object({
  status: z.enum(['ok', 'silenced', 'error']), conversationId: z.string().nullable(),
  error: z.string().nullable(), renderedPrompt: z.string().nullable(), warning: z.string().nullable(),
}).strict();
/** TASK-907. A run's stored report, read back with `safeParse` only. Stored text isn't re-capped (TASK-913). */
export const DispatchReportSchema = z.object({
  status: RoutineReportStatusSchema, update: z.string(), ask: z.string().nullable(),
}).strict();
