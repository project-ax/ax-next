import { z } from 'zod';
import {
  RoutineDefinitionSchema, RoutineOpaqueStringSchema, RoutinePatchSchema,
  type RoutineDefinition, type RoutinePatch,
} from './definition.js';

export const RoutineListToolInputSchema = z.object({}).strict();
export const RoutineGetToolInputSchema = z.object({ routineId: RoutineOpaqueStringSchema }).strict();
export const RoutineCreateToolInputSchema = z.object({ requestId: RoutineOpaqueStringSchema, definition: RoutineDefinitionSchema }).strict();
export const RoutineDeleteToolInputSchema = RoutineGetToolInputSchema.extend({ requestId: RoutineOpaqueStringSchema, expectedRevision: RoutineOpaqueStringSchema }).strict();

/**
 * TASK-906: the agent turns a routine into a task only by sending the whole
 * brief. A repeat routine's name and instructions can be written under Always
 * Allow without anyone seeing them, so a patch that sets `kind` alone (or with
 * `goodWhen`) would put unseen text in a task's brief. The patch must carry
 * its own `name`, `promptBody` and a non-null `goodWhen`, so the card that
 * asks shows all of it. Checked on the parsed patch, whose own keys are what
 * `applyRoutinePatch` merges. Agent tools only: a person converting a routine
 * in Settings goes through `RoutineUpdateInputSchema`, which doesn't carry it.
 */
const RoutineUpdateToolPatchSchema = RoutinePatchSchema.superRefine((patch, ctx) => {
  // Not `=== 'stay-on-top'`: a future kind is a task too.
  if (!Object.hasOwn(patch, 'kind') || patch.kind === 'repeat') return;
  const whole = Object.hasOwn(patch, 'name') && Object.hasOwn(patch, 'promptBody') &&
    Object.hasOwn(patch, 'goodWhen') && typeof patch.goodWhen === 'string';
  if (!whole) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['kind'],
      message: 'To turn a routine into a task, send its name, promptBody and goodWhen in the same patch so the person sees the whole task.',
    });
  }
});
export const RoutineUpdateToolInputSchema = RoutineDeleteToolInputSchema.extend({ patch: RoutineUpdateToolPatchSchema }).strict();
export const RoutineFireNowToolInputSchema = RoutineDeleteToolInputSchema;

export const RoutineToolInputSchemas = {
  routine_list: RoutineListToolInputSchema,
  routine_get: RoutineGetToolInputSchema,
  routine_create: RoutineCreateToolInputSchema,
  routine_update: RoutineUpdateToolInputSchema,
  routine_delete: RoutineDeleteToolInputSchema,
  routine_fire_now: RoutineFireNowToolInputSchema,
} as const;
export type RoutineToolName = keyof typeof RoutineToolInputSchemas;
export type RoutineListToolInput = z.output<typeof RoutineListToolInputSchema>;
export type RoutineGetToolInput = z.output<typeof RoutineGetToolInputSchema>;
export type RoutineCreateToolInput = z.output<typeof RoutineCreateToolInputSchema>;
export type RoutineUpdateToolInput = z.output<typeof RoutineUpdateToolInputSchema>;
export type RoutineDeleteToolInput = z.output<typeof RoutineDeleteToolInputSchema>;
export type RoutineFireNowToolInput = z.output<typeof RoutineFireNowToolInputSchema>;

export function routineToolKind(name: string): 'read' | 'write' | null {
  switch (name) {
    case 'routine_list': case 'routine_get': return 'read';
    case 'routine_create': case 'routine_update': case 'routine_delete': case 'routine_fire_now': return 'write';
    default: return null;
  }
}

/** A task's brief: what it is, what it does and when it's going well. A change to any of these always asks the person. */
export const TASK_BRIEF_FIELDS = ['name', 'promptBody', 'goodWhen', 'kind'] as const;

// Both helpers below read a call's input the way `@ax/routines` applies it: the
// parsed output of the same strict tool schema, whose own keys are exactly what
// `applyRoutinePatch` merges. zod also reads keys the raw object only inherits or
// hides, so never test the raw input's own keys. Each reads `call.name` and
// `call.input` once, looks nothing up and never throws: they run inside
// `tool:pre-call`, where a thrown error is swallowed and the call goes on.

/**
 * TASK-906 authorization predicate: true when a call creates a task or changes a
 * routine's brief, so Always Allow can't cover it. Anything unreadable is true.
 */
