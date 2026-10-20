import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createStorageClient } from '../storage-client.js';
import type { SharedPoolConfig } from '../config.js';
import { makeMockK8sApi } from './mock-k8s.js';
const state = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(() => Buffer.from('fixture-tls')) }));
vi.mock('node:https', () => ({ request: state.request }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), readFileSync: state.read }));
const config: SharedPoolConfig = { replicas: 1, prefix: 'pool', storageNamespace: 'storage', tlsDirectory: '/tls',
  serverName: 'storage.storage.svc', runnerBinaries: { 'claude-sdk': '/runner.js' }, userFiles: { server: '10.0.0.9', exportPath: '/files' } };
const helper = (nodeName = 'node') => ({ spec: { nodeName }, status: { phase: 'Running', podIP: '10.0.0.3',
  conditions: [{ type: 'Ready', status: 'True' }] } });
const identity = { podName: 'pod', podUid: 'pod-uid', claimName: 'claim', claimUid: 'claim-uid', sandboxName: 'sandbox', sandboxUid: 'sandbox-uid' };
function transport(body: string) {
  state.request.mockImplementation((_options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn(), end: vi.fn() });
    req.end.mockImplementation(() => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200, destroy() { this.emit('error', new Error('oversize')); } });
      callback(res); res.emit('data', Buffer.from(body)); res.emit('end');
    }); return req;
  });
}
describe('authenticated storage client', () => {
  it('uses the only ready helper on the assigned node with fixed TLS verification and no proxy agent', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper(), helper('other-node')] });
    transport('{"accepted":true}'); const client = createStorageClient(api, config);
    expect(await client.status('node', identity)).toEqual({ accepted: true });
    expect(state.request).toHaveBeenLastCalledWith(expect.objectContaining({ hostname: '10.0.0.3', port: 9443,
      servername: 'storage.storage.svc', rejectUnauthorized: true, minVersion: 'TLSv1.3', agent: false,
      method: 'POST', path: '/status', ca: Buffer.from('fixture-tls'), cert: Buffer.from('fixture-tls'), key: Buffer.from('fixture-tls') }), expect.any(Function));
    expect(api.listNamespacedPod).toHaveBeenCalledWith({ namespace: 'storage', labelSelector: 'ax.io/storage-helper=pool' });
  });
  it('refuses ambiguous helpers instead of sending credentials to an arbitrary Pod', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper(), helper()] });
    state.request.mockClear(); const client = createStorageClient(api, config);
    await expect(client.status('node', identity)).rejects.toThrow('unavailable'); expect(state.request).not.toHaveBeenCalled();
  });
  it.each(['{"accepted":"false"}', 'null', '[]', 'not-json', 'x'.repeat(4097)])('rejects a malformed or oversized receipt', async body => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper()] });
    transport(body); const client = createStorageClient(api, config);
    await expect(client.status('node', identity)).rejects.toThrow(/storage response/);
  });
});
