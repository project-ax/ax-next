import { HIDDEN_FORMAT_CHARS } from '@ax/core/surface-text';
import { Cron } from 'croner';
import { z } from 'zod';

export const ROUTINE_DEFINITION_MAX_BYTES = 64 * 1024;
export const ROUTINE_OPAQUE_STRING_MAX_CHARS = 256;
/** A routine's name, in UTF-16 units (zod's `max`), so at most this many code points too. */
export const ROUTINE_NAME_MAX_CHARS = 128;
export const RoutineOpaqueStringSchema = z.string().min(1).max(ROUTINE_OPAQUE_STRING_MAX_CHARS);

export const ROUTINE_KINDS = ['repeat', 'stay-on-top'] as const;
export const RoutineKindSchema = z.enum(ROUTINE_KINDS);
export type RoutineKind = z.output<typeof RoutineKindSchema>;
export const ROUTINE_GOOD_WHEN_MAX_CHARS = 1024;
/** A "stay on top of something" task checks in no more often than this. */
export const TASK_CHECK_IN_FLOOR_SECONDS = 900;
/** How many occurrences of a cron the check-in floor inspects. `cronWrapsTooSoon` covers the gap they can miss. */
export const TASK_CRON_FLOOR_RUNS = 48;
const TASK_CHECK_IN_FLOOR_MESSAGE = 'Check-ins need to be at least 15 minutes apart.';
/** Fixed, so a saved definition's validity is a pure function of (expr, tz) and never changes with the clock. */
const TASK_CRON_FLOOR_FROM = new Date('2026-01-01T00:00:00.000Z');

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
const TASK_CRON_QUESTION_MARK_MESSAGE = 'A task’s schedule can’t use “?”. Write the exact time instead.';

/**
 * A cron's minute and hour fields, split the way croner 8.1.2 splits a pattern
 * (`replace(/\s+/g, ' ').split(' ')`, no trim), so they're the fields it
 * parsed: five, or six with seconds first. Null for what has no minute list to
 * wrap: croner reads an expression with ':' as a one-off date, and a nickname
 * (`@hourly`, `@daily`, ...) runs at minute 0 only.
 */
function cronMinuteAndHourFields(expr: string): { minute: string; hour: string } | null {
  if (expr.includes(':') || expr.includes('@')) return null;
  const parts = expr.replace(/\s+/g, ' ').split(' ');
  if (parts.length === 5) return { minute: parts[0]!, hour: parts[1]! };
  if (parts.length === 6) return { minute: parts[1]!, hour: parts[2]! };
  return null;
}

/**
 * The values one field takes, read back through croner's own parser: the
 * runs of `pattern` within the fixed UTC hour (minutes) or day (hours) that
 * starts at the floor's reference. UTC, so the answer depends on the field
 * alone. Null when croner can't read it.
 */
function cronFieldValues(pattern: string, unit: 'minute' | 'hour'): number[] | null {
  const start = TASK_CRON_FLOOR_FROM.getTime();
  const end = start + (unit === 'minute' ? 3_600_000 : 86_400_000);
  try {
    const cron = new Cron(pattern, { timezone: 'UTC' });
    const values: number[] = [];
    // From a second before the start, so a run at the start itself counts.
    for (let run = cron.nextRun(new Date(start - 1000)); run !== null && run.getTime() < end && values.length < 60; run = cron.nextRun(run)) {
      values.push(unit === 'minute' ? run.getUTCMinutes() : run.getUTCHours());
    }
    return values;
  } catch {
    return null;
  }
}

/**
 * The short gap the 48 runs can miss: from the last check-in of one hour to the
 * first of the next, `60 - max + min` minutes. It comes on every matching day
 * when the hours hold some h and h + 1, and wherever two matching days meet
 * when they hold 23 and 0. The second is refused whatever the day fields say,
 * which fails toward asking for a longer-looking schedule, never toward
 * accepting a shorter one. False when a field can't be read, which leaves the
 * 48-run verdict.
 */
