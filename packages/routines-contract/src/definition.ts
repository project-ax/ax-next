import { HIDDEN_FORMAT_CHARS } from '@ax/core/surface-text';
import { Cron } from 'croner';
import { z } from 'zod';

export const ROUTINE_LEGACY_DEFINITION_MAX_BYTES = 64 * 1024;
/** Replacing one `trigger` key with `schedule`/`webhook` and one null adds exactly 16 bytes. */
export const ROUTINE_METHOD_NORMALIZATION_OVERHEAD_BYTES = 16;
export const ROUTINE_DEFINITION_MAX_BYTES = ROUTINE_LEGACY_DEFINITION_MAX_BYTES + ROUTINE_METHOD_NORMALIZATION_OVERHEAD_BYTES;
export const ROUTINE_OPAQUE_STRING_MAX_CHARS = 256;
/** A routine's name, in UTF-16 units (zod's `max`), so at most this many code points too. */
export const ROUTINE_NAME_MAX_CHARS = 128;
export const RoutineOpaqueStringSchema = z.string().min(1).max(ROUTINE_OPAQUE_STRING_MAX_CHARS);

export const ROUTINE_KINDS = ['repeat', 'stay-on-top', 'get-done'] as const;
export const RoutineKindSchema = z.enum(ROUTINE_KINDS);
export type RoutineKind = z.output<typeof RoutineKindSchema>;
/**
 * The kinds that are tasks (TASK-948). Write paths check a kind against this
 * list and refuse one they don't know; read paths keep `!== 'repeat'`.
 */
