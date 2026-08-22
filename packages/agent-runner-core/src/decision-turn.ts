/**
 * The opening message of a turn the HOST started, not the user.
 *
 * When a person answers an approval while the agent's session is still warm,
 * @ax/decisions drops a `decision-resolved` entry into the session inbox and
 * the shell turns it into a turn. The model has to be told three things and no
 * more: what happened, that it may act on it, and that acting means re-issuing
 * the call it already made.
 *
 * WHY THE FRAMING MATTERS. The note lands in a `user`-role slot, because that
 * is the only role a runner may put a message in (`AgentMessage.role` is
 * `'user' | 'assistant'`). Left unlabelled the model would read a host
 * instruction as something the person typed, and would quote it back at them.
 * The prefix below is the label; it is prepended, never interpolated, so
 * nothing inside the note can forge it away.
 *
 * WHAT IS NOT HERE. No authorisation. The standing approval lives on the host,
 * keyed on the held call's FINGERPRINT (AW-4) — an unchanged call passes the
 * gate exactly once and any change to it holds again. This message is a
 * prompt. The model being persuasive about what it was allowed to do changes
 * nothing.
 */

/**
 * Characters that let text move around on a surface someone reads, or forge a
 * line boundary in a log:
 *
 *   - C0 and C1 control characters (CR/LF included) — a newline inside the
 *     note would let it forge what looks like a separate host-authored line;
 *   - the zero-width family (ZWSP/ZWNJ/ZWJ, the word joiner, the invisible
 *     maths operators, and the BOM / zero-width no-break space), which is
 *     invisible and survives a diff;
 *   - LINE SEPARATOR and PARAGRAPH SEPARATOR, which a renderer treats as line
 *     breaks even though they are not CR/LF;
 *   - bidi overrides and isolates (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, and
 *     the LRM/RLM/ALM marks), which can visually reverse a run of text so what
 *     a reader sees is not what is stored.
 *
 * The note is host-authored today — built from constants plus a host-generated
 * decision id — so nothing here should ever fire. That is exactly why it is
 * cheap to keep: it is the guard for the day a producer starts composing the
 * note out of something less trustworthy, and it costs one pass over a string
 * of at most 2000 code points.
 *
 * Written as escapes, never as literal bytes: a raw control byte in a source
 * file makes git treat it as binary and the diff unreviewable.
 */
const UNSAFE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/gu;

/**
 * Cap on the note, in CODE POINTS. `String.prototype.slice` counts UTF-16 code
 * UNITS, so slicing mid-astral-character splits a surrogate pair and emits a
 * lone surrogate — an unpaired code unit that JSON round-trips as U+FFFD and
 * that some consumers reject outright. Splitting on the code-point array
 * cannot do that.
 *
 * Matches the wire schema's bound in @ax/ipc-protocol. The wire already
 * enforces it; this is the runner-side belt, because the note is prose we hand
 * straight to a model.
 */
const NOTE_MAX_CODE_POINTS = 2000;

/** The fixed label. Prepended, never interpolated — the note cannot forge it. */
const SYSTEM_PREFIX = 'System message (not from the user):';

export function sanitizeDecisionNote(note: string): string {
  const flat = note.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const points = [...flat];
  if (points.length <= NOTE_MAX_CODE_POINTS) return flat;
  return `${points.slice(0, NOTE_MAX_CODE_POINTS - 1).join('').trimEnd()}…`;
}

/**
 * Compose the turn's opening message from a host-authored note.
 *
 * Returns `null` when the note is empty after sanitisation — a delivery with
 * nothing to say is not a turn worth starting, and the shell re-polls instead
 * of waking the model with a blank prompt. (The wire schema requires a
 * non-empty note, so this is the belt to that pair of braces.)
 */
export function decisionResolvedTurn(note: string): string | null {
  const clean = sanitizeDecisionNote(note);
  if (clean.length === 0) return null;
  return `${SYSTEM_PREFIX} ${clean}`;
}
