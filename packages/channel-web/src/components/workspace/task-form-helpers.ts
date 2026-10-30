/**
 * The New / Edit task dialog's pure pieces (the minimal redesign, 2026-10-29):
 * the schedule and response-time presets its chips offer, the short words on
 * each chip, and the plain sentence for each problem the contract finds.
 *
 * PRESETS ARE A VIEW, NEVER A WRITE. A saved schedule that equals a preset
 * (an `every: '60m'`, or a `*\/15 * * * *` cron) shows as that preset, but the
 * definition keeps its own text until the person picks something else, so
 * opening and saving a task never rewrites a schedule nobody touched.
 *
 * NO RAW SCHEMA TEXT. zod's own messages ("String must contain at least 1
 * character(s)") and the contract's terse ones ("Invalid interval.") never
 * reach the page. The contract's authored sentences ("Check-ins need to be at
 * least 15 minutes apart.") are already plain and are kept.
 */
import { durationToSeconds, isTaskKind, type ActiveHours, type RoutineDefinition, type RoutineSchedule } from '@ax/routines-contract';
import type { RoutineErrorCode } from '@/lib/routines';

type Kind = RoutineDefinition['kind'];

export interface IntervalPreset {
  value: string;
  /** What the Select lists. */
  label: string;
  /** What the chip says. */
  chip: string;
  /** Only Repeat may run this often (a task checks in at most every 15 minutes). */
  repeatOnly?: boolean;
}
export const INTERVAL_PRESETS: readonly IntervalPreset[] = [
  { value: '1m', label: '1 min', chip: 'Every minute', repeatOnly: true },
  { value: '5m', label: '5 min', chip: 'Every 5 min', repeatOnly: true },
  { value: '15m', label: '15 min', chip: 'Every 15 min' },
  { value: '30m', label: '30 min', chip: 'Every 30 min' },
  { value: '1h', label: '1 hour', chip: 'Every hour' },
  { value: '2h', label: '2 hours', chip: 'Every 2 hours' },
  { value: '1d', label: '1 day', chip: 'Every day' },
  { value: '7d', label: '1 week', chip: 'Every week' },
];
export function intervalPresets(kind: Kind): readonly IntervalPreset[] {
  return isTaskKind(kind) ? INTERVAL_PRESETS.filter(preset => !preset.repeatOnly) : INTERVAL_PRESETS;
}

/** Cron strides that say exactly what a preset says, in minutes and hours. */
const CRON_PRESETS: Record<string, string> = {
  '* *': '1m', '*/1 *': '1m', '*/5 *': '5m', '*/15 *': '15m', '*/30 *': '30m', '0 *': '1h', '0 */1': '1h', '0 */2': '2h',
};

/** The preset a schedule already is, or null (no schedule, or a custom one). */
export function schedulePreset(schedule: RoutineSchedule | null, kind: Kind): string | null {
  if (schedule === null) return null;
  const offered = intervalPresets(kind);
  if (schedule.kind === 'interval') {
    const seconds = durationToSeconds(schedule.every);
    return offered.find(preset => durationToSeconds(preset.value) === seconds)?.value ?? null;
  }
  let fields = schedule.expr.trim().split(/\s+/);
  // A seconds field of 0 runs once a minute, like the five-field form.
  if (fields.length === 6 && fields[0] === '0') fields = fields.slice(1);
  if (fields.length !== 5 || fields.slice(2).some(field => field !== '*')) return null;
  const [minute, hour] = fields as [string, string];
  const value = CRON_PRESETS[`${minute} ${hour}`] ?? null;
  return value !== null && offered.some(preset => preset.value === value) ? value : null;
}

const UNIT = { s: 'second', m: 'min', h: 'hour', d: 'day' } as const;
/** `'45m'` → "45 min", `'3h'` → "3 hours"; the text itself when it isn't a duration. */
export function durationWords(value: string): string {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (match === null) return value;
  const n = Number(match[1]);
  const unit = UNIT[match[2] as keyof typeof UNIT];
  return n === 1 ? `1 ${unit}` : `${n} ${unit === 'min' ? unit : `${unit}s`}`;
}

