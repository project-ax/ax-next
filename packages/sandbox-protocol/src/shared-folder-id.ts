import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared-folder id vocabulary (W2 shared folders).
//
// A folder id is `sf_` + base64url, minted host-side by `@ax/shared-folders`.
// It is a safe SINGLE path segment: it becomes `.shared/<folderId>` in the
// backing store and `/shared/<folderId>` inside the sandbox, so the shape is
// the one gate that keeps a hostile or corrupt id from escaping or aliasing a
// directory. Every consumer (resolvers, providers, the plugin itself) imports
// this one definition (invariant I4 — one source of truth) rather than
// re-deriving the regex.
//
// The `sf_` prefix is also what guarantees an id can never equal `.`, `..` or
// `.shared`, and the character class has no `/`, `\`, `.` or NUL.
// ---------------------------------------------------------------------------

/** `sf_` + 1..64 base64url characters, anchored. Not global/sticky — safe to reuse with `.test`. */
export const SHARED_FOLDER_ID_RE = /^sf_[A-Za-z0-9_-]{1,64}$/;

/** Type guard: `id` is a string with the shared-folder id shape. */
export function isValidSharedFolderId(id: unknown): id is string {
  return typeof id === 'string' && SHARED_FOLDER_ID_RE.test(id);
}

/** zod form of {@link SHARED_FOLDER_ID_RE}. */
export const SharedFolderIdSchema = z.string().regex(SHARED_FOLDER_ID_RE, 'invalid shared folder id');