export const TASK_KINDS = ['stay-on-top', 'get-done'] as const satisfies readonly RoutineKind[];
export type TaskKind = (typeof TASK_KINDS)[number];
/** Membership in `TASK_KINDS`, never a property lookup, so an inherited name such as `toString` is no kind. */
export function isTaskKind(kind: string): kind is TaskKind {
  return (TASK_KINDS as readonly string[]).includes(kind);
}
export const ROUTINE_GOOD_WHEN_MAX_CHARS = 1024;
/** A task checks in no more often than this. */
export const TASK_CHECK_IN_FLOOR_SECONDS = 900;
export const REPEAT_SCHEDULE_FLOOR_SECONDS = 60;
const REPEAT_SCHEDULE_FLOOR_MESSAGE = 'Repeat jobs need to be at least 60 seconds apart.';
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
const TASK_CRON_ONE_DATE_MESSAGE = 'A task checks in again and again, so its schedule can’t be a single date.';
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
function cronFieldValues(pattern: string, unit: 'second' | 'minute' | 'hour'): number[] | null {
  const start = TASK_CRON_FLOOR_FROM.getTime();
  const end = start + (unit === 'second' ? 60_000 : unit === 'minute' ? 3_600_000 : 86_400_000);
  try {
    const cron = new Cron(pattern, { timezone: 'UTC' });
    const values: number[] = [];
    // From a second before the start, so a run at the start itself counts.
    for (let run = cron.nextRun(new Date(start - 1000)); run !== null && run.getTime() < end && values.length < 60; run = cron.nextRun(run)) {
      values.push(unit === 'second' ? run.getUTCSeconds() : unit === 'minute' ? run.getUTCMinutes() : run.getUTCHours());
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
export const RoutineScheduleSchema = z.discriminatedUnion('kind', [IntervalTriggerSchema, CronTriggerSchema])
  .superRefine((schedule, ctx) => {
    if (schedule.kind !== 'cron') return;
    try { new Cron(schedule.expr, { timezone: schedule.tz }); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expr'], message: 'Invalid cron expression or timezone.' }); }
  });
export type RoutineSchedule = z.output<typeof RoutineScheduleSchema>;
export type WebhookTrigger = z.output<typeof WebhookTriggerSchema>;

/**
 * Authoring guard only: reads and completed receipts still accept legacy fast cron.
 * A cron with one seconds value can run at most once a minute. Two distinct values
 * necessarily put two runs less than 60 seconds apart in a matching minute, so
 * inspect the seconds field directly rather than assuming 48 runs cover every gap.
 * Question marks keep their existing repeat semantics: one clock-relative value is
 * fine, while a list/range with another value is checked at both endpoints. This is
 * independent of the current clock and does not add task-only recurrence rules.
 */
export function repeatScheduleWriteIssue(schedule: RoutineSchedule | null, previous?: RoutineSchedule | null): string | null {
  if (schedule === null) return null;
  if (previous !== undefined && previous !== null && schedule.kind === previous.kind &&
      (schedule.kind === 'interval' && previous.kind === 'interval' && schedule.every === previous.every ||
       schedule.kind === 'cron' && previous.kind === 'cron' && schedule.expr === previous.expr && schedule.tz === previous.tz)) return null;
  if (schedule.kind === 'interval') return durationToSeconds(schedule.every) === null ? REPEAT_SCHEDULE_FLOOR_MESSAGE : null;
  if (schedule.expr.includes(':') || schedule.expr.includes('@')) return null;
  const parts = schedule.expr.replace(/\s+/g, ' ').split(' ');
  if (parts.length !== 6) return null;
  const seconds = parts[0]!;
  const samples = seconds.includes('?') ? [seconds.replaceAll('?', '0'), seconds.replaceAll('?', '59')] : [seconds];
  return samples.some(sample => (cronFieldValues(`${sample} * * * * *`, 'second')?.length ?? 0) > 1) ? REPEAT_SCHEDULE_FLOOR_MESSAGE : null;
}
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
  schedule: RoutineScheduleSchema.nullable(),
  webhook: WebhookTriggerSchema.nullable(),
  activeHours: ActiveHoursSchema.nullable(),
  silenceToken: z.string().max(128).nullable(),
  silenceMaxChars: z.number().int().min(0).max(65536),
  conversation: z.enum(['per-fire', 'shared']),
  kind: RoutineKindSchema,
  goodWhen: z.string().max(ROUTINE_GOOD_WHEN_MAX_CHARS).nullable(),
};
const { schedule: _scheduleShape, webhook: _webhookShape, ...legacyCommonShape } = RoutineEditableShape;
/** Legacy/default boundary fields only; authored values use RoutineEditableShape. */
export const LegacyRoutineEditableShape = { ...legacyCommonShape, trigger: RoutineTriggerSchema };

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

/** Where `firstHiddenCharacter` found one, as a person reads it: "U+200B at character 3". */
function hiddenCharacterAt(hidden: { codePoint: number; position: number }): string {
  return `U+${hidden.codePoint.toString(16).toUpperCase().padStart(4, '0')} at character ${hidden.position}`;
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
/** A combining mark at the very start, at the start of a line or after whitespace: it has no character to draw on. A report's and a step's text too (TASK-957). */
const BASELESS_MARK = /(?:^|\s)\p{M}/u;
/** More than 8 combining marks in a row, on one character. Ordinary text stacks two or three. A report's and a step's text too (TASK-957). */
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
  if (hidden !== null) return `A task’s ${label} can’t contain invisible characters (${hiddenCharacterAt(hidden)}).`;
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
  if (definition.schedule === null && definition.activeHours !== null) {
    issue(['activeHours'], 'Active hours need a schedule.');
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
      if (definition.goodWhen !== null) issue(['goodWhen'], 'Only a task can say when it’s going well.');
      if (definition.schedule === null && definition.webhook === null) issue(['schedule'], 'Choose a schedule or updates from another app.');
      break;
    // TASK-948: both task kinds keep a schedule and a brief, so they share one set of rules, in words that fit either.
    case 'stay-on-top':
    case 'get-done': {
      if (!flagged.has('goodWhen') && (definition.goodWhen === null || definition.goodWhen.trim() === '')) {
        issue(['goodWhen'], 'Say how we’ll know this task is going well.');
      }
      const { schedule, webhook } = definition;
      if (schedule === null && webhook === null) issue(['schedule'], 'A task needs a schedule.');
      if (webhook !== null) issue(['webhook'], 'A task checks in on a schedule, not from an update from another app.');
      if (definition.conversation !== 'per-fire') issue(['conversation'], 'A task starts a fresh conversation for each check-in.');
      if (definition.silenceToken !== null) issue(['silenceToken'], 'A task reports how it’s going, so it doesn’t use a silence token.');
      if (schedule?.kind === 'interval') {
        const seconds = durationToSeconds(schedule.every);
        if (seconds !== null && seconds < TASK_CHECK_IN_FLOOR_SECONDS) issue(['schedule', 'every'], TASK_CHECK_IN_FLOOR_MESSAGE);
      } else if (schedule?.kind === 'cron') {
        const floor = cronFloorIssue(schedule.expr, schedule.tz);
        if (floor !== null) issue(['schedule', 'expr'], floor);
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
  schedule: RoutineEditableShape.schedule.default(null),
  webhook: RoutineEditableShape.webhook.default(null),
  description: RoutineEditableShape.description.default(''),
  enabled: RoutineEditableShape.enabled.default(true),
  activeHours: RoutineEditableShape.activeHours.default(null),
  silenceToken: RoutineEditableShape.silenceToken.default(null),
  silenceMaxChars: RoutineEditableShape.silenceMaxChars.default(300),
  conversation: RoutineEditableShape.conversation.default('per-fire'),
  kind: RoutineEditableShape.kind.default('repeat'),
  goodWhen: RoutineEditableShape.goodWhen.default(null),
}).strict();

/** The legacy input object is a boundary DTO, never an authored definition or mirror. */
export const LegacyRoutineDefinitionObjectSchema = RoutineDefinitionObjectSchema.omit({ schedule: true, webhook: true })
  .extend({ trigger: RoutineTriggerSchema }).strict();
const legacyDefinitionKeys = Object.keys(LegacyRoutineDefinitionObjectSchema.shape);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownFields = (value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(keys.map(key => [key, value[key]]));
const encodedSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Preprocess a legacy definition or stored snapshot, preserving every other key for
 * the caller's strict schema. Byte checks cover the editable definition alone, not
 * a receipt's metadata. The parser reads known inherited/non-enumerable fields just
 * as zod does; mixed method representations remain invalid rather than being lost.
 */
export function normalizeLegacyRoutineDefinition(value: unknown, ctx: z.RefinementCtx): unknown {
  if (!isObject(value) || !('trigger' in value)) return value;
  if ('schedule' in value || 'webhook' in value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schedule'], message: 'Use schedule and webhook, or the legacy trigger, without mixing them.' });
    return z.NEVER;
  }
  const legacy = LegacyRoutineDefinitionObjectSchema.safeParse(ownFields(value, legacyDefinitionKeys));
  if (!legacy.success) {
    for (const issue of legacy.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }
  if (encodedSize(legacy.data) > ROUTINE_LEGACY_DEFINITION_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['promptBody'], message: 'Routine definition is too large.' });
    return z.NEVER;
  }
  const { trigger, ...definition } = legacy.data;
  const normalized: Record<string, unknown> = {
    ...value, ...definition,
    schedule: trigger.kind === 'webhook' ? null : trigger,
    webhook: trigger.kind === 'webhook' ? trigger : null,
  };
  delete normalized.trigger;
  return normalized;
}
export const RoutineDefinitionSchema = z.preprocess(normalizeLegacyRoutineDefinition, RoutineDefinitionObjectSchema.superRefine(validateDefinition));

// Explicit optional fields keep create defaults from filling omissions in a patch.
const RoutinePatchObjectSchema = z.object({
  name: RoutineEditableShape.name.optional(),
  description: RoutineEditableShape.description.optional(),
  promptBody: RoutineEditableShape.promptBody.optional(),
  enabled: RoutineEditableShape.enabled.optional(),
  schedule: RoutineEditableShape.schedule.optional(),
  webhook: RoutineEditableShape.webhook.optional(),
  activeHours: RoutineEditableShape.activeHours.optional(),
  silenceToken: RoutineEditableShape.silenceToken.optional(),
  silenceMaxChars: RoutineEditableShape.silenceMaxChars.optional(),
  conversation: RoutineEditableShape.conversation.optional(),
  kind: RoutineEditableShape.kind.optional(),
  goodWhen: RoutineEditableShape.goodWhen.optional(),
}).strict();
const LegacyRoutinePatchObjectSchema = RoutinePatchObjectSchema.omit({ schedule: true, webhook: true }).extend({ trigger: RoutineTriggerSchema.optional() }).strict();
const legacyPatchKeys = Object.keys(LegacyRoutinePatchObjectSchema.shape);
export function normalizeLegacyRoutinePatch(value: unknown, ctx: z.RefinementCtx): unknown {
  if (!isObject(value) || !('trigger' in value)) return value;
  if ('schedule' in value || 'webhook' in value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schedule'], message: 'Use schedule and webhook, or the legacy trigger, without mixing them.' });
    return z.NEVER;
  }
  const projected = Object.fromEntries(legacyPatchKeys.filter(key => key in value).map(key => [key, value[key]]));
  const legacy = LegacyRoutinePatchObjectSchema.safeParse(projected);
  if (!legacy.success) {
    for (const issue of legacy.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }
  if (encodedSize(legacy.data) > ROUTINE_LEGACY_DEFINITION_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['promptBody'], message: 'Routine patch is too large.' });
    return z.NEVER;
  }
  if (legacy.data.trigger === undefined) return value;
  const { trigger, ...patch } = legacy.data;
  const normalized: Record<string, unknown> = {
    ...value, ...patch,
    schedule: trigger.kind === 'webhook' ? null : trigger,
    webhook: trigger.kind === 'webhook' ? trigger : null,
  };
  delete normalized.trigger;
  return normalized;
}
export const RoutinePatchSchema: z.ZodType<RoutinePatch, z.ZodTypeDef, unknown> = z.preprocess(normalizeLegacyRoutinePatch, RoutinePatchObjectSchema.superRefine((patch, ctx) => {
  if (Object.keys(patch).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Routine patch must contain an editable field.' });
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Omit unchanged fields.' });
  }
  if (new TextEncoder().encode(JSON.stringify(patch)).length > ROUTINE_DEFINITION_MAX_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['promptBody'], message: 'Routine patch is too large.' });
})) as unknown as z.ZodType<RoutinePatch, z.ZodTypeDef, unknown>;

export type RoutineDefinition = z.output<typeof RoutineDefinitionObjectSchema>;
export type RoutinePatch = Partial<RoutineDefinition>;
export type RoutineTrigger = z.output<typeof RoutineTriggerSchema>;
export type ActiveHours = z.output<typeof ActiveHoursSchema>;

export function applyRoutinePatch(current: RoutineDefinition, patch: RoutinePatch): RoutineDefinition {
  const checked = RoutinePatchSchema.parse(patch);
  return RoutineDefinitionSchema.parse({ ...RoutineDefinitionSchema.parse(current), ...checked });
}

export const RoutinePermissionsSchema = z.object({ edit: z.boolean(), stop: z.boolean(), fire: z.boolean(), manageSecret: z.boolean() }).strict();
export const RoutineInstantSchema = z.string().datetime({ offset: true });

/*
 * Why a task's check-in ended without a report (TASK-930). The host writes
 * these, never an agent: they are the closed set of reasons, classified where
 * the miss happens rather than parsed from an error string. The wording a person
 * reads lives in channel-web.
 */
export const CHECK_IN_MISSES = ['no-report', 'brief-missing', 'brief-unconfirmed', 'brief-too-long', 'interrupted', 'failed'] as const;
export const CheckInMissSchema = z.enum(CHECK_IN_MISSES);
export type CheckInMiss = z.output<typeof CheckInMissSchema>;
/** Check-ins in a row with no report before a task asks a person for help. */
export const TASK_NEEDS_YOU_AFTER_MISSES = 3;
/** Check-ins in a row with no report before ax pauses the task. */
export const TASK_AUTO_PAUSE_AFTER_MISSES = 5;
export const RoutineNoRecentUpdateViewSchema = z.object({
  inARow: z.number().int().min(1), reason: CheckInMissSchema, at: RoutineInstantSchema, autoPaused: z.boolean(),
}).strict();
export type RoutineNoRecentUpdateView = z.output<typeof RoutineNoRecentUpdateViewSchema>;

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
 *     in a text one, so the stored report wouldn't be what the agent sent;
 *   - refuses a combining mark with nothing to draw on (at the very start, at
 *     the start of a line or after a space) and more than 8 combining marks on
 *     one character, the brief's own `BASELESS_MARK` and `MARK_STACK`
 *     (TASK-957). A mark draws on the character before it, so one with no base
 *     lands on whatever is drawn before the text, and a tall stack draws over
 *     the lines around it.
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
/**
 * TASK-952: a report's optional reading is one number the agent read at this
 * check-in, with a short label it chose ("Open tickets: 3"). It's shown as the
 * agent's reading, never as a measure ax computed or checked. The label follows
 * the report's text rule, one line like an update. The value is a finite number
 * within ±`ROUTINE_READING_MAX_ABS`. Like the rest of a report, it's checked at
 * the writer's input only (TASK-913).
 */
export const ROUTINE_READING_LABEL_MAX_CHARS = 40;
export const ROUTINE_READING_MAX_ABS = 1e12;

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
      : BASELESS_MARK.test(value) ? 'A report can’t have an accent or other combining mark at the start of a line or after a space.'
      : MARK_STACK.test(value) ? 'A report can’t stack more than 8 accents or other combining marks on one character.'
      : null;
    if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });
}

