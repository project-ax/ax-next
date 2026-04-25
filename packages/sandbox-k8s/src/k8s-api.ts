// ---------------------------------------------------------------------------
// k8s-api — narrow facade over @kubernetes/client-node.
//
// We don't import the full CoreV1Api type into our public surface. Instead
// we define a structural interface with just the four methods we use:
//
//   - createNamespacedPod
//   - readNamespacedPod  (used by the readiness poller)
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

/**
 * The bits of CoreV1Api we use. CoreV1Api implements this structurally;
 * tests can hand-roll a stub.
 */
export interface K8sCoreApi {
  createNamespacedPod(req: PodCreateRequest): Promise<unknown>;
  readNamespacedPod(req: PodReadRequest): Promise<unknown>;
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