export function touchesTaskBrief(call: { name: string; input: unknown }): boolean {
  try {
    const name = call.name;
    if (name === 'routine_create') {
      const parsed = RoutineCreateToolInputSchema.safeParse(call.input);
      // Not `=== 'stay-on-top'`: a future kind is a task too, and asks.
      return !parsed.success || parsed.data.definition.kind !== 'repeat';
    }
    if (name === 'routine_update') {
      const parsed = RoutineUpdateToolInputSchema.safeParse(call.input);
      if (!parsed.success) return true;
      const { patch } = parsed.data;
      return TASK_BRIEF_FIELDS.some(key => Object.hasOwn(patch, key));
    }
    return false;
  } catch {
    return true;
  }
}

export type RoutineTaskProposal =
  | { action: 'start'; definition: RoutineDefinition }
  | { action: 'change'; patch: RoutinePatch }
  | null;

/**
 * TASK-906: the one reading of "is this call a task proposal", shared by the
 * approval wording and the approval card so they can't disagree. Never an
 * authority (that's `touchesTaskBrief`): anything unreadable is null. The
 * returned definition or patch is the parsed copy and is still agent-authored.
 * A kind `change` always carries the whole brief (name, promptBody and
 * goodWhen), because `RoutineUpdateToolInputSchema` refuses a conversion
 * without it.
 */
export function routineTaskProposal(call: { name: string; input: unknown }): RoutineTaskProposal {
  try {
    const name = call.name;
    if (name === 'routine_create') {
      const parsed = RoutineCreateToolInputSchema.safeParse(call.input);
      return parsed.success && parsed.data.definition.kind !== 'repeat'
        ? { action: 'start', definition: parsed.data.definition } : null;
    }
    if (name === 'routine_update') {
      const parsed = RoutineUpdateToolInputSchema.safeParse(call.input);
      if (!parsed.success) return null;
      const { patch } = parsed.data;
      const goodWhen = Object.hasOwn(patch, 'goodWhen') && typeof patch.goodWhen === 'string';
      const kind = Object.hasOwn(patch, 'kind') && patch.kind !== 'repeat';
      return goodWhen || kind ? { action: 'change', patch } : null;
    }
    return null;
  } catch {
    return null;
  }
}