/** A report's reading (TASK-952): exactly `{ value, label }`. A refusal's path names the part that's wrong. */
export const RoutineReadingSchema = z.object({
  value: z.number().finite().min(-ROUTINE_READING_MAX_ABS).max(ROUTINE_READING_MAX_ABS),
  label: reportText({ max: ROUTINE_READING_LABEL_MAX_CHARS, blank: 'Name what you read, for example "Open tickets".', oneLine: true }),
}).strict();
export type RoutineReading = z.output<typeof RoutineReadingSchema>;

/**
 * A report's fields as the agent writes them. `ask` and `notes` are nullable and
 * required here, and each schema that uses them picks its own default: the tool
 * fills a missing `ask` with null, and leaving `notes` out keeps the saved ones.
 * `reading` is nullable and required here too; the tool and the service take it
 * optional, and absent or null both mean no reading this time. `done`
 * (TASK-950) is optional on both inputs, and left out or false is no claim.
 */
export const RoutineReportFieldShape = {
  status: RoutineReportStatusSchema,
  update: reportText({ max: ROUTINE_REPORT_UPDATE_MAX_CHARS, blank: 'Say how the task is going.', oneLine: true }),
  ask: reportText({ max: ROUTINE_REPORT_ASK_MAX_CHARS, blank: 'Write something, or send null.', oneLine: false }).nullable(),
  notes: reportText({ max: ROUTINE_AGENT_NOTES_MAX_CHARS, blank: 'Write something, or send null.', oneLine: false }).nullable(),
  reading: RoutineReadingSchema.nullable(),
  done: z.boolean(),
};

