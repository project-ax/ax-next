import fs from 'node:fs';
import { inflateSync } from 'node:zlib';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { registerWorkspaceGitHooks, workspaceIdForAgent } from '../impl.js';
import { retireRoutineFiles } from '../retire-routine-files.js';

const { afterRename, beforeLink } = vi.hoisted(() => ({
  afterRename: { current: undefined as undefined | ((target: string) => Promise<void>) },
  beforeLink: { current: undefined as undefined | ((temporary: string, target: string) => Promise<void>) },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: async (from: string, to: string) => {
    await beforeLink.current?.(from, to);
    await actual.link(from, to);
  }, rename: async (from: string, to: string) => {
    await actual.rename(from, to);
    await afterRename.current?.(to);
  } };
});

const roots: string[] = [];
const now = new Date('2026-10-09T00:00:00Z');
const bytes = new TextEncoder().encode('opaque legacy content; not parsed');
afterEach(async () => { vi.restoreAllMocks(); afterRename.current = undefined; beforeLink.current = undefined; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function seed(agentId = 'a') {
  const repoRoot = await mkdtemp(join(tmpdir(), 'routine-retirement-'));
  roots.push(repoRoot);
  const bus = new HookBus();
  registerWorkspaceGitHooks(bus, { repoRoot });
  const ctx = makeAgentContext({ sessionId: 'maintenance-test', agentId, userId: 'u' });
  const paths = ['.ax/routines/interval.md', '.ax/routines/cron.md', '.ax/routines/webhook.md', '.ax/routines/unsynced.md', '.ax/routines/nested/keep.md', '.ax/routines/keep.txt', '.ax/IDENTITY.md', '.ax/GOALS.md', '.ax/skill-reflection/last-run.json', 'user.txt'];
  await bus.call('workspace:apply-internal', ctx, { parent: null, changes: paths.map(path => ({ kind: 'put', path, content: bytes })) });
  const gitdir = join(repoRoot, `${workspaceIdForAgent(agentId)}.git`);
  return { repoRoot, gitdir, bus, ctx, paths, head: await git.resolveRef({ fs, gitdir, ref: 'HEAD' }) };
}

describe('offline routine file retirement', () => {
  it('dry-runs, deletes only direct markdown entries, preserves history and is idempotent even when quota is full', async () => {
    const s = await seed();
    const quota = vi.fn(() => { throw new Error('quota full'); });
    s.bus.registerService('workspace:check-quota', 'test', quota);
    expect(await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: true, now })).toEqual({ repositories: 1, removed: 4, failures: [] });
    expect(await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' })).toBe(s.head);
    expect(await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).toEqual({ repositories: 1, removed: 4, failures: [] });
    const head = await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' });
    expect((await git.readCommit({ fs, gitdir: s.gitdir, oid: head })).commit.parent).toEqual([s.head]);
    for (const path of s.paths.slice(4)) expect((await git.readBlob({ fs, gitdir: s.gitdir, oid: head, filepath: path })).blob).toEqual(bytes);
    expect((await git.readBlob({ fs, gitdir: s.gitdir, oid: s.head, filepath: s.paths[0]! })).blob).toEqual(bytes);
    expect(await git.listFiles({ fs, gitdir: s.gitdir, ref: head })).toEqual(s.paths.slice(4).sort());
    expect(await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).toEqual({ repositories: 1, removed: 0, failures: [] });
    expect(quota).not.toHaveBeenCalled();
  });
  it('refuses symlinks, unknown repository names and unexpected HEAD layouts without exposing contents', async () => {
    const s = await seed();
    await symlink(s.gitdir, join(s.repoRoot, 'ws-0000000000000000.git'));
    await mkdir(join(s.repoRoot, 'mystery.git'));
    await writeFile(join(s.gitdir, 'HEAD'), 'ref: refs/heads/other\n');
    const result = await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now });
    expect(result.removed).toBe(0);
    expect(result.failures.map(f => f.code).sort()).toEqual(['unexpected-layout', 'unexpected-repository', 'unsafe-path']);
    expect(JSON.stringify(result)).not.toContain('opaque legacy');
  });
  it('refuses a hashed directory with an unknown non-repository layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'routine-layout-')); roots.push(root);
    await mkdir(join(root, 'ws-0000000000000000.git'));
    expect(await retireRoutineFiles({ repoRoot: root, dryRun: false, now })).toEqual({ repositories: 0, removed: 0, failures: [{ repository: 'ws-0000000000000000.git', code: 'unexpected-layout' }] });
  });
  it('rejects a symlink inside a repository and a symlink root', async () => {
    const s = await seed();
    await symlink(s.gitdir, join(s.gitdir, 'objects', 'outside'));
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).failures[0]?.code).toBe('unsafe-path');
    const alias = join(s.repoRoot, 'alias');
    await symlink(s.repoRoot, alias);
    expect((await retireRoutineFiles({ repoRoot: alias, dryRun: true, now })).failures).toEqual([{ repository: '<root>', code: 'unsafe-path' }]);
    expect((await retireRoutineFiles({ repoRoot: 'relative', dryRun: true, now })).failures).toEqual([{ repository: '<root>', code: 'invalid-root' }]);
  });
  it.each(['HEAD', 'config', 'objects/ff', 'objects/pack', 'refs', 'refs/heads', 'refs/heads/main'])('refuses nested %s symlinks before reading or writing external targets', async path => {
    const s = await seed();
    const outside = await mkdtemp(join(tmpdir(), 'routine-outside-')); roots.push(outside);
    const target = join(outside, 'protected');
    await writeFile(target, 'external data remains unchanged');
    const candidate = join(s.gitdir, path);
    await rm(candidate, { recursive: true, force: true });
    await symlink(target, candidate);
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).failures).toEqual([{ repository: `${workspaceIdForAgent('a')}.git`, code: 'unsafe-path' }]);
    expect(await readFile(target, 'utf8')).toBe('external data remains unchanged');
  });
  it('respects an interrupted ref lock and retries after the operator clears it', async () => {
    const s = await seed();
    const lock = join(s.gitdir, 'refs/heads/main.lock');
    await writeFile(lock, 'interrupted');
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).failures[0]?.code).toBe('ref-locked');
    expect(await readFile(lock, 'utf8')).toBe('interrupted');
    expect(await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' })).toBe(s.head);
    await rm(lock);
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).removed).toBe(4);
  });
  it('does not remove a successor lock created after its atomic ref rename', async () => {
    const s = await seed();
    const lockPath = join(s.gitdir, 'refs/heads/main.lock');
    const refPath = join(await realpath(s.gitdir), 'refs/heads/main');
    afterRename.current = async target => { if (target === refPath) await writeFile(lockPath, 'successor'); };
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).removed).toBe(4);
    expect(await readFile(lockPath, 'utf8')).toBe('successor');
  });
  it('recovers after an interrupted object write without changing the old ref', async () => {
    const s = await seed();
    vi.spyOn(git, 'writeCommit').mockRejectedValueOnce(new Error('private failure detail'));
    expect(await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).toEqual({ repositories: 1, removed: 0, failures: [{ repository: `${workspaceIdForAgent('a')}.git`, code: 'maintenance-failed' }] });
    expect(await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' })).toBe(s.head);
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).removed).toBe(4);
  });
  it.each(['tree', 'commit'] as const)('refuses a truncated %s object left at its real OID by an interrupted write', async kind => {
    const s = await seed();
    const truncate = async (oid: string) => {
      const path = join(s.gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
      const original = await readFile(path);
      await writeFile(path, original.subarray(0, Math.max(1, Math.floor(original.length / 2))));
      throw new Error('simulated interruption after partial publication');
    };
    if (kind === 'tree') {
      const write = git.writeTree.bind(git);
      vi.spyOn(git, 'writeTree').mockImplementationOnce(async args => truncate(await write(args)));
    } else {
      const write = git.writeCommit.bind(git);
      vi.spyOn(git, 'writeCommit').mockImplementationOnce(async args => truncate(await write(args)));
    }
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).failures[0]?.code).toBe('maintenance-failed');
    expect(await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' })).toBe(s.head);
    const retry = await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now });
    expect(retry).toEqual({ repositories: 1, removed: 0, failures: [{ repository: `${workspaceIdForAgent('a')}.git`, code: 'invalid-object' }] });
    expect(await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' })).toBe(s.head);
    expect(await git.listFiles({ fs, gitdir: s.gitdir, ref: 'HEAD' })).toEqual(s.paths.slice().sort());
    expect((await git.readBlob({ fs, gitdir: s.gitdir, oid: s.head, filepath: '.ax/IDENTITY.md' })).blob).toEqual(bytes);
  });
  it.each(['tree', 'commit'] as const)('keeps interrupted %s publication private and retries to a readable head', async kind => {
    const s = await seed();
    let interruptedPath: string | undefined;
    let orphanPath: string | undefined;
    beforeLink.current = async (temporary, target) => {
      const compressed = await readFile(temporary);
      if (!inflateSync(compressed).toString().startsWith(`${kind} `)) return;
      // Simulate interruption after part of the staging file reaches disk.
      await writeFile(temporary, compressed.subarray(0, Math.floor(compressed.length / 2)));
      interruptedPath = target;
      orphanPath = `${temporary}-orphan`;
      // A hard-killed process cannot execute finally; leave its equivalent too.
      await writeFile(orphanPath, compressed.subarray(0, 1));
      throw new Error('simulated interrupted temporary object write');
    };
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).failures[0]?.code).toBe('maintenance-failed');
    expect(interruptedPath).toBeDefined();
    await expect(readFile(interruptedPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' })).toBe(s.head);
    beforeLink.current = undefined;
    expect(await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).toEqual({ repositories: 1, removed: 4, failures: [] });
    const head = await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' });
    expect((await git.readCommit({ fs, gitdir: s.gitdir, oid: head })).commit.parent).toEqual([s.head]);
    expect(await git.listFiles({ fs, gitdir: s.gitdir, ref: head })).toEqual(s.paths.slice(4).sort());
    for (const path of s.paths.slice(4)) expect((await git.readBlob({ fs, gitdir: s.gitdir, oid: head, filepath: path })).blob).toEqual(bytes);
    expect((await readFile(orphanPath!)).length).toBe(1);
  });
  it('recognizes empty bare agent repositories without inventing a first commit', async () => {
    const s = await seed();
    const empty = join(s.repoRoot, `${workspaceIdForAgent('empty')}.git`);
    await git.init({ fs, gitdir: empty, bare: true, defaultBranch: 'main' });
    expect(await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: true, now })).toEqual({ repositories: 2, removed: 4, failures: [] });
  });
  it('fails closed if the active ref changes while preparing the deletion commit', async () => {
    const s = await seed();
    const writeCommit = git.writeCommit.bind(git);
    let changedHead: string | undefined;
    vi.spyOn(git, 'writeCommit').mockImplementationOnce(async args => {
      const oid = await writeCommit({ ...args, commit: { ...args.commit, message: 'other writer' } });
      changedHead = oid;
      await git.writeRef({ fs, gitdir: s.gitdir, ref: 'refs/heads/main', value: oid, force: true });
      return oid;
    });
    expect((await retireRoutineFiles({ repoRoot: s.repoRoot, dryRun: false, now })).failures[0]?.code).toBe('ref-changed');
    expect(await git.resolveRef({ fs, gitdir: s.gitdir, ref: 'HEAD' })).toBe(changedHead);
  });
});
