import { z } from 'zod';
import { RoutineDefinitionSchema, RoutineOpaqueStringSchema, RoutinePatchSchema } from './definition.js';

export const RoutineListToolInputSchema = z.object({}).strict();
export const RoutineGetToolInputSchema = z.object({ routineId: RoutineOpaqueStringSchema }).strict();
export const RoutineCreateToolInputSchema = z.object({ requestId: RoutineOpaqueStringSchema, definition: RoutineDefinitionSchema }).strict();
export const RoutineDeleteToolInputSchema = RoutineGetToolInputSchema.extend({ requestId: RoutineOpaqueStringSchema, expectedRevision: RoutineOpaqueStringSchema }).strict();
export const RoutineUpdateToolInputSchema = RoutineDeleteToolInputSchema.extend({ patch: RoutinePatchSchema }).strict();
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
    { type: 'object', additionalProperties: false, required: ['kind', 'every'], properties: { kind: { const: 'interval' }, every: { type: 'string', pattern: '^\\d+(s|m|h|d)$', description: 'Interval of at least 60 seconds, within the valid date range.' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'expr', 'tz'], properties: { kind: { const: 'cron' }, expr: { type: 'string', minLength: 1, maxLength: 256, description: 'Croner cron expression.' }, tz: timezone } },
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
};
export const RoutineDefinitionJsonSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'promptBody', 'trigger'],
  properties: { ...editableProperties,
    description: { ...editableProperties.description, default: '' }, enabled: { ...editableProperties.enabled, default: true },
    activeHours: { ...editableProperties.activeHours, default: null }, silenceToken: { ...editableProperties.silenceToken, default: null },
    silenceMaxChars: { ...editableProperties.silenceMaxChars, default: 300 }, conversation: { ...editableProperties.conversation, default: 'per-fire' },
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
  routine_create: 'Create unattended interval, cron or webhook work. Creates are held for approval unless Always Allow is enabled for this person and agent. Enabled controls scheduling. Use a new logical requestId and reuse it only for retries. Report success only after confirmation.',
  routine_update: 'Patch an authored routine using its current expectedRevision. Omitted fields stay unchanged; null clears optional fields. Trigger and activeHours replace complete objects. Edits are held for approval unless Always Allow is enabled for this person and agent. Set enabled false to stop scheduling. Reuse requestId for retries.',
  routine_delete: 'Delete an authored routine using its current expectedRevision. Requires Allow once approval; Always Allow does not cover deletion. Defaults use separate default controls. Reuse requestId for retries.',
  routine_fire_now: 'Fire an enabled routine now using its current expectedRevision. Reuse requestId for retries. Requires Allow once approval; Always Allow does not cover firing. Confirmation acknowledges dispatch acceptance; final execution status appears in history.',
} as const;
