import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageNodeEngine, type StorageAuthority } from '../storage-node/engine.js';
import { openDirectory } from '../storage-node/confined-directory.js';
import { createStorageAuthority, type StorageKubeApi, type StorageObject } from '../storage-node/authority.js';
import { StorageAssignmentSchema, STORAGE_FINALIZER, type StorageAssignment, type StorageIdentity } from '../storage-node/protocol.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input(): StorageAssignment {
  const podUid = randomUUID();
  return { podUid, podName: 'standby', claimUid: randomUUID(), claimName: 'claim', sandboxUid: randomUUID(),
    sandboxName: 'sandbox', agentId: 'agent-a', backingProfile: 'a'.repeat(64), roles: ['user-files'], bootstrap: { version: 1,
      instanceId: podUid, assignmentId: randomUUID(), expiresAt: Date.now() + 60_000,
      env: { AX_SESSION_ID: 'session', AX_AUTH_TOKEN: 'secret-token', AX_RUNNER_ENDPOINT: 'http://host:80', AX_PROXY_ENDPOINT: 'http://proxy:8888' } } };
}
const identity = ({ podUid, podName, claimUid, claimName, sandboxUid, sandboxName }: StorageIdentity) => ({ podUid, podName, claimUid, claimName, sandboxUid, sandboxName });

