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
 *
 * One host value, never from the payload: `{{lastCompletedRun}}`
 * (TASK-991), filled by `fire.ts` from this routine's own fire records
 * BEFORE the payload pass, so payload text can't produce or re-render it.
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

/**
 * TASK-991. The token a repeat routine's prompt writes to get the date of its
 * last completed run. Whitespace inside the braces is tolerated, as in the
 * payload tokens. It shares no namespace with the payload: `{{payload.X}}` is
 * never this token, and `renderTemplate` never fills this one.
 */
export const LAST_COMPLETED_RUN_TOKEN = '{{lastCompletedRun}}';
// Two regexes: a global one for the replace, and a plain one for the test,
// since `.test()` on a global regex is stateful (`lastIndex`).
const LAST_COMPLETED_RUN_RE = /\{\{\s*lastCompletedRun\s*\}\}/;
const LAST_COMPLETED_RUN_ALL_RE = /\{\{\s*lastCompletedRun\s*\}\}/g;

/** Whether `body` asks for the date of the routine's last completed run. */
export function usesLastCompletedRun(body: string): boolean {
  return LAST_COMPLETED_RUN_RE.test(body);
}

/**
 * Fills every `{{lastCompletedRun}}` in `body` with `lastCompletedRun`'s UTC
 * date (`YYYY-MM-DD`), or `never` when there is none. Host-only and fixed
 * format: the value holds no braces, so the payload pass that follows finds no
 * token in it. A replacer function, so no `$` pattern in a value is expanded.
 */
export function renderLastCompletedRun(body: string, lastCompletedRun: Date | null): string {
  const value = lastCompletedRun === null ? 'never' : lastCompletedRun.toISOString().slice(0, 10);
  return body.replace(LAST_COMPLETED_RUN_ALL_RE, () => value);
}
