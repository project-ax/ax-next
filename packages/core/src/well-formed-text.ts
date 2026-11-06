/**
 * Text every store can hold (TASK-1059).
 *
 * A JS string can carry two things that many stores refuse outright: U+0000,
 * and a lone UTF-16 surrogate (a high half with no low half after it, or a low
 * half with no high half before it). Postgres `jsonb` and `text` both refuse
 * them, and a refused write fails the same way every time, so no retry can
 * save it. A person's message or a tool's output can carry either one.
 *
 * These helpers swap each one for U+FFFD (the replacement character) and keep
 * everything else, well-formed surrogate pairs (emoji) included. It is the same
 * result as `String.prototype.toWellFormed()` PLUS a NUL swap, so the built-in
 * alone is not a drop-in replacement: it leaves U+0000, which Postgres refuses.
 *
 * Deliberately no store vocabulary in the names: this is about text, and any
 * backend that wants well-formed Unicode can use it.
 */

// U+0000, a high surrogate with no low after it, or a low with no high before.
const NOT_WELL_FORMED =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `s` with U+0000 and every lone surrogate replaced by U+FFFD. */
export function toWellFormedText(s: string): string {
  return s.replace(NOT_WELL_FORMED, '\uFFFD');
}

/**
 * A `JSON.stringify` replacer that applies `toWellFormedText` to every string
 * value and every object key. Two keys that differ only in such characters
 * collapse to one (the last wins), which only a hand-built or model-written
 * object can produce.
 */
export function wellFormedJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return toWellFormedText(value);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.some(([k]) => toWellFormedText(k) !== k)) {
      return Object.fromEntries(entries.map(([k, v]) => [toWellFormedText(k), v]));
    }
  }
  return value;
}

// Cheap pre-check on serialized JSON: JSON.stringify writes U+0000 and every
// lone surrogate as a `\u` escape. A well-formed pair is written raw, so a
// match here is either a real problem or a string that literally contains a
// backslash-u sequence; both just take the slower, exact path.
const MAYBE_NOT_WELL_FORMED_JSON = /\\u0000|\\ud[89a-f]/i;

/**
 * `JSON.stringify(value)` with `toWellFormedText` applied to every string and
 * key. Plain `JSON.stringify` first; the replacer pass runs only when the
 * output could hold something to fix, so ordinary payloads cost one stringify.
 */
export function stringifyWellFormed(value: unknown): string {
  const plain = JSON.stringify(value);
  if (plain === undefined || !MAYBE_NOT_WELL_FORMED_JSON.test(plain)) return plain;
  return JSON.stringify(value, wellFormedJsonReplacer);
}

/**
 * `value` with `toWellFormedText` applied to every string and key, as a JSON
 * value. Returns `value` itself (same reference) when there is nothing to fix;
 * otherwise a JSON round-trip of it, so pass only plain JSON data.
 */
export function toWellFormedValue<T>(value: T): T {
  const plain = JSON.stringify(value);
  if (plain === undefined || !MAYBE_NOT_WELL_FORMED_JSON.test(plain)) return value;
  return JSON.parse(JSON.stringify(value, wellFormedJsonReplacer)) as T;
}