// Kernel mount propagation has a separate GKE acceptance gate. Here real files
// exercise the ledger and bootstrap; only privileged mount operations are simulated.
function engineFixture(data = input()) {
  const root = mkdtempSync(join(tmpdir(), 'ax-storage-test-')); roots.push(root);
  const config = { backingProfile: data.backingProfile, kubeletPodsRoot: join(root, 'pods'), ledgerRoot: join(root, 'ledger'), userFilesRoot: join(root, 'files') };
  const volume = join(config.kubeletPodsRoot, data.podUid, 'volumes/kubernetes.io~empty-dir/ax-late');
  mkdirSync(volume, { recursive: true }); mkdirSync(config.userFilesRoot);
  const fds = new Map<number, string>();
  const directory: typeof openDirectory = (base, parts, create) => {
    const parent = typeof base === 'string' ? base : fds.get(base.fd)!;
    let path = parent;
    for (const part of parts) {
      if (!part || ['.', '..'].includes(part) || part.includes('/') || part.includes('\0')) throw new Error('unsafe component');
      path = join(path, part);
      if (create) { try { mkdirSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
      const test = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); closeSync(test);
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fds.set(fd, path);
    return { fd, path, close: () => { fds.delete(fd); closeSync(fd); } };
  };
  const events: string[] = [], mounted = new Set<string>();
  let failUnmount = false, pretendSuccess = false;
  const authority: StorageAuthority = {
    authorize: vi.fn(async () => { events.push('authorize'); }), protect: vi.fn(async () => { events.push('protect'); }),
    stop: vi.fn(async () => { events.push('stop'); }), finish: vi.fn(async () => { events.push('finish'); }),
    abandoned: vi.fn(async () => false),
  };
  const command = vi.fn((program: string, args: string[]) => {
    events.push(program);
    if (program === 'mount' && args.includes('--bind')) mounted.add(args.at(-1)!);
    if (program === 'umount') {
      expect(args.slice(0, 2)).toEqual(['--no-canonicalize', '-l']);
      if (failUnmount) throw new Error('busy');
      if (!pretendSuccess) mounted.delete(args.at(-1)!);
    }
  });
  const io = { directory, chown: vi.fn(), isTmpfs: vi.fn(() => true), mountInfo: () => [...mounted].map(path => `1 2 0:1 / ${path} rw - nfs source rw`).join('\n') };
  return { root, config, volume, data, authority, events, command, make: () => new StorageNodeEngine(config, authority, command, io),
    failUnmount: (v: boolean) => { failUnmount = v; }, pretendSuccess: () => { pretendSuccess = true; }, io };
}

describe('storage-node ledger and lifecycle', () => {
  it('refuses a disk staging directory before publishing intent or attaching durable storage', async () => {
    const f = engineFixture(); f.io.isTmpfs.mockReturnValue(false);
    await expect(f.make().assign(f.data)).rejects.toThrow('requires tmpfs');
    expect(f.command).not.toHaveBeenCalled(); expect(f.authority.protect).not.toHaveBeenCalled();
    expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('refuses assignments when a helper still mounts the old export configuration', async () => {
    const f = engineFixture();
    await expect(f.make().assign({ ...f.data, backingProfile: 'b'.repeat(64) })).rejects.toThrow('deployment configuration differs');
    expect(f.authority.authorize).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
  });
  it('publishes a private one-use assignment and persists no credentials in recovery state', async () => {
    const f = engineFixture(); const engine = f.make(); await engine.assign(f.data);
    const file = join(f.volume, 'bootstrap/session.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(f.data.bootstrap);
    const fd = openSync(file, 'r'); try { expect(fstatSync(fd).mode & 0o777).toBe(0o600); } finally { closeSync(fd); }
    const ledger = readFileSync(join(f.config.ledgerRoot, `${f.data.podUid}.json`), 'utf8');
    expect(ledger).not.toMatch(/secret-token|AX_AUTH_TOKEN|bootstrap/);
    expect(await engine.status(identity(f.data))).toEqual({ accepted: false });
    writeFileSync(join(f.volume, 'bootstrap/accepted.json'), JSON.stringify({ assignmentId: f.data.bootstrap.assignmentId, instanceId: f.data.podUid }));
    expect(await engine.status(identity(f.data))).toEqual({ accepted: true });
  });
  it('does not remount or recreate the secret on retries or helper restart', async () => {
    const f = engineFixture(); await f.make().assign(f.data);
    rmSync(join(f.volume, 'bootstrap/session.json'));
    await f.make().assign(f.data);
    expect(f.command).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(f.volume, 'bootstrap'))).toEqual([]);
    await expect(f.make().assign({ ...f.data, agentId: 'agent-b' })).rejects.toThrow('already assigned');
    await expect(f.make().assign({ ...f.data, bootstrap: { ...f.data.bootstrap, assignmentId: randomUUID() } })).rejects.toThrow('already assigned');
  });
  it('stops, flushes, detaches even with open Gofer descriptors, then releases finalizers', async () => {
    const f = engineFixture(); const engine = f.make(); await engine.assign(f.data); f.events.length = 0;
    await engine.release(identity(f.data));
    expect(f.events).toEqual(['stop', 'sync', 'umount', 'finish']);
    expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
    expect(readdirSync(join(f.volume, 'bootstrap'))).toEqual([]);
  });
  it('keeps its ledger and finalizers until a failed detach can be recovered after restart', async () => {
    const f = engineFixture(); await f.make().assign(f.data); f.failUnmount(true);
    await expect(f.make().release(identity(f.data))).rejects.toThrow('busy');
    expect(f.authority.finish).not.toHaveBeenCalled(); expect(readdirSync(f.config.ledgerRoot)).toHaveLength(1);
    f.failUnmount(false); vi.mocked(f.authority.abandoned).mockResolvedValue(true);
    await f.make().reconcile(); expect(f.authority.finish).toHaveBeenCalledOnce();
    expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('does not trust a successful umount exit status if mountinfo still shows the mount', async () => {
    const f = engineFixture(); await f.make().assign(f.data); f.pretendSuccess();
    await expect(f.make().release(identity(f.data))).rejects.toThrow('remains attached');
    expect(f.authority.finish).not.toHaveBeenCalled();
  });
  it('reclaims a partial bootstrap after a helper crash rather than acknowledging unpublished credentials', async () => {
    const f = engineFixture(); const engine = f.make(); await engine.assign(f.data);
    const path = join(f.config.ledgerRoot, `${f.data.podUid}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8')); record.published = false; writeFileSync(path, JSON.stringify(record));
    await expect(f.make().assign(f.data)).rejects.toThrow('partial assignment reclaimed');
    expect(f.authority.finish).toHaveBeenCalledOnce(); expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('rejects traversal, unknown roles, identity mismatch, and loader environment capabilities', async () => {
    const f = engineFixture();
    for (const data of [{ ...f.data, agentId: '../agent-b' }, { ...f.data, roles: ['arbitrary'] },
      { ...f.data, bootstrap: { ...f.data.bootstrap, instanceId: randomUUID() } },
      { ...f.data, bootstrap: { ...f.data.bootstrap, env: { ...f.data.bootstrap.env, NODE_OPTIONS: '--import=/files/evil.mjs' } } }]) {
      expect(StorageAssignmentSchema.safeParse(data).success).toBe(false);
    }
    expect(f.command).not.toHaveBeenCalled();
  });
  it('refuses a tenant directory symlink before any privileged mount', async () => {
    const f = engineFixture(); symlinkSync(f.config.ledgerRoot, join(f.config.userFilesRoot, 'agent-a'));
    await expect(f.make().assign(f.data)).rejects.toThrow('activation failed');
    expect(f.command).not.toHaveBeenCalled();
  });
});

function kubeFixture(data = input()) {
  const pod: StorageObject = { metadata: { name: data.podName, uid: data.podUid, resourceVersion: '1',
    labels: { 'ax.io/shared-standby': 'pool' }, annotations: { 'dev.gvisor.empty-dir.ax-late.force-shared': 'true' },
    ownerReferences: [{ apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', uid: data.sandboxUid, name: data.sandboxName, controller: true }] },
    spec: { nodeName: 'node', runtimeClassName: 'gvisor', volumes: [{ name: 'ax-late', emptyDir: { medium: 'Memory' } }] }, status: { phase: 'Running' } };
  const claim: StorageObject = { metadata: { name: data.claimName, uid: data.claimUid, resourceVersion: '1',
    labels: { 'ax.io/shared-pool': 'pool-hash', 'ax.io/agent-id': data.agentId } },
    spec: { warmPoolRef: { name: 'pool-hash' }, lifecycle: { shutdownTime: new Date(Date.now() + 60_000).toISOString() } }, status: { sandbox: { name: data.sandboxName } } };
  const sandbox: StorageObject = { metadata: { uid: data.sandboxUid, ownerReferences: [{ kind: 'SandboxClaim',
    apiVersion: 'extensions.agents.x-k8s.io/v1beta1', uid: data.claimUid, name: data.claimName, controller: true }] } };
  const api: StorageKubeApi = { readPod: vi.fn(async () => pod), readClaim: vi.fn(async () => claim),
    readSandbox: vi.fn(async () => sandbox), deletePod: vi.fn(async () => { pod.status = { phase: 'Succeeded', containerStatuses: [{state:{terminated:{finishedAt:new Date().toISOString(), reason:'Completed'}}}] }; }),
    deleteClaim: vi.fn(async () => {}), listNodePods: vi.fn(async () => [pod]),
    patchFinalizers: vi.fn(async (kind, _name, patch) => {
      const object = kind === 'pod' ? pod : claim;
      const change=patch[2] as {path:string;value:unknown};
      if(change.path==='/metadata/annotations')object.metadata!.annotations=change.value as Record<string,string>;
      else object.metadata!.finalizers=change.value as string[];
    }) };
  return { data, pod, claim, sandbox, api, authority: createStorageAuthority(api, 'node', 'pool') };
}
describe('storage-node Kubernetes authority', () => {
  it('refuses disk staging volumes even on an otherwise authorized owner chain', async () => {
    const f = kubeFixture(); f.pod.spec!.volumes![0]!.emptyDir!.medium = '';
    await expect(f.authority.authorize(f.data)).rejects.toThrow('ownership invalid');
    expect(f.api.patchFinalizers).not.toHaveBeenCalled();
  });
  it('protects exact UIDs and preserves other finalizers during cleanup', async () => {
    const f = kubeFixture(); f.pod.metadata!.finalizers = ['other.test/keep'];
    await f.authority.authorize(f.data); await f.authority.protect(f.data);
    expect(f.pod.metadata!.finalizers).toEqual(['other.test/keep', STORAGE_FINALIZER]);
    await f.authority.stop(f.data); await f.authority.finish(f.data);
    expect(f.pod.metadata!.finalizers).toEqual(['other.test/keep']);
    expect(f.api.deletePod).toHaveBeenCalledWith(f.data.podName, f.data.podUid);
    expect(f.api.patchFinalizers).toHaveBeenCalledWith('pod', f.data.podName, expect.arrayContaining([
      { op: 'test', path: '/metadata/uid', value: f.data.podUid }, { op: 'test', path: '/metadata/resourceVersion', value: '1' },
    ]));
  });
  it.each(['node', 'pod', 'sandbox', 'claim', 'agent', 'pool', 'deletion', 'expiry'])('rejects mismatched %s authority', async kind => {
    const f = kubeFixture();
    if (kind === 'node') f.pod.spec!.nodeName = 'different-node';
    if (kind === 'pod') f.pod.metadata!.uid = randomUUID();
    if (kind === 'sandbox') f.sandbox.metadata!.uid = randomUUID();
    if (kind === 'claim') f.claim.metadata!.uid = randomUUID();
    if (kind === 'agent') f.claim.metadata!.labels!['ax.io/agent-id'] = 'agent-b';
    if (kind === 'pool') f.claim.spec!.warmPoolRef!.name = 'other-pool';
    if (kind === 'deletion') f.pod.metadata!.deletionTimestamp = 'now';
    if (kind === 'expiry') f.claim.spec!.lifecycle!.shutdownTime = new Date(Date.now() - 1).toISOString();
    await expect(f.authority.authorize(f.data)).rejects.toThrow(); expect(f.api.patchFinalizers).not.toHaveBeenCalled();
  });
  it('never stops or patches a same-name replacement', async () => {
    const f = kubeFixture(); f.pod.metadata!.uid = randomUUID(); f.claim.metadata!.uid = randomUUID();
    await f.authority.stop(f.data); await f.authority.finish(f.data);
    expect(f.api.deletePod).not.toHaveBeenCalled(); expect(f.api.patchFinalizers).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== 'linux')('Linux descriptor confinement', () => {
  it('pins parent directories across rename and rejects intermediate symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'ax-confined-')); roots.push(root);
    mkdirSync(join(root, 'parent')); mkdirSync(join(root, 'parent/child'));
    const parent = openDirectory(root, ['parent']);
    try {
      const child = openDirectory(parent, ['child']);
      try { expect(fstatSync(child.fd).isDirectory()).toBe(true); } finally { child.close(); }
      symlinkSync('/etc', join(root, 'escape'));
      expect(() => openDirectory(root, ['escape', 'passwd'])).toThrow();
      expect(() => openDirectory(root, ['..'])).toThrow();
    } finally { parent.close(); }
  });
});


describe('shared storage recovery after local ledger loss', () => {
  const fence = { machineId: '5b723d61-8f6a-4b50-9f81-4eecdb84c172', bootId: 'c358457e-3f7a-41b3-b7e3-44eed001fa32' };
  const annotation = 'ax.io/storage-recovery';
  function recoveredFixture() {
    const f = kubeFixture();
    f.pod.metadata!.finalizers=[STORAGE_FINALIZER];f.claim.metadata!.finalizers=[STORAGE_FINALIZER];
    const { bootstrap, ...rest } = f.data;
    const record = { ...rest, assignmentId: bootstrap.assignmentId, published: false };
    f.pod.metadata!.annotations![annotation] = JSON.stringify({ version: 1, fence: { ...fence, bootId: randomUUID() }, record });
    return { ...f, record, authority: createStorageAuthority(f.api, 'node', 'pool', fence) };
  }
  it('records recovery intent before finalizers and excludes bootstrap capabilities', async () => {
    const f=recoveredFixture();f.pod.metadata!.finalizers=[];f.claim.metadata!.finalizers=[];
    await f.authority.protect(f.data,f.record);
    const calls=vi.mocked(f.api.patchFinalizers).mock.calls;expect(calls[0]![2][2]).toMatchObject({path:'/metadata/annotations'});
    const intent=JSON.parse(f.pod.metadata!.annotations![annotation]!);expect(intent.record).not.toHaveProperty('bootstrap');expect(intent.record).not.toHaveProperty('env');expect(intent.fence).toEqual(fence);
  });
  it('recovers a secret-free intent and fences a prior boot before finishing a lost ledger', async () => {
    const f = recoveredFixture();
    f.api.deletePod = vi.fn(async () => {});
    f.pod.status = { phase: 'Failed', containerStatuses: [{ state: { terminated: { reason: 'ContainerStatusUnknown' } } }] };
    expect(await f.authority.recover!()).toEqual([f.record]);
    await f.authority.stop(f.record);
    await f.authority.finish(f.record);
    expect(f.api.deleteClaim).toHaveBeenCalledWith(f.data.claimName, f.data.claimUid);
    expect(vi.mocked(f.api.deleteClaim).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.api.patchFinalizers).mock.invocationCallOrder[0]!);
    expect(f.pod.metadata!.annotations![annotation]).not.toContain('secret-session-token');
  });
  it('requires a matching machine identity, never merely a different boot or terminal phase', async () => {
    const f = recoveredFixture();const intent=JSON.parse(f.pod.metadata!.annotations![annotation]!);intent.fence.machineId=randomUUID();f.pod.metadata!.annotations![annotation]=JSON.stringify(intent);
    await expect(f.authority.recover!()).rejects.toThrow('fence');
    expect(f.api.deletePod).not.toHaveBeenCalled();expect(f.api.patchFinalizers).not.toHaveBeenCalled();
  });
  it('refuses corrupted recovery metadata and API outages', async () => {
    const f=recoveredFixture();f.pod.metadata!.annotations![annotation]='{"token":"not-an-intent"}';
    await expect(f.authority.recover!()).rejects.toThrow();
    f.api.listNodePods=vi.fn(async()=>{throw Object.assign(new Error('unavailable'),{code:503});});
    await expect(f.authority.recover!()).rejects.toThrow('unavailable');
    expect(f.api.deleteClaim).not.toHaveBeenCalled();
  });
  it('never recovers a same-name replacement or a foreign owner chain', async () => {
    const f=recoveredFixture();f.pod.metadata!.uid=randomUUID();
    await expect(f.authority.recover!()).rejects.toThrow('ownership');
    expect(f.api.deleteClaim).not.toHaveBeenCalled();
  });
  it('deletes the released claim before removing its protected Pod to prevent controller recreation', async () => {
    const f=kubeFixture();await f.authority.protect(f.data);await f.authority.stop(f.data);vi.mocked(f.api.patchFinalizers).mockClear();
    await f.authority.finish(f.data);
    expect(f.api.deleteClaim).toHaveBeenCalledWith(f.data.claimName,f.data.claimUid);
    expect(vi.mocked(f.api.deleteClaim).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.api.patchFinalizers).mock.invocationCallOrder[0]!);
  });
});


it('does not equate an uncertain terminal Pod with stopped containers on the current boot', async () => {
  vi.useFakeTimers();
  try {
    const f=kubeFixture();f.pod.status={phase:'Failed',containerStatuses:[{state:{terminated:{reason:'ContainerStatusUnknown'}}}]};f.api.deletePod=vi.fn(async()=>{});
    const assertion=expect(f.authority.stop(f.data)).rejects.toThrow('quiescence');
    await vi.advanceTimersByTimeAsync(90001);await assertion;
    expect(f.api.patchFinalizers).not.toHaveBeenCalled();expect(f.api.deleteClaim).not.toHaveBeenCalled();
  } finally {vi.useRealTimers();}
});
