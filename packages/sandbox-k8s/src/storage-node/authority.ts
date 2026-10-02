import { setTimeout } from 'node:timers/promises';
import type { StorageAuthority } from './engine.js';
import { CLAIM_AGENT_LABEL, CLAIM_POOL_LABEL, STANDBY_LABEL, LATE_VOLUME, STORAGE_FINALIZER,
  type StorageAssignment, type StorageIdentity, type StorageRecord } from './protocol.js';

interface ObjectMeta {
  name?: string; uid?: string; resourceVersion?: string; deletionTimestamp?: string;
  finalizers?: string[]; labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: { apiVersion?: string; kind?: string; uid?: string; name?: string; controller?: boolean }[];
}
export interface StorageObject {
  metadata?: ObjectMeta; spec?: { nodeName?: string; runtimeClassName?: string; warmPoolRef?: { name?: string };
    volumes?: { name?: string; emptyDir?: { medium?: string } }[];
    lifecycle?: { shutdownTime?: string } };
  status?: { phase?: string; containerStatuses?: { state?: { terminated?: unknown } }[];
    initContainerStatuses?: { state?: { terminated?: unknown }; restartCount?: number }[];
    sandbox?: { name?: string } };
}
export interface StorageKubeApi {
  readPod(name: string): Promise<StorageObject>;
  readClaim(name: string): Promise<StorageObject>;
  readSandbox(name: string): Promise<StorageObject>;
  patchFinalizers(kind: 'pod' | 'claim', name: string, patch: unknown[]): Promise<void>;
  deletePod(name: string, uid: string): Promise<void>;
}
export function isNotFound(e: unknown): boolean {
  const x = e as { code?: number; statusCode?: number };
  return x?.code === 404 || x?.statusCode === 404;
}
const terminal = (pod: StorageObject) => ['Succeeded', 'Failed'].includes(pod.status?.phase ?? '') ||
  ((pod.status?.containerStatuses?.length ?? 0) > 0 &&
    pod.status!.containerStatuses!.every(s => s.state?.terminated) &&
    (pod.status?.initContainerStatuses ?? []).every(s => s.state?.terminated));
const expired = (claim: StorageObject) => {
  const deadline = Date.parse(claim.spec?.lifecycle?.shutdownTime ?? '');
  return !Number.isFinite(deadline) || deadline <= Date.now();
};

/** The node helper derives authority from the live owner chain, never a caller path. */
export function createStorageAuthority(api: StorageKubeApi, nodeName: string, poolPrefix: string): StorageAuthority {
  async function observed(identity: StorageIdentity) {
    const [pod, claim, sandbox] = await Promise.all([
      api.readPod(identity.podName), api.readClaim(identity.claimName), api.readSandbox(identity.sandboxName),
    ]);
    if (pod.metadata?.uid !== identity.podUid || claim.metadata?.uid !== identity.claimUid ||
        sandbox.metadata?.uid !== identity.sandboxUid || pod.spec?.nodeName !== nodeName ||
        pod.spec?.runtimeClassName !== 'gvisor' ||
        !pod.spec.volumes?.some(v => v.name === LATE_VOLUME && v.emptyDir?.medium === 'Memory') ||
        pod.metadata.labels?.[STANDBY_LABEL] !== poolPrefix ||
        pod.metadata.annotations?.[`dev.gvisor.empty-dir.${LATE_VOLUME}.force-shared`] !== 'true' ||
        !claim.spec?.warmPoolRef?.name?.startsWith(`${poolPrefix}-`) ||
        claim.metadata.labels?.[CLAIM_POOL_LABEL] !== claim.spec.warmPoolRef.name ||
        claim.status?.sandbox?.name !== identity.sandboxName ||
        !pod.metadata.ownerReferences?.some(o => o.controller && o.kind === 'Sandbox' &&
          o.apiVersion?.startsWith('agents.x-k8s.io/') && o.uid === identity.sandboxUid && o.name === identity.sandboxName) ||
        !sandbox.metadata.ownerReferences?.some(o => o.controller && o.kind === 'SandboxClaim' &&
          o.apiVersion?.startsWith('extensions.agents.x-k8s.io/') && o.uid === identity.claimUid && o.name === identity.claimName)) throw new Error('storage ownership invalid');
    return { pod, claim, sandbox };
  }
  async function finalizer(kind: 'pod' | 'claim', name: string, uid: string, add: boolean) {
    const read = kind === 'pod' ? api.readPod : api.readClaim;
    for (let attempt = 0; attempt < 5; attempt++) {
      let object;
      try { object = await read.call(api, name); }
      catch (e) { if (!add && isNotFound(e)) return; throw e; }
      if (object.metadata?.uid !== uid) { if (!add) return; throw new Error('storage object replaced'); }
      const old = object.metadata.finalizers ?? [];
      const next = add ? [...new Set([...old, STORAGE_FINALIZER])] : old.filter(v => v !== STORAGE_FINALIZER);
      if (old.length === next.length) return;
      try {
        await api.patchFinalizers(kind, name, [
          { op: 'test', path: '/metadata/uid', value: uid },
          { op: 'test', path: '/metadata/resourceVersion', value: object.metadata.resourceVersion },
          { op: 'add', path: '/metadata/finalizers', value: next },
        ]); return;
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code !== 409 && code !== 422) throw e;
      }
    }
    throw new Error('storage finalizer update conflicted');
  }
  return {
    async authorize(input: StorageAssignment) {
      const { pod, claim, sandbox } = await observed(input);
      if (pod.metadata?.deletionTimestamp || claim.metadata?.deletionTimestamp || sandbox.metadata?.deletionTimestamp ||
          terminal(pod) || expired(claim) || claim.metadata?.labels?.[CLAIM_AGENT_LABEL] !== input.agentId) {
        throw new Error('storage assignment is no longer active');
      }
    },
    async protect(input) {
      await observed(input);
      await finalizer('claim', input.claimName, input.claimUid, true);
      await finalizer('pod', input.podName, input.podUid, true);
    },
    async stop(input) {
      let pod;
      try { pod = await api.readPod(input.podName); } catch (e) { if (isNotFound(e)) return; throw e; }
      if (pod.metadata?.uid !== input.podUid) return;
      await api.deletePod(input.podName, input.podUid).catch(e => { if (!isNotFound(e)) throw e; });
      const deadline = Date.now() + 90_000;
      for (;;) {
        try { pod = await api.readPod(input.podName); } catch (e) { if (isNotFound(e)) return; throw e; }
        if (pod.metadata?.uid !== input.podUid || terminal(pod)) return;
        if (Date.now() >= deadline) throw new Error('storage quiescence timed out');
        await setTimeout(100);
      }
    },
    async finish(input) {
      await finalizer('pod', input.podName, input.podUid, false);
      await finalizer('claim', input.claimName, input.claimUid, false);
    },
    async abandoned(record: StorageRecord) {
      try {
        const { pod, claim, sandbox } = await observed(record);
        return !!(pod.metadata?.deletionTimestamp || claim.metadata?.deletionTimestamp || sandbox.metadata?.deletionTimestamp || terminal(pod) || expired(claim));
      } catch (e) { if (isNotFound(e) || (e as Error).message === 'storage ownership invalid') return true; throw e; }
    },
  };
}