/**
 * TASK-950. A claim that a task is done comes with status "needs-you": one
 * issue, at path `['done']`. The claim is part of the report, and every reader
 * of a task (the Tasks page's groups, Today, the badge) keys on the report's
 * status, so a claim must come with "needs-you" to reach the person who
 * decides. Both report inputs refine their whole object with it: a rule on the
 * `done` field alone can't see `status`. The message never reaches the agent,
 * whose refusal names only the field (core's fixed template); it is for the
 * contract's own callers and tests.
 */
export function refuseDoneWithoutNeedsYou(
  report: { status: RoutineReportStatus; done?: boolean | undefined }, ctx: z.RefinementCtx,
): void {
  if (report.done !== true || report.status === 'needs-you') return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['done'], message: 'When you think the task is done, send status "needs-you" with done true.' });
}

/*
 * A reply (TASK-931): what a task's owner writes to their agent about the task,
 * on its task page. Only the task's owner sends one, and it reaches a model
 * only in a later check-in message, quoted and labelled as the person's own
 * words: never in the brief, a tool's answer or a routine view. Unlike a
 * report's, this rule's messages reach the person: the reply box runs this same
 * schema before it sends and shows the first message, so each one says what to
 * fix. The text:
 *   - fits `ROUTINE_REPLY_MAX_CHARS`, counted in UTF-16 units like the rest of
 *     the contract;
 *   - has something on it to read;
 *   - refuses what `firstHiddenCharacter` finds, the brief's own rule, and
 *     names the first one and where it is: nobody can find an invisible
 *     character in a text box by looking;
 *   - refuses a lone surrogate (half of a character), which a JSON body can
 *     carry: stored, it wouldn't be what the person sent.
 * Line breaks and the person's own spacing are allowed: a reply is their own
 * words to their agent, not a brief they approve. The rule holds at the
 * writer's input only, so stored replies aren't re-checked (TASK-913).
 */
