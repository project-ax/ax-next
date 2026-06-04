// ---------------------------------------------------------------------------
// Config + defaults.
//
// Every field is optional in the user-facing shape EXCEPT `hostIpcUrl`,
// which is required — there's no useful default; the right value comes
// from the chart's host Service URL. Defaults for the rest live here in
// one place. Resolving early lets every other module take a fully-populated
// `ResolvedSandboxK8sConfig` and not deal with `??` everywhere.
// ---------------------------------------------------------------------------

import { PluginError } from '@ax/core';

export interface SandboxK8sConfig {
  /**
   * Cluster-internal URL the runner pods use to reach the host's IPC
   * listener (e.g. `http://ax-next-host.ax-next.svc.cluster.local:80`).
   * Required — there is no useful default. The preset reads this from
   * the chart's `host.ipcUrl` (or `AX_K8S_HOST_IPC_URL` env) and threads
   * it through to every runner pod via `AX_RUNNER_ENDPOINT`.
   */
  hostIpcUrl?: string;
  /** Namespace to create pods in. Default: 'ax-next'. */
  namespace?: string;
  /** Container image bundling both runners. Default: 'ax-next/agent:latest'. */
  image?: string;
  /**
   * RuntimeClassName. Default: 'gvisor'. Setting this to '' (empty
   * string) opts out of the userspace kernel and runs on the host kernel
   * directly — we warn loudly at plugin init when this happens. Operators
   * who know exactly what they're doing (single-tenant, trusted models)
   * may want this; everyone else should leave the default.
   */
  runtimeClassName?: string;
  /** Image-pull secrets for private registries. */
  imagePullSecrets?: string[];
  /** CPU limit for the runner container. Default: '1'. */
  cpuLimit?: string;
  /** Memory limit. Default: '1Gi'. */
  memoryLimit?: string;
  /** CPU request. Default: '100m'. */
  cpuRequest?: string;
  /** Memory request. Default: '256Mi'. */
  memoryRequest?: string;
  /** Hard wall-clock pod lifetime cap (seconds). Default 6 h (21600). With
   *  idle-keepalive a warm pod can live across many turns; this is the
   *  ceiling that bounds a continuously-active conversation and the rare
   *  host-crash-plus-wedged-runner orphan. Idle pods are reaped far sooner
   *  by the host idle timer / runner idle floor. */
  activeDeadlineSeconds?: number;
  /**
   * Pod-readiness poll interval (ms). Default: 250 ms. Tests override
   * to 1ms for speed. Production at 250ms keeps the kube-apiserver
   * load light without making the user wait noticeably.
   */
  readinessPollMs?: number;
  /**
   * Pod-readiness timeout (ms). Default: 60_000 ms (1 min). After this
   * we give up, throw a PluginError, and roll back the session. Most
   * pods are Ready in ~5s; a value above a minute usually means image
   * pull is failing — surfacing fast helps the operator notice.
   */
  readinessTimeoutMs?: number;
  /**
   * TASK-151 — per-SERVICE-sidecar CPU limit. Each declared `services[]`
   * descriptor renders as a native sidecar (`initContainers` +
   * `restartPolicy: Always`); this caps its CPU. Default: '1'. Resourcing is a
   * config default, NOT a descriptor field — the descriptor stays
   * backend-agnostic (I1).
   */
  serviceCpuLimit?: string;
  /** Per-service-sidecar memory limit. Default: '1Gi'. */
  serviceMemoryLimit?: string;
  /** Per-service-sidecar CPU request. Default: '100m'. */
  serviceCpuRequest?: string;
  /**
   * Per-service-sidecar memory REQUEST. Default: '512Mi'. Higher than the
   * runner's 256Mi floor because the canonical dev services (a JVM Kafka
   * broker, Mongo) want headroom to start.
   */
  serviceMemoryRequest?: string;
  /**
   * TASK-151 — per-service cold-start allowance (ms) added to the pod-readiness
   * budget for EACH declared service. Native sidecars start SEQUENTIALLY (each
   * gates the next via its startup probe), a JVM broker on a fresh gVisor node
   * pays a multi-hundred-MB image pull, and the JVM itself is slow to come up —
   * so the budget must scale with service count. Default: 120_000 (2 min/svc).
   * Applied by `computeReadinessBudgetMs`; service-less sessions keep the flat
   * `readinessTimeoutMs`.
   */
  perServiceColdStartMs?: number;
  /**
   * Node-filesystem path that backs `/var/run/ax` in BOTH the host pod
   * and every runner pod, so the credential-proxy's Unix socket and CA
   * certificate live in a directory readable from both sides.
   *
   * When set, every runner pod gets a `hostPath` volume at this node
   * path mounted at `/var/run/ax`, and the runner env carries the
   * proxy's socket path + the CA cert path so the SDK can reach the
   * credential-proxy and trust its MITM certs. When unset, runner pods
   * get NO proxy mount and crash at boot with "missing AX_PROXY_*" —
   * which is the intended posture for presets that don't load
   * `@ax/credential-proxy`.
   *
   * `hostPath` is a kind-only / single-node posture. Production deploys
   * should switch the credential-proxy to TCP listen mode and reach it
   * over a Service (the chart can grow a `credentialProxy.tcp` knob
   * once that lands). Documented in SECURITY.md.
   */
  proxySocketHostPath?: string;
}

