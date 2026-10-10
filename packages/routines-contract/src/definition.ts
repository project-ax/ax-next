import { Cron } from 'croner';
import { z } from 'zod';

export const ROUTINE_DEFINITION_MAX_BYTES = 64 * 1024;
export const ROUTINE_OPAQUE_STRING_MAX_CHARS = 256;
export const RoutineOpaqueStringSchema = z.string().min(1).max(ROUTINE_OPAQUE_STRING_MAX_CHARS);

export function durationToSeconds(value: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (match === null) return null;
  const factors = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = Number(match[1]) * factors[match[2] as keyof typeof factors];
  return Number.isSafeInteger(seconds) && seconds >= 60 &&
    seconds * 1000 <= 8_640_000_000_000_000 - Date.now() ? seconds : null;
}

export function validateWebhookPath(path: string): boolean {
  if (path.length > 128 || !/^\/[A-Za-z0-9._\-/]+$/.test(path) || path.startsWith('/webhooks/')) return false;
  return path.slice(1).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}

export const RoutineTimezoneSchema = z.string().min(1).max(256).refine(validTimezone, 'Invalid timezone.');
export const IntervalTriggerSchema = z.object({
  kind: z.literal('interval'),
  every: z.string().refine(value => durationToSeconds(value) !== null, 'Invalid interval.'),
}).strict();
export const CronTriggerSchema = z.object({
  kind: z.literal('cron'), expr: z.string().min(1).max(256), tz: RoutineTimezoneSchema,
}).strict();
export const WebhookHmacSchema = z.object({
  header: z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/, 'Invalid header.'),
  algorithm: z.enum(['sha256', 'sha1']).default('sha256'),
  prefix: z.string().max(128).optional(),
}).strict();
export const WebhookTriggerSchema = z.object({
  kind: z.literal('webhook'), path: z.string().refine(validateWebhookPath, 'Invalid webhook path.'),
  events: z.array(z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid event name.')).max(32).optional(),
  hmac: WebhookHmacSchema.optional(),
}).strict();
export const RoutineTriggerSchema = z.discriminatedUnion('kind', [IntervalTriggerSchema, CronTriggerSchema, WebhookTriggerSchema])
  .superRefine((trigger, ctx) => {
    if (trigger.kind !== 'cron') return;
    try { new Cron(trigger.expr, { timezone: trigger.tz }); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expr'], message: 'Invalid cron expression or timezone.' }); }
  });
export const ActiveHoursSchema = z.object({
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Invalid start time.'),
  end: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Invalid end time.'),
  tz: RoutineTimezoneSchema,
}).strict();

export const RoutineEditableShape = {
  name: z.string().min(1).max(128),
  description: z.string().max(2048),
  promptBody: z.string(),
  enabled: z.boolean(),
  trigger: RoutineTriggerSchema,
  activeHours: ActiveHoursSchema.nullable(),
  silenceToken: z.string().max(128).nullable(),
  silenceMaxChars: z.number().int().min(0).max(65536),
  conversation: z.enum(['per-fire', 'shared']),
};

function validateDefinition(definition: RoutineDefinition, ctx: z.RefinementCtx): void {
  if (new TextEncoder().encode(JSON.stringify(definition)).length > ROUTINE_DEFINITION_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['promptBody'], message: 'Routine definition is too large.' });
  }
  if (definition.trigger.kind === 'webhook' && definition.activeHours !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeHours'], message: 'Webhook routines cannot have active hours.' });
  }
}

export const RoutineDefinitionObjectSchema = z.object({
  ...RoutineEditableShape,
  description: RoutineEditableShape.description.default(''),
  enabled: RoutineEditableShape.enabled.default(true),
  activeHours: RoutineEditableShape.activeHours.default(null),
  silenceToken: RoutineEditableShape.silenceToken.default(null),
  silenceMaxChars: RoutineEditableShape.silenceMaxChars.default(300),
  conversation: RoutineEditableShape.conversation.default('per-fire'),
}).strict();
export const RoutineDefinitionSchema = RoutineDefinitionObjectSchema.superRefine(validateDefinition);

// Explicit optional fields keep create defaults from filling omissions in a patch.
export const RoutinePatchSchema: z.ZodType<RoutinePatch> = z.object({
  name: RoutineEditableShape.name.optional(),
  description: RoutineEditableShape.description.optional(),
  promptBody: RoutineEditableShape.promptBody.optional(),
  enabled: RoutineEditableShape.enabled.optional(),
  trigger: RoutineEditableShape.trigger.optional(),
  activeHours: RoutineEditableShape.activeHours.optional(),
  silenceToken: RoutineEditableShape.silenceToken.optional(),
  silenceMaxChars: RoutineEditableShape.silenceMaxChars.optional(),
  conversation: RoutineEditableShape.conversation.optional(),
}).strict().superRefine((patch, ctx) => {
  if (Object.keys(patch).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Routine patch must contain an editable field.' });
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Omit unchanged fields.' });
  }
  if (new TextEncoder().encode(JSON.stringify(patch)).length > ROUTINE_DEFINITION_MAX_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['promptBody'], message: 'Routine patch is too large.' });
}) as unknown as z.ZodType<RoutinePatch>;

export type RoutineDefinition = z.output<typeof RoutineDefinitionObjectSchema>;
export type RoutinePatch = Partial<RoutineDefinition>;
export type RoutineTrigger = z.output<typeof RoutineTriggerSchema>;
export type ActiveHours = z.output<typeof ActiveHoursSchema>;

export function applyRoutinePatch(current: RoutineDefinition, patch: RoutinePatch): RoutineDefinition {
  const checked = RoutinePatchSchema.parse(patch);
  return RoutineDefinitionSchema.parse({ ...current, ...checked });
}

export const RoutinePermissionsSchema = z.object({ edit: z.boolean(), stop: z.boolean(), fire: z.boolean(), manageSecret: z.boolean() }).strict();
export const RoutineInstantSchema = z.string().datetime({ offset: true });
export const RoutineStatusSchema = z.enum(['ok', 'silenced', 'error']);
export const RoutineViewSchema = z.object({
  ...RoutineEditableShape,
  agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema, revision: RoutineOpaqueStringSchema,
  origin: z.enum(['authored', 'default']), defaultRoutineId: RoutineOpaqueStringSchema.nullable(),
  nextRunAt: RoutineInstantSchema.nullable(), lastRunAt: RoutineInstantSchema.nullable(),
  lastStatus: RoutineStatusSchema.nullable(), lastError: z.string().nullable(), lastWarning: z.string().nullable(),
  permissions: RoutinePermissionsSchema,
}).strict().superRefine((view, ctx) => {
  const definition = Object.fromEntries(Object.keys(RoutineEditableShape).map(key => [key, view[key as keyof typeof view]]));
  validateDefinition(definition as RoutineDefinition, ctx);
});
export type RoutinePermissions = z.output<typeof RoutinePermissionsSchema>;
export type RoutineView = z.output<typeof RoutineViewSchema>;

/** Project only editable fields; no runtime, authority or owner metadata. */
export function editableDefinition(row: RoutineDefinition): RoutineDefinition {
  return {
    name: row.name, description: row.description, promptBody: row.promptBody, enabled: row.enabled,
    trigger: row.trigger, activeHours: row.activeHours, silenceToken: row.silenceToken,
    silenceMaxChars: row.silenceMaxChars, conversation: row.conversation
  };
}
