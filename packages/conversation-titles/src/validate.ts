/**
 * Maximum title length. Mirrored from `@ax/conversations`'s `TITLE_MAX`
 * (see `packages/conversations/src/store.ts:29`). Cross-plugin imports
 * are forbidden (CLAUDE.md invariant 2 / I2), so we duplicate the value
 * and keep them in lockstep — if `@ax/conversations` ever tightens or
 * relaxes the column CHECK, mirror the change here.
 */
const TITLE_MAX = 256;

/**
 * Sanitize the model's title-LLM response into a value safe to write to
 * `conversations.title`, or `null` if the response is unusable.
 *
 * This is the trust boundary: every byte the title model produces flows
 * through here before reaching the database. Returns:
 *
 *  - First-line, trimmed, with matched outer quotes stripped, on success.
 *  - `null` when the model gave us nothing usable (empty / `Untitled` /
 *    pure whitespace) — the caller leaves the row's title NULL rather
 *    than writing garbage.
 *
 * Length is capped at `TITLE_MAX`; oversize titles get truncated rather
 * than rejected (the column's CHECK would also reject them, but failing
 * fast in pure code keeps the error path local).
 */
export function validateGeneratedTitle(raw: string): string | null {
  let s = raw.split('\n')[0] ?? '';
  s = s.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    if (s.length >= 2) {
      s = s.slice(1, -1).trim();
    }
  }
  if (s.length === 0) return null;
  if (s === 'Untitled') return null;
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX).trim();
  return s.length > 0 ? s : null;
}