/** The clock chip's words. */
export function scheduleChip(schedule: RoutineSchedule | null, kind: Kind): string {
  if (schedule === null) return 'No schedule';
  const preset = schedulePreset(schedule, kind);
  if (preset !== null) return INTERVAL_PRESETS.find(item => item.value === preset)!.chip;
  return schedule.kind === 'interval' ? `Every ${durationWords(schedule.every)}` : 'Custom schedule';
}

export const RESPOND_PRESETS = [
  { value: '1m', label: '1 min' },
  { value: '5m', label: '5 min' },
  { value: '15m', label: '15 min' },
  { value: '1h', label: '60 min' },
] as const;
/** Absent response timing means 5 minutes (the contract's default). */
export function respondPreset(value: string | undefined): string | null {
  const seconds = durationToSeconds(value ?? '5m');
  return RESPOND_PRESETS.find(preset => durationToSeconds(preset.value) === seconds)?.value ?? null;
}

const WEEKDAYS = 'mon,tue,wed,thu,fri';
/** `'09:00'` → "9am", `'18:30'` → "6:30pm"; the day's edges are "12am". */
function shortTime(time: string): string {
  const [h = '0', m = '00'] = time.split(':');
  const hour = Number(h) % 24;
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${m === '00' ? '' : `:${m}`}${hour < 12 ? 'am' : 'pm'}`;
}
/** The calendar chip's words: "Any time", or the days and the window. */
export function hoursChip(hours: ActiveHours | null): string {
  if (hours === null) return 'Any time';
  const days = hours.days;
  const dayWord = days === undefined || days.length === 7 ? 'Every day'
    : days.length === 0 ? 'No days'
    : days.join(',') === WEEKDAYS ? 'Weekdays'
    : days.join(',') === 'sat,sun' ? 'Weekends'
    : days.map(day => day.charAt(0).toUpperCase() + day.slice(1)).join(', ');
  return `${dayWord} ${shortTime(hours.start)}–${shortTime(hours.end)}`;
}

/**
 * Where a problem shows and which control gets focus. Most are a field;
 * `schedule`, `hours` and `updates` are the chips whose popovers hold them.
 * The order is the page's reading order, so the first problem is focused.
 */
export const TASK_FIELDS = [
  'name', 'promptBody', 'goodWhen', 'schedule', 'hours', 'updates',
  'customSchedule', 'hoursZone', 'address', 'events', 'signature',
  'conversation', 'quietWord', 'quietLength', 'description', 'form',
] as const;
export type TaskField = (typeof TASK_FIELDS)[number];
export const MORE_OPTIONS_FIELDS: ReadonlySet<TaskField> = new Set([
  'customSchedule', 'hoursZone', 'address', 'events', 'signature', 'conversation', 'quietWord', 'quietLength', 'description',
]);

/** The field a contract (or host) path belongs to. `custom` says the schedule is edited under More options. */
export function taskField(path: string, custom: boolean): TaskField {
  const [head = '', second = ''] = path.split('.');
  switch (head) {
    case 'name': case 'promptBody': case 'goodWhen': case 'conversation': case 'description':
      return head;
    case 'schedule':
      return second === '' || !custom ? 'schedule' : 'customSchedule';
    case 'trigger':
      // The host's legacy name for either method.
      if (['path', 'events'].includes(second)) return second === 'path' ? 'address' : 'events';
      if (second === 'hmac') return 'signature';
      return second === '' || !custom ? 'schedule' : 'customSchedule';
    case 'activeHours':
      return second === 'tz' ? 'hoursZone' : 'hours';
    case 'webhook':
      return second === 'respondWithin' ? 'updates' : second === 'path' ? 'address' : second === 'events' ? 'events'
        : second === 'hmac' ? 'signature' : 'updates';
    case 'silenceToken': return 'quietWord';
    case 'silenceMaxChars': return 'quietLength';
    default: return 'form';
  }
}

/**
 * Whether a field's control can be on screen for this draft. Conversation and the
 * quiet settings are drawn whenever they have a problem, so they always can; a
 * problem anywhere else with nothing to show it on is said at the form instead.
 */
export function fieldHasControl(field: TaskField, definition: RoutineDefinition): boolean {
  switch (field) {
    case 'goodWhen': return isTaskKind(definition.kind);
    case 'customSchedule': return definition.schedule !== null;
    case 'hoursZone': return definition.activeHours !== null;
    case 'address': case 'events': case 'signature': return definition.webhook !== null;
    default: return true;
  }
}

const ZONE = 'Use a time zone name, like America/New_York.';
const FALLBACK: Record<TaskField, string> = {
  name: 'Give it a name.',
  promptBody: '',
  goodWhen: 'Say how we’ll know this task is going well.',
  schedule: 'Choose how often it runs.',
  hours: 'Write times as 24-hour HH:MM, like 09:00 or 18:00, and choose at least one day.',
  updates: 'Choose a response time from 1 minute to 24 hours.',
  customSchedule: 'We couldn’t read that schedule. Write an interval like 45m or 2h, or check the cron expression and time zone.',
  hoursZone: ZONE,
  address: 'Use letters, numbers, dots, dashes and slashes, starting with /, like /project-updates.',
  events: 'Use event names made of letters, numbers, dashes and underscores, separated by commas.',
  signature: 'Use a header name without spaces, like X-Signature.',
  conversation: 'A task starts fresh each time it checks in.',
  quietWord: 'Keep the quiet word to 128 characters or fewer.',
  quietLength: 'Use a whole number from 0 to 65,536.',
  description: 'Keep the note to 2,048 characters or fewer.',
  form: 'Something here needs another look.',
};

/**
 * The contract's own sentence when it wrote one for people; otherwise ours.
 * Its terse checks ("Invalid …"), anything naming a routine or a silence
 * token, and every zod built-in (any code but `custom`) get ours instead.
 */
export function plainIssue(field: TaskField, issue: { code?: string; message?: string; path?: readonly (string | number)[] }, agentName: string): string {
  if (field === 'promptBody' && /too large/i.test(issue.message ?? '')) return 'These instructions are too long. Shorten them a little.';
  if (field === 'quietWord' && /silence token/i.test(issue.message ?? '')) return 'Tasks don’t use a quiet word. Clear it to keep this kind.';
  if (field === 'hours' && issue.path?.[1] === 'days') return 'Choose at least one day.';
  const authored = (issue.code === undefined || issue.code === 'custom') && issue.message !== undefined
    && !/^Invalid\b/.test(issue.message) && !/routine|silence token|directly|only once/i.test(issue.message);
  if (authored) return issue.message!;
  if (field === 'promptBody') return `Tell ${agentName} what to do.`;
  if (field === 'name' && issue.code !== undefined && issue.code !== 'too_small') return 'Keep the name to 128 characters or fewer.';
  if ((field === 'customSchedule' || field === 'schedule') && issue.path?.[1] === 'tz') return ZONE;
  if ((field === 'schedule' || field === 'customSchedule') && issue.message === 'Invalid interval.') return 'Write how often as a number and a unit, at least a minute apart, like 45m or 2h.';
  return FALLBACK[field];
}

/**
 * A save the host refused, in a task's words. `lib/routines.ts` words these for
 * Settings, where they're routines; the dialog says task. Null is a failure
 * that wasn't the host's answer (no response, or one we couldn't read).
 */
const SAVE_ERRORS: Record<RoutineErrorCode, string> = {
  validation: 'We couldn’t save these settings. Check them and try again.',
  'revision-conflict': 'This task changed while you had it open. Reload it to get the latest, then make your change again.',
  'webhook-path-conflict': 'Another task already uses that address name. Choose a different one.',
  'request-conflict': 'We couldn’t match this save to your earlier try. Close this and make the change again.',
  'approval-required': 'This change needs someone’s approval before it takes effect.',
  'not-found': 'This task isn’t available anymore. It may have been deleted.',
  forbidden: 'You don’t have permission to change this task.',
  busy: 'This task is busy with a run. Try again when it finishes.',
  disabled: 'This task is paused. Resume it, then try again.',
  'cleanup-pending': 'We’re still removing this task’s old signing secret. Try again in a moment.',
  unavailable: 'We couldn’t reach tasks just now. Try again in a moment.',
};
/** `marked`: the host named a field we draw and mark, so the sentence may point at it. */
export function taskSaveError(code: RoutineErrorCode | null, marked = false): string {
  if (code === 'validation' && marked) return 'We couldn’t save one of these settings. Check the marked one and try again.';
  return code === null ? 'We couldn’t save this task. Try again.' : SAVE_ERRORS[code];
}
