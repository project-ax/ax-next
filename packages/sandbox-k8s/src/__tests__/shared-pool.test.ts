import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type { Plugin } from '@ax/core';
import { buildSharedTemplate, createSharedPoolSessionApi } from '../shared-pool.js';
import { resolveConfig } from '../config.js';
import { buildPodSpec } from '../pod-spec.js';
import { createSandboxK8sPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';
import type { SandboxCustomApi } from '../agent-sandbox.js';
import type { StorageClient } from '../storage-client.js';
import { makeMockK8sApi } from './mock-k8s.js';

const config = resolveConfig({ backend: 'agent-sandbox', namespace: 'runners',
  hostIpcUrl: 'http://host:80', proxyEndpoint: 'http://proxy:8888', readinessPollMs: 1, readinessTimeoutMs: 1000,
  orphanSweepIntervalMs: 0, sharedPool: { replicas: 2, prefix: 'shared', storageNamespace: 'storage',
    tlsDirectory: '/tls', serverName: 'storage.storage.svc', runnerBinaries: { 'claude-sdk': '/runner.js' },
    userFiles: { server: '10.0.0.9', exportPath: '/files' }, memory: { server: '10.0.0.10', exportPath: '/memory' } } });
const memoryPath = (agent: string) => `${createHash('sha256').update(JSON.stringify([agent])).digest('hex')}/permanent/memory/facts`;
const uid = { claim: randomUUID(), sandbox: randomUUID(), pod: randomUUID() };
function fixture() {
  const pods = makeMockK8sApi(), direct = makeMockK8sApi();
  let claimName = '', sandboxUid = uid.sandbox, podUid = uid.pod, deleting = false;
  const pod = () => ({ metadata: { name: 'original-standby', uid: podUid, ownerReferences: [{
    kind: 'Sandbox', name: 'adopted-sandbox', uid: sandboxUid, controller: true }] },
    spec: { nodeName: 'gvisor-node' }, status: { phase: 'Running', podIP: '10.0.0.2',
      conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [] } });
  vi.spyOn(pods, 'listNamespacedPod').mockImplementation(async () => ({ items: [pod()] }));
  vi.spyOn(pods, 'readNamespacedPod').mockImplementation(async () => pod());
  const custom: SandboxCustomApi = {
    createNamespacedCustomObject: vi.fn(async req => {
      const body = req.body as { metadata: { name: string } };
      if (req.plural === 'sandboxclaims') claimName = body.metadata.name;
      return { metadata: { ...body.metadata, uid: uid.claim } };
    }),
    getNamespacedCustomObject: vi.fn(async req => req.plural === 'sandboxclaims' ? {
      metadata: { name: claimName, uid: uid.claim, ...(deleting ? { deletionTimestamp: 'now' } : {}) },
      status: { sandbox: { name: 'adopted-sandbox' } },
    } : { metadata: { name: 'adopted-sandbox', uid: sandboxUid, ownerReferences: [{
      kind: 'SandboxClaim', name: claimName, uid: uid.claim, controller: true }] } }),
    listNamespacedCustomObject: vi.fn(async () => ({ items: [] })),
    deleteNamespacedCustomObject: vi.fn(async () => { deleting = true; return {}; }),
  };
  const storage: StorageClient = { assign: vi.fn(async () => {}), status: vi.fn(async () => ({ accepted: true })),
    release: vi.fn(async () => {}) };
  return { pods, direct, custom, storage, changePod: () => { podUid = randomUUID(); },
    changeSandbox: () => { sandboxUid = randomUUID(); }, deleteClaim: () => { deleting = true; } };
}
function sessionPod(agent = 'agent-a', memory = false) {
  const pod = buildPodSpec('session', { sessionId: 'session-a', workspaceRoot: '/agent', runnerBinary: '/runner.js',
    authToken: 'secret-session-token', runnerEndpoint: config.hostIpcUrl,
    proxyConfig: { endpoint: 'http://proxy:8888', caCertPem: 'public-ca', envMap: { API_KEY: 'ax-cred:test' } },
    mounts: [{ kind: 'nfs', role: 'user-files', server: '10.0.0.9', exportPath: '/files', subPath: agent,
      mountPath: '/files', readOnly: false }, ...(memory ? [{ kind: 'nfs' as const, role: 'memory' as const,
      server: '10.0.0.10', exportPath: '/memory', subPath: memoryPath(agent), mountPath: '/memory', readOnly: true }] : [])],
  }, config);
  pod.metadata.labels['ax.io/agent-id'] = agent;
  return pod;
}
describe('shared Agent Sandbox pool', () => {
  it('bounds warm capacity by execution class and keeps all session state out of templates', () => {
    const template = buildSharedTemplate(config, '/runner.js');
    expect(buildSharedTemplate(config, '/runner.js')).toEqual(template);
    expect(buildSharedTemplate({ ...config, image: 'new-image' }, '/runner.js').name).not.toBe(template.name);
    expect(JSON.stringify(template)).not.toMatch(/secret|agent-a|AX_AUTH_TOKEN|AX_SESSION_ID|nfs|hostPath/);
    expect(template.resource.spec).toMatchObject({ envVarsInjectionPolicy: 'Disallowed', networkPolicyManagement: 'Unmanaged' });
    expect(template.resource.spec.podTemplate.metadata.annotations).toEqual({ 'dev.gvisor.empty-dir.ax-late.force-shared': 'true' });
    expect(template.resource.spec.podTemplate.spec).not.toHaveProperty('activeDeadlineSeconds');
    // A disk emptyDir recursively removes children during kubelet teardown,
    // including files inside bind-mounted Filestore directories. A tmpfs
    // root must be unmounted first, which blocks until its child binds detach.
    expect(template.resource.spec.podTemplate.spec.volumes).toContainEqual({
      name: 'ax-late', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
    });
  });
  it('adopts the original pod and delivers credentials only through the node helper', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod('agent-a', true) });
    expect(f.direct.creates).toHaveLength(0); expect(f.pods.creates).toHaveLength(0);
    const calls = vi.mocked(f.custom.createNamespacedCustomObject).mock.calls;
    expect(calls.map(([c]) => c.plural)).toEqual(['sandboxtemplates', 'sandboxwarmpools', 'sandboxclaims']);
    // GKE's v1beta1 CRD requires a structured strategy; a string is rejected
    // before the controller can create any standby Pods.
    expect(calls[1]![0].body).toMatchObject({ spec: { replicas: 2, updateStrategy: { type: 'OnReplenish' } } });
    expect(calls[2]![0].body).toMatchObject({ spec: { warmPoolRef: { name: buildSharedTemplate(config, '/runner.js').name } } });
    expect(JSON.stringify(calls)).not.toContain('secret-session-token');
    expect((calls[2]![0].body as { spec: object }).spec).not.toHaveProperty('env');
    expect(f.storage.assign).toHaveBeenCalledWith('gvisor-node', expect.objectContaining({
      podUid: uid.pod, podName: 'original-standby', agentId: 'agent-a', roles: ['user-files', 'memory'],
      bootstrap: expect.objectContaining({ instanceId: uid.pod, env: expect.objectContaining({ AX_AUTH_TOKEN: 'secret-session-token' }) }),
    }));
    expect(await api.readNamespacedPod({ namespace: config.namespace, name: 'session' })).toMatchObject({ metadata: { uid: uid.pod } });
    await api.deleteNamespacedPod({ namespace: config.namespace, name: 'session' });
    expect(f.storage.release).toHaveBeenCalledWith('gvisor-node', expect.objectContaining({ podUid: uid.pod }));
    expect(f.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ plural: 'sandboxclaims',
      body: { propagationPolicy: 'Foreground', preconditions: { uid: uid.claim } } }));
  });
  it.each(['pod', 'sandbox', 'claim'])('fails closed when the assigned %s changes', async kind => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod() });
    if (kind === 'pod') f.changePod(); else if (kind === 'sandbox') f.changeSandbox(); else f.deleteClaim();
    expect(await api.readNamespacedPod({ namespace: config.namespace, name: 'session' })).toMatchObject({ status: { phase: 'Failed' } });
  });
  it('rejects a memory mount pointing into a different agent before making a claim', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const pod = sessionPod('agent-a', true);
    const runner = (pod.spec.containers as { volumeMounts: { mountPath: string; subPath?: string }[] }[])[0]!;
    runner.volumeMounts.find(m => m.mountPath === '/memory')!.subPath = memoryPath('agent-b');
    await expect(api.createNamespacedPod({ namespace: config.namespace, body: pod })).rejects.toThrow('mount resolver');
    expect(vi.mocked(f.custom.createNamespacedCustomObject).mock.calls).toHaveLength(2);
  });
  it('rejects a resolver selecting another agent independently of its supplied subPath', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const pod = sessionPod('agent-b'); pod.metadata.labels['ax.io/agent-id'] = 'agent-a';
    await expect(api.createNamespacedPod({ namespace: config.namespace, body: pod })).rejects.toThrow('mount resolver');
    expect(f.storage.assign).not.toHaveBeenCalled();
    expect(vi.mocked(f.custom.createNamespacedCustomObject).mock.calls).toHaveLength(2);
  });
  it('keeps the claim protected when storage cleanup fails', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod() });
    vi.mocked(f.storage.release).mockRejectedValueOnce(new Error('flush failed'));
    await expect(api.deleteNamespacedPod({ namespace: config.namespace, name: 'session' })).rejects.toThrow('flush failed');
    expect(f.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    await api.deleteNamespacedPod({ namespace: config.namespace, name: 'session' });
    expect(f.custom.deleteNamespacedCustomObject).toHaveBeenCalledTimes(1);
  });
  it('does not read logs from a same-name replacement', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod() }); f.changePod();
    await expect(api.readNamespacedPodLog({ namespace: config.namespace, name: 'session', container: 'runner', tailLines: 10 })).rejects.toThrow('ownership changed');
    expect(f.pods.logReads).toHaveLength(0);
  });
  it('rejects an existing template that adds privileges even when its hash name is unchanged', async () => {
    const f = fixture(); const template = buildSharedTemplate(config, '/runner.js');
    vi.mocked(f.custom.createNamespacedCustomObject).mockRejectedValue({ code: 409 });
    const mutated = structuredClone(template.resource);
    (mutated.spec.podTemplate.spec.containers as { securityContext: { privileged: boolean } }[])[0]!.securityContext.privileged = true;
    vi.mocked(f.custom.getNamespacedCustomObject).mockResolvedValue(mutated);
    await expect(createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config)).rejects.toThrow('configuration differs');
    expect(f.storage.assign).not.toHaveBeenCalled();
  });
  it('is reachable through the real plugin bus and session lifecycle', async () => {
    const f = fixture();
    const resolver: Plugin = { manifest: { name: 'fixture-resolver', version: '0', registers: ['sandbox:resolve-mounts'], calls: [], subscribes: [] },
      init({ bus }) { bus.registerService('sandbox:resolve-mounts', 'fixture-resolver', async () => ({ mounts: [{
        kind: 'nfs', role: 'user-files', server: '10.0.0.9', exportPath: '/files', subPath: 'agent-a', mountPath: '/files', readOnly: false,
      }] })); } };
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin(), resolver,
      createSandboxK8sPlugin({ ...config, api: f.pods, sandboxApi: f.custom, storageClient: f.storage })] });
    try {
      const result = await h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', h.ctx(), {
        sessionId: 's', workspaceRoot: '/agent', runnerBinary: '/runner.js',
        proxyConfig: { endpoint: config.proxyEndpoint, caCertPem: 'public-ca', envMap: {} }, owner: {
          userId: 'user-a', agentId: 'agent-a', agentConfig: { displayName: 'A', systemPromptAugment: '',
            allowedTools: [], mcpConfigIds: [], model: 'model', runner: 'claude-sdk' },
        },
      });
      expect(f.pods.creates).toHaveLength(0); expect(f.storage.assign).toHaveBeenCalledTimes(1);
      vi.mocked(f.storage.release).mockImplementation(async () => {
        expect(await h.bus.call('session:is-alive', h.ctx(), { sessionId: 's' })).toEqual({ alive: false });
      });
      await result.handle.kill(); expect(f.storage.release).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });
});
