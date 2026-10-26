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
const NEXT_CHECK_IN = 'It’ll try again at its next check-in.';
const RESUME = 'Press Resume, and it’ll try again at its next check-in.';
const NOT_YOURS_TO_RESUME = 'Only someone who manages this agent’s tasks can resume it.';
const ASK = 'If it keeps happening, tell whoever runs your workspace.';

/** What the viewer may press, so a fix never tells them to press a button that is disabled for them. */
export interface MissViewer {
  /** Check now: `permissions.fire`. */
  checkNow: boolean;
  /** Resume, and changing the agent's settings: `permissions.edit`. */
  edit: boolean;
}

export function missWords(
  reason: CheckInMiss,
  agentName: string,
  paused: boolean,
  can: MissViewer,
): MissWords {
  const again = paused ? (can.edit ? RESUME : NOT_YOURS_TO_RESUME) : can.checkNow ? TRY_AGAIN : NEXT_CHECK_IN;
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
        // Only someone who can edit gets the instruction to do it, and the link; anyone else is told who can.
        fix: can.edit
          ? `Shorten “What should ${agentName} do?” in ${agentName}’s settings${paused ? ', then resume it.' : '.'}`
          : `Someone who manages this agent’s tasks needs to shorten “What should ${agentName} do?” in ${agentName}’s settings.${paused ? ' Then they can resume it.' : ''}`,
        settingsLink: can.edit,
      };
    case 'interrupted':
      return {
        what: 'The app restarted during its check-in.',
        fix: paused ? again : `Nothing to do. ${NEXT_CHECK_IN}`,
        settingsLink: false,
      };
    default:
      return { what: 'Its check-in stopped before it finished.', fix: again, settingsLink: false };
  }
}

/** The row's one-line reason: the count leads once it's three or more in a row. */
export function missSummary(noRecentUpdate: { inARow: number; reason: CheckInMiss }): string {
  const { what } = missWords(noRecentUpdate.reason, '', false, { checkNow: true, edit: true });
  return noRecentUpdate.inARow >= TASK_NEEDS_YOU_AFTER_MISSES
    ? `Its last ${noRecentUpdate.inARow} check-ins didn’t leave an update. ${what}`
    : what;
}

export const AUTO_PAUSED_LINE = `Paused after ${TASK_AUTO_PAUSE_AFTER_MISSES} check-ins in a row didn’t leave an update.`;