function cronWrapsTooSoon(expr: string): boolean {
  const fields = cronMinuteAndHourFields(expr);
  if (fields === null) return false;
  const minutes = cronFieldValues(`${fields.minute} * * * *`, 'minute');
  if (minutes === null || minutes.length < 2) return false;
  if ((60 - minutes[minutes.length - 1]! + minutes[0]!) * 60 >= TASK_CHECK_IN_FLOOR_SECONDS) return false;
  const hours = cronFieldValues(`0 ${fields.hour} * * *`, 'hour');
  if (hours === null) return false;
  const present = new Set(hours);
  return (present.has(23) && present.has(0)) || hours.some(hour => present.has(hour + 1));
}

/**
 * The check-in floor for a cron task, as the issue message or null. A pure
 * function of (expr, tz), so a saved task's validity never changes with the
 * clock (read paths revalidate it). Never throws and never starts a scheduler.
 */
function cronFloorIssue(expr: string, tz: string): string | null {
  // croner fills "?" in from the clock as it parses, so the times it stands
  // for change with when the schedule is read. No floor can hold for that.
  if (expr.includes('?')) return TASK_CRON_QUESTION_MARK_MESSAGE;
  let runs: Date[];
  try { runs = new Cron(expr, { timezone: tz }).nextRuns(TASK_CRON_FLOOR_RUNS, TASK_CRON_FLOOR_FROM); }
  catch { return null; }
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < TASK_CHECK_IN_FLOOR_SECONDS * 1000) return TASK_CHECK_IN_FLOOR_MESSAGE;
  }
  return cronWrapsTooSoon(expr) ? TASK_CHECK_IN_FLOOR_MESSAGE : null;
}

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
  name: z.string().min(1).max(ROUTINE_NAME_MAX_CHARS),
  description: z.string().max(2048),
  promptBody: z.string(),
  enabled: z.boolean(),
  trigger: RoutineTriggerSchema,
  activeHours: ActiveHoursSchema.nullable(),
  silenceToken: z.string().max(128).nullable(),
  silenceMaxChars: z.number().int().min(0).max(65536),
  conversation: z.enum(['per-fire', 'shared']),
  kind: RoutineKindSchema,
  goodWhen: z.string().max(ROUTINE_GOOD_WHEN_MAX_CHARS).nullable(),
};

/*
 * A task's brief can't hide text from the card that asks (TASK-906).
 *
 * A person approves a task's name, instructions and going-well-when on an
 * approval card that draws them as text, so a character the browser doesn't
 * draw would put words in the brief that nobody saw. Models read Unicode tag
 * characters as the ASCII they shadow: "Keep the queue empty." followed by a
 * tag-encoded sentence looks like the first five words and says more.
 *
 * Refused, for any kind but repeat:
 *   - everything `HIDDEN_FORMAT_CHARS` matches: the shared fence's bidi,
 *     zero-width and line-separator class (TASK-562), imported, never copied;
 *   - C0 and C1 controls other than TAB, LF and CR, which instructions use as
 *     layout (so not `REWRITES_THE_SURFACE`, which includes those three);
 *   - `BRIEF_INVISIBLES`: what the shared class leaves out on purpose
 *     (widening it changes eight packages; TASK-562 decisions row 3);
 *   - a stray presentation selector (`STRAY_SELECTOR`).
 * Repeat routines keep accepting all of it: what an agent may write there
 * without asking is unchanged, and none of it is a task's brief.
 *
 * Every code point is written as an escape: an invisible character in source
 * is the very thing this guards against.
 */
