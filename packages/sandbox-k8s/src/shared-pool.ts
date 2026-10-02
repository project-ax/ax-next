import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { BootstrapAssignmentSchema, BOOTSTRAP_MAX_BYTES } from '@ax/sandbox-protocol';
import { buildPodSpec, type PodSpec } from './pod-spec.js';
import { GKE_SANDBOX_NODE_PLACEMENT, type SandboxCustomApi } from './agent-sandbox.js';
import type { K8sCoreApi, PodReadRequest } from './k8s-api.js';
import type { ResolvedSandboxK8sConfig } from './config.js';
import type { StorageClient } from './storage-client.js';
import { CLAIM_AGENT_LABEL, CLAIM_POOL_LABEL, STANDBY_LABEL, LATE_VOLUME, type StorageIdentity } from './storage-node/protocol.js';
import { isNotFound } from './storage-node/authority.js';
import { sourceParts, backingProfile } from './storage-node/sources.js';

interface Resource {
  metadata?: { name?: string; uid?: string; deletionTimestamp?: string; creationTimestamp?: string; labels?: Record<string, string>;
    ownerReferences?: { kind?: string; uid?: string; name?: string; controller?: boolean }[] };
  spec?: { nodeName?: string }; status?: { sandbox?: { name?: string }; podName?: string; phase?: string };
}
interface RunnerContainer { name: string; args: string[]; env: { name: string; value?: string; valueFrom?: unknown }[];
  command?: string[]; envFrom?: unknown[]; securityContext: Record<string, unknown>;
  volumeMounts: { name: string; mountPath: string; subPath?: string; readOnly?: boolean; mountPropagation?: string }[] }
const extension = (namespace: string, plural: string) => ({ group: 'extensions.agents.x-k8s.io', version: 'v1beta1', namespace, plural });

/** A class contains execution settings only. Agent ids and credentials never enter its hash or template. */
export function buildSharedTemplate(config: ResolvedSandboxK8sConfig, runnerBinary: string) {
  const pool = config.sharedPool!;
  const pod = buildPodSpec('standby', { sessionId: 'unused', authToken: 'unused', workspaceRoot: '/agent',
    runnerBinary, runnerEndpoint: config.hostIpcUrl }, config);
  delete pod.metadata.labels['ax.io/session-id'];
  pod.metadata.labels[STANDBY_LABEL] = pool.prefix;
  const containers = pod.spec.containers as RunnerContainer[];
  const runner = containers[0]!;
  for (const container of [...containers, ...pod.spec.initContainers as RunnerContainer[]]) {
    container.securityContext = { ...container.securityContext, privileged: false, procMount: 'Default',
      seccompProfile: { type: 'RuntimeDefault' } };
  }
  runner.env = [{ name: 'AX_STANDBY', value: '1' }, { name: 'AX_INSTANCE_ID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
    { name: 'HOME', value: '/home/runner' }];
  runner.volumeMounts.push({ name: LATE_VOLUME, mountPath: '/ax/late', mountPropagation: 'HostToContainer' });
  // Kubelet recursively removes a disk emptyDir's contents before rmdir.
  // Its tmpfs teardown unmounts the root first, so active child bind mounts
  // block removal until the storage helper has flushed and detached them.
  (pod.spec.volumes as unknown[]).push({ name: LATE_VOLUME, emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } });
  delete pod.spec.activeDeadlineSeconds;
  Object.assign(pod.spec, { hostPID: false, hostIPC: false, shareProcessNamespace: false, enableServiceLinks: false });
  const podTemplate = { metadata: { labels: pod.metadata.labels,
    annotations: { [`dev.gvisor.empty-dir.${LATE_VOLUME}.force-shared`]: 'true' } },
    spec: { ...pod.spec, ...GKE_SANDBOX_NODE_PLACEMENT, securityContext: { runAsNonRoot: true, fsGroup: 1000 } } };
  const hash = createHash('sha256').update(JSON.stringify({ podTemplate, replicas: pool.replicas })).digest('hex').slice(0, 16);
  const name = `${pool.prefix}-${hash}`;
  return { name, resource: { apiVersion: 'extensions.agents.x-k8s.io/v1beta1', kind: 'SandboxTemplate',
    metadata: { name, namespace: config.namespace, labels: { 'ax.io/pool-owner': pool.prefix } }, spec: { service: false, envVarsInjectionPolicy: 'Disallowed',
      networkPolicyManagement: 'Unmanaged', podTemplate } } };
}

