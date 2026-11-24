/**
 * The opening message of a turn the HOST started with a note of its own, not
 * the person and not an approval: today, "your sandbox was swapped; here is
 * what is running now" after `restart_with_services`.
 *
 * Same framing as `decision-turn.ts` (the fixed `SYSTEM_PREFIX`, prepended
 * never interpolated, because a runner may only put a message in a `user`
 * slot), with one extra step: the note is QUOTED. It is built from host
 * constants plus service names and addresses, so nothing should ever look
 * like a line of its own — but service names come out of a repo's compose
 * file, and this text goes straight to a model. So the note is flattened to
 * one line (no line break to start a forged "System:" or "User:" line) and
 * emitted as a JSON string, whose escaping means a quote inside the note
 * cannot end the quoted run early. A forged label inside the note is data
 * inside quotes, and the only unquoted label is ours.
 *
 * Not an authorisation. It is information; nothing here grants anything.
 */

import { HOST_NOTE_MAX } from '@ax/ipc-protocol';
import { SYSTEM_PREFIX, sanitizeHostAuthoredNote } from './decision-turn.js';

/**
 * What the model is told when the note is empty once sanitised. A stalled
 * invoke is worse than a generic line, so the turn always opens.
 */
const FALLBACK_NOTE = 'AX restarted your sandbox; continue where you left off.';

/**
 * Always returns a message: an empty note falls back to the fixed host line,
 * framed the same way.
 */
export function composeHostNoteMessage(note: string): string {
  // HOST_NOTE_MAX counts characters on the wire; the sanitiser caps code points,
  // which is never more than that, so the wire bound still holds.
  const clean = sanitizeHostAuthoredNote(note, HOST_NOTE_MAX) || FALLBACK_NOTE;
  return `${SYSTEM_PREFIX} AX started this turn, not the person. Its note, quoted: ${JSON.stringify(clean)}`;
}
