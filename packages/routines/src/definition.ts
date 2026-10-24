import { createHash, randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { z } from 'zod';
import { CheckInMissSchema, RoutineDefinitionObjectSchema, RoutineDefinitionSchema, RoutineReportStatusSchema, RoutineStepAuthorSchema, durationToSeconds, type RoutineDefinition } from '@ax/routines-contract';
import { SafeToolError, type SafeToolField } from '@ax/core';
import type { StoredRoutine } from './types.js';

export function opaqueId(prefix: string): string { return `${prefix}_${randomUUID().replaceAll('-', '')}`; }
export { editableDefinition } from '@ax/routines-contract';
import { editableDefinition } from '@ax/routines-contract';
/** Canonical key order makes semantically identical request objects share a receipt. */
export function inputHash(input: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}
/**
 * A refused routine input as a closed validation error that names its field
 * (TASK-906): the first zod issue's path, without a tool or service input's
 * `definition` or `patch` wrapper, joined with dots (`promptBody`,
 * `trigger.expr`, a report's `update`). `SafeToolError` keeps a field only when
 * it is one of core's closed names and makes anything else (`goodWhen`, `kind`,
 * an array index) `input`, so neither the input nor the schema's message
 * reaches the agent. Anything that isn't a zod refusal is `input` too.
 */
export function validationError(error: unknown): SafeToolError {
  const path = error instanceof z.ZodError ? error.issues[0]?.path ?? [] : [];
  const field = path[0] === 'definition' || path[0] === 'patch' ? path.slice(1) : path;
  return new SafeToolError('validation', field.join('.') as SafeToolField);
}
export function validateDefinition(input: unknown): RoutineDefinition {
  const parsed = RoutineDefinitionSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}
export function nextRun(definition: RoutineDefinition, now: Date): Date | null {
  if (!definition.enabled || definition.trigger.kind === 'webhook') return null;
  if (definition.trigger.kind === 'cron') return new Cron(definition.trigger.expr, { timezone: definition.trigger.tz }).nextRun(now);
  return new Date(now.getTime() + durationToSeconds(definition.trigger.every)! * 1000);
}
export function schedulingChanged(a: RoutineDefinition, b: RoutineDefinition): boolean {
  return inputHash({ enabled: a.enabled, trigger: a.trigger, activeHours: a.activeHours }) !== inputHash({ enabled: b.enabled, trigger: b.trigger, activeHours: b.activeHours });
}
export function credentialRef(key: { agentId: string; routineId: string }): string { return `routine:${key.agentId}:${key.routineId}:hmac`; }
export function hasHmac(row: RoutineDefinition): boolean { return row.trigger.kind === 'webhook' && row.trigger.hmac !== undefined; }
// Strict receipt parser also rehydrates JSON dates. Private state never enters RoutineView.
export const StoredRoutineSchema = RoutineDefinitionObjectSchema.extend({
  agentId: z.string(), routineId: z.string(), revision: z.string(), ownerUserId: z.string(),
  definitionId: z.string().nullable(), definitionUpdatedAt: z.coerce.date().nullable(),
  nextRunAt: z.coerce.date().nullable(), lastRunAt: z.coerce.date().nullable(),
  lastStatus: z.enum(['ok', 'silenced', 'error']).nullable(), lastError: z.string().nullable(), lastWarning: z.string().nullable(),
  // TASK-907. Types and the status enum only. No caps: claimDue parses every due row, so text a
  // later card's higher cap let in must still read after a rollback (TASK-913). The default fills
  // it in for a receipt, which leaves the key out (store.ts, receiptCopy), as did any written
  // before this field.
  task: z.object({
    status: RoutineReportStatusSchema, update: z.string(), ask: z.string().nullable(),
    agentNotes: z.string().nullable(), reportedAt: z.coerce.date(),
    // TASK-952. Types only, like the rest (TASK-913).
    reading: z.object({ value: z.number(), label: z.string() }).strict().nullable().default(null),
  }).strict().nullable().default(null),
  // TASK-930. Types and the reason enum only, as for `task`: rowToRoutine has already read the
  // columns leniently (store.ts, noRecentUpdate), so no stored row is refused here. Receipts
  // leave the key out (store.ts, receiptCopy), as did any written before this field, and the
  // default fills it in.
  noRecentUpdate: z.object({
    inARow: z.number().int(), reason: CheckInMissSchema, at: z.coerce.date(), autoPausedAt: z.coerce.date().nullable(),
  }).strict().nullable().default(null),
  // TASK-948. Types and the author enum only, as for `task`: rowToRoutine has already read the
  // column leniently (steps.ts, storedSteps), so no stored row is refused here. Receipts leave the
  // key out (store.ts, receiptCopy), as did any written before this field, and the default fills
  // it in.
  steps: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean(), addedBy: RoutineStepAuthorSchema }).strict()).default([]),
}).strict().superRefine((row, ctx) => {
  const checked = RoutineDefinitionSchema.safeParse(editableDefinition(row));
  if (!checked.success) for (const issue of checked.error.issues) ctx.addIssue(issue);
});
export function parseStoredRoutine(value: unknown): StoredRoutine { return StoredRoutineSchema.parse(value); }

/** Hash exactly the canonical public effect. Actor, owner, request ID, clock and authority
 * flags are excluded: identity/idempotency scope is carried by the receipt primary key.
 */
export function createRequestHash(input: import('@ax/routines-contract').RoutineCreateInput): string {
  return inputHash({ agentId: input.agentId, definition: validateDefinition(input.definition) });
}
export function updateRequestHash(input: import('@ax/routines-contract').RoutineUpdateInput): string {
  return inputHash({ agentId: input.agentId, routineId: input.routineId, expectedRevision: input.expectedRevision, patch: input.patch });
}
export function deleteRequestHash(input: import('@ax/routines-contract').RoutineDeleteInput): string {
  return inputHash({ agentId: input.agentId, routineId: input.routineId, expectedRevision: input.expectedRevision });
}
export function dispatchRequestHash(input: import('@ax/routines-contract').RoutineFireNowInput & { source: import('./types.js').FireSource }): string {
  return inputHash({ agentId: input.agentId, routineId: input.routineId, expectedRevision: input.expectedRevision, source: input.source });
}
