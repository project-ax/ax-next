// ---------------------------------------------------------------------------
// k8s-api — narrow facade over @kubernetes/client-node.
//
// We don't import the full CoreV1Api type into our public surface. Instead
// we define a structural interface with just the methods we use:
//
//   - createNamespacedPod
//   - readNamespacedPod      (used by the readiness poller)
//   - readNamespacedPodLog   (TASK-160: bounded sidecar log tail for the
//                             self-diagnosing failure surface)
//   - deleteNamespacedPod
//   - listNamespacedPod  (used by isAvailable, today only via tests)
//
// Why narrow:
//   - Tests pass in a hand-rolled mock with just these methods. No need to
//     stub 600 unused k8s API surfaces.
//   - The plugin doesn't lock to the @kubernetes/client-node major. If
//     v2 breaks an unrelated method, we don't have to bump our types.
//   - Documents what the plugin is actually allowed to do against the
//     k8s API (I5: capabilities explicit and minimized).
//
// At runtime the real implementation comes from CoreV1Api, which has these
// methods with compatible signatures. The shape is expressed as `unknown`
// for the big k8s structs (V1Pod, V1Status, etc.) to keep this interface
// dep-free; the call sites narrow as needed.
// ---------------------------------------------------------------------------

export interface PodCreateRequest {
  namespace: string;
  body: unknown;
}

export interface PodReadRequest {
  name: string;
  namespace: string;
}

export interface PodDeleteRequest {
  name: string;
  namespace: string;
  gracePeriodSeconds?: number;
}

export interface PodListRequest {
  namespace: string;
  limit?: number;
}

export interface PodLogRequest {
  name: string;
  namespace: string;
  /** Which container's log to read (a service sidecar is `svc-<name>`). */
  container: string;
  /** Bound the captured output — only the last N lines (TASK-160). */
  tailLines?: number;
  /** Read the PREVIOUS terminated instance's log (set for a crashlooped
   *  container whose current attempt hasn't logged yet). */
  previous?: boolean;
}

/**
 * The bits of CoreV1Api we use. CoreV1Api implements this structurally;
 * tests can hand-roll a stub.
 */
export interface K8sCoreApi {
  createNamespacedPod(req: PodCreateRequest): Promise<unknown>;
  readNamespacedPod(req: PodReadRequest): Promise<unknown>;
  /**
   * Read a container's log (bounded by `tailLines`). CoreV1Api implements
   * this structurally; the bundled RBAC already grants `pods/log` (read-only).
   * Returns the log as a string. TASK-160 — the only consumer is the
   * service-sidecar failure diagnoser, which captures a small tail of an
   * UNTRUSTED service image's log to extract the offending writablePath.
   */
  readNamespacedPodLog(req: PodLogRequest): Promise<string>;
  deleteNamespacedPod(req: PodDeleteRequest): Promise<unknown>;
  listNamespacedPod(req: PodListRequest): Promise<unknown>;
}

/**
 * Build a real K8sCoreApi against either an in-cluster service account or
 * the developer's local kubeconfig. We try in-cluster first because the
 * common production deployment is the host running INSIDE k8s. Falling
 * back to ~/.kube/config covers local dev (`kubectl config current-context`).
 *
 * I5 surface to think about: this is the line where the host process gets
 * a token capable of creating pods. It is the single broadest capability
 * grant in this slice — the cluster RBAC bound to the service account
 * (or kubeconfig user) decides exactly what we can do. The bundled k8s
 * RBAC manifest (Task 19) is what locks this down to "create/get/delete
 * pods in our namespace, nothing else."
 */
export async function createDefaultK8sApi(): Promise<K8sCoreApi> {
  // Lazy-import so packages that pull in @ax/sandbox-k8s only for typing
  // don't pay the @kubernetes/client-node cold-start cost.
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    // Local-dev path: kubeconfig from $KUBECONFIG / ~/.kube/config /
    // the in-cluster service account file. loadFromDefault throws on
    // misconfigured env — let it propagate; a misconfigured host should
    // crash loud at boot, not silently fall back to no-cluster.
    kc.loadFromDefault();
  }
  return kc.makeApiClient(k8s.CoreV1Api) as unknown as K8sCoreApi;
}
