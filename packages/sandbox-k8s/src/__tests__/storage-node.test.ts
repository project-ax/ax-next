import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageNodeEngine, type StorageAuthority } from '../storage-node/engine.js';
import { openDirectory } from '../storage-node/confined-directory.js';
import { createStorageAuthority, type StorageKubeApi, type StorageObject } from '../storage-node/authority.js';
import { StorageAssignmentSchema, StorageRecordSchema, STORAGE_FINALIZER, type StorageAssignment, type StorageIdentity } from '../storage-node/protocol.js';
import { legacySharedFolderTargetParts } from '../storage-node/sources.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input(): StorageAssignment {
  const podUid = randomUUID();
  return { podUid, podName: 'standby', claimUid: randomUUID(), claimName: 'claim', sandboxUid: randomUUID(),
    sandboxName: 'sandbox', agentId: 'agent-a', backingProfile: 'a'.repeat(64), roles: ['user-files'], bootstrap: { version: 1,
      instanceId: podUid, assignmentId: randomUUID(), expiresAt: Date.now() + 60_000,
      env: { AX_SESSION_ID: 'session', AX_AUTH_TOKEN: 'secret-token', AX_RUNNER_ENDPOINT: 'http://host:80', AX_PROXY_ENDPOINT: 'http://proxy:8888', AX_PROXY_TOKEN: 'd'.repeat(32) } } };
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
  const reports: string[] = [];
  const io = { directory, chown: vi.fn(), isTmpfs: vi.fn(() => true), report: vi.fn((message: string) => { reports.push(message); }),
    mountInfo: () => [...mounted].map(path => `1 2 0:1 / ${path} rw - nfs source rw`).join('\n') };
  return { root, config, volume, data, authority, events, command, make: () => new StorageNodeEngine(config, authority, command, io),
    failUnmount: (v: boolean) => { failUnmount = v; }, pretendSuccess: () => { pretendSuccess = true; }, io, mounted, reports };
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
  // The standby reader (agent-runner-core `waitForAssignment`) polls for
  // session.json (default every 50ms) and consumes + fails closed on anything it cannot
  // parse, so the publisher must never let a partially written target be seen.
  // An in-place `writeFile` of session.json creates it empty, then fills it.
  it('publishes session.json by same-directory rename: target absent until the complete file lands', async () => {
    const f = engineFixture(); const bootstrapDir = join(f.volume, 'bootstrap');
    const seen: Array<{ entries: string[]; temp?: string; tempMode?: number; tempIno?: bigint }> = [];
    vi.mocked(f.authority.authorize).mockImplementation(async () => {
      let entries: string[] = [];
      try { entries = readdirSync(bootstrapDir).sort(); } catch { /* not created yet */ }
      const snapshot: (typeof seen)[number] = { entries };
      if (entries.includes('session.tmp')) {
        const fd = openSync(join(bootstrapDir, 'session.tmp'), 'r');
        try {
          const st = fstatSync(fd, { bigint: true }); snapshot.tempMode = Number(st.mode & 0o777n); snapshot.tempIno = st.ino;
          snapshot.temp = readFileSync(fd, 'utf8');
        } finally { closeSync(fd); }
      }
      seen.push(snapshot);
    });
    await f.make().assign(f.data);
    // Observation point: the final authorization recheck, which runs after the
    // bootstrap is fully written and immediately before it is published. If this
    // count changes, the recheck moved — re-pick the observation point; it does
    // not by itself mean the atomic publish broke.
    expect(seen).toHaveLength(2);
    const prePublish = seen.at(-1)!;
    expect(prePublish.entries).toEqual(['session.tmp']);
    expect(prePublish.tempMode).toBe(0o600);
    expect(JSON.parse(prePublish.temp!)).toEqual(f.data.bootstrap);
    expect(seen.every(s => !s.entries.includes('session.json'))).toBe(true);
    expect(readdirSync(bootstrapDir)).toEqual(['session.json']);
    const fd = openSync(join(bootstrapDir, 'session.json'), 'r');
    try {
      // Same inode = the complete temp file was renamed into place. A copy into a
      // freshly created target (empty, then filled) gets a new inode.
      expect(fstatSync(fd, { bigint: true }).ino).toBe(prePublish.tempIno);
      expect(JSON.parse(readFileSync(fd, 'utf8'))).toEqual(f.data.bootstrap);
    } finally { closeSync(fd); }
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
  it('does not retire an assignment that finishes while reconciliation waits for its lock', async () => {
    const f = engineFixture(); const engine = f.make();
    let protectedIntent!: () => void; let continueProtection!: () => void;
    const protectedStarted = new Promise<void>(resolve => { protectedIntent = resolve; });
    const protectionPaused = new Promise<void>(resolve => { continueProtection = resolve; });
    vi.mocked(f.authority.protect).mockImplementation(async () => {
      protectedIntent(); await protectionPaused;
    });
    // Discovery can race ahead of the annotation patch and see no intent yet.
    f.authority.recover = vi.fn(async () => []);
    const assignment = engine.assign(f.data); await protectedStarted;
    const reconciliation = engine.reconcile();
    await new Promise(resolve => setTimeout(resolve, 0));
    continueProtection(); await assignment; await reconciliation;
    expect(f.authority.stop).not.toHaveBeenCalled();
    expect(f.authority.finish).not.toHaveBeenCalled();
    const record = JSON.parse(readFileSync(join(f.config.ledgerRoot, `${f.data.podUid}.json`), 'utf8'));
    expect(record.published).toBe(true);
    expect(JSON.parse(readFileSync(join(f.volume, 'bootstrap/session.json'), 'utf8'))).toEqual(f.data.bootstrap);
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

// TASK-904. A W2-era helper (#989, reverted in #1004) bound shared folders at
// ax-late/shared/<folderId> and named them in its ledger record and recovery
// annotation. This helper never binds one. It must boot over those records and
// undo every bind they name when it releases them.
const W2_SHARED = [{ folderId: 'sf_a', readOnly: false }, { folderId: 'sf_b', readOnly: true }];
/** The record a W2 helper wrote: the assignment minus its bootstrap, plus sharedFolders. */
function w2Record(data: StorageAssignment, published: boolean) {
  const { bootstrap, ...rest } = data;
  return { ...rest, sharedFolders: W2_SHARED, assignmentId: bootstrap.assignmentId, published };
}
/** The binds a W2 helper left attached on the pod's late volume. */
function plantW2Binds(f: ReturnType<typeof engineFixture>, folders = ['sf_a', 'sf_b']) {
  for (const parts of [['files'], ...folders.map(id => ['shared', id])]) {
    const path = join(f.volume, ...parts); mkdirSync(path, { recursive: true }); f.mounted.add(path);
  }
}
const unmounted = (f: ReturnType<typeof engineFixture>) =>
  f.command.mock.calls.filter(([program]) => program === 'umount').map(([, args]) => args.at(-1));
const writeLedger = (f: ReturnType<typeof engineFixture>, record: unknown) =>
  writeFileSync(join(f.config.ledgerRoot, `${f.data.podUid}.json`), JSON.stringify(record));

describe('storage-node over leftover W2 shared-folder state (TASK-904)', () => {
  it('boots reconcile over a W2 recovery annotation with no local ledger and unmounts every bind it names', async () => {
    const data = input(); const f = engineFixture(data); const k = kubeFixture(data);
    const fence = { machineId: randomUUID(), bootId: randomUUID() };
    k.pod.metadata!.finalizers = [STORAGE_FINALIZER]; k.claim.metadata!.finalizers = [STORAGE_FINALIZER];
    // Written by the W2 helper during an earlier boot of this machine.
    k.pod.metadata!.annotations!['ax.io/storage-recovery'] =
      JSON.stringify({ version: 1, fence: { ...fence, bootId: randomUUID() }, record: w2Record(data, false) });
    plantW2Binds(f);
    const engine = new StorageNodeEngine(f.config, createStorageAuthority(k.api, 'node', 'pool', fence), f.command, f.io);
    await expect(engine.reconcile()).resolves.toBeUndefined();
    expect(unmounted(f)).toEqual([join(f.volume, 'files'), join(f.volume, 'shared/sf_a'), join(f.volume, 'shared/sf_b')]);
    expect(f.mounted.size).toBe(0);
    expect(k.api.deleteClaim).toHaveBeenCalledWith(data.claimName, data.claimUid);
    expect(k.pod.metadata!.finalizers).toEqual([]); expect(k.claim.metadata!.finalizers).toEqual([]);
    expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('boots reconcile over a W2 ledger record and releases an abandoned one, shared binds included', async () => {
    const f = engineFixture(); const engine = f.make(); plantW2Binds(f); writeLedger(f, w2Record(f.data, true));
    vi.mocked(f.authority.abandoned).mockResolvedValue(true);
    await expect(engine.reconcile()).resolves.toBeUndefined();
    expect(f.mounted.size).toBe(0); expect(f.authority.finish).toHaveBeenCalledOnce();
    expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('leaves a live W2 session alone at boot; its later release unmounts the shared binds too', async () => {
    const f = engineFixture(); const engine = f.make(); plantW2Binds(f); writeLedger(f, w2Record(f.data, true));
    await expect(engine.reconcile()).resolves.toBeUndefined();
    expect(f.authority.stop).not.toHaveBeenCalled(); expect(f.mounted.size).toBe(3);
    await engine.release(identity(f.data));
    expect(f.events).toEqual(['stop', 'sync', 'umount', 'sync', 'umount', 'sync', 'umount', 'finish']);
    expect(f.mounted.size).toBe(0); expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  // W2 saved its record before binding anything, so a record can name a bind, or
  // a whole `shared` directory, that was never made or is already gone.
  it.each<[string, string[], string[]]>([
    ['shared/sf_b', ['sf_a'], ['files', 'shared/sf_a']],
    ['the whole shared directory', [], ['files']],
  ])('still releases a W2 record whose shared bind is already gone (%s)', async (_missing, planted, expected) => {
    const f = engineFixture(); const engine = f.make(); plantW2Binds(f, planted); writeLedger(f, w2Record(f.data, true));
    vi.mocked(f.authority.abandoned).mockResolvedValue(true);
    await expect(engine.reconcile()).resolves.toBeUndefined();
    expect(unmounted(f)).toEqual(expected.map(parts => join(f.volume, parts)));
    expect(f.authority.finish).toHaveBeenCalledOnce();
  });
  it('accepts sharedFolders on a record only, and only in the shape W2 wrote', () => {
    const data = input();
    expect(StorageAssignmentSchema.safeParse({ ...data, sharedFolders: W2_SHARED }).success).toBe(false);
    expect(StorageRecordSchema.safeParse(w2Record(data, false)).success).toBe(true);
    const seventeen = Array.from({ length: 17 }, (_, i) => ({ folderId: `sf_${String(i).padStart(2, '0')}`, readOnly: true }));
    for (const sharedFolders of [[{ folderId: '../agent-b', readOnly: false }], [{ folderId: 'sf_a/..', readOnly: false }],
      [{ folderId: 'agent-a', readOnly: false }], [{ folderId: 'sf_a', readOnly: 'no' }], [{ folderId: 'sf_a' }],
      [{ folderId: 'sf_a', readOnly: false, path: '/etc' }], [{ folderId: 'sf_a', readOnly: false }, { folderId: 'sf_a', readOnly: true }],
      [{ folderId: 'sf_b', readOnly: false }, { folderId: 'sf_a', readOnly: false }], [], seventeen]) {
      expect(StorageRecordSchema.safeParse({ ...w2Record(data, false), sharedFolders }).success).toBe(false);
    }
  });
  // The one place a folder id becomes path components re-checks it, so nothing
  // that skipped the schema can reach `..`, `/` or a sibling of `shared`.
  it('turns only a W2-shaped folder id into path components', () => {
    expect(legacySharedFolderTargetParts('sf_a')).toEqual(['shared', 'sf_a']);
    for (const id of ['', '.', '..', 'sf_', 'sf_.', 'sf_..', '../sf_a', 'sf_a/..', 'sf_a/b', 'sf_a\\b', 'agent-a',
      'SF_a', 'sf_a\u0000', 'sf_a\n', `sf_${'a'.repeat(65)}`]) {
      expect(() => legacySharedFolderTargetParts(id)).toThrow('invalid shared folder id');
    }
  });
});

// F4 — a failed activation keeps its cause: the helper reports the underlying
// error (and any release error) and rethrows with { cause }. Credentials never
// reach the report.
describe('storage-node activation failure reporting', () => {
  it('reports the failing mount and keeps it as the cause', async () => {
    const f = engineFixture();
    f.command.mockImplementationOnce(() => { throw new Error('mount: /files: permission denied'); });
    const err = await f.make().assign(f.data).catch((e: unknown) => e) as Error;
    expect(err.message).toBe('storage activation failed');
    expect((err.cause as Error).message).toBe('mount: /files: permission denied');
    expect(f.reports.join('\n')).toContain('mount: /files: permission denied');
    expect(f.reports.join('\n')).toContain(f.data.podUid);
  });
  it('reports a release failure during unwind as well as the original error', async () => {
    const f = engineFixture();
    f.command.mockImplementationOnce(() => { throw new Error('first failure'); });
    vi.mocked(f.authority.stop).mockRejectedValueOnce(new Error('stop refused'));
    await expect(f.make().assign(f.data)).rejects.toThrow('activation failed');
    const log = f.reports.join('\n');
    expect(log).toContain('first failure'); expect(log).toContain('stop refused');
  });
  it('never reports bootstrap credentials, even when an error message echoes them', async () => {
    const f = engineFixture();
    f.command.mockImplementationOnce(() => { throw new Error(`leaked secret-token and ${'d'.repeat(32)}`); });
    await expect(f.make().assign(f.data)).rejects.toThrow('activation failed');
    const log = f.reports.join('\n');
    expect(log).toContain('leaked'); expect(log).not.toContain('secret-token'); expect(log).not.toContain('d'.repeat(32));
  });
  it('rethrows a redacted stand-in as the cause, never the credential-bearing original', async () => {
    const f = engineFixture();
    const original = new Error('leaked secret-token');
    f.command.mockImplementationOnce(() => { throw original; });
    const err = await f.make().assign(f.data).catch((e: unknown) => e) as Error;
    expect(err.cause).not.toBe(original);
    expect((err.cause as Error).message).toContain('leaked');
    expect((err.cause as Error).message).not.toContain('secret-token');
  });
  it('redacts a short secret-named bootstrap value from the report', async () => {
    const data = input(); data.bootstrap.env.AX_AUTH_TOKEN = 'tok42';
    const f = engineFixture(data);
    f.command.mockImplementationOnce(() => { throw new Error('auth tok42 refused for session'); });
    await expect(f.make().assign(f.data)).rejects.toThrow('activation failed');
    const log = f.reports.join('\n');
    expect(log).toContain('refused'); expect(log).not.toContain('tok42');
  });
});
