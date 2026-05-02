import { PluginError } from '@ax/core';
import type { IpcErrorCode } from '@ax/ipc-protocol';
import type { HandlerErr } from './handlers/types.js';

// ---------------------------------------------------------------------------
// Error mapping
//
// Thin helpers that translate host-side failure modes into the sanitized
// wire-shape the client sees. The invariant (I9 + "no info leak") is:
//
//   - The client receives { code: IpcErrorCode, message: <safe string> }.
//   - The caller-side logger receives the real error (hookName, plugin,
//     cause) at `error` level for debugging.
//
// Callers pass the logger's `ctx.logger.error` into `logInternalError()` so
// the leak-prevention is localized to these helpers — dispatcher and
// handlers can't accidentally spill a stack trace by returning the wrong
// shape. The wire-shape helpers below (`validationError`, `notFound`,
// `hookRejected`, `mapPluginError`, `internalError`) produce
// sanitized responses; `logInternalError` is the matching observability
// side that logs the real cause for debugging.
// ---------------------------------------------------------------------------

/** Validation failure — bad JSON shape, missing fields, etc. */
export function validationError(message: string): HandlerErr {
  return { status: 400, body: { error: { code: 'VALIDATION', message } } };
}

/** 404 for "unknown route / unknown host tool" — distinct from 400 VALIDATION
 *  (malformed request) since the client can legitimately ask about a tool the
 *  host doesn't expose. */
export function notFound(message: string): HandlerErr {
  return { status: 404, body: { error: { code: 'NOT_FOUND', message } } };
}

/** A subscriber chain returned `reject`; the action is vetoed. */
export function hookRejected(reason: string): HandlerErr {
  return { status: 409, body: { error: { code: 'HOOK_REJECTED', message: reason } } };
}

/**
 * Map a PluginError thrown inside a service hook call to a safe wire error.
 * Internal codes never leak to the client; only the bucketed HTTP status
 * and a fixed message do.
 *
 * `conflict` is mapped to 409 HOOK_REJECTED — used by
 * `conversations:store-runner-session` (Phase C) when an idempotent bind
 * sees a different runner session id already attached to the row.
 */
export function mapPluginError(err: PluginError): HandlerErr {
  switch (err.code) {
    case 'invalid-payload':
      return validationError('invalid payload');
    // Session backend codes (Week 9.5). Unknown / terminated sessions
    // map to 401 because the bearer token the runner is authenticating
    // with no longer resolves to a usable session — the runner should
    // exit, not retry. `owner-missing` (legacy pre-9.5 row reaching
    // session:get-config) is a configuration mismatch, not a transient
    // failure; map to 401 too so the runner fails fast.
    case 'unknown-session':
    case 'owner-missing':
      return {
        status: 401,
        body: { error: { code: 'SESSION_INVALID', message: 'session has no usable config' } },
      };
    // Task 15 (Week 10–12): conversations:fetch-history surfaces these
    // codes from its ACL gate (`not-found` for cross-tenant or unknown
    // rows, `forbidden` for `agents:resolve` denial). Channel-web maps
    // the SAME bus errors as 404 / 403 over HTTP; we mirror that here
    // so the runner sees the same outcome regardless of caller. We use
    // HOOK_REJECTED with HTTP 403 (the IPC error-code enum doesn't have
    // a FORBIDDEN constant — minting one would widen the wire surface
    // and isn't load-bearing for the runner, which only branches on
    // status to decide retry-vs-fatal).
    case 'not-found':
      return notFound('not found');
    case 'forbidden':
      return {
        status: 403,
        body: { error: { code: 'HOOK_REJECTED', message: 'forbidden' } },
      };
    // Phase C (runner-owned sessions). conversations:store-runner-session
    // throws `conflict` when the conversation row is already bound to a
    // different runnerSessionId. The runner should treat this as fatal
    // (the binding it observed locally diverges from what the host has
    // recorded for an earlier turn) — 409 maps to a non-retryable error
    // on the client side.
    case 'conflict':
      return hookRejected('conflict');
    case 'no-service':
    case 'duplicate-service':
    case 'missing-service':
    case 'init-failed':
    case 'cycle':
    case 'timeout':
    case 'subscriber-failed':
    case 'unknown':
    default:
      // All other PluginError codes bucket to 500 INTERNAL. The specifics
      // (hookName, plugin, cause) are logged via logInternalError below; we
      // never paint them onto the wire.
      return { status: 500, body: { error: { code: 'INTERNAL', message: 'internal server error' } } };
  }
}

/** Shape for "generic thrown error" fallback — 500 with opaque message. */
export function internalError(): HandlerErr {
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'internal server error' } },
  };
}

/**
 * Log an internal failure with full detail. Callers pass their request-scoped
 * logger so reqId is stamped automatically. We log at `error` level because
 * a 500 reaching the wire means something genuinely wrong happened — we want
 * it surfaced in production log pipelines.
 */
export function logInternalError(
  logger: { error: (msg: string, bindings?: Record<string, unknown>) => void },
  action: string,
  err: unknown,
): void {
  const base: Record<string, unknown> = { action };
  if (err instanceof PluginError) {
    base.pluginErrorCode = err.code;
    base.plugin = err.plugin;
    if (err.hookName !== undefined) base.hookName = err.hookName;
    base.err = err;
  } else if (err instanceof Error) {
    base.err = err;
  } else {
    base.err = new Error(String(err));
  }
  logger.error('ipc_dispatch_internal_error', base);
}

// Internal re-exports so handlers don't need to know which file the type
// lives in. `IpcErrorCode` stays authoritative from @ax/ipc-protocol.
export type { IpcErrorCode };
