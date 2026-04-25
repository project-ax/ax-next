// ---------------------------------------------------------------------------
// Config + defaults.
//
// Every field is optional in the user-facing shape; defaults live here in
// one place. Resolving early lets every other module take a fully-populated
// `ResolvedSandboxK8sConfig` and not deal with `??` everywhere.
// ---------------------------------------------------------------------------

export interface SandboxK8sConfig {
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
  /**
   * Hard deadline. The kubelet kills the pod after this even if the host
   * crashes and loses its in-memory timers. Default: 3600 seconds (1h).
   */
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
}

export interface ResolvedSandboxK8sConfig {
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
}

export function resolveConfig(
  raw: SandboxK8sConfig = {},
): ResolvedSandboxK8sConfig {
  const resolved: ResolvedSandboxK8sConfig = {
    namespace: raw.namespace ?? 'ax-next',
    image: raw.image ?? 'ax-next/agent:latest',
    runtimeClassName: raw.runtimeClassName ?? 'gvisor',
    cpuLimit: raw.cpuLimit ?? '1',
    memoryLimit: raw.memoryLimit ?? '1Gi',
    cpuRequest: raw.cpuRequest ?? '100m',
    memoryRequest: raw.memoryRequest ?? '256Mi',
    activeDeadlineSeconds: raw.activeDeadlineSeconds ?? 3600,
    readinessPollMs: raw.readinessPollMs ?? 250,
    readinessTimeoutMs: raw.readinessTimeoutMs ?? 60_000,
  };
  if (raw.imagePullSecrets !== undefined) {
    resolved.imagePullSecrets = raw.imagePullSecrets;
  }
  return resolved;
}
