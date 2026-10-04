/**
 * Cut `text` to at most `max` UTF-16 code units (the unit zod's `.max()`
 * counts in), without ever splitting a surrogate pair.
 *
 * The one copy of this rule on the host (TASK-781). Every producer that has to
 * fit free text under a wire ceiling — a hold note, a deny reason, a rejection
 * reason a plugin wrote — clamps through here instead of a plain `.slice()`.
 * A plain slice can keep the high half of an astral character (an emoji, say)
 * and drop the low half; a lone surrogate is not valid UTF-8 and gets mangled
 * on its way out as JSON. When the cut would land between the two halves we
 * drop the whole character, so the result can be one unit shorter than `max`.
 */
export function clampCodeUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
