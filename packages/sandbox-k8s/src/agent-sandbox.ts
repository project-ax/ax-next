import { PluginError } from '@ax/core';
import type { ResolvedSandboxK8sConfig } from './config.js';
import type { K8sCoreApi, PodReadRequest } from './k8s-api.js';
import type { PodSpec } from './pod-spec.js';

const GROUP = 'agents.x-k8s.io';
const PLURAL = 'sandboxes';
export const SANDBOX_BACKEND_LABEL = 'ax.io/sandbox-backend';
export const SANDBOX_SELECTOR = `${SANDBOX_BACKEND_LABEL}=agent-sandbox`;
export const GKE_SANDBOX_NODE_PLACEMENT = {
  nodeSelector: { 'sandbox.gke.io/runtime': 'gvisor' },
  tolerations: [{ key: 'sandbox.gke.io/runtime', operator: 'Equal', value: 'gvisor', effect: 'NoSchedule' }],
};

interface CustomRequest {
  group: string;
  version: string;
  plural: string;
  namespace: string;
}

/** No discovery, cluster-scoped access, patch, exec, or template/claim permissions. */
export interface SandboxCustomApi {
  createNamespacedCustomObject(req: CustomRequest & { body: unknown }): Promise<unknown>;
  getNamespacedCustomObject(req: CustomRequest & { name: string }): Promise<unknown>;
  listNamespacedCustomObject(req: CustomRequest & { labelSelector: string; limit?: number }): Promise<unknown>;
  deleteNamespacedCustomObject(req: CustomRequest & {
    name: string;
    body: { propagationPolicy: 'Foreground'; preconditions: { uid: string } };
  }): Promise<unknown>;
}

interface Metadata {
  name?: string;
  uid?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  ownerReferences?: Array<{ apiVersion?: string; kind?: string; name?: string; uid?: string; controller?: boolean }>;
}
interface SandboxObject {
  metadata?: Metadata;
}
interface ObservedPod {
  metadata?: Metadata;
  status?: Record<string, unknown>;
}

function failed(reason: string): ObservedPod {
  return { status: { phase: 'Failed', reason } };
}

function notFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } } | null;
  return e?.code === 404 || e?.statusCode === 404 || e?.response?.statusCode === 404;
}

/** Convert our existing locked Pod spec without changing any hook or runner wire. */
export function buildSandboxResource(pod: PodSpec, config: ResolvedSandboxK8sConfig, now = Date.now()) {
  const sandboxPodSpec: Record<string, unknown> = {
    ...pod.spec,
    securityContext: { ...(pod.spec.securityContext as object | undefined), runAsNonRoot: true },
    // GKE's admission policy requires explicit sandbox-node selection.
    ...GKE_SANDBOX_NODE_PLACEMENT,
  };
  return {
    apiVersion: `${GROUP}/${config.agentSandboxApiVersion}`,
    kind: 'Sandbox',
    metadata: {
      name: pod.metadata.name,
      namespace: pod.metadata.namespace,
      labels: { ...pod.metadata.labels, [SANDBOX_BACKEND_LABEL]: 'agent-sandbox' },
    },
    spec: {
      // The runner connects OUT to AX; no router or extra inbound Service is needed.
      service: false,
      shutdownTime: new Date(now + config.activeDeadlineSeconds * 1000).toISOString(),
      shutdownPolicy: 'Delete',
      podTemplate: {
        metadata: { labels: { ...pod.metadata.labels, [SANDBOX_BACKEND_LABEL]: 'agent-sandbox' } },
        spec: sandboxPodSpec,
      },
    },
  };
}

/**
 * Internal lifecycle adapter, used ONLY for agent sessions and their sweeper.
 * Auxiliary read/reclaim/ownership pods use the original CoreV1 API.
 * Deletion always targets the Sandbox, never just its controller-owned Pod.
 * UID pins detect resource replacement and prevent deleting a same-name successor.
 */
