import { z } from 'zod';
import {
  IntervalTriggerSchema, RoutineDefinitionObjectSchema, RoutineDefinitionSchema,
  RoutineEditableShape, RoutineInstantSchema, RoutineOpaqueStringSchema,
  RoutinePatchSchema, RoutineReadingViewSchema, RoutineReplyTextSchema, RoutineReportFieldShape, RoutineReportStatusSchema,
  RoutineReportStepsOutcomeSchema, RoutineReportStepsSchema, RoutineListToolViewSchema, RoutineStatusSchema, RoutineStepViewSchema,
  RoutineTimezoneSchema, RoutineViewSchema, refuseDoneWithoutNeedsYou,
} from './definition.js';
import { RoutineFinishBySchema } from './finish-by.js';

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
/**
 * One run's report, on its history row (TASK-907). The notes stay on the task.
 * TASK-952: `reading` is the reading the run sent with it, or null, and is
 * required like the task's. Stored text isn't re-capped (TASK-913).
 */
export const RoutineFireReportViewSchema = z.object({
  status: RoutineReportStatusSchema, update: z.string(), ask: z.string().nullable(),
  reading: RoutineReadingViewSchema.nullable(),
}).strict();
/**
 * `routines:report` (TASK-907), the one writer of a task's report. The tool fills
 * `agentId` and `dispatchId` from the host-set session, never from the model.
 * `ask` is required. Leaving `notes` out keeps the saved notes; null clears them.
 * A run accepted at or before the person last cleared the notes can't change them (TASK-910).
 * Absent or null `reading`: none this time (TASK-952).
 * `steps` (TASK-948) is for a "get-done" task only: changes to its checklist,
 * applied in order. One that can't apply is skipped and counted, and the rest
 * of the report still lands.
 * `done` (TASK-950): true says the agent thinks a "get-done" task is finished;
 * it must come with "needs-you" (`refuseDoneWithoutNeedsYou`). Left out or
 * false is no claim, and a later report without it takes the claim back.
 */
export const RoutineReportInputSchema = z.object({
  agentId: RoutineOpaqueStringSchema, dispatchId: RoutineOpaqueStringSchema,
  status: RoutineReportFieldShape.status, update: RoutineReportFieldShape.update,
  ask: RoutineReportFieldShape.ask, notes: RoutineReportFieldShape.notes.optional(),
  reading: RoutineReportFieldShape.reading.optional(),
  done: RoutineReportFieldShape.done.optional(),
  steps: RoutineReportStepsSchema.optional(),
}).strict().superRefine(refuseDoneWithoutNeedsYou);
/** `steps` is there only when the report sent changes: how many applied and how many were skipped (TASK-948). */
export const RoutineReportOutputSchema = z.object({ recorded: z.literal(true), steps: RoutineReportStepsOutcomeSchema.optional() }).strict();
/**
 * `routines:clear-notes` (TASK-910): the person clears a task's agent notes,
 * the text its next check-in reads (design §7). Only the routine's owner may.
 * No run accepted at or before the clear can write notes again. It never
 * changes the routine's revision.
 */
export const RoutineClearNotesInputSchema = RoutineKeySchema;
export const RoutineClearNotesOutputSchema = z.object({ cleared: z.literal(true) }).strict();
/**
 * `routines:set-finish-by` (TASK-951): a person sets or removes a "get-done"
 * task's finish date, on its task page. Only the routine's owner may, and only
 * on a get-done task. It never changes the routine's revision. Neither a tool
 * nor an IPC action, so no model can set it. Null removes it.
 *
 * TASK-955. `finishByTimeZone` is the time zone the person's browser reported
 * when they set the date; absent or null when it reported none. It must be a
 * zone this runtime's `Intl` knows (`RoutineTimezoneSchema`, a schedule's zone
 * rule), and it is kept as sent. It is stored only beside a date, so removing
 * the date removes it too, and the answer says what was stored. Whether it
 * counts, and on which calendar, is `taskTimeZone`'s to decide.
 */
export const RoutineSetFinishByInputSchema = RoutineKeySchema.extend({
  finishBy: RoutineFinishBySchema.nullable(),
  finishByTimeZone: RoutineTimezoneSchema.nullable().optional(),
}).strict();
export const RoutineSetFinishByOutputSchema = z.object({ finishBy: z.string().nullable(), finishByTimeZone: z.string().nullable() }).strict();
/**
 * `routines:tasks-for-conversations` (TASK-932): which of these conversations
 * are check-ins of a task the caller owns, on this agent, so Today can name the
 * task an approval was held in. A label, never an authorization. A conversation
 * that isn't a check-in, is another person's, or that more than one run shared
 * is simply absent, all alike. Neither a tool nor an IPC action.
 */
