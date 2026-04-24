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
