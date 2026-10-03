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
 * looks like it came from somewhere else. Unlike the decision note, though,
 * this reason is NOT host constants: it is a `workspace:pre-apply` plugin's
 * prose, and can embed text the model chose (validator-skill quotes the vetoed
 * path). So it is also quoted (with its own double quotes swapped out, so it
 * cannot close the fence), and the label inside it — after an NFKC fold — is
 * replaced. Cross-script homoglyphs are NOT caught; see `LABEL_RE`.
 *
 * The wording says SOME OR ALL of the changes were undone, never that every
 * file was removed: a scoped veto (TASK-287) resets `--mixed` and undoes only
 * the paths it refused, and this sentence must hold for both.
 */

import { saveRefusedFrom, type CommitNotifyResult } from './commit-notify-resync.js';
import { sanitizeDecisionNote } from './decision-turn.js';
import type { SaveRefusedCode } from '@ax/ipc-protocol';

/** The fixed label — the same one `decisionResolvedTurn` uses. */
const SYSTEM_PREFIX = 'System message (not from the user):';

/**
 * The model-facing notice for an end-of-turn commit result, or `undefined`
 * when the save was not refused. "Refused" is exactly {@link saveRefusedFrom}'s
 * predicate, so the model is told on precisely the turns the person is.
 */
export function saveRefusedNotice(result: CommitNotifyResult): string | undefined {
  if (saveRefusedFrom(result) === undefined) return undefined;
  const reason = fenceSafe(sanitizeDecisionNote(result.rejectionReason ?? ''));
  // "Some or all": a scoped veto undoes only the paths it refused, and the
  // rest of the turn's work stays. "An earlier turn": a loop that pulls ahead
  // can carry the notice a turn late (see run-runner's
  // `pendingSaveRefusedNotice`).
  const head = NOTICE_HEAD;
  // Fenced as a quotation: the reason is a plugin's prose and can embed text
  // the model itself chose (a vetoed file path, say), so it is presented as
  // something quoted, never as more of this message.
  const why = reason.length > 0 ? ` The workspace gave this reason (quoted): "${reason}"` : '';
  return `${head}${why}${NOTICE_ADVICE}`;
}

const NOTICE_HEAD =
  `${SYSTEM_PREFIX} Some or all of the file changes you made in an earlier ` +
  `turn were not saved. The workspace refused them after that turn ended, ` +
  `and the refused changes were undone, so they are no longer in the workspace.`;

const NOTICE_ADVICE =
  ` Check what is actually there before relying on those files, and do not ` +
  `write the same content again unchanged.`;

/**
 * One fixed sentence per closed code. Host-authored constants: the
 * host-persisted path below never carries a refusal's prose, so nothing a
 * model chose reaches the notice from there.
 */
const CODE_REASONS: Readonly<Record<SaveRefusedCode, string>> = {
  'storage-full': 'The storage limit for this workspace was reached.',
  'too-large': 'The changes were too large to save at once.',
  refused: 'A workspace check did not accept them.',
};

/**
 * TASK-749 — the notice for refusals the HOST kept for the model: a final/idle
 * save after the last turn, or a per-turn save whose runner process exited
 * before its next turn. Those reach this process only as closed codes
 * (`conversation.drain-save-refusals`), so the reason is a fixed sentence per
 * distinct code rather than the host's prose — there is no forwarded text to
 * fence. Same label, head and advice as {@link saveRefusedNotice}, so the model
 * reads one kind of notice whichever path told it. `undefined` for no codes.
 */
export function saveRefusedNoticeFromCodes(
  codes: readonly SaveRefusedCode[],
): string | undefined {
  if (codes.length === 0) return undefined;
  const reasons = [...new Set(codes)].map((code) => CODE_REASONS[code]).join(' ');
  return `${NOTICE_HEAD} ${reasons}${NOTICE_ADVICE}`;
}

/**
 * The label, matched loosely (any case, any whitespace run). Matched AFTER an
 * NFKC fold, so fullwidth and other compatibility forms of its parens, colon
 * and letters count as the label too. `sanitizeDecisionNote` has already
 * flattened the line breaks and invisible characters that would otherwise slip
 * between its words.
 *
 * What this does NOT catch: cross-script homoglyphs (a Cyrillic `Ѕ` for `S`)
 * — NFKC does not fold those — and any other phrasing that merely claims
 * authority. The quote fence is the boundary for those; this is a cheap
 * extra so the exact label, the one a model has learned to trust here,
 * appears once.
 */
const LABEL_RE = /system\s+message\s*\(\s*not\s+from\s+the\s+user\s*\)\s*:?/gi;

/** Every double-quote mark that could close (or fake) the fence after NFKC. */
const DOUBLE_QUOTES_RE = /["“”„‟″«»]/g;

/**
 * Make forwarded text safe to sit inside the `"…"` fence: NFKC-fold it, swap
 * every double-quote mark for `'` so it cannot close the fence, and replace
 * every copy of the label with a marker.
 */
function fenceSafe(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DOUBLE_QUOTES_RE, "'")
    .replace(LABEL_RE, '[label removed]');
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