export async function createSharedPoolSessionApi(pods: K8sCoreApi, custom: SandboxCustomApi,
  direct: K8sCoreApi, storage: StorageClient, config: ResolvedSandboxK8sConfig): Promise<K8sCoreApi> {
  const pool = config.sharedPool!;
  const classes = new Map<string, string>();
  const contains = (actual: unknown, expected: unknown): boolean => {
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => contains(actual[i], v));
    if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object' &&
      Object.entries(expected).every(([k, v]) => contains((actual as Record<string, unknown>)[k], v));
    return actual === expected;
  };
  async function ensure(plural: string, name: string, body: unknown) {
    try { await custom.createNamespacedCustomObject({ ...extension(config.namespace, plural), body }); }
    catch (e) { if ((e as { code?: number }).code !== 409) throw e;
      const existing = await custom.getNamespacedCustomObject({ ...extension(config.namespace, plural), name }) as {
        metadata?: { labels?: Record<string, string> }; spec?: { podTemplate?: { spec?: { containers?: RunnerContainer[]; initContainers?: RunnerContainer[] } } };
      };
      if (existing.metadata?.labels?.['ax.io/pool-owner'] !== pool.prefix || !contains(existing.spec, (body as { spec: unknown }).spec)) {
        throw new Error('existing shared pool configuration differs');
      }
      if (plural === 'sandboxtemplates') {
        const spec = existing.spec?.podTemplate?.spec;
        if (spec?.containers?.some(c => c.command !== undefined || c.envFrom !== undefined) ||
            spec?.initContainers?.some(c => c.envFrom !== undefined) ||
            [...spec?.containers ?? [], ...spec?.initContainers ?? []].some(c =>
              (c.securityContext?.capabilities as { add?: unknown } | undefined)?.add !== undefined)) {
          throw new Error('existing shared template adds process capabilities');
        }
      }
    }
  }
  for (const binary of Object.values(pool.runnerBinaries)) {
    const template = buildSharedTemplate(config, binary);
    await ensure('sandboxtemplates', template.name, template.resource);
    await ensure('sandboxwarmpools', template.name, { apiVersion: 'extensions.agents.x-k8s.io/v1beta1', kind: 'SandboxWarmPool',
      metadata: { name: template.name, namespace: config.namespace, labels: { 'ax.io/pool-owner': pool.prefix } },
      spec: { replicas: pool.replicas, sandboxTemplateRef: { name: template.name }, updateStrategy: { type: 'OnReplenish' } } });
    classes.set(binary, template.name);
  }
  // Retire standbys from old image/capacity classes. Assigned Sandboxes are
  // claim-owned already, so this never deletes an active conversation.
  for (const plural of ['sandboxwarmpools', 'sandboxtemplates']) {
    const old = await custom.listNamespacedCustomObject({ ...extension(config.namespace, plural),
      labelSelector: `ax.io/pool-owner=${pool.prefix}` }) as { items?: Resource[] };
    for (const resource of old.items ?? []) {
      const name = resource.metadata?.name, uid = resource.metadata?.uid;
      if (name && uid && ![...classes.values()].includes(name) && resource.metadata?.labels?.['ax.io/pool-owner'] === pool.prefix) {
        await custom.deleteNamespacedCustomObject({ ...extension(config.namespace, plural), name,
          body: { propagationPolicy: 'Foreground', preconditions: { uid } } });
      }
    }
  }
  const live = new Map<string, StorageIdentity & { node: string }>();
  const key = (req: PodReadRequest) => `${req.namespace}/${req.name}`;
  const claimReq = (name: string) => ({ ...extension(config.namespace, 'sandboxclaims'), name });
  const sandboxReq = (name: string) => ({ group: 'agents.x-k8s.io', version: 'v1beta1', plural: 'sandboxes', namespace: config.namespace, name });
  async function identity(name: string, uid: string, requireRunning = true): Promise<(StorageIdentity & { node: string }) | undefined> {
    const claim = await custom.getNamespacedCustomObject(claimReq(name)) as Resource;
    if (claim.metadata?.uid !== uid || claim.metadata.deletionTimestamp) throw new Error('shared claim replaced or deleted');
    const sandboxName = claim.status?.sandbox?.name; if (!sandboxName) return;
    let sandbox: Resource;
    try { sandbox = await custom.getNamespacedCustomObject(sandboxReq(sandboxName)) as Resource; }
    catch (e) { if (isNotFound(e)) return; throw e; }
    if (!sandbox.metadata?.uid || !sandbox.metadata.ownerReferences?.some(o => o.controller && o.kind === 'SandboxClaim' && o.uid === uid)) {
      throw new Error('shared sandbox ownership invalid');
    }
    // Adopted pods keep their original standby name; never assume claim == pod name.
    const list = await pods.listNamespacedPod({ namespace: config.namespace,
      labelSelector: 'app.kubernetes.io/component=ax-next-runner' }) as { items?: Resource[] };
    const owned = (list.items ?? []).filter(p => p.metadata?.ownerReferences?.some(o =>
      o.controller && o.kind === 'Sandbox' && o.uid === sandbox.metadata!.uid));
    if (owned.length === 0) return;
    if (owned.length !== 1 || !owned[0]!.metadata?.name) throw new Error('shared pod ownership invalid');
    const pod = owned[0]!, podName = pod.metadata!.name!;
    if (!pod.metadata?.uid || !pod.metadata.ownerReferences?.some(o => o.controller && o.kind === 'Sandbox' && o.uid === sandbox.metadata!.uid)) {
      throw new Error('shared pod ownership invalid');
    }
    if (!pod.spec?.nodeName || (requireRunning && pod.status?.phase !== 'Running')) return;
    return { claimName: name, claimUid: uid, sandboxName, sandboxUid: sandbox.metadata.uid, podName,
      podUid: pod.metadata.uid, node: pod.spec.nodeName };
  }
  async function read(req: PodReadRequest): Promise<unknown> {
    const assigned = live.get(key(req)); if (!assigned) return direct.readNamespacedPod(req);
    try {
      const current = await identity(req.name, assigned.claimUid, false);
      if (!current || current.podUid !== assigned.podUid || current.sandboxUid !== assigned.sandboxUid) throw new Error('shared pod replaced');
      const pod = await pods.readNamespacedPod({ namespace: req.namespace, name: assigned.podName }) as Resource;
      if (pod.metadata?.uid !== assigned.podUid || !pod.metadata.ownerReferences?.some(o =>
        o.controller && o.kind === 'Sandbox' && o.uid === assigned.sandboxUid)) throw new Error('shared pod replaced');
      return pod;
    } catch (e) { if (isNotFound(e) || (e as Error).message.startsWith('shared ')) return { status: { phase: 'Failed', reason: 'shared-instance-gone' } }; throw e; }
  }
  return {
    async createNamespacedPod(req) {
      if (req.namespace !== config.namespace) throw new Error('shared session namespace mismatch');
      const pod = req.body as PodSpec; const runner = (pod.spec.containers as RunnerContainer[])[0]!;
      const className = classes.get(runner.args[1]!);
      // Service classes remain the existing cold backend. The caller prepares their NFS mount first.
      if (!className || (pod.spec.initContainers as { restartPolicy?: string }[]).some(c => c.restartPolicy === 'Always')) {
        return direct.createNamespacedPod(req);
      }
      const env = Object.fromEntries(runner.env.filter(e => e.name !== 'AX_RUNNER_BINARY').map(e => [e.name, e.value!]));
      const nfs = pod.spec.volumes as { name: string; nfs?: { server: string; path: string } }[];
      const roles: ('user-files' | 'memory')[] = [];
      const agentId = pod.metadata.labels[CLAIM_AGENT_LABEL];
      for (const mount of runner.volumeMounts.filter(m => m.subPath)) {
        const role = mount.mountPath === '/files' ? 'user-files' : mount.mountPath === '/memory' ? 'memory' : undefined;
        const source = nfs.find(v => v.name === mount.name)?.nfs;
        const expected = role === 'user-files' ? pool.userFiles : role === 'memory' ? pool.memory : undefined;
        if (!role || !source || !expected || source.server !== expected.server || source.path !== expected.exportPath ||
            (role === 'memory' && mount.readOnly !== true) || !agentId ||
            sourceParts(agentId, role).join('/') !== mount.subPath) throw new Error('shared storage configuration differs from mount resolver');
        roles.push(role);
      }
      if (!agentId) throw new Error('shared session requires an agent storage identity');
      // Validate before creating any resources; raw schema errors must never contain credentials.
      const draft = BootstrapAssignmentSchema.safeParse({ version: 1, assignmentId: randomUUID(), instanceId: 'pending',
        expiresAt: Date.now() + config.readinessTimeoutMs, env });
      if (!draft.success || Buffer.byteLength(JSON.stringify(draft.data)) > BOOTSTRAP_MAX_BYTES) throw new Error('shared bootstrap configuration invalid');
      const name = pod.metadata.name;
      const claim = await custom.createNamespacedCustomObject({ ...extension(req.namespace, 'sandboxclaims'), body: {
        apiVersion: 'extensions.agents.x-k8s.io/v1beta1', kind: 'SandboxClaim', metadata: { name, namespace: req.namespace,
          labels: { [CLAIM_POOL_LABEL]: className, [CLAIM_AGENT_LABEL]: agentId } },
        spec: { warmPoolRef: { name: className }, lifecycle: { shutdownTime: new Date(Date.now() + config.activeDeadlineSeconds * 1000).toISOString(),
          shutdownPolicy: 'DeleteForeground' } },
      } }) as Resource;
      if (!claim.metadata?.uid) throw new Error('shared claim response invalid');
      let assigned;
      try {
        const deadline = Date.now() + config.readinessTimeoutMs;
        while (!(assigned = await identity(name, claim.metadata.uid))) {
          if (Date.now() >= deadline) throw new Error('shared claim timed out'); await setTimeout(config.readinessPollMs);
        }
        live.set(key({ namespace: req.namespace, name }), assigned);
        const { node, ...id } = assigned;
        await storage.assign(node, { ...id, agentId, roles, backingProfile: backingProfile(pool),
          bootstrap: { ...draft.data, instanceId: id.podUid } });
        while (!(await storage.status(node, id)).accepted) {
          if (Date.now() >= deadline) throw new Error('shared activation timed out'); await setTimeout(config.readinessPollMs);
        }
        return claim;
      } catch {
        if (assigned) { const { node, ...id } = assigned; await storage.release(node, id).catch(() => undefined); }
        await custom.deleteNamespacedCustomObject({ ...claimReq(name), body: { propagationPolicy: 'Foreground', preconditions: { uid: claim.metadata.uid } } }).catch(() => undefined);
        throw new Error('shared session activation failed');
      }
    },
    readNamespacedPod: read,
    async readNamespacedPodLog(req) { const assigned = live.get(key(req)); if (!assigned) return direct.readNamespacedPodLog(req);
      const pod = await read(req) as Resource;
      if (pod.metadata?.uid !== assigned.podUid) throw new Error('shared pod ownership changed');
      return pods.readNamespacedPodLog({ ...req, name: assigned.podName }); },
    async deleteNamespacedPod(req) {
      const assigned = live.get(key(req)); if (!assigned) return direct.deleteNamespacedPod(req);
      const { node, ...id } = assigned;
      await storage.release(node, id);
      await custom.deleteNamespacedCustomObject({ ...claimReq(req.name), body: { propagationPolicy: 'Foreground', preconditions: { uid: assigned.claimUid } } }).catch(e => { if (!isNotFound(e)) throw e; });
      live.delete(key(req));
    },
    async listNamespacedPod(req) {
      const cold = await direct.listNamespacedPod(req) as { items: unknown[] };
      const claims = await custom.listNamespacedCustomObject({ ...extension(req.namespace, 'sandboxclaims'), labelSelector: CLAIM_POOL_LABEL }) as { items?: Resource[] };
      for (const claim of claims.items ?? []) {
        if (!claim.metadata?.uid || !claim.metadata.name) continue;
        const assigned = await identity(claim.metadata.name, claim.metadata.uid, false).catch(() => undefined);
        if (assigned) { live.set(key({ namespace: req.namespace, name: claim.metadata.name }), assigned);
          const pod = await read({ namespace: req.namespace, name: claim.metadata.name }) as Resource;
          cold.items.push({ ...pod, metadata: { ...pod.metadata, name: claim.metadata.name } }); }
      }
      return cold;
    },
  };
}
