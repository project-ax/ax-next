import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createStorageClient } from '../storage-client.js';
import { CHANGE_SHARED_REQUEST_MAX_BYTES } from '../storage-node/protocol.js';
import type { SharedPoolConfig } from '../config.js';
import { makeMockK8sApi } from './mock-k8s.js';
const state = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(() => Buffer.from('fixture-tls')) }));
vi.mock('node:https', () => ({ request: state.request }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), readFileSync: state.read }));
const config: SharedPoolConfig = { replicas: 1, prefix: 'pool', storageNamespace: 'storage', tlsDirectory: '/tls',
  serverName: 'storage.storage.svc', runnerBinaries: { 'claude-sdk': '/runner.js' }, userFiles: { server: '10.0.0.9', exportPath: '/files' } };
const helper = (nodeName = 'node', podIP = '10.0.0.3', ready = 'True') => ({ spec: { nodeName }, status: { phase: 'Running', podIP,
  conditions: [{ type: 'Ready', status: ready }] } });
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
describe('storage client: shared-folder changes (W3c)', () => {
  const change = { folderId: 'sf_a', changes: [{ op: 'write' as const, path: 'a.md', content: 'aGk=' }] };
  it('sends to a Ready helper on ANY node, with the same TLS verification', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [
      helper('node-a', '10.0.0.1', 'False'), helper('node-b', '10.0.0.2'), helper('node-c', '10.0.0.4'),
      { ...helper('node-d', '10.0.0.5'), metadata: { deletionTimestamp: 'now' } }] });
    transport('{"kind":"done","results":[{"path":"a.md","outcome":"created"}]}');
    const client = createStorageClient(api, config, count => count - 1);
    expect(await client.changeShared(change)).toEqual({ kind: 'done', results: [{ path: 'a.md', outcome: 'created' }] });
    expect(state.request).toHaveBeenLastCalledWith(expect.objectContaining({ hostname: '10.0.0.4', port: 9443,
      path: '/change-shared', servername: 'storage.storage.svc', rejectUnauthorized: true, minVersion: 'TLSv1.3', agent: false }),
    expect.any(Function));
    const sent = vi.mocked(state.request).mock.results.at(-1)!.value as { end: ReturnType<typeof vi.fn> };
    expect(JSON.parse(sent.end.mock.calls[0]![0] as string)).toEqual(change);
  });
  it('picks a random Ready helper by default', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper('a', '10.0.0.1'), helper('b', '10.0.0.2')] });
    transport('{"kind":"done","results":[]}');
    await createStorageClient(api, config).changeShared(change);
    expect(['10.0.0.1', '10.0.0.2']).toContain((vi.mocked(state.request).mock.lastCall![0] as { hostname: string }).hostname);
  });
  it('fails when no helper is Ready, sending nothing', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper('a', '10.0.0.1', 'False')] });
    state.request.mockClear();
    await expect(createStorageClient(api, config).changeShared(change)).rejects.toThrow('unavailable');
    expect(state.request).not.toHaveBeenCalled();
  });
  it('passes a refusal through and rejects a malformed reply', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper()] });
    transport('{"kind":"refused","refused":"not-empty","results":[]}');
    expect(await createStorageClient(api, config).changeShared(change)).toEqual({ kind: 'refused', refused: 'not-empty', results: [] });
    for (const body of ['{"accepted":true}', '{"kind":"done","results":[{"path":"a","outcome":"moved"}]}',
      '{"kind":"refused","refused":"/etc/passwd","results":[]}']) {
      transport(body);
      await expect(createStorageClient(api, config).changeShared(change)).rejects.toThrow('storage response invalid');
    }
  });
  it('accepts a reply above the 4 KiB assignment cap (64 results), not one above its own cap', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper()] });
    const results = Array.from({ length: 64 }, (_, i) => ({ path: `${'p'.repeat(200)}${i}`, outcome: 'created' }));
    transport(JSON.stringify({ kind: 'done', results }));
    expect((await createStorageClient(api, config).changeShared(change)).results).toHaveLength(64);
    transport(JSON.stringify({ kind: 'done', results: [{ path: 'x'.repeat(300 * 1024), outcome: 'created' }] }));
    await expect(createStorageClient(api, config).changeShared(change)).rejects.toThrow(/storage response/);
  });
  // Review, 2026-10-18: a real `res.destroy()` with no error emits neither
  // 'error' nor 'end', so an oversize reply used to hang until the request
  // timeout (55 s) instead of failing at once.
  it('rejects an oversize reply at once, even when destroy() is silent', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper()] });
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn(), end: vi.fn() });
    state.request.mockImplementation((_options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      req.end.mockImplementation(() => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200, destroy: vi.fn() });
        callback(res); res.emit('data', Buffer.alloc(300 * 1024));
      }); return req;
    });
    await expect(createStorageClient(api, config).changeShared(change)).rejects.toThrow('storage response too large');
    expect(req.destroy).toHaveBeenCalled();
  });
  it('refuses a request over the route cap before connecting', async () => {
    const api = makeMockK8sApi(); vi.spyOn(api, 'listNamespacedPod').mockResolvedValue({ items: [helper()] });
    state.request.mockClear();
    const content = 'A'.repeat(CHANGE_SHARED_REQUEST_MAX_BYTES);
    await expect(createStorageClient(api, config).changeShared({ folderId: 'sf_a', changes: [{ op: 'write', path: 'a', content }] }))
      .rejects.toThrow('too large');
    expect(state.request).not.toHaveBeenCalled();
  });
});