export function createAgentSandboxSessionApi(
  pods: K8sCoreApi,
  custom: SandboxCustomApi,
  config: ResolvedSandboxK8sConfig,
): K8sCoreApi {
  const sandboxUids = new Map<string, string>();
  const podUids = new Map<string, string>();
  const request = (namespace: string): CustomRequest => {
    if (namespace !== config.namespace) throw new Error('Agent Sandbox namespace differs from configured runner namespace');
    return { group: GROUP, version: config.agentSandboxApiVersion, plural: PLURAL, namespace };
  };
  const key = (req: PodReadRequest) => `${req.namespace}/${req.name}`;

  async function read(req: PodReadRequest): Promise<ObservedPod> {
    let sandbox: SandboxObject;
    try {
      sandbox = await custom.getNamespacedCustomObject({ ...request(req.namespace), name: req.name }) as SandboxObject;
    } catch (err) {
      if (notFound(err)) {
        sandboxUids.delete(key(req));
        podUids.delete(key(req));
        return failed('sandbox-gone');
      }
      throw err;
    }
    const uid = sandbox.metadata?.uid;
    if (!uid || sandbox.metadata?.labels?.[SANDBOX_BACKEND_LABEL] !== 'agent-sandbox') {
      return failed('sandbox-ownership-invalid');
    }
    const pinnedUid = sandboxUids.get(key(req));
    if (pinnedUid !== undefined && pinnedUid !== uid) return failed('sandbox-replaced');
    if (sandbox.metadata?.deletionTimestamp) return failed('sandbox-deleting');
    sandboxUids.set(key(req), uid);

    let pod: ObservedPod;
    try {
      // Fresh Sandbox resources use the resource name as their Pod name.
      // No warm-pool adoption or pod-name annotation is supported in this stage.
      pod = await pods.readNamespacedPod(req) as ObservedPod;
    } catch (err) {
      if (!notFound(err)) throw err;
      return podUids.has(key(req)) ? failed('sandbox-pod-gone') : { status: { phase: 'Pending' } };
    }
    const owned = pod.metadata?.ownerReferences?.some((owner) =>
      owner.controller === true && owner.kind === 'Sandbox' &&
      owner.apiVersion?.startsWith(`${GROUP}/`) &&
      owner.uid === uid && owner.name === req.name);
    if (!owned || !pod.metadata?.uid) return failed('sandbox-pod-ownership-invalid');
    const pinnedPod = podUids.get(key(req));
    if (pinnedPod !== undefined && pinnedPod !== pod.metadata.uid) return failed('sandbox-pod-replaced');
    podUids.set(key(req), pod.metadata.uid);
    return pod;
  }

  return {
    async createNamespacedPod(req) {
      const pod = req.body as PodSpec;
      if (pod.metadata.namespace !== req.namespace) throw new Error('Sandbox Pod namespace mismatch');
      const result = await custom.createNamespacedCustomObject({
        ...request(req.namespace), body: buildSandboxResource(pod, config),
      }) as SandboxObject;
      const uid = result.metadata?.uid;
      if (!uid) throw new PluginError({ code: 'sandbox-invalid-response', plugin: '@ax/sandbox-k8s', message: 'Agent Sandbox create returned no resource UID' });
      sandboxUids.set(key({ namespace: req.namespace, name: pod.metadata.name }), uid);
      return result;
    },
    readNamespacedPod: read,
    async readNamespacedPodLog(req) {
      const pod = await read(req);
      if (pod.status?.phase === 'Failed' && !pod.metadata) throw new Error('Sandbox Pod ownership changed');
      return pods.readNamespacedPodLog(req);
    },
    async deleteNamespacedPod(req) {
      // The sweeper pins the UID through read(); active sessions pin it at create.
      const uid = sandboxUids.get(key(req));
      if (!uid) return; // Already deleted by the other idempotent cleanup path.
      const result = await custom.deleteNamespacedCustomObject({
        ...request(req.namespace), name: req.name,
        body: { propagationPolicy: 'Foreground', preconditions: { uid } },
      });
      sandboxUids.delete(key(req));
      podUids.delete(key(req));
      return result;
    },
    async listNamespacedPod(req) {
      const list = await custom.listNamespacedCustomObject({
        ...request(req.namespace), labelSelector: SANDBOX_SELECTOR,
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
      }) as { items?: SandboxObject[] };
      const items: ObservedPod[] = [];
      for (const sandbox of list.items ?? []) {
        const name = sandbox.metadata?.name;
        const uid = sandbox.metadata?.uid;
        if (!name || !uid || sandbox.metadata?.labels?.[SANDBOX_BACKEND_LABEL] !== 'agent-sandbox') continue;
        const reqKey = key({ namespace: req.namespace, name });
        const pinned = sandboxUids.get(reqKey);
        if (pinned !== undefined && pinned !== uid) continue;
        sandboxUids.set(reqKey, uid);
        const pod = await read({ namespace: req.namespace, name });
        items.push({ ...pod, metadata: { name,
          ...(sandbox.metadata?.creationTimestamp !== undefined
            ? { creationTimestamp: sandbox.metadata.creationTimestamp } : {}) } });
      }
      return { items };
    },
  };
}
