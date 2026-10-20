import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createLogger, type Plugin } from '@ax/core';
import { buildSandboxResource, createAgentSandboxSessionApi, SANDBOX_BACKEND_LABEL, type SandboxCustomApi } from '../agent-sandbox.js';
import { resolveConfig } from '../config.js';
import { createSandboxK8sPlugin } from '../plugin.js';
import { buildPodSpec } from '../pod-spec.js';
import { prepareAgentSandboxMounts } from '../prepare-mounts.js';
import { sweepOrphanedPods } from '../sweep.js';
import type { OpenSessionResult } from '../open-session.js';
import { makeMockK8sApi } from './mock-k8s.js';
import { testProxyConfigTcp } from './proxy-config.js';

const config = resolveConfig({ backend: 'agent-sandbox', namespace: 'runners',
  hostIpcUrl: 'http://host:80', proxyEndpoint: 'http://proxy:8888',
  readinessPollMs: 1, readinessTimeoutMs: 100 });
const log = createLogger({ reqId: 'test', writer: () => {} });
const labels = { [SANDBOX_BACKEND_LABEL]: 'agent-sandbox' };
// Valid TCP-posture proxyConfig (this config sets `proxyEndpoint`); required on
// every `sandbox:open-session` input since TASK-838.
const proxyConfig = testProxyConfigTcp(config.proxyEndpoint);

function mocks() {
  const pods = makeMockK8sApi();
  let resource = { metadata: { name: 'test', uid: 'sandbox-uid', labels,
    creationTimestamp: new Date(Date.now() - 60_000).toISOString() } };
  let phase = 'Running';
  let podUid = 'pod-uid';
  const custom = {
    createNamespacedCustomObject: vi.fn(async (req) => {
      const body = req.body as typeof resource;
      resource = { metadata: { ...resource.metadata, ...body.metadata, uid: 'sandbox-uid' } };
      return resource;
    }),
    getNamespacedCustomObject: vi.fn(async () => resource),
    listNamespacedCustomObject: vi.fn(async () => ({ items: [resource] })),
    deleteNamespacedCustomObject: vi.fn(async () => {
      custom.getNamespacedCustomObject.mockRejectedValue({ code: 404 });
      return {};
    }),
  } satisfies SandboxCustomApi;
  const readPod = vi.spyOn(pods, 'readNamespacedPod').mockImplementation(async () => ({
    metadata: { uid: podUid, name: resource.metadata.name, ownerReferences: [{
      apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', name: resource.metadata.name,
      uid: 'sandbox-uid', controller: true,
    }] },
    status: { phase, podIP: '10.0.0.2', conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: phase === 'Running' ? [] : [{ state: { terminated: { exitCode: 0 } } }] },
  }));
  return { pods, custom, readPod, setPhase: (value: string) => { phase = value; },
    replacePod: () => { podUid = 'replacement'; }, replaceSandbox: () => { resource.metadata.uid = 'replacement'; } };
}

function pod() {
  return buildPodSpec('test', { sessionId: 's', workspaceRoot: '/agent',
    runnerBinary: '/runner.js', authToken: 'session-secret', runnerEndpoint: config.hostIpcUrl }, config);
}

