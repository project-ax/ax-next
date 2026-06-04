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
import {
  extractWritablePathFromLog,
  type ServiceStartupDiagnosis,
} from '@ax/sandbox-protocol';
import type { K8sCoreApi } from './k8s-api.js';

const PLUGIN_NAME = '@ax/sandbox-k8s';

/** Prefix every service-sidecar container carries in the pod (pod-spec.ts). */
const SERVICE_SIDECAR_PREFIX = 'svc-';
/** Bound the captured sidecar log tail (TASK-160 — untrusted output). */
const SIDECAR_LOG_TAIL_LINES = 20;

interface ReadyResult {
  podIP: string;
}

interface InitContainerStatusLike {
  name?: string;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: {
      exitCode?: number;
      signal?: number;
      reason?: string;
      message?: string;
    };
  };
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
    // TASK-151 service sidecars render as native initContainers; TASK-160
    // reads their status to self-diagnose a startup failure.
    initContainerStatuses?: InitContainerStatusLike[];
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

// ---------------------------------------------------------------------------
// diagnoseServiceSidecars (TASK-160) — make a failed dev-service sidecar
// SELF-DIAGNOSING.
//
// A declared dev service (TASK-151) renders as a native sidecar — an
// `initContainers[]` entry named `svc-<name>` with `restartPolicy: Always`. If
// it crashes on startup (commonly EROFS because a dir it writes isn't in
// `writablePaths`), the pod never reaches Ready, so `waitForPodReady` times out
// with a generic message. This inspects `initContainerStatuses[]` for the
// offending `svc-*` sidecar and pulls a BOUNDED tail of its log to extract the
// path it couldn't write. Returns a backend-agnostic diagnosis (no pod /
// initContainer / exit-code vocab leaks out).
//
// SECURITY: the sidecar log is UNTRUSTED (arbitrary connector image). We cap it
// to `tailLines` at the apiserver, and `extractWritablePathFromLog` scans for a
// fixed set of shapes and extracts only an absolute-path token — it never
// echoes the raw log. Best-effort: any failure here returns undefined so the
// caller falls back to the original (generic) error.
// ---------------------------------------------------------------------------

export interface DiagnoseServiceSidecarsInput {
  api: K8sCoreApi;
  pod: PodLike;
  podName: string;
  namespace: string;
  podLog: Logger;
}

/** Is this init-container status a failed/failing service sidecar? */
function isFailingSidecar(s: InitContainerStatusLike): boolean {
  const name = s.name ?? '';
  if (!name.startsWith(SERVICE_SIDECAR_PREFIX)) return false;
  const waitingReason = s.state?.waiting?.reason;
  // A crashlooping sidecar sits in `waiting` with CrashLoopBackOff / Error.
  if (
    waitingReason === 'CrashLoopBackOff' ||
    waitingReason === 'Error' ||
    waitingReason === 'RunContainerError'
  ) {
    return true;
  }
  // Or it terminated with a non-zero exit code.
  const term = s.state?.terminated;
  if (term !== undefined && typeof term.exitCode === 'number' && term.exitCode !== 0) {
    return true;
  }
  return false;
}

export async function diagnoseServiceSidecars(
  input: DiagnoseServiceSidecarsInput,
): Promise<ServiceStartupDiagnosis | undefined> {
  try {
    const statuses = input.pod.status?.initContainerStatuses ?? [];
    const failing = statuses.find(isFailingSidecar);
    if (failing === undefined) return undefined;

    const container = failing.name ?? '';
    const service = container.slice(SERVICE_SIDECAR_PREFIX.length);

    // PRIMARY source — the kubelet-captured termination/waiting message. With
    // `terminationMessagePolicy: FallbackToLogsOnError` on the sidecar (set in
    // pod-spec.ts) the kubelet copies the crashed container's log tail into
    // `state.terminated.message` — so we get the EROFS line WITHOUT the host
    // needing the `pods/log` API capability. `waiting.message` is the analogous
    // hint for a container stuck before it ever ran. Both are bounded by the
    // kubelet (terminationMessage is capped, ~4 KiB).
    const statusMessage =
      failing.state?.terminated?.message ?? failing.state?.waiting?.message ?? '';

    let tail = statusMessage;
    // FALLBACK — only when the status message yielded nothing useful do we read
    // a bounded log tail via the API (needs the `pods/log` grant; best-effort, a
    // 403 on a cluster that withholds it leaves us with status-only). A
    // crashlooped container's CURRENT attempt may not have logged yet, so try
    // the PREVIOUS terminated instance first, then the current log.
    const probe = extractWritablePathFromLog(statusMessage);
    if (probe.path === undefined) {
      try {
        tail = await input.api.readNamespacedPodLog({
          name: input.podName,
          namespace: input.namespace,
          container,
          tailLines: SIDECAR_LOG_TAIL_LINES,
          previous: true,
        });
      } catch {
        try {
          tail = await input.api.readNamespacedPodLog({
            name: input.podName,
            namespace: input.namespace,
            container,
            tailLines: SIDECAR_LOG_TAIL_LINES,
          });
        } catch {
          // No log access (e.g. pods/log withheld) — keep the status message.
          tail = statusMessage;
        }
      }
    }

    const { path, reason } = extractWritablePathFromLog(
      typeof tail === 'string' ? tail : '',
    );
    input.podLog.info('service_sidecar_failed', {
      service,
      // Operator-facing structured log — the offending path + reason only,
      // never the raw tail.
      ...(path !== undefined ? { path } : {}),
      reason,
    });
    return path !== undefined ? { service, path, reason } : { service, reason };
  } catch (err) {
    input.podLog.debug('service_sidecar_diagnose_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
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