export const ROUTINE_REPLY_MAX_CHARS = 2000;
const REPLY_BLANK = 'Write a reply first.';

/** The one thing wrong with a reply's text that fits the cap, in the person's words, or null. */
function replyTextIssue(value: string): string | null {
  if (value.trim() === '') return REPLY_BLANK;
  const hidden = firstHiddenCharacter(value);
  if (hidden !== null) return `A reply can’t contain invisible characters (${hiddenCharacterAt(hidden)}).`;
  return LONE_SURROGATE.test(value) ? 'A reply can’t contain broken characters.' : null;
}

/** zod's cap with the person's own words for it, then the first rule the text breaks, so it gets one reason. */
export const RoutineReplyTextSchema = z.string()
  .min(1, REPLY_BLANK)
  .max(ROUTINE_REPLY_MAX_CHARS, 'A reply can be up to 2,000 characters.')
  .superRefine((value, ctx) => {
    if (value.length < 1 || value.length > ROUTINE_REPLY_MAX_CHARS) return;
    const problem = replyTextIssue(value);
    if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

/*
 * A task's steps (TASK-948): a "get-done" task's checklist, at most
 * `ROUTINE_STEPS_MAX` of them. The agent drafts them at its first check-in,
 * then adds, ticks and unticks them through its report, and it can reword or
 * remove only the steps it added. The task's owner can add, tick, reword or
 * remove any of them on its task page (TASK-949). A step comes back in every
 * later check-in message and shows on the task page, so the rules hold at each
 * writer's input. A step's text:
 *   - fits `ROUTINE_STEP_TEXT_MAX_CHARS`, counted in UTF-16 units like the rest
 *     of the contract;
 *   - has something on it to read;
 *   - is one line, with no LF or CR, so it can't pose as a second step (the
 *     other line breaks are invisible characters already);
 *   - refuses what `firstHiddenCharacter` finds, the brief's own rule, and
 *     names the first one and where it is;
 *   - refuses a lone surrogate (half of a character), which a JSON body can
 *     carry: Postgres refuses one in a JSONB value and quotes the value it
 *     refused in its error.
 *   - refuses a combining mark with nothing to draw on (at the start or after
 *     a space) and more than 8 combining marks on one character, the brief's
 *     and the report's `BASELESS_MARK` and `MARK_STACK` (TASK-957): a mark
 *     with no base lands on whatever the page draws before the step, and a
 *     tall stack draws over the steps around it.
 * Like a reply's, these messages reach a person (the task page's step editor
 * shows them, TASK-949), so each says what to fix; the agent gets only the
 * field's name, through core's fixed template. Stored text isn't re-checked
 * (TASK-913), so a view takes any string. A step's id is made by the host and
 * opaque to everyone else, and no change can say who added a step: the host
 * sets that.
 */
export const ROUTINE_STEPS_MAX = 50;
export const ROUTINE_STEP_TEXT_MAX_CHARS = 200;
/** A step's id is opaque and host-made; only its length is bounded. */
export const ROUTINE_STEP_ID_MAX_CHARS = 32;
export const ROUTINE_STEP_AUTHORS = ['person', 'agent'] as const;
export const RoutineStepAuthorSchema = z.enum(ROUTINE_STEP_AUTHORS);
export type RoutineStepAuthor = z.output<typeof RoutineStepAuthorSchema>;
const STEP_BLANK = 'Write the step first.';

/** The one thing wrong with a step's text that fits the cap, in the person's words, or null. */
function stepTextIssue(value: string): string | null {
  if (value.trim() === '') return STEP_BLANK;
  if (/[\n\r]/.test(value)) return 'A step is one line.';
  const hidden = firstHiddenCharacter(value);
  if (hidden !== null) return `A step can’t contain invisible characters (${hiddenCharacterAt(hidden)}).`;
  if (LONE_SURROGATE.test(value)) return 'A step can’t contain broken characters.';
  if (BASELESS_MARK.test(value)) return 'A step can’t have an accent or other combining mark at the start or after a space.';
  return MARK_STACK.test(value) ? 'A step can’t stack more than 8 accents or other combining marks on one character.' : null;
}

/** zod's cap with the person's own words for it, then the first rule the text breaks, so it gets one reason. */
export const RoutineStepTextSchema = z.string()
  .min(1, STEP_BLANK)
  .max(ROUTINE_STEP_TEXT_MAX_CHARS, 'A step can be up to 200 characters.')
  .superRefine((value, ctx) => {
    if (value.length < 1 || value.length > ROUTINE_STEP_TEXT_MAX_CHARS) return;
    const problem = stepTextIssue(value);
    if (problem !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });
export const RoutineStepIdSchema = z.string().min(1).max(ROUTINE_STEP_ID_MAX_CHARS);
/** A step as a read shows it. `addedBy` is host-set, so a reader can tell the agent's words from the person's. */
export const RoutineStepViewSchema = z.object({
  id: RoutineStepIdSchema, text: z.string(), done: z.boolean(), addedBy: RoutineStepAuthorSchema,
}).strict();
export type RoutineStepView = z.output<typeof RoutineStepViewSchema>;
/**
 * One change to a task's steps, as the agent sends it in a report, or a person
 * sends it from the task page (`routines:set-steps`, TASK-949). Each is
 * strict, so none can name a new step's id or say who added a step: the host
 * sets that from who sent the change. `done` on an add is for a step finished
 * in the same check-in: the host makes a new step's id, so the report can't
 * tick it by id.
 */
export const RoutineStepOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), text: RoutineStepTextSchema, done: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('tick'), id: RoutineStepIdSchema }).strict(),
  z.object({ op: z.literal('untick'), id: RoutineStepIdSchema }).strict(),
  z.object({ op: z.literal('edit'), id: RoutineStepIdSchema, text: RoutineStepTextSchema }).strict(),
  z.object({ op: z.literal('remove'), id: RoutineStepIdSchema }).strict(),
]);
export type RoutineStepOp = z.output<typeof RoutineStepOpSchema>;
/**
 * A list of changes to a task's steps, applied in order: a report's, and a
 * person's (`routines:set-steps`, TASK-949). One rule for both: never empty
 * when sent, and at most `ROUTINE_STEPS_MAX`. Optional on both report inputs.
 */
