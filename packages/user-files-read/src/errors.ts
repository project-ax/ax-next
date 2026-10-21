/**
 * The storage was there and would not answer.
 *
 * Thrown only from the post-confinement reads, so it can never be the first
 * thing a caller learns about a path — by the time one of these is possible,
 * the path has already been proved to exist inside the caller's own root.
 *
 * `code` is the raw errno (`EIO`, `ESTALE`, `EACCES`, …) when the filesystem
 * gave us one. It is for an operator reading a log: nothing user-facing should
 * repeat it, because "ESTALE" is not a sentence anybody can act on.
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
