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
   * over a Service (set `proxyEndpoint` instead). Documented in SECURITY.md.
   *
   * Mutually exclusive with `proxyEndpoint` — `resolveConfig` rejects both.
   */
  proxySocketHostPath?: string;
  /**
   * Cluster-reachable URL of the credential-proxy's TCP listener, fronted
   * by a k8s Service (e.g.
   * `http://ax-next-proxy.ax-next.svc.cluster.local:8888`). This is the
   * production-gVisor posture (GKE Sandbox bans `hostPath`).
   *
   * When set, runner pods get NO `proxy-socket` hostPath mount; instead
   * pod-spec stamps the proxy endpoint (`AX_PROXY_ENDPOINT` / `HTTPS_PROXY`)
   * from the per-session `proxyConfig.endpoint` and delivers the MITM CA
   * cert as an `AX_PROXY_CA_PEM` env var (the runner writes it to a tmpfs
   * path at boot — the host can't write into the runner pod without a
   * shared dir). The CA cert is a public key, safe inside the sandbox (I1).
   *
   * Mutually exclusive with `proxySocketHostPath` — `resolveConfig` rejects
   * both. Empty = unset.
   */
  proxyEndpoint?: string;
  /**
   * TASK-170 — how often (ms) the orphan-sweep runs. The sweep reclaims
   * terminated runner pods (Succeeded/Failed) that a transient-failed delete
   * left behind — runner pods have no ownerReference, so nothing else GCs them.
   * Default 300_000 (5 min). Set <= 0 to DISABLE the sweeper entirely (tests, or
   * a deployment that reaps pods some other way).
   */
  orphanSweepIntervalMs?: number;
  /**
   * TASK-170 — minimum age (ms) a terminal runner pod must reach before the
   * orphan-sweep deletes it. Generously past a normal teardown (5 s grace +
   * a couple of killPod retries) so we never race the legitimate
   * cleanup-on-exit path. Default 600_000 (10 min).
   */
  orphanSweepTerminalAgeMs?: number;
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
  /** See SandboxK8sConfig.proxyEndpoint. Empty = unset. */
  proxyEndpoint: string;
  /** See SandboxK8sConfig.orphanSweepIntervalMs. <= 0 disables the sweeper. */
  orphanSweepIntervalMs: number;
  /** See SandboxK8sConfig.orphanSweepTerminalAgeMs. */
  orphanSweepTerminalAgeMs: number;
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
  // I9 — the proxy transport is hostPath (Unix socket) XOR TCP (Service URL).
  // Both set is a wiring bug: pod-spec would key the mode off an ambiguous
  // signal. Fail loud at resolve time so the operator fixes the chart values
  // rather than booting a runner that can't reach the proxy.
  const hasHostPath =
    typeof raw.proxySocketHostPath === 'string' && raw.proxySocketHostPath.length > 0;
  const hasEndpoint =
    typeof raw.proxyEndpoint === 'string' && raw.proxyEndpoint.length > 0;
  if (hasHostPath && hasEndpoint) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: '@ax/sandbox-k8s',
      message:
        'exactly one of proxySocketHostPath (hostPath/Unix socket) or proxyEndpoint (TCP Service) may be set — they are mutually exclusive proxy transports',
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
    proxyEndpoint: raw.proxyEndpoint ?? '',
    orphanSweepIntervalMs: raw.orphanSweepIntervalMs ?? 300_000,
    orphanSweepTerminalAgeMs: raw.orphanSweepTerminalAgeMs ?? 600_000,
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