describe('Agent Sandbox lifecycle', () => {
  it('supplies CPU and memory limits for every container under GKE hardening admission', () => {
    const spec = buildSandboxResource(pod(), config).spec.podTemplate.spec;
    const containers = [...spec.containers as Array<Record<string, unknown>>,
      ...spec.initContainers as Array<Record<string, unknown>>];
    expect(containers.some((container) => container.name === 'sdk-scaffold')).toBe(true);
    for (const container of containers) {
      expect(container.resources, String(container.name)).toMatchObject({
        limits: { cpu: config.cpuLimit, memory: config.memoryLimit },
        requests: { cpu: config.cpuRequest, memory: config.memoryRequest },
      });
    }
  });

  it.each(['v1alpha1', 'v1beta1'] as const)('preserves the runner spec under %s with bounded resource expiry', (version) => {
    const body = buildSandboxResource(pod(), { ...config, agentSandboxApiVersion: version }, 0);
    expect(body.apiVersion).toBe(`agents.x-k8s.io/${version}`);
    expect(body.spec.shutdownPolicy).toBe('Delete');
    expect(body.spec.shutdownTime).toBe(new Date(21_600_000).toISOString());
    expect(body.spec.service).toBe(false);
    expect(body.spec.podTemplate.spec.containers).toEqual(pod().spec.containers);
    expect(body.spec.podTemplate.spec).toMatchObject({ runtimeClassName: 'gvisor',
      automountServiceAccountToken: false, restartPolicy: 'Never',
      securityContext: { runAsNonRoot: true }, nodeSelector: { 'sandbox.gke.io/runtime': 'gvisor' } });
  });

  it('waits for asynchronous Pod creation, then pins its controller and UID', async () => {
    const { pods, custom, readPod } = mocks();
    const api = createAgentSandboxSessionApi(pods, custom, config);
    await api.createNamespacedPod({ namespace: 'runners', body: pod() });
    readPod.mockRejectedValueOnce({ code: 404 });
    const req = { name: 'test', namespace: 'runners' };
    expect(await api.readNamespacedPod(req)).toMatchObject({ status: { phase: 'Pending' } });
    expect(await api.readNamespacedPod(req)).toMatchObject({ status: { phase: 'Running' } });
    readPod.mockRejectedValueOnce({ code: 404 });
    expect(await api.readNamespacedPod(req)).toMatchObject({ status: { phase: 'Failed', reason: 'sandbox-pod-gone' } });
    expect(pods.creates).toHaveLength(0);
  });

  it.each(['pod', 'sandbox'])('treats a replacement %s as session death', async (kind) => {
    const mock = mocks();
    const api = createAgentSandboxSessionApi(mock.pods, mock.custom, config);
    await api.createNamespacedPod({ namespace: 'runners', body: pod() });
    const req = { namespace: 'runners', name: 'test' };
    await api.readNamespacedPod(req);
    if (kind === 'pod') mock.replacePod(); else mock.replaceSandbox();
    expect(await api.readNamespacedPod(req)).toMatchObject({ status: { phase: 'Failed', reason: `sandbox${kind === 'pod' ? '-pod' : ''}-replaced` } });
  });

  it('rejects a same-name Pod owned by another Sandbox', async () => {
    const { pods, custom, readPod } = mocks();
    readPod.mockResolvedValueOnce({ metadata: { uid: 'other' }, status: { phase: 'Running' } });
    const api = createAgentSandboxSessionApi(pods, custom, config);
    expect(await api.readNamespacedPod({ name: 'test', namespace: 'runners' })).toMatchObject({ status: { reason: 'sandbox-pod-ownership-invalid' } });
  });

  it('uses foreground, UID-constrained parent deletion and remains idempotent', async () => {
    const { pods, custom } = mocks();
    const api = createAgentSandboxSessionApi(pods, custom, config);
    await api.createNamespacedPod({ namespace: 'runners', body: pod() });
    await api.deleteNamespacedPod({ name: 'test', namespace: 'runners' });
    await api.deleteNamespacedPod({ name: 'test', namespace: 'runners' });
    expect(custom.deleteNamespacedCustomObject).toHaveBeenCalledTimes(1);
    expect(custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'test', body: { propagationPolicy: 'Foreground', preconditions: { uid: 'sandbox-uid' } },
    }));
    expect(pods.deletes).toHaveLength(0);
  });

  it('sweeps terminal parent resources instead of recreating their Pods', async () => {
    const mock = mocks();
    mock.setPhase('Succeeded');
    const api = createAgentSandboxSessionApi(mock.pods, mock.custom, config);
    expect(await sweepOrphanedPods({ api, namespace: 'runners', terminalAgeMs: 10_000, podLog: log })).toBe(1);
    expect(mock.custom.listNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ labelSelector: 'ax.io/sandbox-backend=agent-sandbox' }));
    expect(mock.pods.deletes).toHaveLength(0);
  });

  it('ordinary Pod sweeps leave Sandbox-owned Pods alone', async () => {
    const pods = makeMockK8sApi();
    pods.setListResponses({ metadata: { name: 'managed', creationTimestamp: new Date(0),
      ownerReferences: [{ controller: true, kind: 'Sandbox', apiVersion: 'agents.x-k8s.io/v1beta1' }] }, status: { phase: 'Succeeded' } });
    expect(await sweepOrphanedPods({ api: pods, namespace: 'runners', terminalAgeMs: 1, podLog: log })).toBe(0);
    expect(pods.deletes).toHaveLength(0);
  });

  it.each(['/opt/claude/main.js', '/opt/aisdk/main.js'])('canary: real plugin + session hooks launch %s and revoke before deletion', async (runnerBinary) => {
    const mock = mocks();
    const order: string[] = [];
    const audit: Plugin = { manifest: { name: 'test-audit', version: '0.0.0', registers: [], calls: [], subscribes: ['session:terminate'] },
      init({ bus }) { bus.subscribe('session:terminate', 'test-audit', async () => { order.push('revoked'); }); } };
    mock.custom.deleteNamespacedCustomObject.mockImplementation(async () => {
      order.push('deleted'); mock.custom.getNamespacedCustomObject.mockRejectedValue({ code: 404 }); return {};
    });
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin(), audit,
      createSandboxK8sPlugin({ ...config, api: mock.pods, sandboxApi: mock.custom, orphanSweepIntervalMs: 0 })] });
    try {
      const ctx = h.ctx();
      const result = await h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', ctx,
        { sessionId: ctx.sessionId, workspaceRoot: '/agent', runnerBinary, proxyConfig });
      const body = mock.custom.createNamespacedCustomObject.mock.calls[0]![0].body as ReturnType<typeof buildSandboxResource>;
      const containers = body.spec.podTemplate.spec.containers as Array<{ args: string[]; env: Array<{ name: string; value: string }> }>;
      expect(containers[0]!.args).toEqual(['node', runnerBinary]);
      expect(containers[0]!.env.find((env) => env.name === 'AX_AUTH_TOKEN')?.value).toBeTruthy();
      expect(result.runnerEndpoint).toBe(config.hostIpcUrl);
      await result.handle.kill();
      expect(order[0]).toBe('revoked');
      await expect(result.handle.exited).resolves.toMatchObject({ reason: 'sandbox-gone' });
      expect(mock.pods.creates).toHaveLength(0);
    } finally { await h.close(); }
  });

  it('fails initialization when the configured CRD/version or RBAC is unavailable', async () => {
    const mock = mocks();
    mock.custom.listNamespacedCustomObject.mockRejectedValue({ code: 404 });
    await expect(createTestHarness({ plugins: [createSessionInmemoryPlugin(), createSandboxK8sPlugin({
      ...config, api: mock.pods, sandboxApi: mock.custom, orphanSweepIntervalMs: 0,
    })] })).rejects.toThrow();
    expect(mock.pods.creates).toHaveLength(0);
  });

  it.each(['create', 'readiness'])('rolls back the AX session on %s failure', async (stage) => {
    const mock = mocks();
    if (stage === 'create') mock.custom.createNamespacedCustomObject.mockRejectedValue({ code: 403 });
    else mock.setPhase('Failed');
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin(), createSandboxK8sPlugin({
      ...config, api: mock.pods, sandboxApi: mock.custom, orphanSweepIntervalMs: 0,
    })] });
    try {
      const ctx = h.ctx();
      await expect(h.bus.call('sandbox:open-session', ctx, { sessionId: ctx.sessionId,
        workspaceRoot: '/agent', runnerBinary: '/runner.js', proxyConfig })).rejects.toThrow();
      // Got past input validation to the Sandbox create (and failed THERE), so
      // the rollback below is the one under test, not an invalid-payload refusal.
      expect(mock.custom.createNamespacedCustomObject).toHaveBeenCalledTimes(1);
      expect(await h.bus.call('session:is-alive', ctx, { sessionId: ctx.sessionId })).toEqual({ alive: false });
      expect(mock.custom.deleteNamespacedCustomObject).toHaveBeenCalledTimes(stage === 'readiness' ? 1 : 0);
    } finally { await h.close(); }
  });

  it('revokes the token even when parent deletion is refused', async () => {
    const mock = mocks();
    mock.custom.deleteNamespacedCustomObject.mockRejectedValue({ code: 403 });
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin(), createSandboxK8sPlugin({
      ...config, api: mock.pods, sandboxApi: mock.custom, orphanSweepIntervalMs: 0,
    })] });
    try {
      const ctx = h.ctx();
      const result = await h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', ctx,
        { sessionId: ctx.sessionId, workspaceRoot: '/agent', runnerBinary: '/runner.js', proxyConfig });
      await result.handle.kill();
      expect(await h.bus.call('session:is-alive', ctx, { sessionId: ctx.sessionId })).toEqual({ alive: false });
      mock.setPhase('Succeeded');
      await result.handle.exited;
    } finally { await h.close(); }
  });
});

