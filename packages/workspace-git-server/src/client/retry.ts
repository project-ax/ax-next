// ---------------------------------------------------------------------------
// Retry primitive for host-side workspace clients.
//
// The original lives in `@ax/workspace-git-http/src/client.ts` (`withRetry`,
// `defaultBackoff`, and `TRANSIENT_ERRNOS`). We extract a standalone helper
// here because Phase 2's host plugin needs the same retry shape but a
// different transport — git smart-HTTP wire protocol against the storage
// tier, not JSON-over-HTTP. Operators expect consistent retry behavior across
// the two backends during canary, so the cadence and semantics MUST match.
//
// Backoff curve: 100ms, 200ms, 400ms, 800ms, 1600ms, …, capped at 30000ms.
// Computed as `Math.min(backoffBaseMs * 2 ** attempt, 30_000)` where
// `attempt` is 0-indexed. No jitter (the legacy code has none, and adding
// jitter here would diverge from the operator-facing behavior of the
// existing backend).
//
// Why `PluginError` is never retried: it's the 4xx-mapped semantic error
// shape (e.g., `parent-mismatch`, `invalid-path`, `unknown-version`).
// Retrying won't fix it — the orchestrator needs to react (e.g., rebase on
// parent-mismatch). Retrying a 4xx would also waste time during the canary
// when latency is already a concern.
//
// Why we use `isTransientConnectionError` (errno-based, structural) and not
// message-string matching: errno codes (`.code` property on
// `NodeJS.ErrnoException`) are stable across libc versions, library
// wrappers, and Node updates. Error messages are not — they're translated,
// reformatted, or wrapped at every layer. A predicate that matches "this
// looks transient" by message text would silently break on a Node minor
// upgrade. The structural check costs us nothing (a single Set lookup) and
// is the only thing we trust.
//
// Total-tries naming: the legacy code parameterizes "max retries on top of
// the first try" as `maxRetries: 5` (default), with the loop
// `for (let attempt = 0; attempt <= maxRetries; attempt++)` — so 6 total
// tries. We rename to `maxAttempts` for clarity at the call site, but the
// SEMANTICS are unchanged: `maxAttempts: 5` still means 6 total tries
// (1 initial + 5 retries). The interface JSDoc on `RetryOptions.maxAttempts`
// pins this; tests in `__tests__/retry.test.ts` enforce it.
// ---------------------------------------------------------------------------

import { PluginError } from '@ax/core';

/**
 * Connection-level errnos that should trigger a retry. Same set as
 * `@ax/workspace-git-http`'s `TRANSIENT_ERRNOS` (and `@ax/ipc-protocol`'s
 * `ipc-client.ts` minus `ENOENT`, since we don't speak unix sockets here).
 */
export const TRANSIENT_ERRNOS: ReadonlySet<string> = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

/**
 * Returns `true` iff `err` is a structural (errno-based) transient
 * connection error. Note: explicitly does NOT match `PluginError` (those
 * are 4xx-mapped semantic errors and never retry) or `Error` instances
 * whose only "transientness" is their message text.
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (err instanceof PluginError) return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_ERRNOS.has(code);
}

export interface RetryOptions {
  /**
   * "Max retries on top of the first try", mirroring the legacy
   * `@ax/workspace-git-http` semantics verbatim. Total tries on transient
   * errors = `maxAttempts + 1`. Default `5` (so 6 total tries).
   */
  maxAttempts?: number;
  /**
   * Backoff base in ms. Default `100`. The Nth retry waits
   * `min(backoffBaseMs * 2 ** N, 30000)` ms (N is 0-indexed). Cap is
   * fixed at 30000ms.
   */
  backoffBaseMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 30_000;

function backoffFor(attempt: number, baseMs: number): number {
  // attempt is 0-indexed: first retry waits `baseMs`, second waits
  // `2 * baseMs`, third waits `4 * baseMs`, etc., capped at 30s.
  return Math.min(baseMs * 2 ** attempt, BACKOFF_CAP_MS);
}

/**
 * Retries `fn` on transient (errno-based) connection errors with
 * exponential backoff. `PluginError` and any non-transient error breaks out
 * of the loop immediately. After `maxAttempts` retries, the final error is
 * rethrown.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = opts?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

  // Validate input shape before entering the loop. A negative or
  // non-integer `maxAttempts` would skip the loop and fall through to the
  // defensive throw at the bottom — which throws `undefined`, an utterly
  // useless failure mode. A negative or NaN `backoffBaseMs` would compute
  // a NaN/negative wait and turn the retry into a tight loop. We reject
  // both with a clear TypeError so misconfiguration fails loudly at the
  // first call instead of silently swallowing the operation.
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0) {
    throw new TypeError('maxAttempts must be a non-negative integer');
  }
  if (!Number.isFinite(backoffBaseMs) || backoffBaseMs < 0) {
    throw new TypeError('backoffBaseMs must be a non-negative number');
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Non-transient (incl. PluginError 4xx) → throw immediately.
      // On the final attempt (attempt === maxAttempts) we've exhausted the
      // retry budget; rethrow even if transient.
      if (!isTransientConnectionError(err) || attempt === maxAttempts) throw err;
      const wait = backoffFor(attempt, backoffBaseMs);
      if (wait > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  // Unreachable — the loop body either returns or throws on every iteration.
  // Defensive throw for the control-flow analyzer (matches the legacy code).
  throw lastErr;
}
