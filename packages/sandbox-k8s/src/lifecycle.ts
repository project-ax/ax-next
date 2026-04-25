// ---------------------------------------------------------------------------
// Pod lifecycle — readiness wait + exit watch.
//
// Two concerns here, kept separate:
//
//   waitForPodReady  — poll readNamespacedPod until the Ready condition
//                      flips True (or the pod fails / times out).
//                      Returns the pod's resolved IP so the caller can
//                      build `runnerEndpoint`.
//
//   watchPodExit     — repeated readNamespacedPod calls until phase reaches
//                      a terminal state. Yields a structured exit reason
//                      that distinguishes container-level reasons (e.g.
//                      OOMKilled) from pod-level reasons (e.g. Evicted,
//                      DeadlineExceeded).
//
// Why polling instead of the k8s Watch API: polling is simpler to mock,
// resilient to apiserver disconnects, and the 250ms cadence is cheap
// against pod-create + image-pull latencies that are seconds-to-minutes.
// The legacy provider used Watch for this; we deliberately don't.
// ---------------------------------------------------------------------------

import { PluginError, type Logger } from '@ax/core';
import type { K8sCoreApi } from './k8s-api.js';

const PLUGIN_NAME = '@ax/sandbox-k8s';

interface ReadyResult {
  podIP: string;
}

interface PodLike {
  status?: {
    phase?: string;
    podIP?: string;
    reason?: string;
    message?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    containerStatuses?: Array<{
      name?: string;
      state?: {
        terminated?: {
          exitCode?: number;
          signal?: number;
          reason?: string;
          message?: string;
        };
      };
    }>;
  };
}

export interface WaitForPodReadyInput {
  api: K8sCoreApi;
  podName: string;
  namespace: string;
  pollIntervalMs: number;
  timeoutMs: number;
  podLog: Logger;
  /** Testable seam — defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Testable seam — defaults to Date.now. */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForPodReady(
  input: WaitForPodReadyInput,
): Promise<ReadyResult> {
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const deadline = now() + input.timeoutMs;

  for (;;) {
    let pod: PodLike;
    try {
      pod = (await input.api.readNamespacedPod({
        name: input.podName,
        namespace: input.namespace,
      })) as PodLike;
    } catch (err) {
      // Read failures are typically transient (apiserver flap). Bubble
      // up as host-unavailable-style errors only after the deadline.
      if (now() >= deadline) {
        throw new PluginError({
          code: 'pod-readiness-timeout',
          plugin: PLUGIN_NAME,
          hookName: 'sandbox:open-session',
          message: `pod ${input.podName} did not become Ready within ${input.timeoutMs}ms (last error: ${err instanceof Error ? err.message : String(err)})`,
          cause: err,
        });
      }
      input.podLog.debug('pod_read_transient_error', {
        err: err instanceof Error ? err.message : String(err),
      });
      await sleep(input.pollIntervalMs);
      continue;
    }

    const phase = pod.status?.phase;
    // Terminal-bad states: the pod is never going to be Ready. Surface
    // immediately so the orchestrator can roll back and tell the user.
    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new PluginError({
        code: 'pod-failed-before-ready',
        plugin: PLUGIN_NAME,
        hookName: 'sandbox:open-session',
        message: `pod ${input.podName} ended in phase=${phase} before Ready (reason=${pod.status?.reason ?? 'unknown'})`,
      });
    }

    const ready = pod.status?.conditions?.find((c) => c.type === 'Ready');
    if (ready?.status === 'True') {
      const podIP = pod.status?.podIP;
      if (typeof podIP !== 'string' || podIP.length === 0) {
        // Ready=True without an IP is a k8s race we've seen — the IP
        // gets populated within ~50ms. Loop one more cycle.
        input.podLog.debug('pod_ready_no_ip_yet');
      } else {
        input.podLog.info('pod_ready', { podIP });
        return { podIP };
      }
    }

    if (now() >= deadline) {
      throw new PluginError({
        code: 'pod-readiness-timeout',
        plugin: PLUGIN_NAME,
        hookName: 'sandbox:open-session',
        message: `pod ${input.podName} did not become Ready within ${input.timeoutMs}ms (last phase=${phase ?? 'unknown'})`,
      });
    }

    await sleep(input.pollIntervalMs);
  }
}

export interface ExitInfo {
  /** Container exit code if available, else null. */
  code: number | null;
  /** Process signal name (e.g. 'SIGTERM'), best-effort, else null. */
  signal: NodeJS.Signals | null;
  /**
   * Termination cause. Distinguishes container-level reasons (OOMKilled,
   * Error) from pod-level reasons (Evicted, DeadlineExceeded). Returns
   * the most specific one available, or 'unknown'.
   */
  reason: string;
}

export interface WatchPodExitInput {
  api: K8sCoreApi;
  podName: string;
  namespace: string;
  pollIntervalMs: number;
  podLog: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export async function watchPodExit(
  input: WatchPodExitInput,
): Promise<ExitInfo> {
  const sleep = input.sleep ?? defaultSleep;
  for (;;) {
    let pod: PodLike;
    try {
      pod = (await input.api.readNamespacedPod({
        name: input.podName,
        namespace: input.namespace,
      })) as PodLike;
    } catch (err) {
      // 404 means the pod is gone — counts as exit. We don't have an exit
      // code in that case; report unknown.
      if (
        typeof err === 'object' &&
        err !== null &&
        ((err as { code?: number }).code === 404 ||
          (err as { statusCode?: number }).statusCode === 404)
      ) {
        return { code: null, signal: null, reason: 'pod-gone' };
      }
      input.podLog.debug('pod_watch_transient_error', {
        err: err instanceof Error ? err.message : String(err),
      });
      await sleep(input.pollIntervalMs);
      continue;
    }

    const phase = pod.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') {
      const containerStatus = pod.status?.containerStatuses?.[0];
      const terminated = containerStatus?.state?.terminated;
      const containerReason = terminated?.reason;
      const podReason = pod.status?.reason;
      // Pod-level reason wins when present — it's the "useful" one for
      // operators (DeadlineExceeded, Evicted, etc.). Container-level
      // (OOMKilled, Error) is the fallback.
      const reason = podReason ?? containerReason ?? 'unknown';
      const code = terminated?.exitCode ?? null;
      // Translate raw signal numbers to names where we can. Most pod
      // exits report only an exitCode and we leave signal=null.
      const signalNum = terminated?.signal;
      const signal: NodeJS.Signals | null =
        typeof signalNum === 'number' && signalNum > 0
          ? (`SIG${signalNum}` as NodeJS.Signals)
          : null;
      input.podLog.info('pod_exited', {
        phase,
        code,
        reason,
        containerReason,
        podReason,
      });
      return { code, signal, reason };
    }

    await sleep(input.pollIntervalMs);
  }
}
