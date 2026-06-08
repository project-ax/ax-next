// ---------------------------------------------------------------------------
// Orphan-sweep — reclaim terminated runner pods a failed delete left behind.
//
// TASK-170. A warm runner pod that exits clean (idle-reap → exit 0 → phase
// `Succeeded`) is normally deleted by open-session's cleanup-on-exit. But that
// delete is best-effort (`.catch(() => undefined)` at both call sites), and if
// the managed apiserver briefly throttles (the observed GKE-Standard incident:
// `HTTP 500 ... code = Unavailable ... (memory-protection)`), the pod can be
// left ORPHANED forever — runner pods are bare Pods with NO ownerReference, so
// no controller or terminated-pod GC ever reclaims them. `killPod`'s bounded
// retry handles the brief blip; THIS periodic sweep is the belt-and-suspenders
// for the case where the retry still ultimately fails: a later sweep finds the
// stale terminal pod and deletes it, so the leak self-heals.
//
// SCOPE / SAFETY (I5): the list is scoped server-side to runner pods only
// (`app.kubernetes.io/component=ax-next-runner` — the label pod-spec.ts stamps),
// so the sweep can never see, let alone delete, the host pod or anything else
// in the namespace. It only ever deletes pods in a TERMINAL phase
// (Succeeded/Failed) older than `terminalAgeMs` — a Running/Pending pod, or a
// young just-finished one mid-teardown, is left alone. It uses the EXISTING
// `pods: list/delete` grant from the host Role; no new capability.
// ---------------------------------------------------------------------------

import { makeAgentContext, type Logger } from '@ax/core';
import type { K8sCoreApi } from './k8s-api.js';
import { killPod } from './kill.js';

/** The label selector pod-spec.ts stamps on every runner pod. Scopes the
 *  sweep so it can only ever touch runner pods (never the host). */
export const RUNNER_COMPONENT_SELECTOR =
  'app.kubernetes.io/component=ax-next-runner';

/** Phases a pod is never coming back from — safe to reap once aged. */
const TERMINAL_PHASES = new Set(['Succeeded', 'Failed']);

interface PodListItemLike {
  metadata?: { name?: string; creationTimestamp?: Date | string };
  status?: { phase?: string };
}
interface PodListLike {
  items?: PodListItemLike[];
}

export interface SweepOrphanedPodsInput {
  api: K8sCoreApi;
  namespace: string;
  /** Reap terminal pods whose age exceeds this. */
  terminalAgeMs: number;
  podLog: Logger;
  /** Testable clock seam — defaults to Date.now. */
  now?: () => number;
}

/**
 * One sweep pass: list runner pods, reap the stale terminal ones. Returns the
 * count actually deleted. Best-effort throughout — a list failure logs + returns
 * 0; a per-pod delete failure logs + is skipped (the next sweep retries it).
 * Never throws, so it's safe to fire from a timer.
 */
export async function sweepOrphanedPods(
  input: SweepOrphanedPodsInput,
): Promise<number> {
  const now = input.now ?? Date.now;
  let list: PodListLike;
  try {
    list = (await input.api.listNamespacedPod({
      namespace: input.namespace,
      labelSelector: RUNNER_COMPONENT_SELECTOR,
    })) as PodListLike;
  } catch (err) {
    input.podLog.warn('orphan_sweep_list_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  const items = list.items ?? [];
  const cutoff = now() - input.terminalAgeMs;
  let reaped = 0;

  for (const item of items) {
    const name = item.metadata?.name;
    const phase = item.status?.phase;
    if (name === undefined || phase === undefined) continue;
    if (!TERMINAL_PHASES.has(phase)) continue;

    const created = item.metadata?.creationTimestamp;
    const createdMs =
      created instanceof Date
        ? created.getTime()
        : typeof created === 'string'
          ? Date.parse(created)
          : NaN;
    // No usable creation time → we can't prove it's old, so leave it alone.
    if (!Number.isFinite(createdMs) || createdMs > cutoff) continue;

    try {
      await killPod({
        api: input.api,
        podName: name,
        namespace: input.namespace,
        podLog: input.podLog,
        // It's already terminal — no graceful drain needed.
        gracePeriodSeconds: 0,
      });
      reaped += 1;
      input.podLog.info('orphan_pod_reaped', { podName: name, phase });
    } catch (err) {
      // Best-effort: a transient/permanent failure on one pod must not abort
      // the rest of the sweep. The next pass retries it.
      input.podLog.warn('orphan_pod_reap_failed', {
        podName: name,
        phase,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (reaped > 0) {
    input.podLog.info('orphan_sweep_done', { reaped, scanned: items.length });
  }
  return reaped;
}

export interface OrphanSweeperHandle {
  /** Stop the periodic sweep: clears the timer and awaits any in-flight pass.
   *  Idempotent — a second call is a no-op. */
  stop(): Promise<void>;
}

export interface StartOrphanSweeperInput {
  api: K8sCoreApi;
  namespace: string;
  /** How often to sweep (ms). Must be > 0. */
  intervalMs: number;
  /** Reap terminal pods older than this (ms). */
  terminalAgeMs: number;
  /** Optional pre-bound logger; defaults to a system-context init logger. */
  podLog?: Logger;
}

/**
 * Start the periodic orphan-sweep. Mirrors the attachments janitor: run one
 * pass immediately, then schedule the rest via `setInterval`, `unref()` the
 * timer so it never keeps the process alive, and expose an idempotent `stop()`
 * that clears the timer and awaits any in-flight pass for a clean shutdown.
 */
export function startOrphanSweeper(
  input: StartOrphanSweeperInput,
): OrphanSweeperHandle {
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error(
      `sandbox-k8s orphan-sweeper intervalMs must be > 0 (got ${String(input.intervalMs)})`,
    );
  }

  const podLog =
    input.podLog ??
    makeAgentContext({
      sessionId: 'init',
      agentId: '@ax/sandbox-k8s',
      userId: 'system',
    }).logger;

  let inFlight: Promise<unknown> | null = null;
  let stopped = false;

  const runPass = (): Promise<unknown> => {
    if (stopped) return Promise.resolve();
    return sweepOrphanedPods({
      api: input.api,
      namespace: input.namespace,
      terminalAgeMs: input.terminalAgeMs,
      podLog,
    }).catch(() => undefined);
  };

  inFlight = runPass();

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = runPass();
  }, input.intervalMs);
  // Don't pin the Node process alive on this background timer.
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (inFlight) {
        await inFlight.catch(() => undefined);
      }
    },
  };
}
