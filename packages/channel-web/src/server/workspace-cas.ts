import { PluginError } from '@ax/core';

// ---------------------------------------------------------------------------
// Workspace CAS (compare-and-set) helpers shared by the channel-web routes that
// seed `.ax/` files via `workspace:apply` (the bootstrap-seed route and the
// admin identity editor).
//
// The local workspace backend is a SINGLE shared git repo with one global
// `main` ref; `workspace:apply`'s `parent` is an optimistic-CAS token against
// that head. A first write to a never-committed workspace passes `parent: null`
// (the backend lazy-creates `main`). On any live deployment `main` already
// exists, so that first attempt CAS-misses with a `parent-mismatch` PluginError
// whose `cause.actualParent` echoes the tier's real head. The established
// recovery contract (also used by attachments:commit and the apply-bundle
// path) is: read `actualParent` off the mismatch and retry once with it.
// ---------------------------------------------------------------------------

/**
 * Sentinel returned by {@link actualParentFromMismatch} when the error is NOT a
 * `parent-mismatch` carrying `actualParent` — i.e. a real failure the caller
 * must surface, not a CAS miss to retry.
 */
export const NO_ACTUAL_PARENT = Symbol('no-actual-parent');

/**
 * Extract the storage tier's actual head from a `parent-mismatch` PluginError's
 * `cause.actualParent` (the established workspace CAS contract). Returns the
 * value (a version token or null) when the error is a parent-mismatch carrying
 * it, or {@link NO_ACTUAL_PARENT} so the caller knows NOT to retry.
 */
export function actualParentFromMismatch(
  err: unknown,
): string | null | typeof NO_ACTUAL_PARENT {
  if (!(err instanceof PluginError) || err.code !== 'parent-mismatch') {
    return NO_ACTUAL_PARENT;
  }
  const cause = err.cause as { actualParent?: string | null } | undefined;
  if (cause === undefined || !('actualParent' in cause)) return NO_ACTUAL_PARENT;
  return cause.actualParent ?? null;
}