export const ROUTINE_CHECKIN_LOOKUP_MAX_IDS = 200;
export const RoutineTasksForConversationsInputSchema = RoutineListInputSchema.extend({
  conversationIds: z.array(RoutineOpaqueStringSchema).min(1).max(ROUTINE_CHECKIN_LOOKUP_MAX_IDS),
}).strict();
/** One check-in: its conversation, its task's id (an opaque host id) and its task's name. */
export const RoutineCheckInViewSchema = z.object({
  conversationId: RoutineOpaqueStringSchema,
  routineId: RoutineOpaqueStringSchema,
  name: RoutineEditableShape.name,
}).strict();
export const RoutineTasksForConversationsOutputSchema = z.object({ checkIns: z.array(RoutineCheckInViewSchema) }).strict();
/**
 * `routines:reply` (TASK-931): a task's owner writes to their agent about the
 * task. Only the routine's owner may. The reply is stored first, and `checkIn`
 * says what happened next:
 *   - `started`: a check-in was accepted. Not finished: its update arrives like
 *     any other check-in's. Also a retry's answer when it starts one more
 *     because a host restart cut the earlier check-in off before it reported
 *     (TASK-937);
 *   - `replayed`: an earlier try with this `requestId` already started a
 *     check-in that is still running or ended on its own (its update, or why
 *     it failed, is under Updates), or this reply's check-in has already been
 *     restarted three times;
 *   - `not-allowed`: the caller may no longer start the task's check-ins, so
 *     none starts;
 *   - `paused`: none starts until a person resumes the task. Only said to a
 *     caller who may start one, so never to someone who can't resume it.
 * The same `requestId` again stores nothing new, and starts a second check-in
 * only after a host restart cut the first one off before it reported; retries
 * at the same moment still start one between them. Neither a tool nor an IPC
 * action: a reply reaches a model only in a check-in message.
 */
export const ROUTINE_REPLY_CHECK_INS = ['started', 'paused', 'not-allowed', 'replayed'] as const;
export const RoutineReplyCheckInSchema = z.enum(ROUTINE_REPLY_CHECK_INS);
export const RoutineReplyInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema, text: RoutineReplyTextSchema }).strict();
export const RoutineReplyOutputSchema = z.object({ replyId: RoutineOpaqueStringSchema, checkIn: RoutineReplyCheckInSchema }).strict();
/**
 * `routines:complete` (TASK-950): a person marks a "get-done" task done. Only
 * its owner, who manages the agent's tasks (`edit`), may. It stops checking in
 * the way a pause does and keeps its steps, report and notes. The same
 * `requestId` again answers the same without doing it twice; a task already
 * done answers done with no change. Neither a tool nor an IPC action: only a
 * person marks a task done.
 */
export const RoutineCompleteInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema }).strict();
export const RoutineCompleteOutputSchema = z.object({ done: z.literal(true) }).strict();
/**
 * `routines:reopen` (TASK-950): Not yet, and Reopen on a Done task. It stores
 * a reply as `routines:reply` does; it clears the agent's claim, and on a Done
 * task it also clears the completion and runs the task again (that needs
 * `edit`); then it starts a check-in as a reply does, and `checkIn` says what
 * happened, with `routines:reply`'s meanings. Neither a tool nor an IPC action.
 */
export const RoutineReopenInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema, text: RoutineReplyTextSchema }).strict();
export const RoutineReopenOutputSchema = RoutineReplyOutputSchema;
/**
 * `routines:recent-replies` (TASK-931): a task's replies, newest first, for its
 * owner, and only the ones they wrote: once a task moves to a new owner, the
 * earlier owner's replies reach no one. Anyone else, and a routine that's gone,
 * gets none. `limit` is 1 to 50 and defaults to 20. `authorUserId` (so far
 * always the caller) is there for the caller's own "was this me?" and never
 * leaves the host. Stored text isn't re-capped (TASK-913). Neither a tool nor
 * an IPC action.
 */
export const ROUTINE_REPLIES_MAX_LIMIT = 50;
export const RoutineRecentRepliesInputSchema = RoutineKeySchema.extend({ limit: z.number().int().min(1).max(ROUTINE_REPLIES_MAX_LIMIT).optional() }).strict();
export const RoutineReplyViewSchema = z.object({
  replyId: RoutineOpaqueStringSchema, authorUserId: z.string().min(1), text: z.string(), sentAt: RoutineInstantSchema,
}).strict();
export const RoutineRecentRepliesOutputSchema = z.object({ replies: z.array(RoutineReplyViewSchema) }).strict();
/**
 * `routines:set-steps` (TASK-949): a task's owner changes its steps on its
 * task page: adds one, ticks or unticks one, rewords or removes one. Only the
 * routine's owner may, whether or not they still manage the agent's tasks, and
 * only on a "get-done" task. `ops` are the changes the agent's report sends,
 * applied in order, by id: a person may reword or remove any step, the agent's
 * included, and their `add`, like a step whose words they change, is
 * `addedBy: 'person'`. A change to a step that's gone, an `add` past 50 and an
 * `add` whose text is already listed are skipped and counted (`skipped`);
 * `steps` is the list after them. The same `requestId` again changes nothing
 * and answers with the steps as they are now and the first try's count; with
 * other changes, or on another task, it is refused (`request-conflict`). It
 * never changes the routine's revision. Each text is checked by
 * `RoutineStepTextSchema`, whose messages the person reads. Neither a tool nor
 * an IPC action, so no model can call it.
 */
