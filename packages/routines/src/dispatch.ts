import { z } from 'zod';
import { StoredRoutineSchema } from './definition.js';
export const AcceptedDispatchSchema = z.object({
  dispatchId: z.string(), reqId: z.string(), row: StoredRoutineSchema,
  source: z.enum(['tick', 'manual', 'webhook']), acceptedAt: z.coerce.date(),
}).strict();
export const DispatchOutcomeSchema = z.object({
  status: z.enum(['ok', 'silenced', 'error']), conversationId: z.string().nullable(),
  error: z.string().nullable(), renderedPrompt: z.string().nullable(), warning: z.string().nullable(),
}).strict();
