import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, chmodSync, existsSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_MAX_BYTES } from '@ax/sandbox-protocol';
import { StorageNodeEngine, STORAGE_REQUEST_MAX_BYTES, assertReadOnlyMount, type StorageAuthority } from '../storage-node/engine.js';
import { openDirectory } from '../storage-node/confined-directory.js';
import { createStorageAuthority, type StorageKubeApi, type StorageObject } from '../storage-node/authority.js';
import { StorageAssignmentSchema, StorageRecordSchema, StorageRecoverySchema, STORAGE_FINALIZER, type StorageAssignment, type StorageIdentity,
  ChangeSharedRequestSchema, CHANGE_SHARED_REQUEST_MAX_BYTES, base64Length } from '../storage-node/protocol.js';
import { WalkChangeError, WalkPathError, WalkReadError, type changeConfinedByWalk } from '@ax/user-files-read';

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
  const config = { backingProfile: data.backingProfile, kubeletPodsRoot: join(root, 'pods'), ledgerRoot: join(root, 'ledger'),
    userFilesRoot: join(root, 'files'), userFilesReadOnlyRoot: join(root, 'files-ro') };
  const volume = join(config.kubeletPodsRoot, data.podUid, 'volumes/kubernetes.io~empty-dir/ax-late');
  mkdirSync(volume, { recursive: true }); mkdirSync(config.userFilesRoot);
  // The read-only root is a second mount of the same export; a link stands in for it.
  symlinkSync(config.userFilesRoot, config.userFilesReadOnlyRoot);
  let readOnlyRootOptions: string | null = 'ro';
  const fds = new Map<number, string>();
  const directory: typeof openDirectory = (base, parts, create) => {
    const parent = typeof base === 'string' ? base : fds.get(base.fd)!;
    let path = parent;
    for (const part of parts) {
      if (!part || ['.', '..'].includes(part) || part.includes('/') || part.includes('\0')) throw new Error('unsafe component');
      path = join(path, part);
      if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
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
  const chowned: (string | undefined)[] = [];
  // The helper runs as root; the fixture does not. Directories are reported
  // root-owned unless a test plants one with another owner.
  const foreignOwned = new Set<string>();
  const reports: string[] = [];
  const io = { directory, chown: vi.fn((fd: number) => { chowned.push(fds.get(fd)); }), isTmpfs: vi.fn(() => true),
    owner: vi.fn((fd: number) => foreignOwned.has(fds.get(fd)!) ? 1000 : 0),
    inode: vi.fn((fd: number) => fstatSync(fd).ino),
    report: vi.fn((message: string) => { reports.push(message); }),
    mountInfo: () => [...(readOnlyRootOptions === null ? [] : [`1 2 0:1 / ${config.userFilesReadOnlyRoot} ${readOnlyRootOptions} - nfs source rw`]),
      ...[...mounted].map(path => `1 2 0:1 / ${path} rw - nfs source rw`)].join('\n') };
  return { root, config, volume, data, authority, events, command, make: () => new StorageNodeEngine(config, authority, command, io),
    failUnmount: (v: boolean) => { failUnmount = v; }, pretendSuccess: () => { pretendSuccess = true; }, io, mounted, chowned,
    foreignOwned, reports, readOnlyRootOptions: (v: string | null) => { readOnlyRootOptions = v; } };
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

// F4 — a failed activation keeps its cause: the helper reports the underlying
// error (and any release error) and rethrows with { cause }. Credentials never
// reach the report.
describe('storage-node activation failure reporting', () => {
  it('reports the failing mount and keeps it as the cause', async () => {
    const f = engineFixture();
    f.command.mockImplementationOnce(() => { throw new Error('mount: /files: permission denied'); });
    const err = await f.make().assign(f.data).catch((e: unknown) => e as Error);
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
    const err = await f.make().assign(f.data).catch((e: unknown) => e as Error);
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

// W2 §3.8.1 — shared folders on the shared warm pool. The source path comes
// from the folder id only; the claim annotation is the host's decision.
const SHARED = [{ folderId: 'sf_a', readOnly: false }, { folderId: 'sf_b', readOnly: true }];
const withShared = (data = input(), sharedFolders = SHARED): StorageAssignment => ({ ...data, sharedFolders });
describe('storage-node shared folders', () => {
  it('binds .shared/<id> to ax-late/shared/<id>, viewers from the read-only root, and chowns every source, all before publishing', async () => {
    const f = engineFixture(withShared()); await f.make().assign(f.data);
    const files = f.config.userFilesRoot;
    expect(f.command.mock.calls.filter(([p]) => p === 'mount').map(([, a]) => a)).toEqual([
      ['--no-canonicalize', '--bind', join(files, 'agent-a'), join(f.volume, 'files')],
      // An editor binds from the writable export.
      ['--no-canonicalize', '--bind', join(files, '.shared/sf_a'), join(f.volume, 'shared/sf_a')],
      // A viewer binds from the read-only mount, so the bind is read-only before
      // it propagates. The remount below alone never reaches the runner's copy.
      ['--no-canonicalize', '--bind', join(f.config.userFilesReadOnlyRoot, '.shared/sf_b'), join(f.volume, 'shared/sf_b')],
      ['--no-canonicalize', '-o', 'remount,bind,ro', join(f.volume, 'shared/sf_b')],
    ]);
    expect(f.chowned).toContain(join(files, '.shared/sf_a'));
    // F5 — a viewer may be the first to touch a folder; its source must be
    // runner-owned to be readable. It is still read-only remounted above.
    expect(f.chowned).toContain(join(files, '.shared/sf_b'));
    expect(f.chowned).not.toContain(join(files, '.shared'));
    // `shared` is not a mount point: the non-root runner must be able to traverse it.
    expect(statSync(join(f.volume, 'shared')).mode & 0o777).toBe(0o755);
    // Every bind precedes the pre-publish authorization recheck and the publish.
    expect(f.events).toEqual(['authorize', 'protect', 'mount', 'mount', 'mount', 'mount', 'authorize']);
    expect(readdirSync(join(f.volume, 'bootstrap'))).toEqual(['session.json']);
    const ledger = JSON.parse(readFileSync(join(f.config.ledgerRoot, `${f.data.podUid}.json`), 'utf8'));
    expect(ledger.sharedFolders).toEqual(SHARED);
    expect(f.authority.protect).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sharedFolders: SHARED }));
  });
  it.each([['rw', 'rw,relatime'], ['missing', null]])(
    'refuses a viewer when the read-only root is %s, binding no viewer folder and publishing nothing', async (_label, options) => {
      const f = engineFixture(withShared());
      f.readOnlyRootOptions(options);
      await expect(f.make().assign(f.data)).rejects.toThrow('activation failed');
      expect(f.command.mock.calls.some(([p, a]) => p === 'mount' && a.some(x => x.includes('sf_b')))).toBe(false);
      expect(existsSync(join(f.volume, 'bootstrap/session.json'))).toBe(false);
    });
  it('refuses a viewer whose read-only source is not the folder it chowned', async () => {
    const f = engineFixture(withShared());
    let calls = 0; f.io.inode.mockImplementation(() => ++calls);
    await expect(f.make().assign(f.data)).rejects.toThrow('activation failed');
    expect(f.command.mock.calls.some(([p, a]) => p === 'mount' && a.some(x => x.includes('sf_b')))).toBe(false);
    expect(existsSync(join(f.volume, 'bootstrap/session.json'))).toBe(false);
  });
  it('never binds an editor from the read-only root', async () => {
    const f = engineFixture(withShared(input(), [{ folderId: 'sf_a', readOnly: false }])); f.readOnlyRootOptions('rw');
    await f.make().assign(f.data);
    expect(f.command.mock.calls.some(([, a]) => a.some(x => x.startsWith(f.config.userFilesReadOnlyRoot)))).toBe(false);
  });
  it('binds a shared folder for a session with no other storage role', async () => {
    const f = engineFixture(withShared({ ...input(), roles: [] }, [{ folderId: 'sf_a', readOnly: true }]));
    await f.make().assign(f.data);
    expect([...f.mounted]).toEqual([join(f.volume, 'shared/sf_a')]);
  });
  it.each([
    ['.shared', (files: string, ledger: string) => { symlinkSync(ledger, join(files, '.shared')); }],
    ['folder', (files: string, ledger: string) => { mkdirSync(join(files, '.shared')); symlinkSync(ledger, join(files, '.shared/sf_a')); }],
    ['staging shared', (_files: string, _ledger: string, volume: string) => { symlinkSync('/tmp', join(volume, 'shared')); }],
  ])('refuses a symlinked %s directory before any shared bind', async (_label, plant) => {
    const f = engineFixture(withShared()); plant(f.config.userFilesRoot, f.config.ledgerRoot, f.volume);
    await expect(f.make().assign(f.data)).rejects.toThrow('activation failed');
    expect(f.command.mock.calls.some(([p, a]) => p === 'mount' && a.some(x => x.includes('.shared')))).toBe(false);
    // Credentials are never published without every bind in place.
    expect(existsSync(join(f.volume, 'bootstrap/session.json'))).toBe(false);
  });
  // F6 — the staging `shared` dir is not mounted over, so whoever owns it
  // controls the namespace the binds land in. The runner must never own it.
  it('refuses a staging shared directory the runner pre-created, binding nothing and releasing cleanly', async () => {
    const f = engineFixture(withShared());
    mkdirSync(join(f.volume, 'shared')); chmodSync(join(f.volume, 'shared'), 0o777); f.foreignOwned.add(join(f.volume, 'shared'));
    await expect(f.make().assign(f.data)).rejects.toThrow('activation failed');
    expect(f.command.mock.calls.some(([p, a]) => p === 'mount' && a.includes('--bind'))).toBe(false);
    expect(f.chowned).toEqual([]);
    // Fail closed: ownership is refused, not repaired.
    expect(statSync(join(f.volume, 'shared')).mode & 0o777).toBe(0o777);
    expect(existsSync(join(f.volume, 'bootstrap/session.json'))).toBe(false);
    expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
    expect(f.authority.finish).toHaveBeenCalledTimes(1);
    expect(f.reports.join('\n')).toMatch(/staging/);
  });
  // W3b — the host (uid 1000) reads a folder whose id it knows through the
  // read-only export mount. `.shared` stays root-owned; 0711 lets anyone
  // traverse it to a known name, and nobody but root list or create in it.
  it('makes .shared traverse-only (0711) on a prepare that touches shared folders, creating it if needed', async () => {
    const f = engineFixture(withShared()); await f.make().assign(f.data);
    const shared = join(f.config.userFilesRoot, '.shared');
    expect(statSync(shared).mode & 0o777).toBe(0o711);
    expect(f.chowned).not.toContain(shared);
    // The folders themselves are unchanged: created 0700, chowned to the runner.
    expect(statSync(join(shared, 'sf_a')).mode & 0o777).toBe(0o700);
  });
  it('re-applies 0711 on every prepare, so a .shared someone tightened is loosened again', async () => {
    const f = engineFixture(withShared()); const engine = f.make();
    const shared = join(f.config.userFilesRoot, '.shared');
    mkdirSync(shared, { mode: 0o700 }); chmodSync(shared, 0o700);
    await engine.assign(f.data);
    expect(statSync(shared).mode & 0o777).toBe(0o711);
  });
  it('leaves .shared alone on a prepare with no shared folders', async () => {
    const f = engineFixture(); await f.make().assign(f.data);
    expect(existsSync(join(f.config.userFilesRoot, '.shared'))).toBe(false);
  });
  it('makes an existing .shared 0711 at startup, without creating one that is missing', () => {
    const f = engineFixture();
    const shared = join(f.config.userFilesRoot, '.shared');
    f.make();
    expect(existsSync(shared)).toBe(false);
    mkdirSync(shared, { mode: 0o700 }); chmodSync(shared, 0o700);
    f.make();
    expect(statSync(shared).mode & 0o777).toBe(0o711);
    expect(f.reports).toEqual([]);
  });
  it('starts anyway when .shared cannot be opened at startup, and says so', () => {
    const f = engineFixture();
    symlinkSync(f.config.ledgerRoot, join(f.config.userFilesRoot, '.shared'));
    expect(() => f.make()).not.toThrow();
    expect(f.reports.join('\n')).toMatch(/\.shared/);
  });
  it('accepts a root-owned pre-existing staging shared directory', async () => {
    const f = engineFixture(withShared()); mkdirSync(join(f.volume, 'shared'), { mode: 0o700 });
    await f.make().assign(f.data);
    expect(statSync(join(f.volume, 'shared')).mode & 0o777).toBe(0o755);
  });
  it('unmounts every shared target on release and verifies each in mountinfo', async () => {
    const f = engineFixture(withShared()); const engine = f.make(); await engine.assign(f.data); f.events.length = 0;
    const unmounted: string[] = [];
    f.command.mockImplementation((program: string, args: string[]) => {
      f.events.push(program); if (program === 'umount') { unmounted.push(args.at(-1)!); f.mounted.delete(args.at(-1)!); }
    });
    await engine.release(identity(f.data));
    expect(f.events).toEqual(['stop', 'sync', 'umount', 'sync', 'umount', 'sync', 'umount', 'finish']);
    expect(unmounted).toEqual([join(f.volume, 'files'), join(f.volume, 'shared/sf_a'), join(f.volume, 'shared/sf_b')]);
    expect(f.mounted.size).toBe(0); expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('does not trust umount for a shared target that mountinfo still shows', async () => {
    const f = engineFixture(withShared({ ...input(), roles: [] })); await f.make().assign(f.data); f.pretendSuccess();
    await expect(f.make().release(identity(f.data))).rejects.toThrow('remains attached');
    expect(f.authority.finish).not.toHaveBeenCalled(); expect(readdirSync(f.config.ledgerRoot)).toHaveLength(1);
  });
  it('releases shared binds from the ledger after a helper restart', async () => {
    const f = engineFixture(withShared()); await f.make().assign(f.data);
    vi.mocked(f.authority.abandoned).mockResolvedValue(true);
    await f.make().reconcile();
    expect(f.mounted.size).toBe(0); expect(f.authority.finish).toHaveBeenCalledOnce();
  });
  it('releases shared binds from the recovery annotation after the local ledger is lost', async () => {
    const f = engineFixture(withShared()); await f.make().assign(f.data);
    const ledger = join(f.config.ledgerRoot, `${f.data.podUid}.json`);
    const record = JSON.parse(readFileSync(ledger, 'utf8')); unlinkSync(ledger);
    f.authority.recover = vi.fn(async () => [{ ...record, published: false }]);
    await f.make().reconcile();
    expect(f.mounted.size).toBe(0); expect(f.authority.finish).toHaveBeenCalledOnce();
  });
  it('treats a different folder list as a different assignment on retry', async () => {
    const f = engineFixture(withShared()); await f.make().assign(f.data);
    await expect(f.make().assign({ ...f.data, sharedFolders: [{ folderId: 'sf_a', readOnly: false }] })).rejects.toThrow('already assigned');
  });
  it('rejects malformed folder lists in the protocol', () => {
    const base = input();
    const many = Array.from({ length: 17 }, (_, i) => ({ folderId: `sf_${String(i).padStart(2, '0')}`, readOnly: true }));
    for (const sharedFolders of [[{ folderId: '../agent-b', readOnly: false }], [{ folderId: 'sf_a/..', readOnly: false }],
      [{ folderId: 'agent-a', readOnly: false }], [{ folderId: 'sf_a', readOnly: 'no' }], [{ folderId: 'sf_a' }],
      [{ folderId: 'sf_a', readOnly: false, path: '/etc' }], [{ folderId: 'sf_a', readOnly: false }, { folderId: 'sf_a', readOnly: true }],
      [{ folderId: 'sf_b', readOnly: false }, { folderId: 'sf_a', readOnly: false }], [], many]) {
      expect(StorageAssignmentSchema.safeParse({ ...base, sharedFolders }).success).toBe(false);
      const { bootstrap, ...rest } = base;
      expect(StorageRecordSchema.safeParse({ ...rest, assignmentId: bootstrap.assignmentId, published: false, sharedFolders }).success).toBe(false);
    }
    expect(StorageAssignmentSchema.safeParse({ ...base, sharedFolders: many.slice(0, 16) }).success).toBe(true);
  });
  it('keeps 16 maximum-length folders under the ledger, annotation and request caps', () => {
    const name = 'n'.repeat(63);
    const longest = Array.from({ length: 16 }, (_, i) => ({ folderId: `sf_${i.toString(16)}${'z'.repeat(63)}`, readOnly: false }));
    const { bootstrap, ...rest } = input();
    const record = StorageRecordSchema.parse({ ...rest, podName: name, claimName: name, sandboxName: name, agentId: 'a'.repeat(128),
      roles: ['user-files', 'memory'], assignmentId: bootstrap.assignmentId, published: false, sharedFolders: longest });
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(8192);
    const intent = StorageRecoverySchema.parse({ version: 1, fence: { machineId: randomUUID(), bootId: randomUUID() }, record });
    expect(Buffer.byteLength(JSON.stringify(intent))).toBeLessThanOrEqual(8192);
    const { assignmentId: _a, published: _p, ...request } = record;
    // The request is the identity + list plus a bootstrap bounded by BOOTSTRAP_MAX_BYTES.
    expect(Buffer.byteLength(JSON.stringify({ ...request, bootstrap: null })) + BOOTSTRAP_MAX_BYTES).toBeLessThanOrEqual(STORAGE_REQUEST_MAX_BYTES);
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

describe('storage-node shared-folder authority', () => {
  const ANNOTATION = 'ax.io/shared-folders';
  const canonical = '[{"folderId":"sf_a","readOnly":false},{"folderId":"sf_b","readOnly":true}]';
  it('accepts a list that equals the claim annotation exactly', async () => {
    const f = kubeFixture(withShared()); f.claim.metadata!.annotations = { [ANNOTATION]: canonical };
    await expect(f.authority.authorize(f.data)).resolves.toBeUndefined();
  });
  it('accepts no list when the claim carries no annotation', async () => {
    const f = kubeFixture(); await expect(f.authority.authorize(f.data)).resolves.toBeUndefined();
  });
  it.each<[string, string | undefined, StorageAssignment['sharedFolders']]>([
    ['an extra folder', '[{"folderId":"sf_a","readOnly":false}]', SHARED],
    ['a missing folder', canonical, [{ folderId: 'sf_a', readOnly: false }]],
    ['a flipped readOnly', canonical, [{ folderId: 'sf_a', readOnly: false }, { folderId: 'sf_b', readOnly: false }]],
    ['a malformed annotation', '[{"folderId":"sf_a","readOnly":false},{"folderId":"sf_b","readOnly":true}', SHARED],
    ['a non-canonical annotation', '[{"readOnly":false,"folderId":"sf_a"},{"folderId":"sf_b","readOnly":true}]', SHARED],
    ['an annotation with an unvalidated id', '[{"folderId":"../x","readOnly":false}]', undefined],
    ['an empty annotation', '[]', undefined],
    ['an annotation but no request list', canonical, undefined],
    ['a request list but no annotation', undefined, SHARED],
  ])('refuses %s', async (_label, annotation, sharedFolders) => {
    const f = kubeFixture(sharedFolders ? withShared(input(), sharedFolders) : input());
    if (annotation !== undefined) f.claim.metadata!.annotations = { [ANNOTATION]: annotation };
    await expect(f.authority.authorize(f.data)).rejects.toThrow('no longer active');
    expect(f.api.patchFinalizers).not.toHaveBeenCalled();
  });
  it('re-checks the annotation in the pre-publish recheck', async () => {
    const f = kubeFixture(withShared()); f.claim.metadata!.annotations = { [ANNOTATION]: canonical };
    await f.authority.authorize(f.data);
    f.claim.metadata!.annotations = { [ANNOTATION]: '[{"folderId":"sf_a","readOnly":false}]' };
    await expect(f.authority.authorize(f.data)).rejects.toThrow('no longer active');
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


// W3c — `/change-shared`: the engine half. The walk itself is
// @ax/user-files-read's (and Linux-only); here a fake stands in for it off
// Linux, and the real one runs in the Linux block below.
describe('storage-node shared-folder changes', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  function withWalk(f: ReturnType<typeof engineFixture>, impl?: typeof changeConfinedByWalk) {
    const change = vi.fn<typeof changeConfinedByWalk>(impl ?? ((_root, _base, changes) =>
      changes.map(c => ({ path: c.path, outcome: 'created' as const }))));
    (f.io as { change?: typeof changeConfinedByWalk }).change = change;
    return change;
  }
  it('creates .shared (0711) for createFolder, then walks .shared/<id> with createBase and chown through io', async () => {
    const f = engineFixture(); const change = withWalk(f, (_root, _base, changes, opts) => {
      opts.chown?.(42); return changes.map(c => ({ path: c.path, outcome: 'created' as const }));
    });
    const out = await f.make().changeShared({ folderId: 'sf_a', createFolder: true,
      changes: [{ op: 'mkdir', path: 'work', ifAbsent: true }, { op: 'write', path: 'work/a.md', content: b64('hello'), ifAbsent: true }] });
    expect(out).toEqual({ kind: 'done', results: [{ path: 'work', outcome: 'created' }, { path: 'work/a.md', outcome: 'created' }] });
    expect(statSync(join(f.config.userFilesRoot, '.shared')).mode & 0o777).toBe(0o711);
    const [root, base, changes, opts] = change.mock.calls[0]!;
    expect(root).toBe(f.config.userFilesRoot);
    expect(base).toEqual(['.shared', 'sf_a']);
    expect(opts).toMatchObject({ createBase: true, maxChanges: 64, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024 });
    // Content arrives as bytes, decoded from the wire's base64.
    expect(Buffer.from((changes[1] as { content: Uint8Array }).content).toString()).toBe('hello');
    // chown goes through io.chown (production: fchown 1000:1000).
    expect(f.io.chown).toHaveBeenCalledWith(42);
  });
  it('neither creates .shared nor asks for createBase without createFolder', async () => {
    const f = engineFixture(); const change = withWalk(f);
    await f.make().changeShared({ folderId: 'sf_a', changes: [{ op: 'delete', path: 'x' }] });
    expect(existsSync(join(f.config.userFilesRoot, '.shared'))).toBe(false);
    expect(change.mock.calls[0]![3]).not.toHaveProperty('createBase');
  });
  it.each([
    ['link-or-not-dir'], ['not-empty'], ['is-directory'], ['invalid-change'], ['too-large'], ['too-many-changes'],
  ] as const)('answers a %s refusal with its code and the changes already applied', async code => {
    const f = engineFixture();
    withWalk(f, () => { throw new WalkChangeError('refused', { code, index: 1, applied: [{ path: 'a', outcome: 'created' }] }); });
    expect(await f.make().changeShared({ folderId: 'sf_a', changes: [{ op: 'mkdir', path: 'a' }, { op: 'mkdir', path: 'b' }] }))
      .toEqual({ kind: 'refused', refused: code, results: [{ path: 'a', outcome: 'created' }] });
  });
  it('answers invalid-path for a malformed path and missing-folder for an absent folder', async () => {
    const f = engineFixture(); const engine = f.make();
    withWalk(f, () => { throw new WalkPathError('path must be relative'); });
    expect(await engine.changeShared({ folderId: 'sf_a', changes: [{ op: 'delete', path: '/etc/passwd' }] }))
      .toEqual({ kind: 'refused', refused: 'invalid-path', results: [] });
    withWalk(f, () => { throw new WalkReadError('the base does not exist (ENOENT)', { code: 'ENOENT', depth: 1 }); });
    expect(await engine.changeShared({ folderId: 'sf_a', changes: [] }))
      .toEqual({ kind: 'refused', refused: 'missing-folder', results: [] });
  });
  it('throws a bare error for a storage failure and reports it without paths', async () => {
    const f = engineFixture();
    withWalk(f, () => { throw new WalkReadError('could not write a temp file (EIO)', { code: 'EIO', depth: 3 }); });
    await expect(f.make().changeShared({ folderId: 'sf_a', changes: [{ op: 'mkdir', path: 'a' }] }))
      .rejects.toThrow(/^shared folder change failed$/);
    expect(f.reports.join('\n')).toMatch(/sf_a.*EIO/);
    expect(f.reports.join('\n')).not.toContain(f.root);
  });
  it('refuses a bad wire request before the walk runs', async () => {
    const f = engineFixture(); const change = withWalk(f); const engine = f.make();
    const bad: unknown[] = [
      { folderId: '../x', changes: [] },
      { folderId: 'sf_a', changes: [], extra: 1 },
      { folderId: 'sf_a', createFolder: false, changes: [] },
      { folderId: 'sf_a', changes: [{ op: 'write', path: 'a', content: 'not base64!' }] },
      { folderId: 'sf_a', changes: [{ op: 'write', path: 'a', content: 'aGVsbG8' }] }, // unpadded: not canonical
      { folderId: 'sf_a', changes: [{ op: 'write', path: 'a', content: '', ifMatch: 'a'.repeat(64), ifAbsent: true }] },
      { folderId: 'sf_a', changes: [{ op: 'write', path: 'a', content: '', ifMatch: 'A'.repeat(64) }] },
      { folderId: 'sf_a', changes: [{ op: 'chmod', path: 'a' }] },
      { folderId: 'sf_a', changes: [{ op: 'delete', path: 'a', recursive: true }] },
      { folderId: 'sf_a', changes: [{ op: 'delete', path: 'a'.repeat(1025) }] },
      { folderId: 'sf_a', changes: Array.from({ length: 65 }, () => ({ op: 'mkdir', path: 'a' })) },
    ];
    for (const raw of bad) await expect(engine.changeShared(raw as never)).rejects.toThrow();
    expect(change).not.toHaveBeenCalled();
  });
  it('caps each file at 10 MiB decoded and the call at 25 MiB', () => {
    const file = (bytes: number) => ({ op: 'write' as const, path: 'a', content: Buffer.alloc(bytes).toString('base64') });
    const MiB = 1024 * 1024;
    expect(ChangeSharedRequestSchema.safeParse({ folderId: 'sf_a', changes: [file(10 * MiB)] }).success).toBe(true);
    expect(ChangeSharedRequestSchema.safeParse({ folderId: 'sf_a', changes: [file(10 * MiB + 1)] }).success).toBe(false);
    expect(ChangeSharedRequestSchema.safeParse({ folderId: 'sf_a', changes: [file(10 * MiB), file(10 * MiB), file(5 * MiB)] }).success).toBe(true);
    expect(ChangeSharedRequestSchema.safeParse({ folderId: 'sf_a', changes: [file(10 * MiB), file(10 * MiB), file(5 * MiB + 1)] }).success).toBe(false);
    // The largest legal request fits the route's cap with paths at their limit.
    const largest = JSON.stringify({ folderId: 'sf_' + 'a'.repeat(64), createFolder: true, changes: [
      ...[10 * MiB, 10 * MiB, 5 * MiB].map(n => ({ op: 'write', path: 'p'.repeat(1024), content: 'A'.repeat(base64Length(n)), ifMatch: 'a'.repeat(64) })),
      ...Array.from({ length: 61 }, () => ({ op: 'mkdir', path: '"'.repeat(1024), ifAbsent: true })),
    ] });
    expect(Buffer.byteLength(largest)).toBeLessThanOrEqual(CHANGE_SHARED_REQUEST_MAX_BYTES);
  });
});

describe.skipIf(process.platform !== 'linux')('Linux shared-folder changes through the real walk', () => {
  it('creates the folder 0700, chowns what it creates, and refuses a planted symlink', async () => {
    const f = engineFixture(); const engine = f.make();
    const out = await engine.changeShared({ folderId: 'sf_a', createFolder: true,
      changes: [{ op: 'write', path: 'work/a.md', content: Buffer.from('hi').toString('base64') }] });
    expect(out).toEqual({ kind: 'done', results: [{ path: 'work/a.md', outcome: 'created' }] });
    const folder = join(f.config.userFilesRoot, '.shared', 'sf_a');
    expect(statSync(join(f.config.userFilesRoot, '.shared')).mode & 0o777).toBe(0o711);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(folder, 'work/a.md'), 'utf8')).toBe('hi');
    // The folder, work/, and the file (as its temp) are each handed to chown.
    expect(f.io.chown).toHaveBeenCalledTimes(3);
    symlinkSync('/etc', join(folder, 'escape'));
    expect(await engine.changeShared({ folderId: 'sf_a',
      changes: [{ op: 'write', path: 'escape/owned', content: '' }] }))
      .toEqual({ kind: 'refused', refused: 'link-or-not-dir', results: [] });
    expect(existsSync('/etc/owned')).toBe(false);
  });
  it('refuses a folder that does not exist without createFolder', async () => {
    const f = engineFixture(); mkdirSync(join(f.config.userFilesRoot, '.shared'));
    expect(await f.make().changeShared({ folderId: 'sf_b', changes: [{ op: 'mkdir', path: 'x' }] }))
      .toEqual({ kind: 'refused', refused: 'missing-folder', results: [] });
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
  it('carries the shared-folder list through the recovery annotation', async () => {
    const f = recoveredFixture(); const record = { ...f.record, sharedFolders: SHARED };
    await f.authority.protect({ ...f.data, sharedFolders: SHARED }, record);
    expect(JSON.parse(f.pod.metadata!.annotations![annotation]!).record.sharedFolders).toEqual(SHARED);
    expect(await f.authority.recover!()).toEqual([record]);
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

describe('assertReadOnlyMount', () => {
  const line = (path: string, options: string) => `36 25 0:52 / ${path} ${options} - nfs 10.0.0.1:/vol1 rw`;
  it('accepts a read-only mount', () => {
    expect(() => assertReadOnlyMount(line('/backing/files-ro', 'ro,relatime'), '/backing/files-ro')).not.toThrow();
  });
  it.each([
    ['writable', line('/backing/files-ro', 'rw,relatime')],
    ['absent', line('/backing/files', 'ro,relatime')],
    ['covered by a writable mount', [line('/backing/files-ro', 'ro'), line('/backing/files-ro', 'rw')].join('\n')],
    ['only a prefix match', line('/backing/files-ro-other', 'ro')],
  ])('refuses a mount that is %s', (_label, info) => {
    expect(() => assertReadOnlyMount(info, '/backing/files-ro')).toThrow('not mounted read-only');
  });
  it('reads past optional fields on a shared or slave mount', () => {
    const info = '36 25 0:52 / /backing/files-ro ro,relatime shared:7 master:3 - nfs 10.0.0.1:/vol1 rw';
    expect(() => assertReadOnlyMount(info, '/backing/files-ro')).not.toThrow();
    expect(() => assertReadOnlyMount(info.replace(' ro,', ' rw,'), '/backing/files-ro')).toThrow();
  });
  it('reads per-mount options, not superblock options', () => {
    expect(() => assertReadOnlyMount('36 25 0:52 / /backing/files-ro rw - nfs src ro', '/backing/files-ro')).toThrow();
  });
});
