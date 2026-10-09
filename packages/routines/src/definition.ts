import { createHash, randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { z } from 'zod';
import { RoutineDefinitionObjectSchema, RoutineDefinitionSchema, durationToSeconds, type RoutineDefinition } from '@ax/routines-contract';
import { SafeToolError } from '@ax/core';
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
export function validateDefinition(input: unknown): RoutineDefinition {
  const parsed = RoutineDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new SafeToolError('validation', 'input');
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