export const RoutineReportStepsSchema = z.array(RoutineStepOpSchema).min(1).max(ROUTINE_STEPS_MAX);
/** What a report that sent changes hears back: how many applied and how many were skipped. Counts only, never a step's text. */
export const RoutineReportStepsOutcomeSchema = z.object({ applied: z.number().int().min(0), skipped: z.number().int().min(0) }).strict();

/**
 * TASK-952. A reading as a read shows it: the number the agent sent and its
 * label. Types only: stored values aren't re-checked, so a later change to the
 * writer's rule can't make a stored reading unreadable (TASK-913).
 */
export const RoutineReadingViewSchema = z.object({ value: z.number(), label: z.string() }).strict();
export type RoutineReadingView = z.output<typeof RoutineReadingViewSchema>;

/**
 * A task's latest report and the notes it keeps between check-ins, as a read
 * shows them. The agent sends its notes as the report's `notes`; a read names
 * them `agentNotes`, so whoever reads them knows who wrote them. TASK-952:
 * `reading` is the reading that report sent, or null. It's required, so a view
 * from a producer that doesn't know it is refused rather than read as "no
 * reading". TASK-950: `doneClaimed` says that report claimed a "get-done" task
 * is finished (its `done`), so the person can mark it done or say what's left;
 * always false for any other kind. Required too, so a view from a producer
 * that doesn't know it is refused rather than read as "no claim". Stored text
 * isn't re-capped (TASK-913).
 */
