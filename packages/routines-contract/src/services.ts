import { z } from 'zod';
import {
  IntervalTriggerSchema, RoutineDefinitionObjectSchema, RoutineDefinitionSchema,
  RoutineEditableShape, RoutineInstantSchema, RoutineOpaqueStringSchema,
  RoutinePatchSchema, RoutineStatusSchema, RoutineViewSchema,
} from './definition.js';

export const ROUTINE_SECRET_MAX_BYTES = 64 * 1024;
export const ROUTINE_HISTORY_MAX_LIMIT = 200;
export const RoutineListInputSchema = z.object({ agentId: RoutineOpaqueStringSchema }).strict();
export const RoutineKeySchema = z.object({ agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema }).strict();
export const RoutineGetInputSchema = RoutineKeySchema;
export const RoutineListOutputSchema = z.object({ routines: z.array(RoutineViewSchema) }).strict();
export const RoutineGetOutputSchema = RoutineViewSchema;
export const RoutineCreateInputSchema = RoutineListInputSchema.extend({ requestId: RoutineOpaqueStringSchema, definition: RoutineDefinitionSchema }).strict();
export const RoutineCreateOutputSchema = RoutineViewSchema;
export const RoutineDeleteInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema, expectedRevision: RoutineOpaqueStringSchema }).strict();
export const RoutineUpdateInputSchema = RoutineDeleteInputSchema.extend({ patch: RoutinePatchSchema }).strict();
export const RoutineUpdateOutputSchema = RoutineViewSchema;
export const RoutineDeleteOutputSchema = z.object({ deleted: z.literal(true), cleanupPending: z.boolean() }).strict();
export const RoutineFireNowInputSchema = RoutineDeleteInputSchema;
export const RoutineFireNowOutputSchema = z.object({ status: z.enum(['ok', 'error']) }).strict();

const secretKey = { agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema, expectedRevision: RoutineOpaqueStringSchema };
export const RoutineSecretInputSchema = z.discriminatedUnion('operation', [
  z.object({ ...secretKey, operation: z.literal('set'), secret: z.instanceof(Uint8Array).refine(secret => secret.byteLength >= 1 && secret.byteLength <= ROUTINE_SECRET_MAX_BYTES, 'Invalid secret size.') }).strict(),
  z.object({ ...secretKey, operation: z.literal('delete') }).strict(),
]);
export const RoutineSecretOutputSchema = z.object({ saved: z.literal(true) }).strict();

const limit = z.number().int().min(1).max(ROUTINE_HISTORY_MAX_LIMIT).optional();
export const RoutineRecentFiresInputSchema = RoutineKeySchema.extend({ limit }).strict();
export const RoutineRecentFiresForAgentInputSchema = RoutineListInputSchema.extend({ limit, before: RoutineInstantSchema.optional() }).strict();
export const RoutineFireViewSchema = z.object({
  agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema,
  firedAt: RoutineInstantSchema, triggerSource: z.enum(['tick', 'manual', 'webhook']),
  conversationId: RoutineOpaqueStringSchema.nullable(), status: RoutineStatusSchema,
  error: z.string().nullable(), renderedPrompt: z.string().nullable(), warning: z.string().nullable(),
}).strict();
export const RoutineRecentFiresOutputSchema = z.object({ fires: z.array(RoutineFireViewSchema) }).strict();
export const RoutineRecentFiresForAgentOutputSchema = RoutineRecentFiresOutputSchema;

