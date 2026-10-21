/**
 * The storage was there and would not answer.
 *
 * Thrown when a read that was allowed to proceed fails: opening the root the
 * caller chose, or any component, listing or read inside a directory the walk
 * has already opened under it, for any errno other than the path having
 * vanished. Every one of those concerns the caller's own root or a directory
 * already proved to be inside it, so none of them says anything about anyone
 * else's files. It is also thrown, with code `unsupported-platform`, before any
 * path is looked at, when this is not Linux.
 *
 * `code` is the errno's name (`EIO`, `ESTALE`, `EACCES`, …) when the filesystem
 * gave us one, even one Node has no name for: on Linux, Node reports ESTALE
 * only by number. It is for an operator reading a log: nothing user-facing
 * should repeat it, because "ESTALE" is not a sentence anybody can act on.
 *
 * A plain `Error` subclass rather than a `PluginError` on purpose — this
 * package is a dependency-free library with no `@ax/core` import, and the
 * realizations that call it wrap or re-throw as their own plugin sees fit.
 */
export class UserFilesReadError extends Error {
  readonly code: string | undefined;
  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UserFilesReadError';
    this.code = options?.code;
  }
}
