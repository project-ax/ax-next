import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createLogger, type Plugin } from '@ax/core';
import { buildSharedTemplate, createSharedPoolSessionApi, retireSharedClaims } from '../shared-pool.js';
import { resolveConfig } from '../config.js';
import { buildPodSpec } from '../pod-spec.js';
import { createSandboxK8sPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';
import type { SandboxCustomApi } from '../agent-sandbox.js';
import type { StorageClient } from '../storage-client.js';
import { makeMockK8sApi } from './mock-k8s.js';
import { sweepOrphanedPods } from '../sweep.js';

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
function sessionPod(agent = 'agent-a', memory = false, shared: { id: string; readOnly: boolean }[] = []) {
  const pod = buildPodSpec('session', { sessionId: 'session-a', workspaceRoot: '/agent', runnerBinary: '/runner.js',
    authToken: 'secret-session-token', runnerEndpoint: config.hostIpcUrl,
    proxyConfig: { endpoint: 'http://proxy:8888', caCertPem: 'public-ca', envMap: { API_KEY: 'ax-cred:test' }, proxyAuthToken: 'e'.repeat(32) },
    mounts: [{ kind: 'nfs', role: 'user-files', server: '10.0.0.9', exportPath: '/files', subPath: agent,
      mountPath: '/files', readOnly: false }, ...(memory ? [{ kind: 'nfs' as const, role: 'memory' as const,
      server: '10.0.0.10', exportPath: '/memory', subPath: memoryPath(agent), mountPath: '/memory', readOnly: true }] : []),
      ...shared.map(s => ({ kind: 'nfs' as const, role: 'shared-folder' as const, folderId: s.id, server: '10.0.0.9', exportPath: '/files',
        subPath: `.shared/${s.id}`, mountPath: `/shared/${s.id}`, readOnly: s.readOnly }))],
  }, config);
  pod.metadata.labels['ax.io/agent-id'] = agent;
  return pod;
}
const runnerOf = (pod: ReturnType<typeof sessionPod>) => (pod.spec.containers as {
  env: { name: string; value?: string }[]; volumeMounts: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[] }[])[0]!;
function claimBody(f: ReturnType<typeof fixture>) {
  const call = vi.mocked(f.custom.createNamespacedCustomObject).mock.calls.find(([c]) => c.plural === 'sandboxclaims')!;
  return call[0].body as { metadata: { labels: Record<string, string>; annotations?: Record<string, string> } };
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
  // F4 — the host's generic activation error keeps its cause, and the
  // caller's pod_create_failed log (open-session) sees it in the message.
  it('keeps the underlying activation and cleanup errors without leaking credentials', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const cause = new Error('storage operation rejected');
    vi.mocked(f.storage.assign).mockRejectedValueOnce(cause);
    vi.mocked(f.storage.release).mockRejectedValueOnce(new Error('echo secret-session-token release refused'));
    const err = await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod() }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/^shared session activation failed/);
    expect(err.message).toContain('storage operation rejected');
    expect(err.message).toContain('release refused');
    expect(err.message).not.toContain('secret-session-token');
    // The cause is a redacted stand-in, not the original object: a logger
    // that deep-serializes `cause` must not find a credential there.
    expect(err.cause).not.toBe(cause);
    expect((err.cause as Error).message).toContain('storage operation rejected');
    expect(f.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ plural: 'sandboxclaims' }));
  });
  it('never attaches a credential-bearing original error as the cause', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const original = new Error('assign echoed secret-session-token');
    vi.mocked(f.storage.assign).mockRejectedValueOnce(original);
    const err = await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod() }).catch((e: unknown) => e as Error);
    expect(err.cause).not.toBe(original);
    expect((err.cause as Error).message).toContain('assign echoed');
    expect((err.cause as Error).message).not.toContain('secret-session-token');
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('secret-session-token');
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
  it('reaps a terminal claimed pod after restart through its claim, not its Pod owner', async () => {
    const f = fixture();
    const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const claim = { metadata: { name: 'session', uid: uid.claim, creationTimestamp: '2026-01-01T00:00:00Z',
      labels: { 'ax.io/shared-pool': buildSharedTemplate(config, '/runner.js').name } },
      status: { sandbox: { name: 'adopted-sandbox' } } };
    vi.mocked(f.custom.listNamespacedCustomObject).mockImplementation(async req => ({ items: req.plural === 'sandboxclaims' ? [claim] : [] }));
    vi.mocked(f.custom.getNamespacedCustomObject).mockImplementation(async req => req.plural === 'sandboxclaims' ? claim : {
      metadata: { name: 'adopted-sandbox', uid: uid.sandbox, ownerReferences: [{ kind: 'SandboxClaim', uid: uid.claim, controller: true }] },
    });
    const pod = { metadata: { name: 'original-standby', uid: uid.pod,
      ownerReferences: [{ apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', uid: uid.sandbox, controller: true }] },
      spec: { nodeName: 'gvisor-node' }, status: { phase: 'Succeeded' } };
    vi.mocked(f.pods.listNamespacedPod).mockResolvedValue({ items: [pod] });
    vi.mocked(f.pods.readNamespacedPod).mockResolvedValue(pod);
    expect(await sweepOrphanedPods({ api, namespace: config.namespace, terminalAgeMs: 60_000,
      podLog: createLogger({ reqId: 'recovery', writer: () => {} }) })).toBe(1);
    expect(f.storage.release).toHaveBeenCalledWith('gvisor-node', expect.objectContaining({ podUid: uid.pod, claimUid: uid.claim }));
    expect(f.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ plural: 'sandboxclaims',
      body: { propagationPolicy: 'Foreground', preconditions: { uid: uid.claim } } }));
    expect(f.direct.deletes).toHaveLength(0);
  });
  it('reaps an assigned claim whose Sandbox is gone without bypassing cleanup finalizers', async () => {
    const f = fixture();
    const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const claim = { metadata: { name: 'session', uid: uid.claim, creationTimestamp: '2026-01-01T00:00:00Z',
      finalizers: ['ax.io/storage-cleanup'], labels: { 'ax.io/shared-pool': buildSharedTemplate(config, '/runner.js').name } },
      status: { sandbox: { name: 'adopted-sandbox' } } };
    vi.mocked(f.custom.listNamespacedCustomObject).mockImplementation(async req => ({ items: req.plural === 'sandboxclaims' ? [claim] : [] }));
    vi.mocked(f.custom.getNamespacedCustomObject).mockImplementation(async req => {
      if (req.plural === 'sandboxclaims') return claim;
      throw { code: 404 };
    });
    expect(await sweepOrphanedPods({ api, namespace: config.namespace, terminalAgeMs: 60_000,
      podLog: createLogger({ reqId: 'recovery', writer: () => {} }) })).toBe(1);
    expect(f.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ plural: 'sandboxclaims',
      body: { propagationPolicy: 'Foreground', preconditions: { uid: uid.claim } } }));
    expect(f.storage.release).not.toHaveBeenCalled();
    expect(claim.metadata.finalizers).toEqual(['ax.io/storage-cleanup']);
    expect(f.direct.deletes).toHaveLength(0);
  });
  it.each(['pending', 'foreign', 'unavailable'])('does not reap a %s claim during recovery', async kind => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const claim = { metadata: { name: 'session', uid: uid.claim, creationTimestamp: '2026-01-01T00:00:00Z',
      labels: { 'ax.io/shared-pool': kind === 'foreign' ? 'someone-else-1234567890abcdef' : buildSharedTemplate(config, '/runner.js').name } },
      ...(kind === 'pending' ? {} : { status: { sandbox: { name: 'adopted-sandbox' } } }) };
    vi.mocked(f.custom.listNamespacedCustomObject).mockImplementation(async req => ({ items: req.plural === 'sandboxclaims' ? [claim] : [] }));
    vi.mocked(f.custom.getNamespacedCustomObject).mockImplementation(async req => {
      if (req.plural === 'sandboxclaims') return claim;
      throw { code: kind === 'unavailable' ? 503 : 404 };
    });
    expect(await sweepOrphanedPods({ api, namespace: config.namespace, terminalAgeMs: 60_000,
      podLog: createLogger({ reqId: 'recovery', writer: () => {} }) })).toBe(0);
    expect(f.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    expect(f.storage.release).not.toHaveBeenCalled();
  });
  it('preserves a running claimed conversation during the startup sweep', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod() });
    const claim = { metadata: { name: 'session', uid: uid.claim, creationTimestamp: '2026-01-01T00:00:00Z',
      labels: { 'ax.io/shared-pool': buildSharedTemplate(config, '/runner.js').name } },
      status: { sandbox: { name: 'adopted-sandbox' } } };
    vi.mocked(f.custom.listNamespacedCustomObject).mockImplementation(async req => ({ items: req.plural === 'sandboxclaims' ? [claim] : [] }));
    expect(await sweepOrphanedPods({ api, namespace: config.namespace, terminalAgeMs: 60_000,
      podLog: createLogger({ reqId: 'recovery', writer: () => {} }) })).toBe(0);
    expect(f.storage.release).not.toHaveBeenCalled();
    expect(f.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });
  it('keeps the observed UID guard when a retired claim is replaced', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const claim = { metadata: { name: 'session', uid: uid.claim,
      labels: { 'ax.io/shared-pool': buildSharedTemplate(config, '/runner.js').name } },
      status: { sandbox: { name: 'adopted-sandbox' } } };
    vi.mocked(f.custom.listNamespacedCustomObject).mockImplementation(async req => ({ items: req.plural === 'sandboxclaims' ? [claim] : [] }));
    vi.mocked(f.custom.getNamespacedCustomObject).mockImplementation(async req => {
      if (req.plural === 'sandboxclaims') return claim;
      throw { code: 404 };
    });
    await api.listNamespacedPod({ namespace: config.namespace });
    vi.mocked(f.custom.deleteNamespacedCustomObject).mockRejectedValue({ code: 409 });
    await expect(api.deleteNamespacedPod({ namespace: config.namespace, name: 'session' })).rejects.toEqual({ code: 409 });
    expect(f.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({
      body: { propagationPolicy: 'Foreground', preconditions: { uid: uid.claim } } }));
    expect(f.storage.release).not.toHaveBeenCalled();
    expect(f.direct.deletes).toHaveLength(0);
  });
  it('does not treat a temporarily missing Pod under a live Sandbox as retired', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod() });
    const claim = { metadata: { name: 'session', uid: uid.claim, creationTimestamp: '2026-01-01T00:00:00Z',
      labels: { 'ax.io/shared-pool': buildSharedTemplate(config, '/runner.js').name } },
      status: { sandbox: { name: 'adopted-sandbox' } } };
    vi.mocked(f.custom.listNamespacedCustomObject).mockImplementation(async req => ({ items: req.plural === 'sandboxclaims' ? [claim] : [] }));
    vi.mocked(f.pods.listNamespacedPod).mockResolvedValue({ items: [] });
    expect(await sweepOrphanedPods({ api, namespace: config.namespace, terminalAgeMs: 60_000,
      podLog: createLogger({ reqId: 'recovery', writer: () => {} }) })).toBe(0);
    expect(f.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    expect(f.storage.release).not.toHaveBeenCalled();
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
        proxyConfig: { endpoint: config.proxyEndpoint, caCertPem: 'public-ca', envMap: {}, proxyAuthToken: 'e'.repeat(32) }, owner: {
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
  // W2 shared folders §3.8.1: a pooled session late-binds its shared folders
  // through the node helper. The claim carries the host's decision; the helper
  // refuses anything the claim doesn't name.
  it('opens a pooled session with a shared-folder mount through the real plugin bus', async () => {
    const f = fixture();
    const resolver: Plugin = { manifest: { name: 'fixture-resolver', version: '0', registers: ['sandbox:resolve-mounts'], calls: [], subscribes: [] },
      init({ bus }) { bus.registerService('sandbox:resolve-mounts', 'fixture-resolver', async () => ({ mounts: [
        { kind: 'nfs', role: 'user-files', server: '10.0.0.9', exportPath: '/files', subPath: 'agent-a', mountPath: '/files', readOnly: false },
        { kind: 'nfs', role: 'shared-folder', folderId: 'sf_x', server: '10.0.0.9', exportPath: '/files', subPath: '.shared/sf_x',
          mountPath: '/shared/sf_x', readOnly: false },
      ] })); } };
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin(), resolver,
      createSandboxK8sPlugin({ ...config, api: f.pods, sandboxApi: f.custom, storageClient: f.storage })] });
    try {
      const result = await h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', h.ctx(), {
        sessionId: 's-shared', workspaceRoot: '/agent', runnerBinary: '/runner.js', sharedFolderIds: ['sf_x'],
        proxyConfig: { endpoint: config.proxyEndpoint, caCertPem: 'public-ca', envMap: {}, proxyAuthToken: 'e'.repeat(32) }, owner: {
          userId: 'user-a', agentId: 'agent-a', agentConfig: { displayName: 'A', systemPromptAugment: '',
            allowedTools: [], mcpConfigIds: [], model: 'model', runner: 'claude-sdk' },
        },
      });
      expect(f.pods.creates).toHaveLength(0); expect(f.direct.creates).toHaveLength(0);
      expect(claimBody(f).metadata.annotations).toEqual({ 'ax.io/shared-folders': '[{"folderId":"sf_x","readOnly":false}]' });
      expect(f.storage.assign).toHaveBeenCalledWith('gvisor-node', expect.objectContaining({
        roles: ['user-files'], sharedFolders: [{ folderId: 'sf_x', readOnly: false }] }));
      await result.handle.kill(); expect(f.storage.release).toHaveBeenCalledTimes(1);
    } finally { await h.close(); }
  });
  it('carries editor and viewer folders on the claim, the assignment and the bootstrap, sorted by id', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const pod = sessionPod('agent-a', true, [{ id: 'sf_b', readOnly: true }, { id: 'sf_a', readOnly: false }]);
    const envValue = runnerOf(pod).env.find(e => e.name === 'AX_SHARED_FOLDERS')!.value;
    await api.createNamespacedPod({ namespace: config.namespace, body: pod });
    expect(f.direct.creates).toHaveLength(0);
    expect(claimBody(f).metadata.annotations).toEqual({
      'ax.io/shared-folders': '[{"folderId":"sf_a","readOnly":false},{"folderId":"sf_b","readOnly":true}]' });
    expect(claimBody(f).metadata.labels).toEqual({ 'ax.io/shared-pool': buildSharedTemplate(config, '/runner.js').name, 'ax.io/agent-id': 'agent-a' });
    expect(f.storage.assign).toHaveBeenCalledWith('gvisor-node', expect.objectContaining({
      agentId: 'agent-a', roles: ['user-files', 'memory'],
      sharedFolders: [{ folderId: 'sf_a', readOnly: false }, { folderId: 'sf_b', readOnly: true }],
      bootstrap: expect.objectContaining({ env: expect.objectContaining({ AX_SHARED_FOLDERS: envValue }) }),
    }));
  });
  it('leaves a session without shared folders byte-identical: no annotation, no sharedFolders key', async () => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    await api.createNamespacedPod({ namespace: config.namespace, body: sessionPod('agent-a', true) });
    expect('annotations' in claimBody(f).metadata).toBe(false);
    const req = vi.mocked(f.storage.assign).mock.calls[0]![1];
    expect('sharedFolders' in req).toBe(false);
    expect(req.bootstrap.env).not.toHaveProperty('AX_SHARED_FOLDERS');
  });
  type Mutable = { volumes: { name: string; nfs?: { server: string; path: string } }[]; mount: { name: string; mountPath: string; subPath?: string; readOnly?: boolean };
    runner: ReturnType<typeof runnerOf>; pod: ReturnType<typeof sessionPod> };
  it.each<[string, (m: Mutable) => void]>([
    ['another server', m => { m.volumes.find(v => v.name === m.mount.name)!.nfs!.server = '10.0.0.10'; }],
    ['another export', m => { m.volumes.find(v => v.name === m.mount.name)!.nfs!.path = '/memory'; }],
    ['a subPath into an agent tree', m => { m.mount.subPath = 'agent-b'; }],
    ['a subPath naming another folder', m => { m.mount.subPath = '.shared/sf_b'; }],
    ['a nested subPath', m => { m.mount.subPath = '.shared/sf_a/../sf_b'; }],
    ['a mountPath for another folder', m => { m.mount.mountPath = '/shared/sf_b'; }],
    ['a mountPath outside /shared', m => { m.mount.mountPath = '/files/sf_a'; }],
    ['an invalid id', m => { m.mount.subPath = '.shared/bad'; m.mount.mountPath = '/shared/bad'; }],
    ['a duplicate folder', m => { m.runner.volumeMounts.push({ ...m.mount, readOnly: true }); }],
    ['a bootstrap env that disagrees with the mounts', m => {
      m.runner.env.find(e => e.name === 'AX_SHARED_FOLDERS')!.value = '[{"id":"sf_a","path":"/shared/sf_a","readOnly":true}]'; }],
    ['a bootstrap env with no mounts', m => {
      m.runner.volumeMounts.splice(m.runner.volumeMounts.indexOf(m.mount), 1); }],
  ])('rejects a shared-folder mount with %s before making a claim', async (_label, mutate) => {
    const f = fixture(); const api = await createSharedPoolSessionApi(f.pods, f.custom, f.direct, f.storage, config);
    const pod = sessionPod('agent-a', false, [{ id: 'sf_a', readOnly: false }]);
    const runner = runnerOf(pod);
    mutate({ pod, runner, volumes: pod.spec.volumes as Mutable['volumes'], mount: runner.volumeMounts.find(m => m.mountPath === '/shared/sf_a')! });
    await expect(api.createNamespacedPod({ namespace: config.namespace, body: pod })).rejects.toThrow();
    expect(vi.mocked(f.custom.createNamespacedCustomObject).mock.calls).toHaveLength(2);
    expect(f.storage.assign).not.toHaveBeenCalled(); expect(f.direct.creates).toHaveLength(0);
  });
});


it('retires only matching-prefix claims on actual host boot, preserving finalizers and UID guards', async () => {
  const f=fixture();vi.mocked(f.custom.listNamespacedCustomObject).mockResolvedValue({items:[
    {metadata:{name:'owned-old-class',uid:uid.claim,labels:{'ax.io/shared-pool':'shared-0123456789abcdef'},finalizers:['ax.io/storage-cleanup']}},
    {metadata:{name:'foreign',uid:randomUUID(),labels:{'ax.io/shared-pool':'different-0123456789abcdef'}}},
    {metadata:{name:'malformed',uid:randomUUID(),labels:{'ax.io/shared-pool':'shared-not-a-class'}}},
  ]});await retireSharedClaims(f.custom,config);
  expect(f.custom.deleteNamespacedCustomObject).toHaveBeenCalledExactlyOnceWith({group:'extensions.agents.x-k8s.io',version:'v1beta1',namespace:'runners',plural:'sandboxclaims',name:'owned-old-class',body:{propagationPolicy:'Foreground',preconditions:{uid:uid.claim}}});
});
