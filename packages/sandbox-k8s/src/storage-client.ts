import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { K8sCoreApi } from './k8s-api.js';
import type { SharedPoolConfig } from './config.js';
import { STORAGE_REQUEST_MAX_BYTES } from './storage-node/engine.js';
import type { StorageAssignment, StorageIdentity } from './storage-node/protocol.js';

export interface StorageClient {
  assign(node: string, input: StorageAssignment): Promise<void>;
  status(node: string, input: StorageIdentity): Promise<{ accepted: boolean }>;
  release(node: string, input: StorageIdentity): Promise<void>;
}
export function createStorageClient(api: K8sCoreApi, config: SharedPoolConfig): StorageClient {
  const tls = { ca: readFileSync(join(config.tlsDirectory, 'ca.crt')),
    cert: readFileSync(join(config.tlsDirectory, 'tls.crt')), key: readFileSync(join(config.tlsDirectory, 'tls.key')) };
  async function call(node: string, route: string, input: unknown): Promise<{ accepted: boolean }> {
    const list = await api.listNamespacedPod({ namespace: config.storageNamespace,
      labelSelector: `ax.io/storage-helper=${config.prefix}` }) as { items?: Array<{
        metadata?: { deletionTimestamp?: string }; spec?: { nodeName?: string };
        status?: { podIP?: string; phase?: string; conditions?: { type?: string; status?: string }[] };
      }> };
    const eligible = (list.items ?? []).filter(p => p.spec?.nodeName === node && !p.metadata?.deletionTimestamp &&
      p.status?.phase === 'Running' && p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
    if (eligible.length !== 1 || !eligible[0]!.status?.podIP) throw new Error('storage node is unavailable');
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > STORAGE_REQUEST_MAX_BYTES) throw new Error('storage request too large');
    return new Promise((resolve, reject) => {
      const req = request({ hostname: eligible[0]!.status!.podIP!, port: 9443, path: route, method: 'POST',
        servername: config.serverName, ...tls, rejectUnauthorized: true, minVersion: 'TLSv1.3',
        agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        let bytes = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) res.destroy(); else chunks.push(chunk); });
        res.on('error', () => reject(new Error('storage response failed')));
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error('storage operation rejected')); return; }
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
                (route === '/status' && typeof (parsed as { accepted?: unknown }).accepted !== 'boolean')) throw new Error('invalid response');
            resolve(parsed as { accepted: boolean });
          }
          catch { reject(new Error('storage response invalid')); }
        });
      });
      req.on('error', () => reject(new Error('storage connection failed')));
      req.setTimeout(120_000, () => req.destroy()); req.end(body);
    });
  }
  return { async assign(node, input) { await call(node, '/assign', input); },
    status: (node, input) => call(node, '/status', input),
    async release(node, input) { await call(node, '/release', input); } };
}
