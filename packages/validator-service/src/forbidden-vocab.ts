// ---------------------------------------------------------------------------
// Forbidden backend-vocabulary scan (I2).
//
// The neutral ServiceDescriptor is transport/storage-agnostic: it names WHAT a
// service is, never HOW a backend (k8s, docker, …) schedules it. The canonical
// Zod schema's `.strict()` already rejects an unknown TOP-LEVEL key, so a
// smuggled `securityContext` / `runtimeClassName` at the descriptor root fails
// the parse. This scan is the defense-in-depth twin: it walks the WHOLE object
// graph and flags any forbidden token appearing as an object KEY at any depth,
// returning a SPECIFICALLY-NAMED reason (the card's "REJECTING forbidden
// vocabulary") instead of zod's generic "unrecognized key". A reviewer reading
// a rejection learns exactly which scheduler field leaked.
// ---------------------------------------------------------------------------

/**
 * Lower-cased k8s / container-runtime field names that must never appear in a
 * neutral descriptor. Matched case-insensitively against object KEYS at any
 * depth. Kept in sync with the card's I2 list.
 */
export const FORBIDDEN_VOCAB = [
  'pod',
  'container',
  'securitycontext',
  'runtimeclassname',
  'volume',
  'emptydir',
  'initcontainers',
  'restartpolicy',
] as const;

const FORBIDDEN_SET = new Set<string>(FORBIDDEN_VOCAB);

/**
 * Deep-scan `value` for any object key whose lower-cased form is in
 * {@link FORBIDDEN_VOCAB}. Returns the offending key (original casing) or
 * `null` when clean. Arrays are walked element-wise; non-object leaves are
 * ignored (we flag KEYS, not values — a value of "pod" is a legitimate string).
 */
export function findForbiddenVocab(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const el of value) {
      const hit = findForbiddenVocab(el);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_SET.has(key.toLowerCase())) return key;
      const hit = findForbiddenVocab(child);
      if (hit !== null) return hit;
    }
  }
  return null;
}
