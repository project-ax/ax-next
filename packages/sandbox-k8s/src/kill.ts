// ---------------------------------------------------------------------------
// Pod kill — idempotent. A "pod is already gone" 404 is the happy path,
// not a failure: if the kubelet, GC, or a previous kill already removed
// the pod, we're done. The legacy provider (~/dev/ai/ax/src/providers/
// sandbox/k8s.ts:38) had the same shape — ported here verbatim.
//
// Why this matters: open-session sets up a child-close-style cleanup that
// fires on pod exit AND a separate handle.kill() the orchestrator may call
// when the chat times out. Both paths can race to delete the same pod;
// either one observes 404 from the other and that's fine.
// ---------------------------------------------------------------------------

import type { Logger } from '@ax/core';
import type { K8sCoreApi } from './k8s-api.js';

/**
 * 404 detector. The @kubernetes/client-node delete API surfaces 404 in
 * several shapes depending on which transport / version / error path
 * fires:
 *   - `err.code === 404` (legacy numeric)
 *   - `err.statusCode === 404`
 *   - `err.response?.statusCode === 404`
 *   - `err.body` is a serialized k8s Status JSON with code:404 OR
 *     contains the literal phrase "not found".
 */
export function isPodGoneError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    statusCode?: unknown;
    response?: { statusCode?: unknown };
    body?: unknown;
  };
  if (e.code === 404) return true;
  if (e.statusCode === 404) return true;
  if (e.response?.statusCode === 404) return true;
  const body = typeof e.body === 'string' ? e.body : '';
  if (body.length > 0 && /not found/i.test(body)) return true;
  return false;
}

/**
 * TRANSIENT-error detector for the kill retry (TASK-170). A managed
 * kube-apiserver / etcd briefly throttling under load is the canonical case:
 * the GKE-Standard incident surfaced `HTTP 500 rpc error: code = Unavailable
 * ... 'Txn' throttled ... (memory-protection)` — a 500 whose body carries the
 * "Unavailable" hint. We retry these because a couple of attempts clears the
 * blip; we do NOT retry a permanent error (a 403/forbidden or 400/bad-request),
 * because that just hammers the apiserver to no end. 404 is excluded here on
 * purpose — it's the HAPPY path (`isPodGoneError`), handled before we ever ask
 * "is this transient?".
 *
 * Transient iff:
 *   - an HTTP 5xx in any of the shapes `isPodGoneError` knows
 *     (`code` / `statusCode` / `response.statusCode`), OR
 *   - the error message / serialized `body` matches one of the well-known
 *     "try again" phrases (Unavailable / throttled / overloaded / timeout).
 */
const TRANSIENT_MESSAGE_RE =
  /unavailable|throttl|overloaded|timeout|ServiceUnavailable/i;

function is5xx(n: unknown): boolean {
  return typeof n === 'number' && n >= 500 && n <= 599;
}

export function isTransientApiError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    statusCode?: unknown;
    response?: { statusCode?: unknown };
    body?: unknown;
    message?: unknown;
  };
  if (is5xx(e.code) || is5xx(e.statusCode) || is5xx(e.response?.statusCode)) {
    return true;
  }
  const body = typeof e.body === 'string' ? e.body : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (body.length > 0 && TRANSIENT_MESSAGE_RE.test(body)) return true;
  if (message.length > 0 && TRANSIENT_MESSAGE_RE.test(message)) return true;
  return false;
}

/** Backoff schedule (ms) between kill attempts. Index i is the wait BEFORE
 *  attempt i+1. Short and bounded — the throttle is brief and the whole kill
 *  must stay well under the 300 s `sandbox:open-session` service timeout. */
const KILL_BACKOFF_MS = [250, 500, 1000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface KillPodInput {
  api: K8sCoreApi;
  podName: string;
  namespace: string;
  /** Per-pod child logger pre-bound with reqId/podName/pid. */
  podLog: Logger;
  /** Defaults to 5 — kube gives the runner that long to flush before SIGKILL. */
  gracePeriodSeconds?: number;
  /**
   * TASK-170 — max delete attempts on a TRANSIENT apiserver error. Default 3.
   * 404 (already gone) and permanent errors (4xx ≠ 404) never consume a retry.
   */
  maxAttempts?: number;
  /** Testable seam — defaults to a setTimeout-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Delete a pod, idempotently and resiliently.
 *
 *   - 404 / NotFound  → happy path, resolve (the pod's already gone).
 *   - transient 5xx / Unavailable → retry up to `maxAttempts` with backoff.
 *   - any other error (permanent 4xx) → rethrow immediately, no retry.
 *
 * On the final exhausted attempt we keep the original behavior — log
 * `pod_kill_failed` (warn) and rethrow — so the caller's existing best-effort
 * `.catch` still applies, just only AFTER we've given the throttle a few
 * chances to clear (the TASK-170 fix; the periodic orphan-sweep is the
 * belt-and-suspenders for the case where it still doesn't).
 */
export async function killPod(input: KillPodInput): Promise<void> {
  const grace = input.gracePeriodSeconds ?? 5;
  const maxAttempts = input.maxAttempts ?? 3;
  const sleep = input.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await input.api.deleteNamespacedPod({
        name: input.podName,
        namespace: input.namespace,
        gracePeriodSeconds: grace,
      });
      input.podLog.info('pod_killed');
      return;
    } catch (err) {
      if (isPodGoneError(err)) {
        // Already gone is the happy path — debug, not warn.
        input.podLog.debug('pod_already_gone');
        return;
      }
      const transient = isTransientApiError(err);
      const lastAttempt = attempt >= maxAttempts;
      if (transient && !lastAttempt) {
        const backoffMs = KILL_BACKOFF_MS[attempt - 1] ?? 1000;
        input.podLog.debug('pod_kill_retry', {
          attempt,
          maxAttempts,
          backoffMs,
          err: err instanceof Error ? err.message : String(err),
        });
        await sleep(backoffMs);
        continue;
      }
      // Permanent error, or transient but out of attempts: warn + rethrow.
      input.podLog.warn('pod_kill_failed', {
        attempt,
        transient,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
