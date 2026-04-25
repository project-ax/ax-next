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

export interface KillPodInput {
  api: K8sCoreApi;
  podName: string;
  namespace: string;
  /** Per-pod child logger pre-bound with reqId/podName/pid. */
  podLog: Logger;
  /** Defaults to 5 — kube gives the runner that long to flush before SIGKILL. */
  gracePeriodSeconds?: number;
}

export async function killPod(input: KillPodInput): Promise<void> {
  const grace = input.gracePeriodSeconds ?? 5;
  try {
    await input.api.deleteNamespacedPod({
      name: input.podName,
      namespace: input.namespace,
      gracePeriodSeconds: grace,
    });
    input.podLog.info('pod_killed');
  } catch (err) {
    if (isPodGoneError(err)) {
      // Already gone is the happy path — debug, not warn.
      input.podLog.debug('pod_already_gone');
      return;
    }
    input.podLog.warn('pod_kill_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
