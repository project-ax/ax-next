/**
 * fence-line — one line of plain text, bounded, out of untrusted input.
 *
 * This lived privately inside `server/routes-workspace.ts` until TASK-352,
 * which needed the same fence on BOTH sides of the workspace: the reload path
 * builds its thread on the server, and the live path builds the same rows in
 * the browser off SSE frames that never pass through that route. A fence that
 * only one of the two applies is not a fence — it is a difference between what
 * you see live and what you see after a reload, which is the exact class of
 * seam that card exists to close.
 *
 * So it moved here, to a module both trees can import, and
 * `routes-workspace.ts` now reads it from here rather than keeping a private
 * copy (invariant 4: one source of truth per concept).
 *
 * `server/sse.ts` still carries its own `fenceLine`. That one is deliberately
 * left alone: it fences the chat SSE wire, a different boundary with a
 * different lifetime, and folding it in here is a refactor of chat on the way
 * out rather than of the surface being built. The CHARACTER CLASS, though, is
 * not copied anywhere any more: both read `@ax/core/surface-text` (TASK-562).
 */

import { replaceSurfaceRewriters } from '@ax/core/surface-text';

/**
 * One line, plain text, bounded — or `null` when nothing legible survives.
 *
 * The characters that let untrusted text rewrite the surface it is drawn on —
 * a lone U+202E that makes `"gnp.dorp-eteled"` render as a different filename,
 * an unterminated isolate, a zero-width run — become spaces, so a name that
 * leaned on one to separate two words still reads as two words. React escapes
 * markup, so this was never XSS; it is the quieter failure where the UI says,
 * in our voice, something other than what is on the wire. The class itself is
 * `@ax/core/surface-text`'s, shared with every other bidi-aware fence in the repo.
 *
 * Callers pass text that arrived from across a trust boundary: a routine name
 * authored in the agent's own workspace and validated only for non-emptiness,
 * a recorded error, an MCP server's tool name. Fencing happens at the boundary
 * rather than in a renderer, so a second renderer cannot forget to do it.
 *
 * The function is a local twin of `@ax/agent-activity`'s `fencePhrase` rather
 * than an import: plugins talk through the hook bus, never through each other's
 * modules (invariant 2). The class both apply is not twinned — it is imported.
 *
 * The cap counts CODE POINTS, not UTF-16 units, so truncation can never split a
 * surrogate pair and leave a lone half behind — ill-formed UTF-16 out of a
 * function whose whole job is "plain text" would be a poor joke.
 */
export function fenceLine(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  if (typeof value !== 'string') return null;
  const flattened = replaceSurfaceRewriters(value)
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length === 0) return null;
  const points = [...flattened];
  if (points.length <= maxChars) return flattened;
  return `${points.slice(0, maxChars - 1).join('').trimEnd()}…`;
}
