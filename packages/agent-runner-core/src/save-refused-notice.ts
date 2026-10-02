/**
 * What the MODEL is told, at the start of its next turn, when the end-of-turn
 * save of its previous turn was refused (TASK-732).
 *
 * The end-of-turn commit runs after the model has stopped talking. A refusal
 * there (a `workspace:pre-apply` veto, or a save too big to carry) undoes the
 * refused changes, and the person hears about it on `event.turn-end`
 * (`saveRefused`, TASK-720). Without this, the model never does: it would carry
 * on as if the files were saved — rewrite the same oversized content, or reason
 * about a file that is gone. The mid-turn flush before a host tool has its own
 * channel (the tool error, `flushPreconditionMessage`); this is the end-of-turn
 * twin.
 *
 * The notice lands in the user-role slot, so it wears the same fixed label as
 * a host-started decision turn, and the host's reason goes through the same
 * sanitizer: flattened to one line, so nothing inside it can forge a line that
 * looks like it came from somewhere else.
 *
 * The wording says the refused changes were UNDONE, never that every file was
 * removed: a scoped veto (TASK-287) resets `--mixed` and undoes only the paths
 * it refused, and this sentence must hold for both.
 */

import { saveRefusedFrom, type CommitNotifyResult } from './commit-notify-resync.js';
import { sanitizeDecisionNote } from './decision-turn.js';

/** The fixed label — the same one `decisionResolvedTurn` uses. */
const SYSTEM_PREFIX = 'System message (not from the user):';

/**
 * The model-facing notice for an end-of-turn commit result, or `undefined`
 * when the save was not refused. "Refused" is exactly {@link saveRefusedFrom}'s
 * predicate, so the model is told on precisely the turns the person is.
 */
export function saveRefusedNotice(result: CommitNotifyResult): string | undefined {
  if (saveRefusedFrom(result) === undefined) return undefined;
  const reason = sanitizeDecisionNote(result.rejectionReason ?? '');
  const head =
    `${SYSTEM_PREFIX} The file changes from your previous turn were not saved. ` +
    `The workspace refused them after that turn ended, and the refused changes ` +
    `were undone, so they are no longer in the workspace.`;
  // Host reasons are not required to end in a period; without one the advice
  // below would run straight on from theirs.
  const why =
    reason.length > 0 ? ` Reason given: ${/[.!?…]$/.test(reason) ? reason : `${reason}.`}` : '';
  const advice =
    ` Check what is actually there before relying on those files, and do not ` +
    `write the same content again unchanged.`;
  return `${head}${why}${advice}`;
}

/**
 * Put `notice` in front of a turn's user content — before a plain-text
 * message, or as the leading text block of a block array (the shape the shell
 * builds when a turn carries attachments, and one both loops already read).
 * The input is never mutated.
 */
export function prependNotice(content: unknown, notice: string): unknown {
  if (Array.isArray(content)) {
    return [{ type: 'text', text: notice }, ...content];
  }
  const text = typeof content === 'string' ? content : String(content ?? '');
  return text.length > 0 ? `${notice}\n\n${text}` : notice;
}
