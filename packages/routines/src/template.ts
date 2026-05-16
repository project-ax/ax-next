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
const WHOLE_RE = /\{\{\s*payload\s*\}\}/g;
const PATH_RE = /\{\{\s*payload((?:\.[a-zA-Z0-9_-]+)+)\s*\}\}/g;

export function renderTemplate(body: string, ctx: { payload: unknown }): string {
  return body
    .replace(WHOLE_RE, () => JSON.stringify(ctx.payload))
    .replace(PATH_RE, (_m, raw: string) => walkOrEmpty(ctx.payload, raw));
}

function walkOrEmpty(root: unknown, raw: string): string {
  // raw starts with '.', so segments[0] is empty after .slice(1).split
  const segments = raw.slice(1).split('.');
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === null || cur === undefined) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return JSON.stringify(cur);
}
