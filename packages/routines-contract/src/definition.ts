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
const TASK_CRON_ONE_DATE_MESSAGE = 'A task that stays on top of something checks in again and again, so its schedule can’t be a single date.';
const TASK_CRON_NEVER_MESSAGE = 'This schedule never checks in.';

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
 * A task keeps checking in, so a schedule must repeat and must come at all.
 */
function cronFloorIssue(expr: string, tz: string): string | null {
  // croner fills "?" in from the clock as it parses, so the times it stands
  // for change with when the schedule is read. No floor can hold for that.
  if (expr.includes('?')) return TASK_CRON_QUESTION_MARK_MESSAGE;
  let cron: Cron;
  // The trigger's own check reports an expression croner can't read.
  try { cron = new Cron(expr, { timezone: tz }); }
  catch { return null; }
  // croner reads an expression with a ":" past its first character as one
  // date, and then has no pattern. An ISO date without a time has no ":", so
  // croner refuses it as a pattern and the trigger's own check reports it.
  if (cron.getPattern() === undefined) return TASK_CRON_ONE_DATE_MESSAGE;
  let runs: Date[];
  // A date no calendar has (31 February) sends croner's search, recursively,
  // through every year to its limit: it finds nothing, or it runs out of stack
  // first, depending on the pattern and on how deep the caller already is.
  // Both mean the task never checks in, so the verdict stays pure.
  try { runs = cron.nextRuns(TASK_CRON_FLOOR_RUNS, TASK_CRON_FLOOR_FROM); }
  catch { return TASK_CRON_NEVER_MESSAGE; }
  if (runs.length === 0) return TASK_CRON_NEVER_MESSAGE;
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
 *   - a stray presentation selector (`STRAY_SELECTOR`), and a Mongolian free
 *     variation selector anywhere but straight after a Mongolian letter
 *     (`STRAY_MONGOLIAN_SELECTOR`);
 *   - in the name, TAB, LF and CR: a name is one line, and TASK-908 puts it in
 *     the brief as one, so a line break in it would fake a second line there;
 *   - in the instructions and going-well-when, padding that pushes the rest
 *     out of view: more than two blank lines in a row (a blank line holds
 *     nothing to see, only whitespace and combining marks), a combining mark
 *     with no character to draw on (at the start of a line or after
 *     whitespace), more than 8 combining marks on one character (a stack that
 *     tall draws over the lines around it), or more than 16 whitespace
 *     characters in a row. The card draws each in a box that shows about
 *     twelve lines and then scrolls, with no scrollbar on systems that hide
 *     it, so "Keep the queue empty." over a screen of blank lines would hide
 *     the sentence below them.
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
 * U+180F (ordinary after a Mongolian letter, ruled on by
 * `STRAY_MONGOLIAN_SELECTOR`), plus characters that aren't default-ignorable
 * but draw as nothing all the same: the interlinear annotation controls
 * U+FFF9-U+FFFB, the Syriac abbreviation mark U+070F, the Egyptian hieroglyph
 * format controls U+13430-U+1343F, the Khitan small script filler U+16FE4,
 * the musical null notehead U+1D159, and the braille blank U+2800 (an empty
 * cell: not whitespace, so a run of it pads past the space rules below).
 * The default-ignorable part: the soft hyphen, the combining grapheme joiner,
 * the Hangul and Khmer fillers, the Mongolian vowel separator, U+2065 and
 * U+206A-U+206F, the variation selectors U+FE00-U+FE0D, U+FFF0-U+FFF8, the
 * shorthand and musical format controls, and all of U+E0000-U+E0FFF: the tag
 * characters, the supplementary variation selectors U+E0100-U+E01EF, and the
 * unassigned code points around them. Disjoint from the shared class, so
 * nothing of it is repeated here. The astral ranges need the `u` flag.
 */
const BRIEF_INVISIBLES = /[\u00AD\u034F\u070F\u115F\u1160\u17B4\u17B5\u180E\u2065\u206A-\u206F\u2800\u3164\uFE00-\uFE0D\uFFA0\uFFF0-\uFFFB\u{13430}-\u{1343F}\u{16FE4}\u{1BCA0}-\u{1BCA3}\u{1D159}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;
/**
 * A variation selector at the very start, or straight after another one. One
 * U+FE0E or U+FE0F after a character picks text or emoji presentation, and
 * that's ordinary emoji. A run of selectors after one base character draws as
 * that one character and can carry bytes.
 */
const STRAY_SELECTOR = /(?:^|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}])[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
/**
 * A Mongolian free variation selector (U+180B-U+180D, U+180F) that doesn't come
 * straight after a Mongolian letter (U+1820-U+1878, U+1880-U+18AA): at the
 * very start, after another selector, or after anything else. One after a
 * letter picks that letter's written form, which is ordinary Mongolian; any
 * other one draws as nothing and can carry bytes. No lookbehind, which older
 * browsers that bundle this contract can't parse.
 */
const STRAY_MONGOLIAN_SELECTOR = /(?:^|[^\u1820-\u1878\u1880-\u18AA])[\u180B-\u180D\u180F]/u;
const BRIEF_TEXT_FIELDS = [['name', 'name'], ['promptBody', 'instructions'], ['goodWhen', 'going-well-when']] as const;

/**
 * Each matches a stretch whose last code point is one the card wouldn't draw:
 * a single character, or a selector with what makes it stray in front of it.
 * None is global, so `exec` keeps no `lastIndex` between calls.
 */
const BRIEF_HIDDEN: readonly RegExp[] = [HIDDEN_FORMAT_CHARS, BRIEF_CONTROLS, BRIEF_INVISIBLES, STRAY_SELECTOR, STRAY_MONGOLIAN_SELECTOR];

/**
 * The first character in `value` the card wouldn't draw, or null: its code
 * point, and its position counted in code points from 1, so an emoji before
 * it counts once although it is two UTF-16 units. The decision is the
 * patterns' own; only a refusal pays for counting the position. A task's
 * report refuses the same characters (TASK-907).
 */
export function firstHiddenCharacter(value: string): { codePoint: number; position: number } | null {
  let index = -1;
  for (const pattern of BRIEF_HIDDEN) {
    const match = pattern.exec(value);
    if (match === null) continue;
    const points = [...match[0]];
    const at = match.index + match[0].length - points[points.length - 1]!.length;
    if (index === -1 || at < index) index = at;
  }
  if (index === -1) return null;
  return { codePoint: value.codePointAt(index)!, position: [...value.slice(0, index)].length + 1 };
}

/** More than 16 whitespace characters in a row, LF aside: spaces, tabs, CR, and the no-break and wide spaces. */
const BRIEF_SPACE_RUN = /[^\S\n]{17}/;

/**
 * A line with nothing on it to see: only whitespace and combining marks, which
 * draw on a character that isn't there. CR is whitespace, so CRLF text counts
 * the same. The invisible-character rule runs first, so the other characters
 * the contract knows draw as nothing are already refused.
 */
const BLANK_LINE = /^[\p{M}\s]*$/u;
/** A combining mark at the very start, at the start of a line or after whitespace: it has no character to draw on. */
const BASELESS_MARK = /(?:^|\s)\p{M}/u;
/** More than 8 combining marks in a row, on one character. Ordinary text stacks two or three. */
const MARK_STACK = /\p{M}{9}/u;

/** More than two blank lines in a row. */
function hasBlankLineRun(value: string): boolean {
  let blank = 0;
  for (const line of value.split('\n')) {
    blank = BLANK_LINE.test(line) ? blank + 1 : 0;
    if (blank > 2) return true;
  }
  return false;
}

/** The one thing wrong with a field of a task's brief, in plain words, or null. */
function briefFieldIssue(field: (typeof BRIEF_TEXT_FIELDS)[number][0], label: string, value: string): string | null {
  const hidden = firstHiddenCharacter(value);
  if (hidden !== null) {
    const codePoint = hidden.codePoint.toString(16).toUpperCase().padStart(4, '0');
    return `A task’s ${label} can’t contain invisible characters (U+${codePoint} at character ${hidden.position}).`;
  }
  if (field === 'name') return /[\t\n\r]/.test(value) ? 'A task’s name can’t contain tabs or line breaks.' : null;
  // Blank text has nothing to push out of view, and a blank going-well-when is the kind's own rule.
  if (value.trim() === '') return null;
  if (hasBlankLineRun(value)) return `A task’s ${label} can’t have more than two blank lines in a row.`;
  if (BASELESS_MARK.test(value)) return `A task’s ${label} can’t have an accent or other combining mark at the start of a line or after a space.`;
  if (MARK_STACK.test(value)) return `A task’s ${label} can’t stack more than 8 accents or other combining marks on one character.`;
  if (BRIEF_SPACE_RUN.test(value)) return `A task’s ${label} can’t have more than 16 spaces or tabs in a row.`;
  return null;
}

function validateDefinition(definition: RoutineDefinition, ctx: z.RefinementCtx): void {
  // A field gets one issue from here, so a person reads one reason for it.
  const flagged = new Set<string | number>();
  const issue = (path: (string | number)[], message: string): void => {
    flagged.add(path[0]!);
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  if (new TextEncoder().encode(JSON.stringify(definition)).length > ROUTINE_DEFINITION_MAX_BYTES) {
    issue(['promptBody'], 'Routine definition is too large.');
  }
  if (definition.trigger.kind === 'webhook' && definition.activeHours !== null) {
    issue(['activeHours'], 'Webhook routines cannot have active hours.');
  }
  // Not `=== 'stay-on-top'`: a future kind is a task too.
  if (definition.kind !== 'repeat') {
    for (const [field, label] of BRIEF_TEXT_FIELDS) {
      const value = definition[field];
      if (flagged.has(field) || typeof value !== 'string') continue;
      const problem = briefFieldIssue(field, label, value);
      if (problem !== null) issue([field], problem);
    }
  }
  switch (definition.kind) {
    case 'repeat':
      if (definition.goodWhen !== null) issue(['goodWhen'], 'Only a task that stays on top of something can say when it’s going well.');
      break;
    case 'stay-on-top': {
      if (!flagged.has('goodWhen') && (definition.goodWhen === null || definition.goodWhen.trim() === '')) {
        issue(['goodWhen'], 'Say how we’ll know this task is going well.');
      }
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

/*
 * A task's report (TASK-907): what a check-in says about how the task is going.
 * The agent writes it, the host keeps it as the task's state, and it goes back
 * to a model at the next check-in and in routine_list and routine_get. A person
 * reads it on the task page, which is what keeps an instruction injected
 * through a ticket in sight (the design's section 7), so the text can't say
 * more than the page shows. Each text field:
 *   - fits its cap, counted in UTF-16 units like the rest of the contract;
 *   - has something on it to read. Null is the one way to say "nothing", so a
 *     blank string is refused;
 *   - refuses what `firstHiddenCharacter` finds, the brief's own rule;
 *   - refuses a lone surrogate (half of a character), which a JSON body can
 *     carry. Postgres refuses one in a JSON column and puts U+FFFD in its place
 *     in a text one, so the stored report wouldn't be what the agent sent.
 * An update is also one line, with no LF or CR. The other line breaks (U+2028,
 * U+2029 and NEL) are invisible characters already. Padding (blank lines, runs
 * of spaces) is allowed: a report is read, not approved.
 *
 * The rules hold at the writer's input only. Stored text and the views aren't
 * re-checked, so a later change to a cap can't make a stored row unreadable
 * (TASK-913).
 */
export const ROUTINE_REPORT_STATUSES = ['on-track', 'off-track', 'needs-you'] as const;
export const RoutineReportStatusSchema = z.enum(ROUTINE_REPORT_STATUSES);
export type RoutineReportStatus = z.output<typeof RoutineReportStatusSchema>;
export const ROUTINE_REPORT_UPDATE_MAX_CHARS = 500;
export const ROUTINE_REPORT_ASK_MAX_CHARS = 500;
export const ROUTINE_AGENT_NOTES_MAX_CHARS = 2000;

/** Half of a character. With the `u` flag a pair reads as one code point, so only a surrogate with no partner matches. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * One text field of a report: zod's own cap, then the first rule the text
 * breaks, so it gets one reason. Text the cap refuses gets only the cap's
 * reason and isn't scanned.
 */
function reportText(rule: { max: number; blank: string; oneLine: boolean }): z.ZodEffects<z.ZodString, string, string> {
  return z.string().min(1).max(rule.max).superRefine((value, ctx) => {
    if (value.length < 1 || value.length > rule.max) return;
    const problem = value.trim() === '' ? rule.blank
      : rule.oneLine && /[\n\r]/.test(value) ? 'An update is one line.'
      : firstHiddenCharacter(value) !== null ? 'A report can’t contain invisible characters.'
      : LONE_SURROGATE.test(value) ? 'A report can’t contain broken characters.'
      : null;
    if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });
}

/**
 * A report's fields as the agent writes them. `ask` and `notes` are nullable and
 * required here, and each schema that uses them picks its own default: the tool
 * fills a missing `ask` with null, and leaving `notes` out keeps the saved ones.
 */
export const RoutineReportFieldShape = {
  status: RoutineReportStatusSchema,
  update: reportText({ max: ROUTINE_REPORT_UPDATE_MAX_CHARS, blank: 'Say how the task is going.', oneLine: true }),
  ask: reportText({ max: ROUTINE_REPORT_ASK_MAX_CHARS, blank: 'Write something, or send null.', oneLine: false }).nullable(),
  notes: reportText({ max: ROUTINE_AGENT_NOTES_MAX_CHARS, blank: 'Write something, or send null.', oneLine: false }).nullable(),
};

/** A task's latest report and the notes it keeps between check-ins, as a read shows them. Stored text isn't re-capped (TASK-913). */
export const RoutineTaskViewSchema = z.object({
  status: RoutineReportStatusSchema, update: z.string(), ask: z.string().nullable(),
  reportedAt: RoutineInstantSchema, notes: z.string().nullable(),
}).strict();
export type RoutineTaskView = z.output<typeof RoutineTaskViewSchema>;

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
