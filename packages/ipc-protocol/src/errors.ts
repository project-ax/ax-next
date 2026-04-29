import { z } from 'zod';

// ---------------------------------------------------------------------------
// This file has two halves:
//
//   1. Wire-error schemas (Zod) — the shared error envelope returned by
//      every host IPC handler. Lives below.
//
//   2. Typed Error classes — thrown by the sandbox-side IPC client when it
//      decodes a wire error or hits a transport-level failure. Lives at the
//      bottom of this file. The client (also in @ax/ipc-protocol) imports
//      them via `./errors.js`.
//
// Why colocated: callers and decoders share the same vocabulary
// (HOST_UNAVAILABLE, SESSION_INVALID, …) and keeping wire-shape + typed-
// error in one file makes it harder for the two to drift out of sync.
// ---------------------------------------------------------------------------

/**
 * The closed set of error codes emitted by any host IPC handler.
 *
 * A regression guard in schemas.test.ts asserts this set exactly —
 * adding or removing a code is a protocol change and must be done
 * with intent.
 */
export const IpcErrorCodeSchema = z.enum([
  'SESSION_INVALID',
  'HOST_UNAVAILABLE',
  'VALIDATION',
  'HOOK_REJECTED',
  'NOT_FOUND',
  'INTERNAL',
]);
export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>;

/** Inner error body — carried inside the envelope below. */
export const IpcErrorSchema = z.object({
  code: IpcErrorCodeSchema,
  message: z.string(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

/**
 * Wire envelope for an error response. `.strict()` so unknown top-level
 * keys are rejected: the envelope shape is frozen (extensions go inside
 * `error`, not next to it) and any drift is a protocol bug we want the
 * decoder to surface loudly.
 */
export const IpcErrorEnvelopeSchema = z
  .object({
    error: IpcErrorSchema,
  })
  .strict();
export type IpcErrorEnvelope = z.infer<typeof IpcErrorEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Typed errors for the sandbox-side IPC client.
//
// Three shapes, matched to how the runner should react:
//
//   SessionInvalidError   — the session token the runner holds is no longer
//                           honored (401). Terminal. The runner should exit.
//                           A retry will not help; the host has told us our
//                           session is gone.
//
//   HostUnavailableError  — the host-side listener is not reachable
//                           (ECONNREFUSED, ECONNRESET, EPIPE, missing socket
//                           file, per-action timeout). Transient — the
//                           client retries with exponential backoff before
//                           raising this to the caller.
//
//   IpcRequestError       — the host accepted the request but rejected it
//                           with a structured error envelope (400/404/409/
//                           5xx). Carries the wire-level error code and
//                           HTTP status. 4xx is a caller bug (don't retry);
//                           5xx is transient (the client already retried).
// ---------------------------------------------------------------------------

export class SessionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInvalidError';
  }
}

export class HostUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    // Use Error's options-bag cause field (ES2022) so stack traces chain
    // naturally. Only pass the options object when we actually have a
    // cause — exactOptionalPropertyTypes won't let `cause: undefined`
    // slip through.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'HostUnavailableError';
  }
}

export class IpcRequestError extends Error {
  constructor(
    public readonly code: string, // IpcErrorCode from the wire
    public readonly status: number, // HTTP status
    message: string,
  ) {
    super(message);
    this.name = 'IpcRequestError';
  }
}
