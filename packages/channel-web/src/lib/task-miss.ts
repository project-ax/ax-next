/**
 * task-miss — the plain words for a check-in that left no update (TASK-930).
 *
 * A closed table keyed on the reason code the host classified at the source,
 * never on error text (TASK-910 row 13). Every sentence here is host-written;
 * nothing an agent said reaches it. An unknown code (a newer host) reads as
 * `failed`.
 *
 * "Check now", "Resume" and "See what it did" are the names of the controls on
 * the task page. The fix text names the first two as buttons but never
 * mentions a link: "See what it did" and the settings link are drawn as their
 * own elements.
 *
 * Pure, with relative imports only.
 */
import {
  TASK_AUTO_PAUSE_AFTER_MISSES,
  TASK_NEEDS_YOU_AFTER_MISSES,
  type CheckInMiss,
} from '@ax/routines-contract';

export interface MissWords {
  /** What happened, one sentence. */
  what: string;
  /** The one thing to do next. */
  fix: string;
  /** True when the fix is a change in the agent's settings, which gets a link. */
  settingsLink: boolean;
}

const TRY_AGAIN = 'Press Check now to try again.';
const RESUME = 'Press Resume, and it’ll try again at its next check-in.';
const ASK = 'If it keeps happening, tell whoever runs your workspace.';

export function missWords(reason: CheckInMiss, agentName: string, paused: boolean): MissWords {
  const again = paused ? RESUME : TRY_AGAIN;
  switch (reason) {
    case 'no-report':
      return { what: 'It checked in but didn’t say how it went.', fix: again, settingsLink: false };
    case 'brief-missing':
      return {
        what: 'Its instructions didn’t load, so it couldn’t check in.',
        fix: `${again} ${ASK}`,
        settingsLink: false,
      };
    case 'brief-unconfirmed':
      return {
        what: 'We couldn’t confirm its instructions loaded, so we counted that check-in as missed.',
        fix: `${again} ${ASK}`,
        settingsLink: false,
      };
    case 'brief-too-long':
      return {
        what: 'Its instructions are too long to load.',
        fix: `Shorten “What to do” in ${agentName}’s settings${paused ? ', then resume it.' : '.'}`,
        settingsLink: true,
      };
    case 'interrupted':
      return {
        what: 'The app restarted during its check-in.',
        fix: paused ? RESUME : 'Nothing to do. It’ll try again at its next check-in.',
        settingsLink: false,
      };
    default:
      return { what: 'Its check-in stopped before it finished.', fix: again, settingsLink: false };
  }
}

/** The row's one-line reason: the count leads once it's three or more in a row. */
export function missSummary(noRecentUpdate: { inARow: number; reason: CheckInMiss }): string {
  const { what } = missWords(noRecentUpdate.reason, '', false);
  return noRecentUpdate.inARow >= TASK_NEEDS_YOU_AFTER_MISSES
    ? `Its last ${noRecentUpdate.inARow} check-ins didn’t leave an update. ${what}`
    : what;
}

export const AUTO_PAUSED_LINE = `Paused after ${TASK_AUTO_PAUSE_AFTER_MISSES} check-ins in a row didn’t leave an update.`;