export interface ResolvedSandboxK8sConfig {
  hostIpcUrl: string;
  namespace: string;
  image: string;
  runtimeClassName: string;
  imagePullSecrets?: string[];
  cpuLimit: string;
  memoryLimit: string;
  cpuRequest: string;
  memoryRequest: string;
  activeDeadlineSeconds: number;
  readinessPollMs: number;
  readinessTimeoutMs: number;
  serviceCpuLimit: string;
  serviceMemoryLimit: string;
  serviceCpuRequest: string;
  serviceMemoryRequest: string;
  perServiceColdStartMs: number;
  /** See SandboxK8sConfig.proxySocketHostPath. Empty = unset. */
  proxySocketHostPath: string;
}

export function resolveConfig(
  raw: SandboxK8sConfig = {},
): ResolvedSandboxK8sConfig {
  if (typeof raw.hostIpcUrl !== 'string' || raw.hostIpcUrl.length === 0) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: '@ax/sandbox-k8s',
      message:
        'k8s preset requires hostIpcUrl — set host.ipcUrl in your Helm values, or pass it via env (AX_K8S_HOST_IPC_URL)',
    });
  }
  const resolved: ResolvedSandboxK8sConfig = {
    hostIpcUrl: raw.hostIpcUrl,
    namespace: raw.namespace ?? 'ax-next',
    image: raw.image ?? 'ax-next/agent:latest',
    runtimeClassName: raw.runtimeClassName ?? 'gvisor',
    cpuLimit: raw.cpuLimit ?? '1',
    memoryLimit: raw.memoryLimit ?? '1Gi',
    cpuRequest: raw.cpuRequest ?? '100m',
    memoryRequest: raw.memoryRequest ?? '256Mi',
    activeDeadlineSeconds: raw.activeDeadlineSeconds ?? 21600,
    readinessPollMs: raw.readinessPollMs ?? 250,
    readinessTimeoutMs: raw.readinessTimeoutMs ?? 60_000,
    serviceCpuLimit: raw.serviceCpuLimit ?? '1',
    serviceMemoryLimit: raw.serviceMemoryLimit ?? '1Gi',
    serviceCpuRequest: raw.serviceCpuRequest ?? '100m',
    serviceMemoryRequest: raw.serviceMemoryRequest ?? '512Mi',
    perServiceColdStartMs: raw.perServiceColdStartMs ?? 120_000,
    proxySocketHostPath: raw.proxySocketHostPath ?? '',
  };
  if (raw.imagePullSecrets !== undefined) {
    resolved.imagePullSecrets = raw.imagePullSecrets;
  }
  return resolved;
}

/**
 * TASK-151 — pod-readiness budget policy. Native service sidecars start
 * SEQUENTIALLY and each pays JVM cold-start + image pull, so the flat
 * `readinessTimeoutMs` (tuned for a service-less runner that's Ready in ~5s)
 * would time out a perfectly healthy multi-service pod. This scales the budget
 * by service count.
 *
 * Pure + side-effect-free so it's unit-testable and callable from
 * `open-session.ts` where the per-session service count is in scope (the
 * resolved config has the policy CONSTANTS; the COUNT is a request quantity).
 *
 * `serviceCount <= 0` (no services, or a defensively-passed negative) returns
 * the base budget unchanged — service-less sessions keep their 60s.
 */
export function computeReadinessBudgetMs(args: {
  baseTimeoutMs: number;
  serviceCount: number;
  perServiceColdStartMs: number;
}): number {
  if (args.serviceCount <= 0) return args.baseTimeoutMs;
  return args.baseTimeoutMs + args.serviceCount * args.perServiceColdStartMs;
}