export const RoutineTaskViewSchema = z.object({
  status: RoutineReportStatusSchema, update: z.string(), ask: z.string().nullable(),
  reading: RoutineReadingViewSchema.nullable(), doneClaimed: z.boolean(),
  reportedAt: RoutineInstantSchema, agentNotes: z.string().nullable(),
}).strict();
export type RoutineTaskView = z.output<typeof RoutineTaskViewSchema>;

/** What a task's report shows when its agent notes stay out of the read: the list tool's view (TASK-907). */
export const RoutineTaskListViewSchema = RoutineTaskViewSchema.omit({ agentNotes: true });
export type RoutineTaskListView = z.output<typeof RoutineTaskListViewSchema>;

/**
 * TASK-950. When a person marked a "get-done" task done. Only `at`: who marked
 * it is always the task's owner, the one person a view shows it to, so the
 * view never names anyone.
 */
export const RoutineDoneViewSchema = z.object({ at: RoutineInstantSchema }).strict();
export type RoutineDoneView = z.output<typeof RoutineDoneViewSchema>;

const RoutineViewShape = {
  ...RoutineEditableShape,
  agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema, revision: RoutineOpaqueStringSchema,
  origin: z.enum(['authored', 'default']), defaultRoutineId: RoutineOpaqueStringSchema.nullable(),
  nextRunAt: RoutineInstantSchema.nullable(), lastRunAt: RoutineInstantSchema.nullable(),
  lastStatus: RoutineStatusSchema.nullable(), lastError: z.string().nullable(), lastWarning: z.string().nullable(),
  permissions: RoutinePermissionsSchema,
  /**
   * TASK-930. A task's check-ins in a row that ended without a report. Host-written
   * (a count, a closed reason code, the last one's start, whether ax paused the
   * task), never agent text. Null for a repeat routine, for a task with none, for
   * anyone but the task's owner (`task`'s rule), and in an exact replay's answer:
   * a receipt keeps none. Required, so a view from a producer that doesn't know
   * it is refused rather than read as "no misses". The same in every view, the
   * tools' included: the owner's chat shows it to the model, whose tool
   * descriptions say what it means and that only a person resumes a paused task.
   */
  noRecentUpdate: RoutineNoRecentUpdateViewSchema.nullable(),
  /**
   * TASK-951. A "get-done" task's finish date, `YYYY-MM-DD`, or null: null for
   * any other kind and for a task with none. Only a person sets it, through
   * `routines:set-finish-by`; no tool can. Unlike `task` it isn't owner-gated:
   * it is about the work, holds no agent text, and whoever can see the routine
   * sees it. A read takes it as a type, not the rule (TASK-913). Receipts keep
   * none, so an exact replay's answer has none. Required, so a view from a
   * producer that doesn't know it is refused rather than read as "no date".
   * The same in every view, the tools' included.
   */
  finishBy: z.string().nullable(),
  /**
   * TASK-955. The time zone the person's browser reported when they set
   * `finishBy`, or null: null for any kind but get-done, when there is no
   * date, and when the browser reported none. A task with no zone of its own
   * counts its date's days on it (`taskTimeZone`). Only a person's browser
   * sends it, through `routines:set-finish-by`; no tool can. Like `finishBy`,
   * it isn't owner-gated, and a read takes it as a type, not the zone rule
   * (TASK-913). Receipts keep none, so an exact replay's answer has none.
   * Required, so a view from a producer that doesn't know it is refused
   * rather than read as "no zone". The same in every view, the tools'
   * included.
   */
  finishByTimeZone: z.string().nullable(),
  /**
   * TASK-950. A "get-done" task a person marked done: `{ at }`, while it stays
   * done (off, and finished by its owner). Host-written, never agent text. Null
   * for anyone but the task's owner (`task`'s rule), for any kind but get-done,
   * for a task that isn't done, and in an exact replay's answer: a receipt
   * keeps none. Required, so a view from a producer that doesn't know it is
   * refused rather than read as "not done". The same in every view, the tools'
   * included: their descriptions say only a person reopens a done task.
   */
  done: RoutineDoneViewSchema.nullable(),
};
function validateView(view: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const definition = Object.fromEntries(Object.keys(RoutineEditableShape).map(key => [key, view[key]]));
  validateDefinition(definition as RoutineDefinition, ctx);
}
export const RoutineViewSchema = z.object({
  ...RoutineViewShape,
  /**
   * TASK-907. Null for a repeat routine, for a task that hasn't reported yet,
   * for anyone but the task's owner (whoever can see the routine still sees the
   * routine), and in an exact replay's answer: a receipt keeps no task state.
   */
  task: RoutineTaskViewSchema.nullable(),
  /**
   * TASK-948. A "get-done" task's checklist, in order. Empty for any other
   * kind, for anyone but the task's owner (`task`'s rule), and in an exact
   * replay's answer: a receipt keeps none. Required, so a view from a producer
   * that doesn't know it is refused rather than read as "no steps". Stored
   * text isn't re-capped (TASK-913). `routine_list` and `routine_update` leave
   * it out (`RoutineListToolViewSchema`).
   */
  steps: z.array(RoutineStepViewSchema),
}).strict().superRefine(validateView);
/**
 * A routine as `routine_list` and `routine_update` show it (TASK-907): the same
 * view, with a task's report but not its agent notes, and (TASK-948) without a
 * "get-done" task's steps. A list reaches every chat and holds every routine,
 * so up to 2,000 characters of agent-written notes per task, and up to 50
 * steps of 200 characters, would ride along each time; "how's the support
 * queue?" needs the report alone, and an edit's answer needs neither. Built
 * from `RoutineViewShape`, which has no `steps`, so the strict schema refuses
 * a view that carries them. `routine_get` and the `routines:*` services keep
 * the agent notes and the steps, for the task's owner.
 */
export const RoutineListToolViewSchema = z.object({
  ...RoutineViewShape,
  task: RoutineTaskListViewSchema.nullable(),
}).strict().superRefine(validateView);
export type RoutinePermissions = z.output<typeof RoutinePermissionsSchema>;
export type RoutineView = z.output<typeof RoutineViewSchema>;

/** Project only editable fields; no runtime, authority or owner metadata. */
export function editableDefinition(row: RoutineDefinition): RoutineDefinition {
  return {
    name: row.name, description: row.description, promptBody: row.promptBody, enabled: row.enabled,
    schedule: row.schedule, webhook: row.webhook, activeHours: row.activeHours, silenceToken: row.silenceToken,
    silenceMaxChars: row.silenceMaxChars, conversation: row.conversation,
    kind: row.kind, goodWhen: row.goodWhen,
  };
}