/** C0 and C1 controls, except TAB (U+0009), LF (U+000A) and CR (U+000D). */
const BRIEF_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/**
 * Unicode's default-ignorable code points that the shared class leaves out,
 * minus the presentation selectors U+FE0E/U+FE0F (ordinary emoji, ruled on by
 * `STRAY_SELECTOR`) and Mongolian's free variation selectors U+180B-U+180D and
 * U+180F (ordinary Mongolian), plus the interlinear annotation controls
 * U+FFF9-U+FFFB: the soft hyphen, the combining grapheme joiner, the Hangul and
 * Khmer fillers, the Mongolian vowel separator, U+2065 and U+206A-U+206F, the
 * variation selectors U+FE00-U+FE0D, U+FFF0-U+FFFB, the shorthand and musical
 * format controls, and all of U+E0000-U+E0FFF: the tag characters, the
 * supplementary variation selectors U+E0100-U+E01EF, and the unassigned code
 * points around them. Disjoint from the shared class, so nothing of it is
 * repeated here. The astral ranges need the `u` flag.
 */
const BRIEF_INVISIBLES = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u2065\u206A-\u206F\u3164\uFE00-\uFE0D\uFFA0\uFFF0-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;
/**
 * A variation selector at the very start, or straight after another one. One
 * U+FE0E or U+FE0F after a character picks text or emoji presentation, and
 * that's ordinary emoji. A run of selectors after one base character draws as
 * that one character and can carry bytes.
 */
const STRAY_SELECTOR = /(?:^|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}])[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
const BRIEF_TEXT_FIELDS = [['name', 'name'], ['promptBody', 'instructions'], ['goodWhen', 'going-well-when']] as const;

function hidesText(value: string): boolean {
  return HIDDEN_FORMAT_CHARS.test(value) || BRIEF_CONTROLS.test(value) ||
    BRIEF_INVISIBLES.test(value) || STRAY_SELECTOR.test(value);
}

function validateDefinition(definition: RoutineDefinition, ctx: z.RefinementCtx): void {
  if (new TextEncoder().encode(JSON.stringify(definition)).length > ROUTINE_DEFINITION_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['promptBody'], message: 'Routine definition is too large.' });
  }
  if (definition.trigger.kind === 'webhook' && definition.activeHours !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeHours'], message: 'Webhook routines cannot have active hours.' });
  }
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  // Not `=== 'stay-on-top'`: a future kind is a task too.
  if (definition.kind !== 'repeat') {
    for (const [field, label] of BRIEF_TEXT_FIELDS) {
      const value = definition[field];
      if (typeof value === 'string' && hidesText(value)) issue([field], `A task’s ${label} can’t contain invisible characters.`);
    }
  }
  switch (definition.kind) {
    case 'repeat':
      if (definition.goodWhen !== null) issue(['goodWhen'], 'Only a task that stays on top of something can say when it’s going well.');
      break;
    case 'stay-on-top': {
      if (definition.goodWhen === null || definition.goodWhen.trim() === '') issue(['goodWhen'], 'Say how we’ll know this task is going well.');
      const { trigger } = definition;
      if (trigger.kind === 'webhook') issue(['trigger'], 'A task that stays on top of something checks in on a schedule, not from a webhook.');
      if (definition.conversation !== 'per-fire') issue(['conversation'], 'A task that stays on top of something starts a fresh conversation for each check-in.');
      if (definition.silenceToken !== null) issue(['silenceToken'], 'A task that stays on top of something reports how it’s going, so it doesn’t use a silence token.');
      if (trigger.kind === 'interval') {
        const seconds = durationToSeconds(trigger.every);
        if (seconds !== null && seconds < TASK_CHECK_IN_FLOOR_SECONDS) issue(['trigger', 'every'], TASK_CHECK_IN_FLOOR_MESSAGE);
      } else if (trigger.kind === 'cron') {
        const floor = cronFloorIssue(trigger.expr, trigger.tz);
        if (floor !== null) issue(['trigger', 'expr'], floor);
      }
      break;
    }
    default: {
      const unreachable: never = definition.kind;
      return unreachable;
    }
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
  kind: RoutineEditableShape.kind.default('repeat'),
  goodWhen: RoutineEditableShape.goodWhen.default(null),
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
  kind: RoutineEditableShape.kind.optional(),
  goodWhen: RoutineEditableShape.goodWhen.optional(),
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
    silenceMaxChars: row.silenceMaxChars, conversation: row.conversation,
    kind: row.kind, goodWhen: row.goodWhen,
  };
}
