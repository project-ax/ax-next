/**
 * Strict-whitelist payload substitution for webhook routine prompts.
 *
 * Only two emission shapes:
 *   {{payload}}              -> JSON.stringify(payload)
 *   {{payload.dotted.path}}  -> dot-walked value, coerced to string
 *
 * Path segments match [a-zA-Z0-9_-]+ only. Brackets, dots inside
 * segments, function-call syntax, and any other expression form are
 * left literal by the regex. There is no expression engine here by
 * design — anything beyond string substitution would be a
 * prompt-injection amplifier (the substituted output flows verbatim
 * into the agent's prompt; see K9 in the Phase C design doc).
 *
 * Missing fields, non-object intermediates, and null/undefined
 * terminals all collapse to the empty string. The walk never throws.
 */
// Single regex matches BOTH emission shapes so substitution is a
// single-pass walk over `body`. The optional capture group is `undefined`
// for `{{payload}}` (whole) and `.x.y` for `{{payload.x.y}}` (path). Two
// sequential .replace() calls would re-scan the first pass's output and
// expand any attacker-embedded `{{payload.X}}` strings sitting inside
// JSON-stringified payload values — a K9 contract violation even though
// the only data in scope is the attacker's own payload. Single-pass
// closes that amplifier.
const TEMPLATE_RE = /\{\{\s*payload((?:\.[a-zA-Z0-9_-]+)+)?\s*\}\}/g;

export function renderTemplate(body: string, ctx: { payload: unknown }): string {
  return body.replace(TEMPLATE_RE, (_m, raw?: string) =>
    raw === undefined || raw === ''
      ? JSON.stringify(ctx.payload)
      : walkOrEmpty(ctx.payload, raw),
  );
}

function walkOrEmpty(root: unknown, raw: string): string {
  // raw starts with '.', so first .split entry is empty — slice it off.
  const segments = raw.slice(1).split('.');
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return '';
    // Own-properties only — refuses `__proto__` / `constructor` /
    // `prototype` traversal even if a JSON payload sets them as own
    // properties via JSON.parse. (For URLSearchParams payloads,
    // `Object.fromEntries` can also produce own `__proto__` keys; same
    // guard applies.)
    if (!Object.hasOwn(cur, seg)) return '';
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === null || cur === undefined) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return JSON.stringify(cur);
}
