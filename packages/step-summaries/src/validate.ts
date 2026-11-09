/**
 * The trust boundary for the summary model's answer: every byte it writes
 * goes through here before it reaches a stream frame or the event log.
 *
 * One line, collapsed whitespace, outer quotes and a leading bullet stripped,
 * at most SUMMARY_MAX_CHARS (cut at a word, with an ellipsis). `null` when
 * there is nothing usable, and the step simply goes without a summary.
 */
export const SUMMARY_MAX_CHARS = 120;

export function validateSummary(raw: string): string | null {
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let s = firstLine.replace(/\s+/g, ' ').replace(/^[-*•]\s+/, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Control and format characters have no business in a one-line label.
  s = s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (s.length < 3 || s.toLowerCase() === 'none') return null;
  const points = [...s];
  if (points.length > SUMMARY_MAX_CHARS) {
    const cut = points.slice(0, SUMMARY_MAX_CHARS - 1).join('');
    const atSpace = cut.lastIndexOf(' ');
    s = `${(atSpace > 40 ? cut.slice(0, atSpace) : cut).trimEnd()}…`;
  }
  return s;
}
