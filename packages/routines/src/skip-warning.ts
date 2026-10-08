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

export type SkipReason = 'not-signed-in' | 'needs-reconnect';

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

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function sentence(names: readonly string[], reason: SkipReason, agent: string): string {
  const one = names.length === 1;
  const verb = reason === 'not-signed-in'
    ? (one ? "isn't signed in" : "aren't signed in")
    : (one ? 'needs to be signed in again' : 'need to be signed in again');
  return `${listNames(names)} ${verb} on ${agent}, so this run went without ${one ? 'it' : 'them'}.`;
}

export function buildSkipWarning(
  agentName: string | null,
  skips: ReadonlyArray<{ name: string; reason: SkipReason }>,
): string | null {
  const byReason: Record<SkipReason, string[]> = { 'not-signed-in': [], 'needs-reconnect': [] };
  for (const s of skips) {
    // Checked against the set, not by indexing: an inherited key like
    // 'constructor' would otherwise reach Object.prototype.
    if (s.reason !== 'not-signed-in' && s.reason !== 'needs-reconnect') continue;
    const list = byReason[s.reason];
    const name = sanitizeSkipName(typeof s.name === 'string' ? s.name : '');
    if (name.length === 0 || list.includes(name)) continue;
    list.push(name);
  }
  const agent = sanitizeSkipName(agentName ?? '') || 'this agent';
  const parts: string[] = [];
  if (byReason['not-signed-in'].length > 0) {
    parts.push(sentence(byReason['not-signed-in'], 'not-signed-in', agent));
  }
  if (byReason['needs-reconnect'].length > 0) {
    parts.push(sentence(byReason['needs-reconnect'], 'needs-reconnect', agent));
  }
  if (parts.length === 0) return null;
  return clampCodePoints(parts.join(' '), SKIP_WARNING_MAX);
}
