import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createSandboxK8sPlugin } from '../plugin.js';
import { createSessionStatus } from '../session-status.js';
import { resolveConfig } from '../config.js';
import type { K8sCoreApi } from '../k8s-api.js';
import type { SandboxCustomApi } from '../agent-sandbox.js';
import { CLAIM_POOL_LABEL, SESSION_ID_ANNOTATION } from '../storage-node/protocol.js';
import { makeMockK8sApi } from './mock-k8s.js';
const pod = (sessionId = 'session', phase = 'Running') => ({ spec: { containers: [{ env: [{ name: 'AX_SESSION_ID', value: sessionId }] }] }, status: { phase } });
function fixture(items: unknown[] = []) {
  const listNamespacedPod = vi.fn(async () => ({ items }));
  const api = { listNamespacedPod } as unknown as K8sCoreApi;
  const custom = { listNamespacedCustomObject: vi.fn(async () => ({ items: [] as unknown[] })) };
  const config = resolveConfig({ namespace: 'runners', hostIpcUrl: 'http://host:8080' });
  return { listNamespacedPod, api, custom, config, run: createSessionStatus(api, custom as unknown as SandboxCustomApi, config) };
}
describe('authoritative session resource observations', () => {
  it.each(['Running', 'Pending'])('keeps a %s execution reserved', async phase => {
    const f = fixture([pod('session', phase)]);
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'running' });
  });
  it.each(['Succeeded', 'Failed'])('recognizes a %s runner without trusting a session label', async phase => {
    const f = fixture([{ ...pod('different'), metadata: { labels: { 'ax.io/session-id': 'session' } } }, pod('session', phase)]);
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'stopped' });
  });
  it('proves absence only from a complete successful observation', async () => {
    const f = fixture([pod('different')]);
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'stopped' });
    expect(f.listNamespacedPod).toHaveBeenCalledWith({ namespace: 'runners', labelSelector: 'app.kubernetes.io/component=ax-next-runner' });
    f.listNamespacedPod.mockRejectedValueOnce(new Error('PRIVATE infrastructure'));
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'unknown' });
    f.listNamespacedPod.mockResolvedValueOnce({ items: [{}] });
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'unknown' });
  });
  it('keeps controller intent reserved before its runner appears', async () => {
    const f = fixture(); f.config.backend = 'agent-sandbox';
    f.custom.listNamespacedCustomObject.mockResolvedValueOnce({ items: [{ metadata: {}, spec: { podTemplate: pod() } }] });
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'unknown' });
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'stopped' });
  });
  it('keeps live and legacy pooled claims reserved, then recognizes their removal', async () => {
    const f = fixture(); f.config.sharedPool = { prefix: 'pool' } as NonNullable<typeof f.config.sharedPool>;
    const claim = { metadata: { labels: { [CLAIM_POOL_LABEL]: 'pool-class' }, annotations: { [SESSION_ID_ANNOTATION]: 'session' } } };
    f.custom.listNamespacedCustomObject.mockResolvedValueOnce({ items: [claim] });
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'running' });
    f.custom.listNamespacedCustomObject.mockResolvedValueOnce({ items: [{ metadata: { labels: claim.metadata.labels } }] });
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'unknown' });
    expect(await f.run({}, { sessionId: 'session' })).toEqual({ state: 'stopped' });
  });
  it('registers a reachable hook on the real plugin and rejects invalid input', async () => {
    const api = makeMockK8sApi(); api.setListResponses();
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin(), createSandboxK8sPlugin({ api, namespace: 'runners', hostIpcUrl: 'http://host:8080' })] });
    try {
      expect(await h.bus.call('sandbox:session-status', h.ctx(), { sessionId: 'session' })).toEqual({ state: 'stopped' });
      await expect(h.bus.call('sandbox:session-status', h.ctx(), { sessionId: '' })).rejects.toThrow('Invalid session status input');
    } finally { await h.close(); }
  });
});
