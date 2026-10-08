/**
 * Slice 6 — the sentence a routine run records when it went without a
 * connector: "Gmail isn't signed in on Bob, so this run went without it."
 *
 * Every name here is untrusted (connector names are admin/user-authored, the
 * agent name is user-authored). The producer (chat-orchestrator) already
 * sanitizes connector names; this re-sanitizes anyway, because this text is
 * stored and later shown, and it must not depend on another plugin's
 * discipline. The UI renders the result as text.
 */

/**
 * Why a run went without a connector. `'unavailable'` is how routines files
 * any reason it does not know (a producer newer than this plugin): the skip
 * is still reported, in generic words, rather than dropped.
 */
export type SkipReason = 'not-signed-in' | 'needs-reconnect' | 'unavailable';

/** Map a reported reason onto one this plugin words; unknown → 'unavailable'. */
export function normalizeSkipReason(raw: unknown): SkipReason {
  return raw === 'not-signed-in' || raw === 'needs-reconnect' ? raw : 'unavailable';
}

/** Longest warning stored, in code points (including the trailing `…`). */
export const SKIP_WARNING_MAX = 300;

/** Longest single name used, in code points (mirrors the producer's clamp). */
const NAME_MAX = 64;

/**
 * One line of plain text: control, format (zero-width, bidi overrides and
 * isolates) and line/paragraph separators become spaces, whitespace
 * collapses, the ends are trimmed, and the length is clamped.
 */
export function sanitizeSkipName(raw: string): string {
  const clean = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clampCodePoints(clean, NAME_MAX);
}

function clampCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Most names one sentence lists before "and N more". */
export const SKIP_NAMES_SHOWN = 3;

/** Sentence order: the actionable reasons first, the generic one last. */
const REASON_ORDER: readonly SkipReason[] = ['not-signed-in', 'needs-reconnect', 'unavailable'];

/** "A", "A and B", "A, B and C", "A, B, C and 4 more". */
function listNames(names: readonly string[], shown: number): string {
  if (names.length > shown) {
    return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
  }
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function sentence(names: readonly string[], reason: SkipReason, agent: string, shown: number): string {
  const one = names.length === 1;
  const verb = reason === 'not-signed-in'
    ? (one ? "isn't signed in" : "aren't signed in")
    : reason === 'needs-reconnect'
      ? (one ? 'needs to be signed in again' : 'need to be signed in again')
      : (one ? "wasn't available" : "weren't available");
  return `${listNames(names, shown)} ${verb} on ${agent}, so this run went without ${one ? 'it' : 'them'}.`;
}

export function buildSkipWarning(
  agentName: string | null,
  skips: ReadonlyArray<{ name: string; reason: SkipReason }>,
): string | null {
  const byReason: Record<SkipReason, string[]> = {
    'not-signed-in': [], 'needs-reconnect': [], unavailable: [],
  };
  for (const s of skips) {
    // Normalized, not indexed raw: an inherited key like 'constructor' would
    // otherwise reach Object.prototype. An unknown reason is still a skip.
    const list = byReason[normalizeSkipReason(s.reason)];
    const name = sanitizeSkipName(typeof s.name === 'string' ? s.name : '');
    if (name.length === 0 || list.includes(name)) continue;
    list.push(name);
  }
  const agent = sanitizeSkipName(agentName ?? '') || 'this agent';
  const groups = REASON_ORDER.filter((r) => byReason[r].length > 0);
  if (groups.length === 0) return null;
  // At most SKIP_NAMES_SHOWN names per sentence, so every sentence survives
  // the cap; with long names, show fewer before giving up to the clamp.
  let text = '';
  for (let shown = SKIP_NAMES_SHOWN; shown >= 1; shown -= 1) {
    text = groups.map((r) => sentence(byReason[r], r, agent, shown)).join(' ');
    if (Array.from(text).length <= SKIP_WARNING_MAX) return text;
  }
  return clampCodePoints(text, SKIP_WARNING_MAX);
}