export const RoutineListDefaultsInputSchema = z.object({}).strict();
export const RoutineGetDefaultInputSchema = z.object({ defaultRoutineId: RoutineOpaqueStringSchema }).strict();
export const RoutineDefaultSummarySchema = z.object({
  defaultRoutineId: RoutineOpaqueStringSchema, name: RoutineEditableShape.name,
  description: RoutineEditableShape.description, trigger: IntervalTriggerSchema,
  enabled: z.boolean(), updatedAt: RoutineInstantSchema,
}).strict();
export const RoutineListDefaultsOutputSchema = z.object({ defaults: z.array(RoutineDefaultSummarySchema) }).strict();
export const RoutineGetDefaultOutputSchema = z.object({
  ...RoutineEditableShape, trigger: IntervalTriggerSchema,
  defaultRoutineId: RoutineOpaqueStringSchema, updatedAt: RoutineInstantSchema,
}).strict().superRefine((detail, ctx) => {
  const { defaultRoutineId: _id, updatedAt: _updated, ...definition } = detail;
  const result = RoutineDefinitionSchema.safeParse(definition);
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
});
export const RoutineUpsertDefaultInputSchema = RoutineDefinitionObjectSchema.extend({
  trigger: IntervalTriggerSchema, enabled: z.boolean().optional(),
}).strict().superRefine((input, ctx) => {
  const result = RoutineDefinitionSchema.safeParse({ ...input, enabled: input.enabled ?? true });
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
});
export const RoutineUpsertDefaultOutputSchema = z.object({ defaultRoutineId: RoutineOpaqueStringSchema, created: z.boolean() }).strict();
export const RoutineDeleteDefaultInputSchema = RoutineGetDefaultInputSchema;
export const RoutineDeleteDefaultOutputSchema = z.object({}).strict();
export const RoutineSetAgentDefaultEnabledInputSchema = RoutineListInputSchema.extend({ defaultRoutineId: RoutineOpaqueStringSchema, enabled: z.boolean() }).strict();
export const RoutineSetAgentDefaultEnabledOutputSchema = z.object({}).strict();
export const RoutineListAgentDefaultsInputSchema = RoutineListInputSchema;
export const RoutineListAgentDefaultsOutputSchema = z.object({ defaults: z.array(z.object({ defaultRoutineId: RoutineOpaqueStringSchema, name: RoutineEditableShape.name, enabled: z.boolean() }).strict()) }).strict();

export type RoutineKey = z.output<typeof RoutineKeySchema>;
export type RoutineListInput = z.output<typeof RoutineListInputSchema>;
export type RoutineListOutput = z.output<typeof RoutineListOutputSchema>;
export type RoutineGetInput = z.output<typeof RoutineGetInputSchema>;
export type RoutineGetOutput = z.output<typeof RoutineGetOutputSchema>;
export type RoutineCreateInput = z.output<typeof RoutineCreateInputSchema>;
export type RoutineCreateOutput = z.output<typeof RoutineCreateOutputSchema>;
export type RoutineUpdateInput = z.output<typeof RoutineUpdateInputSchema>;
export type RoutineUpdateOutput = z.output<typeof RoutineUpdateOutputSchema>;
export type RoutineDeleteInput = z.output<typeof RoutineDeleteInputSchema>;
export type RoutineDeleteOutput = z.output<typeof RoutineDeleteOutputSchema>;
export type RoutineFireNowInput = z.output<typeof RoutineFireNowInputSchema>;
export type RoutineFireNowOutput = z.output<typeof RoutineFireNowOutputSchema>;
export type RoutineSecretInput = z.output<typeof RoutineSecretInputSchema>;
export type RoutineSecretOutput = z.output<typeof RoutineSecretOutputSchema>;
export type RoutineRecentFiresInput = z.output<typeof RoutineRecentFiresInputSchema>;
export type RoutineRecentFiresOutput = z.output<typeof RoutineRecentFiresOutputSchema>;
export type RoutineRecentFiresForAgentInput = z.output<typeof RoutineRecentFiresForAgentInputSchema>;
export type RoutineRecentFiresForAgentOutput = z.output<typeof RoutineRecentFiresForAgentOutputSchema>;
export type RoutineFireView = z.output<typeof RoutineFireViewSchema>;
export type RoutineDefaultSummary = z.output<typeof RoutineDefaultSummarySchema>;
export type RoutineListDefaultsInput = z.output<typeof RoutineListDefaultsInputSchema>;
export type RoutineListDefaultsOutput = z.output<typeof RoutineListDefaultsOutputSchema>;
export type RoutineGetDefaultInput = z.output<typeof RoutineGetDefaultInputSchema>;
export type RoutineGetDefaultOutput = z.output<typeof RoutineGetDefaultOutputSchema>;
export type RoutineUpsertDefaultInput = z.output<typeof RoutineUpsertDefaultInputSchema>;
export type RoutineUpsertDefaultOutput = z.output<typeof RoutineUpsertDefaultOutputSchema>;
export type RoutineDeleteDefaultInput = z.output<typeof RoutineDeleteDefaultInputSchema>;
export type RoutineDeleteDefaultOutput = z.output<typeof RoutineDeleteDefaultOutputSchema>;
export type RoutineSetAgentDefaultEnabledInput = z.output<typeof RoutineSetAgentDefaultEnabledInputSchema>;
export type RoutineSetAgentDefaultEnabledOutput = z.output<typeof RoutineSetAgentDefaultEnabledOutputSchema>;
export type RoutineListAgentDefaultsInput = z.output<typeof RoutineListAgentDefaultsInputSchema>;
export type RoutineListAgentDefaultsOutput = z.output<typeof RoutineListAgentDefaultsOutputSchema>;