export const RoutineSetStepsInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema, ops: RoutineReportStepsSchema }).strict();
export const RoutineSetStepsOutputSchema = z.object({ steps: z.array(RoutineStepViewSchema), skipped: z.number().int().min(0) }).strict();
/**
 * `routines:duplicate` (TASK-953): a person copies their own task, from its
 * page. The copy is a new task of the same kind, paused (not enabled, no
 * next check-in), named "Copy of {name}" (cut to fit the name limit, never
 * inside a character), with the source's definition otherwise: its brief,
 * its schedule and its active hours. A "get-done" task's steps come along
 * unticked, under new ids, each still saying who wrote it. It copies none
 * of the task's state (its report, notes, reading or missed check-ins),
 * nor its finish date, and none of its replies or its history. The answer
 * is the copy's id. The same `requestId` again answers with the same copy;
 * on another task it is refused (`request-conflict`). Who may follows
 * `routines:create` (someone who may manage the agent's tasks; the copy is
 * the agent's owner's on a personal agent, else the caller's), plus `edit`
 * on the source, so only its owner copies it. Someone else's routine, and a
 * default (which no one edits), are `forbidden`; a repeat routine of the
 * caller's own and a missing one are `not-found`; a task whose copy today's
 * rules refuse is `validation`. Neither a tool nor an IPC action, so no
 * model can call it, and no approval: the person makes the copy themselves,
 * and it stays paused until a person resumes it.
 */
export const RoutineDuplicateInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema }).strict();
export const RoutineDuplicateOutputSchema = z.object({ routineId: RoutineOpaqueStringSchema }).strict();
export const RoutineFireViewSchema = z.object({
  agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema,
  firedAt: RoutineInstantSchema, triggerSource: z.enum(['tick', 'manual', 'webhook']),
  conversationId: RoutineOpaqueStringSchema.nullable(), status: RoutineStatusSchema,
  error: z.string().nullable(), renderedPrompt: z.string().nullable(), warning: z.string().nullable(),
  /** TASK-907. Null when the run made no report, and for anyone but the routine's owner, who is also the person the run ran as (TASK-936): a report is its task's state. */
  report: RoutineFireReportViewSchema.nullable(),
}).strict();
/**
 * `routines:recent-fires` and `routines:recent-fires-for-agent` (TASK-936): a
 * routine's runs, newest first. For a live routine, only the runs that ran as
 * its current owner. After a change of owner the earlier owner's runs reach no
 * one, their reports included, until the routine moves back. A gone routine's
 * runs all list, with no report.
 */
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
export type RoutineSetFinishByInput = z.output<typeof RoutineSetFinishByInputSchema>;
export type RoutineSetFinishByOutput = z.output<typeof RoutineSetFinishByOutputSchema>;
export type RoutineTasksForConversationsInput = z.output<typeof RoutineTasksForConversationsInputSchema>;
export type RoutineTasksForConversationsOutput = z.output<typeof RoutineTasksForConversationsOutputSchema>;
export type RoutineCheckInView = z.output<typeof RoutineCheckInViewSchema>;
export type RoutineReplyCheckIn = z.output<typeof RoutineReplyCheckInSchema>;
export type RoutineReplyInput = z.output<typeof RoutineReplyInputSchema>;
export type RoutineReplyOutput = z.output<typeof RoutineReplyOutputSchema>;
export type RoutineCompleteInput = z.output<typeof RoutineCompleteInputSchema>;
export type RoutineCompleteOutput = z.output<typeof RoutineCompleteOutputSchema>;
export type RoutineReopenInput = z.output<typeof RoutineReopenInputSchema>;
export type RoutineReopenOutput = z.output<typeof RoutineReopenOutputSchema>;
export type RoutineRecentRepliesInput = z.output<typeof RoutineRecentRepliesInputSchema>;
export type RoutineRecentRepliesOutput = z.output<typeof RoutineRecentRepliesOutputSchema>;
export type RoutineReplyView = z.output<typeof RoutineReplyViewSchema>;
export type RoutineSetStepsInput = z.output<typeof RoutineSetStepsInputSchema>;
export type RoutineSetStepsOutput = z.output<typeof RoutineSetStepsOutputSchema>;
export type RoutineDuplicateInput = z.output<typeof RoutineDuplicateInputSchema>;
export type RoutineDuplicateOutput = z.output<typeof RoutineDuplicateOutputSchema>;
