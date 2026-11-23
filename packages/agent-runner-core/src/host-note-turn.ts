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

import { replaceSurfaceRewriters } from '@ax/core/surface-text';
import { SYSTEM_PREFIX } from './decision-turn.js';

/**
 * Cap on the note, in CODE POINTS (not UTF-16 units: a slice would split a
 * surrogate pair). Matches `HOST_NOTE_MAX` on the wire in @ax/ipc-protocol;
 * the wire already enforces it, this is the runner-side belt.
 */
const HOST_NOTE_MAX_CODE_POINTS = 4000;

function sanitizeHostNote(note: string): string {
  const flat = replaceSurfaceRewriters(note).replace(/\s+/g, ' ').trim();
  const points = [...flat];
  if (points.length <= HOST_NOTE_MAX_CODE_POINTS) return flat;
  return `${points.slice(0, HOST_NOTE_MAX_CODE_POINTS - 1).join('').trimEnd()}…`;
}

/**
 * Returns `null` when the note is empty after sanitising: the shell re-polls
 * rather than waking the model on a blank prompt.
 */
export function composeHostNoteMessage(note: string): string | null {
  const clean = sanitizeHostNote(note);
  if (clean.length === 0) return null;
  return `${SYSTEM_PREFIX} AX started this turn, not the person. Its note, quoted: ${JSON.stringify(clean)}`;
}