describe('Agent Sandbox mount preparation', () => {
  function mountedPod() {
    return buildPodSpec('test', { sessionId: 's', workspaceRoot: '/agent', runnerBinary: '/runner.js',
      authToken: 'session-secret', runnerEndpoint: config.hostIpcUrl,
      mounts: [{ kind: 'nfs', role: 'user-files', server: '10.1.1.1', exportPath: '/files', mountPath: '/files', subPath: 'agent-one', readOnly: false }],
    }, config);
  }
  it('initializes only the agent subtree, with no session credentials, before a non-root Sandbox', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({ status: { phase: 'Succeeded', containerStatuses: [{ name: 'ownership', state: { terminated: { exitCode: 0 } } }] } });
    const prepared = await prepareAgentSandboxMounts(api, mountedPod(), config, log);
    const body = api.creates[0]!.body as { spec: { containers: Array<{ env: unknown; volumeMounts: unknown; securityContext: unknown }>; volumes: unknown[] } };
    expect(body.spec.containers[0]!.volumeMounts).toEqual([{ name: 'ax-mount-0', mountPath: '/files', subPath: 'agent-one', readOnly: false }]);
    expect(body.spec.containers[0]!.securityContext).toMatchObject({ capabilities: { drop: ['ALL'], add: ['CHOWN'] } });
    expect(JSON.stringify(body)).not.toContain('session-secret');
    expect(body.spec.volumes).toHaveLength(1);
    expect(body.spec).toMatchObject({ runtimeClassName: 'gvisor',
      nodeSelector: { 'sandbox.gke.io/runtime': 'gvisor' },
      automountServiceAccountToken: false, hostNetwork: false });
    expect((prepared.spec.initContainers as Array<{ name: string }>).map((init) => init.name)).toEqual(['sdk-scaffold']);
    expect(api.deletes).toHaveLength(1);
  });

  it.each([null, 1])('fails closed on an unknown or failed ownership exit (%s) and deletes the preparation pod', async (code) => {
    const api = makeMockK8sApi();
    api.setReadResponses({ status: { phase: 'Succeeded', containerStatuses: code === null ? [] : [{ name: 'ownership', state: { terminated: { exitCode: code } } }] } });
    await expect(prepareAgentSandboxMounts(api, mountedPod(), config, log)).rejects.toThrow(/writable file mount/);
    expect(api.deletes).toHaveLength(1);
  });

  it('preserves read-only memory and non-root native service sidecars without preparation', async () => {
    const api = makeMockK8sApi();
    const original = buildPodSpec('test', { sessionId: 's', workspaceRoot: '/agent', runnerBinary: '/runner.js',
      authToken: 'secret', runnerEndpoint: config.hostIpcUrl,
      mounts: [{ kind: 'nfs', role: 'memory', server: '10.1.1.2', exportPath: '/memory',
        mountPath: '/memory', subPath: 'agent-one', readOnly: true }],
      services: [{ name: 'postgres', image: `docker.io/library/postgres@sha256:${'a'.repeat(64)}`,
        ports: [5432], env: {}, writablePaths: ['/var/lib/postgresql/data'] }],
    }, config);
    const prepared = await prepareAgentSandboxMounts(api, original, config, log);
    const body = buildSandboxResource(prepared, config);
    expect(body.spec.podTemplate.spec.containers).toEqual(original.spec.containers);
    expect(body.spec.podTemplate.spec.volumes).toEqual(original.spec.volumes);
    expect(body.spec.podTemplate.spec.initContainers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'svc-postgres', restartPolicy: 'Always',
        securityContext: expect.objectContaining({ runAsNonRoot: true, capabilities: { drop: ['ALL'] } }) }),
    ]));
    expect(api.creates).toHaveLength(0);
  });

  it('bounds a stuck ownership preparation and deletes its pod', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({ status: { phase: 'Pending' } });
    await expect(prepareAgentSandboxMounts(api, mountedPod(), { ...config, readinessTimeoutMs: 5 }, log)).rejects.toThrow(/writable file mount/);
    expect(api.deletes).toHaveLength(1);
  });
});
