import { z } from 'zod';
import {
  IntervalTriggerSchema, RoutineDefinitionObjectSchema, RoutineDefinitionSchema,
  RoutineEditableShape, RoutineInstantSchema, RoutineOpaqueStringSchema,
  RoutinePatchSchema, RoutineReportFieldShape, RoutineReportStatusSchema,
  RoutineListToolViewSchema, RoutineStatusSchema, RoutineViewSchema,
} from './definition.js';

export const ROUTINE_SECRET_MAX_BYTES = 64 * 1024;
export const ROUTINE_HISTORY_MAX_LIMIT = 200;
export const RoutineListInputSchema = z.object({ agentId: RoutineOpaqueStringSchema }).strict();
export const RoutineKeySchema = z.object({ agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema }).strict();
export const RoutineGetInputSchema = RoutineKeySchema;
export const RoutineListOutputSchema = z.object({ routines: z.array(RoutineViewSchema) }).strict();
/** What the `routine_list` tool returns: the service's list, without any task's agent notes (TASK-907). */
export const RoutineListToolOutputSchema = z.object({ routines: z.array(RoutineListToolViewSchema) }).strict();
export const RoutineGetOutputSchema = RoutineViewSchema;
export const RoutineCreateInputSchema = RoutineListInputSchema.extend({ requestId: RoutineOpaqueStringSchema, definition: RoutineDefinitionSchema }).strict();
export const RoutineCreateOutputSchema = RoutineViewSchema;
export const RoutineDeleteInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema, expectedRevision: RoutineOpaqueStringSchema }).strict();
export const RoutineUpdateInputSchema = RoutineDeleteInputSchema.extend({ patch: RoutinePatchSchema }).strict();
export const RoutineUpdateOutputSchema = RoutineViewSchema;
/** What the `routine_update` tool returns: the edited routine as `routine_list` shows it, without its task's agent notes (TASK-907). */
export const RoutineUpdateToolOutputSchema = RoutineListToolViewSchema;
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
/** One run's report, on its history row (TASK-907). The notes stay on the task. Stored text isn't re-capped (TASK-913). */
export const RoutineFireReportViewSchema = z.object({
  status: RoutineReportStatusSchema, update: z.string(), ask: z.string().nullable(),
}).strict();
/**
 * `routines:report` (TASK-907), the one writer of a task's state. The tool fills
 * `agentId` and `dispatchId` from the host-set session, never from the model.
 * `ask` is required. Leaving `notes` out keeps the saved notes; null clears them.
 * A run accepted at or before the person last cleared the notes can't change them (TASK-910).
 */
export const RoutineReportInputSchema = z.object({
  agentId: RoutineOpaqueStringSchema, dispatchId: RoutineOpaqueStringSchema,
  status: RoutineReportFieldShape.status, update: RoutineReportFieldShape.update,
  ask: RoutineReportFieldShape.ask, notes: RoutineReportFieldShape.notes.optional(),
}).strict();
export const RoutineReportOutputSchema = z.object({ recorded: z.literal(true) }).strict();
/**
 * `routines:clear-notes` (TASK-910): the person clears a task's agent notes,
 * the text its next check-in reads (design §7). Only the routine's owner may.
 * No run accepted at or before the clear can write notes again. It never
 * changes the routine's revision.
 */
export const RoutineClearNotesInputSchema = RoutineKeySchema;
export const RoutineClearNotesOutputSchema = z.object({ cleared: z.literal(true) }).strict();
export const RoutineFireViewSchema = z.object({
  agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema,
  firedAt: RoutineInstantSchema, triggerSource: z.enum(['tick', 'manual', 'webhook']),
  conversationId: RoutineOpaqueStringSchema.nullable(), status: RoutineStatusSchema,
  error: z.string().nullable(), renderedPrompt: z.string().nullable(), warning: z.string().nullable(),
  /** TASK-907. Null when the run made no report, and for anyone but the routine's owner: a report is its task's state. */
  report: RoutineFireReportViewSchema.nullable(),
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
  kind: z.literal('repeat'), goodWhen: z.null(),
  defaultRoutineId: RoutineOpaqueStringSchema, updatedAt: RoutineInstantSchema,
}).strict().superRefine((detail, ctx) => {
  const { defaultRoutineId: _id, updatedAt: _updated, ...definition } = detail;
  const result = RoutineDefinitionSchema.safeParse(definition);
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
});
export const RoutineUpsertDefaultInputSchema = RoutineDefinitionObjectSchema.extend({
  trigger: IntervalTriggerSchema, enabled: z.boolean().optional(),
  kind: z.literal('repeat').default('repeat'), goodWhen: z.null().default(null),
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
export type RoutineListToolOutput = z.output<typeof RoutineListToolOutputSchema>;
export type RoutineGetOutput = z.output<typeof RoutineGetOutputSchema>;
export type RoutineCreateInput = z.output<typeof RoutineCreateInputSchema>;
export type RoutineCreateOutput = z.output<typeof RoutineCreateOutputSchema>;
export type RoutineUpdateInput = z.output<typeof RoutineUpdateInputSchema>;
export type RoutineUpdateOutput = z.output<typeof RoutineUpdateOutputSchema>;
export type RoutineUpdateToolOutput = z.output<typeof RoutineUpdateToolOutputSchema>;
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
export type RoutineFireReportView = z.output<typeof RoutineFireReportViewSchema>;
export type RoutineReportInput = z.output<typeof RoutineReportInputSchema>;
export type RoutineReportOutput = z.output<typeof RoutineReportOutputSchema>;
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
export type RoutineClearNotesInput = z.output<typeof RoutineClearNotesInputSchema>;
export type RoutineClearNotesOutput = z.output<typeof RoutineClearNotesOutputSchema>;