const opaque = { type: 'string', minLength: 1, maxLength: 256 };
const timezone = { type: 'string', minLength: 1, maxLength: 256, description: 'IANA timezone, for example America/New_York.' };
const activeHours = {
  type: 'object', additionalProperties: false, required: ['start', 'end', 'tz'],
  properties: {
    start: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
    end: { type: 'string', pattern: '^(?:(?:[01]\\d|2[0-3]):[0-5]\\d|24:00)$' }, tz: timezone,
  },
};
const trigger = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'every'], properties: { kind: { const: 'interval' }, every: { type: 'string', pattern: '^\\d+(s|m|h|d)$', description: 'Interval of at least 60 seconds (15 minutes for a "stay-on-top" task), within the valid date range.' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'expr', 'tz'], properties: { kind: { const: 'cron' }, expr: { type: 'string', minLength: 1, maxLength: 256, description: 'Croner cron expression. For a "stay-on-top" task, runs must be at least 15 minutes apart.' }, tz: timezone } },
    { type: 'object', additionalProperties: false, required: ['kind', 'path'], properties: {
      kind: { const: 'webhook' }, path: { type: 'string', maxLength: 128, pattern: '^/[A-Za-z0-9._/-]+$', description: 'Canonical absolute path. No empty, dot, dot-dot, trailing-slash or reserved /webhooks/ segments.' },
      events: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' } },
      hmac: { type: 'object', additionalProperties: false, required: ['header'], properties: {
        header: { type: 'string', minLength: 1, maxLength: 128, pattern: "^[!#$%&'*+.^_`|~A-Za-z0-9-]+$" },
        algorithm: { type: 'string', enum: ['sha256', 'sha1'], default: 'sha256' }, prefix: { type: 'string', maxLength: 128 },
      } },
    } },
  ],
};
const editableProperties = {
  name: { type: 'string', minLength: 1, maxLength: 128 },
  description: { type: 'string', maxLength: 2048 },
  promptBody: { type: 'string', description: 'Instructions preserved exactly, including newlines. Complete definition must fit 64 KiB UTF-8.' },
  enabled: { type: 'boolean' }, trigger,
  activeHours: { anyOf: [activeHours, { type: 'null' }], description: 'Optional local-time window, including overnight windows. Not available for webhook triggers.' },
  silenceToken: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }] },
  silenceMaxChars: { type: 'integer', minimum: 0, maximum: 65536 },
  conversation: { type: 'string', enum: ['per-fire', 'shared'] },
  kind: { type: 'string', enum: ['repeat', 'stay-on-top'], description: 'What this is for. "repeat" (the default) does the same job each time. "stay-on-top" is a "Stay on top of something" task: it keeps checking and fixing something and never finishes, and it needs goodWhen.' },
  goodWhen: { anyOf: [{ type: 'string', maxLength: 1024 }, { type: 'null' }], description: 'For a "stay-on-top" task only: how you and the person will know it is going well, in plain words, for example "No ticket stays open longer than an hour". Null for "repeat".' },
};
export const RoutineDefinitionJsonSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'promptBody', 'trigger'],
  properties: { ...editableProperties,
    description: { ...editableProperties.description, default: '' }, enabled: { ...editableProperties.enabled, default: true },
    activeHours: { ...editableProperties.activeHours, default: null }, silenceToken: { ...editableProperties.silenceToken, default: null },
    silenceMaxChars: { ...editableProperties.silenceMaxChars, default: 300 }, conversation: { ...editableProperties.conversation, default: 'per-fire' },
    kind: { ...editableProperties.kind, default: 'repeat' }, goodWhen: { ...editableProperties.goodWhen, default: null },
  },
};
export const RoutinePatchJsonSchema = {
  type: 'object', additionalProperties: false, minProperties: 1, properties: editableProperties,
  description: 'Only supplied fields change. Null clears activeHours or silenceToken. Trigger and activeHours replace complete objects.',
};
const mutationProperties = { routineId: opaque, requestId: opaque, expectedRevision: opaque };
const mutationRequired = ['routineId', 'requestId', 'expectedRevision'];
export const RoutineToolJsonSchemas = {
  routine_list: { type: 'object', additionalProperties: false, properties: {} },
  routine_get: { type: 'object', additionalProperties: false, required: ['routineId'], properties: { routineId: opaque } },
  routine_create: { type: 'object', additionalProperties: false, required: ['requestId', 'definition'], properties: { requestId: opaque, definition: RoutineDefinitionJsonSchema } },
  routine_update: { type: 'object', additionalProperties: false, required: [...mutationRequired, 'patch'], properties: { ...mutationProperties, patch: RoutinePatchJsonSchema } },
  routine_delete: { type: 'object', additionalProperties: false, required: mutationRequired, properties: mutationProperties },
  routine_fire_now: { type: 'object', additionalProperties: false, required: mutationRequired, properties: mutationProperties },
} as const;

export const RoutineToolDescriptions = {
  routine_list: 'List this agent’s routines, revisions, current status and permissions, including defaults.',
  routine_get: 'Read a routine’s complete current definition and revision. Read before editing. IDs and revisions are opaque.',
  routine_create: 'Create unattended interval, cron or webhook work. People call routines "tasks". kind "repeat" (the default) does the same job each time. kind "stay-on-top" is a "Stay on top of something" task: it needs goodWhen, an interval or cron schedule whose check-ins are at least 15 minutes apart, conversation "per-fire" and no silenceToken. Creating a "stay-on-top" task always asks the person, even with Always Allow. Other creates are held for approval unless Always Allow is enabled for this person and agent. Enabled controls scheduling. Use a new logical requestId and reuse it only for retries. Report success only after confirmation.',
  routine_update: 'Patch an authored routine using its current expectedRevision. Omitted fields stay unchanged; null clears optional fields. Trigger and activeHours replace complete objects. Changing name, promptBody, goodWhen or kind always asks the person, even with Always Allow. To turn a routine into a task (a kind other than "repeat"), send its name, promptBody and goodWhen in the same patch so the person sees the whole task. Other edits are held for approval unless Always Allow is enabled for this person and agent. A "stay-on-top" task keeps check-ins at least 15 minutes apart. Set enabled false to stop scheduling. Reuse requestId for retries.',
  routine_delete: 'Delete an authored routine using its current expectedRevision. Requires Allow once approval; Always Allow does not cover deletion. Defaults use separate default controls. Reuse requestId for retries.',
  routine_fire_now: 'Fire an enabled routine now using its current expectedRevision. Reuse requestId for retries. Requires Allow once approval; Always Allow does not cover firing. Confirmation acknowledges dispatch acceptance; final execution status appears in history.',
} as const;
