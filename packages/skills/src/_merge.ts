/**
 * Shared merge + ordering helpers for @ax/skills scope-aware hooks.
 *
 * The `skills:list`, `skills:get` (all-fallback), `skills:resolve`, and
 * `skills:list-defaults` hooks all union a global skill list with a
 * user-scoped list where user rows win on id collision. This module is the
 * single source of truth for that merge so the four call sites stay in sync.
 *
 * DO NOT import this file from outside the @ax/skills package.
 */

/**
 * Merge a global list with a user list where user rows win on id collision.
 * Returns the merged Map keyed by id; the caller picks the final ordering
 * (list/list-defaults sort by id ascending; resolve replays input order).
 */
export function mergeUserWins<T extends { id: string }>(
  global: T[],
  user: T[],
): Map<string, T> {
  const byId = new Map<string, T>(global.map((s) => [s.id, s]));
  for (const s of user) {
    byId.set(s.id, s);
  }
  return byId;
}

/** Stable ascending comparator by `id`. Used by list / list-defaults. */
export function compareById<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
