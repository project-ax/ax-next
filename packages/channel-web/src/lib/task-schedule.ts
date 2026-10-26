/**
 * task-schedule — how often a task checks in, in plain words (TASK-906).
 *
 * An approval card that asks "should this task start?" has to say when it will
 * run, and `1h` or `0 9 * * 1-5` doesn't say that to most people. This turns a
 * routine trigger into one sentence: an interval in words, a cron through
 * `describeCron`, or the raw expression when the cron is past what that will
 * put into words (a wrong description is worse than none). A webhook doesn't
 * check in on a schedule, so it has no sentence.
 *
 * Pure and browser-safe: no DOM, and nothing from the contract at runtime. The
 * server builds the approval card's line from it (`wireTask` in
 * `server/routes-workspace.ts`), which is why its sibling is imported
 * relatively, with `.js`, like every lib module the server loads. The `@/`
 * alias the client components use would survive tsc unrewritten in `dist/`,
 * and the built server would fail to import it.
 *
 * The output carries the trigger's own text (a cron expression, a timezone),
 * so a caller putting it on the wire fences it first.
 */
import type { ActiveHours, RoutineTrigger } from '@ax/routines-contract';
import { clockTime, describeCron, describeCronPhrase } from './cron-describe.js';

const UNIT_WORDS = { s: 'second', m: 'minute', h: 'hour', d: 'day' } as const;

/** One sentence saying when a trigger runs, or `null` when it doesn't run on a schedule. */
export function describeCheckIns(trigger: RoutineTrigger | null): string | null {
  if (trigger === null) return null;
  switch (trigger.kind) {
    case 'interval': {
      // The contract's own duration shape. Anything else says nothing rather
      // than a guess.
      const match = /^(\d+)(s|m|h|d)$/.exec(trigger.every);
      if (match === null) return null;
      const n = Number(match[1]);
      const unit = UNIT_WORDS[match[2] as keyof typeof UNIT_WORDS];
      return n === 1 ? `Runs every ${unit}` : `Runs every ${n} ${unit}s`;
    }
    case 'cron': {
      const described = describeCron(trigger.expr, trigger.tz);
      return described.kind === 'described'
        ? described.text
        : `Custom schedule: ${trigger.expr} (${trigger.tz})`;
    }
    case 'webhook':
      return null;
    default:
      return null;
  }
}

/** `'09:00'` → "9:00 AM"; the day's two edges read as "midnight". */
function hm(time: string): string {
  if (time === '00:00' || time === '24:00') return 'midnight';
  const [hour = '0', minute = '0'] = time.split(':');
  return clockTime(String(Number(minute)), String(Number(hour)));
}

/**
 * How often a task checks in, as the words after "checks in" (TASK-910), or
 * null when it doesn't check in on a schedule. Carries the trigger's own time
 * zone, so a caller fences it.
 */
export function checkInSchedule(
  trigger: RoutineTrigger | null,
  activeHours: ActiveHours | null,
): string | null {
  let phrase: string | null = null;
  if (trigger === null) return null;
  switch (trigger.kind) {
    case 'interval': {
      const match = /^(\d+)(s|m|h|d)$/.exec(trigger.every);
      if (match === null) return null;
      const n = Number(match[1]);
      const unit = UNIT_WORDS[match[2] as keyof typeof UNIT_WORDS];
      phrase = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
      break;
    }
    case 'cron': {
      const described = describeCronPhrase(trigger.expr, trigger.tz);
      phrase = described.kind === 'described' ? described.text : 'on a custom schedule';
      break;
    }
    default:
      return null;
  }
  if (activeHours === null) return phrase;
  return `${phrase}, ${hm(activeHours.start)} to ${hm(activeHours.end)} (${activeHours.tz})`;
}
