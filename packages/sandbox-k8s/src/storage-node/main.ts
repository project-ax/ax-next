import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createStorageAuthority, type StorageKubeApi, type StorageObject } from './authority.js';
import { StorageNodeEngine } from './engine.js';
import { createStorageServer } from './server.js';
import { backingProfile } from './sources.js';

try { unlinkSync('/tmp/storage-ready'); } catch { /* No readiness until this instance listens. */ }

const required = (key: string) => {
  const value = process.env[key]; if (!value) throw new Error(`missing storage configuration: ${key}`); return value;
};
const { KubeConfig, CoreV1Api, CustomObjectsApi } = await import('@kubernetes/client-node');
const kc = new KubeConfig(); kc.loadFromCluster();
const pods = kc.makeApiClient(CoreV1Api), custom = kc.makeApiClient(CustomObjectsApi);
const namespace = required('AX_RUNNER_NAMESPACE');
const req = (plural: string, name: string) => ({ group: plural === 'sandboxes' ? 'agents.x-k8s.io' : 'extensions.agents.x-k8s.io',
  version: 'v1beta1', plural, namespace, name });
const api: StorageKubeApi = {
  readPod: async name => await pods.readNamespacedPod({ namespace, name }) as unknown as StorageObject,
  readClaim: async name => await custom.getNamespacedCustomObject(req('sandboxclaims', name)) as StorageObject,
  readSandbox: async name => await custom.getNamespacedCustomObject(req('sandboxes', name)) as StorageObject,
  async patchFinalizers(kind, name, body) {
    // The pinned SDK's first supported patch media type is JSON Patch.
    if (kind === 'pod') await pods.patchNamespacedPod({ namespace, name, body });
    else await custom.patchNamespacedCustomObject({ ...req('sandboxclaims', name), body });
  },
  async deletePod(name, uid) { await pods.deleteNamespacedPod({ namespace, name,
    body: { preconditions: { uid }, gracePeriodSeconds: 5 } }); },
};
const engine = new StorageNodeEngine({ kubeletPodsRoot: '/kubelet-pods', ledgerRoot: '/ledger',
  backingProfile: backingProfile({ userFiles: { server: required('AX_STORAGE_FILES_SERVER'), exportPath: required('AX_STORAGE_FILES_PATH') },
    ...(process.env.AX_STORAGE_MEMORY === '1' ? { memory: { server: required('AX_STORAGE_MEMORY_SERVER'), exportPath: required('AX_STORAGE_MEMORY_PATH') } } : {}) }),
  userFilesRoot: '/backing/files', ...(process.env.AX_STORAGE_MEMORY === '1' ? { memoryRoot: '/backing/memory' } : {}) },
createStorageAuthority(api, required('AX_NODE_NAME'), required('AX_POOL_PREFIX')));
const tlsRoot = '/tls';
const server = createStorageServer(engine, { ca: readFileSync(join(tlsRoot, 'ca.crt')),
  cert: readFileSync(join(tlsRoot, 'tls.crt')), key: readFileSync(join(tlsRoot, 'tls.key')) });
await engine.reconcile();
server.listen(9443, '0.0.0.0', () => writeFileSync('/tmp/storage-ready', 'ready', { mode: 0o600 }));
let reconciling = false;
const timer = setInterval(() => {
  if (reconciling) return;
  reconciling = true;
  void engine.reconcile().catch(() => process.stderr.write('storage recovery pending\n')).finally(() => { reconciling = false; });
}, 2000);
const close = () => { clearInterval(timer); try { unlinkSync('/tmp/storage-ready'); } catch { /* already removed */ }
  server.close(() => process.exit(0)); };
process.once('SIGTERM', close); process.once('SIGINT', close);
