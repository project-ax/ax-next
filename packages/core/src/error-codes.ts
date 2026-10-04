/**
 * Error codes that cross a plugin boundary AND reach the browser — the ONE
 * spelling of each (TASK-782, CLAUDE.md invariant 4).
 *
 * Import them from `@ax/core/error-codes`. Like `@ax/core/surface-text`, this
 * file imports nothing, so the channel-web SPA can bundle it without pulling
 * the kernel's hook bus into the browser, and every plugin already depends on
 * `@ax/core`, so no consumer needs a cross-plugin import (invariant 2).
 *
 * A code here is a wire contract: a producer throws it as a `PluginError`
 * code, a route answers it as `{ error: <code> }`, and a UI keys a plain
 * message on it. Renaming one here renames it everywhere at once — which is
 * the point; three hand-copied spellings could drift and quietly drop the UI
 * back to its generic message.
 */

/**
 * The `PluginError` code `connectors:upsert` throws when a save could not first
 * update the connector's tool permissions — resetting a kept-name server that
 * moved to a new endpoint (TASK-758), or recording which of its servers carry
 * an admin ceiling (TASK-809). Nothing was saved. The connector routes (and the
 * chat grant route) answer it as a 503 with this exact string as `error`, and
 * the channel-web editors and approve surfaces key their message on it.
 */
export const TOOL_PERMISSIONS_RESET_FAILED = 'tool-permissions-reset-failed';
