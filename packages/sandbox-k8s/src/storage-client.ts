import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { K8sCoreApi } from './k8s-api.js';
import type { SharedPoolConfig } from './config.js';
import { STORAGE_REQUEST_MAX_BYTES } from './storage-node/engine.js';
import { CHANGE_SHARED_REQUEST_MAX_BYTES, CHANGE_SHARED_RESPONSE_MAX_BYTES, ChangeSharedResponseSchema,
  type ChangeSharedResponse, type ChangeSharedWireRequest, type StorageAssignment, type StorageIdentity } from './storage-node/protocol.js';

export interface StorageClient {
  assign(node: string, input: StorageAssignment): Promise<void>;
  status(node: string, input: StorageIdentity): Promise<{ accepted: boolean }>;
  release(node: string, input: StorageIdentity): Promise<void>;
  /**
   * W3c — write into one shared folder through ANY Ready helper. Not
   * node-scoped: every helper mounts the same user-files export, so the node
   * a helper runs on doesn't matter.
   */
  changeShared(input: ChangeSharedWireRequest): Promise<ChangeSharedResponse>;
}
type HelperPod = {
  metadata?: { deletionTimestamp?: string }; spec?: { nodeName?: string };
  status?: { podIP?: string; phase?: string; conditions?: { type?: string; status?: string }[] };
};
export function createStorageClient(api: K8sCoreApi, config: SharedPoolConfig,
  pick: (count: number) => number = count => Math.floor(Math.random() * count)): StorageClient {
  const tls = { ca: readFileSync(join(config.tlsDirectory, 'ca.crt')),
    cert: readFileSync(join(config.tlsDirectory, 'tls.crt')), key: readFileSync(join(config.tlsDirectory, 'tls.key')) };
  async function readyHelpers(): Promise<HelperPod[]> {
    const list = await api.listNamespacedPod({ namespace: config.storageNamespace,
      labelSelector: `ax.io/storage-helper=${config.prefix}` }) as { items?: HelperPod[] };
    return (list.items ?? []).filter(p => !p.metadata?.deletionTimestamp &&
      p.status?.phase === 'Running' && p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
  }
  function post(podIP: string, route: string, body: string, responseMax: number, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: podIP, port: 9443, path: route, method: 'POST',
        servername: config.serverName, ...tls, rejectUnauthorized: true, minVersion: 'TLSv1.3',
        agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        let bytes = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > responseMax) res.destroy(); else chunks.push(chunk); });
        res.on('error', () => reject(new Error('storage response failed')));
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error('storage operation rejected')); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('storage response invalid')); }
        });
      });
      req.on('error', () => reject(new Error('storage connection failed')));
      req.setTimeout(timeoutMs, () => req.destroy()); req.end(body);
    });
  }
  async function call(node: string, route: string, input: unknown): Promise<{ accepted: boolean }> {
    const eligible = (await readyHelpers()).filter(p => p.spec?.nodeName === node);
    if (eligible.length !== 1 || !eligible[0]!.status?.podIP) throw new Error('storage node is unavailable');
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > STORAGE_REQUEST_MAX_BYTES) throw new Error('storage request too large');
    const parsed = await post(eligible[0]!.status!.podIP!, route, body, 4096, 120_000);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        (route === '/status' && typeof (parsed as { accepted?: unknown }).accepted !== 'boolean')) throw new Error('storage response invalid');
    return parsed as { accepted: boolean };
  }
  return { async assign(node, input) { await call(node, '/assign', input); },
    status: (node, input) => call(node, '/status', input),
    async release(node, input) { await call(node, '/release', input); },
    async changeShared(input) {
      const ready = (await readyHelpers()).filter(p => !!p.status?.podIP);
      if (ready.length === 0) throw new Error('storage node is unavailable');
      const helper = ready[Math.min(ready.length - 1, Math.max(0, pick(ready.length)))]!;
      const body = JSON.stringify(input);
      if (Buffer.byteLength(body) > CHANGE_SHARED_REQUEST_MAX_BYTES) throw new Error('storage request too large');
      // Under the hook's 60 s budget; the node may still finish a write after we give up.
      const parsed = ChangeSharedResponseSchema.safeParse(
        await post(helper.status!.podIP!, '/change-shared', body, CHANGE_SHARED_RESPONSE_MAX_BYTES, 55_000));
      if (!parsed.success) throw new Error('storage response invalid');
      return parsed.data;
    } };
}
