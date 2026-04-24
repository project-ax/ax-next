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
// Callers pass the logger's `ctx.logger.error` into `unexpectedError()` so
// the leak-prevention is localized to these helpers — dispatcher and
// handlers can't accidentally spill a stack trace by returning the wrong
// shape.
// ---------------------------------------------------------------------------

/** Validation failure — bad JSON shape, missing fields, etc. */
export function validationError(message: string): HandlerErr {
  return { status: 400, body: { error: { code: 'VALIDATION', message } } };
}

/** 404 is reserved for "unknown route / unknown host tool". */
export function notFound(message: string): HandlerErr {
  return { status: 404, body: { error: { code: 'VALIDATION', message } } };
}

/** A subscriber chain returned `reject`; the action is vetoed. */
export function hookRejected(reason: string): HandlerErr {
  return { status: 409, body: { error: { code: 'HOOK_REJECTED', message: reason } } };
}

/**
 * Map a PluginError thrown inside a service hook call to a safe wire error.
 * Internal codes never leak to the client; only the bucketed HTTP status
 * and a fixed message do.
 */
export function mapPluginError(err: PluginError): HandlerErr {
  switch (err.code) {
    case 'invalid-payload':
      return validationError('invalid payload');
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
