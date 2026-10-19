import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import type {
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  MountSpec,
  ScanSharedFolderInput,
  ScanSharedFolderOutput,
} from '@ax/sandbox-mount-protocol';
import { SCAN_SHARED_FOLDER_MAX_ENTRIES } from '@ax/sandbox-mount-protocol';
import { MAX_WALK_ENTRIES, WalkPathError, WalkReadError } from '@ax/user-files-read';
import { createWorkspaceLocaldirPlugin } from '@ax/workspace-localdir';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import { scanSharedFolder } from '../shared-folders.js';

// ---------------------------------------------------------------------------
// W3d — `sandbox:scan-shared-folder` on the subprocess (dev) provider.
//
// Same location rules as the read (the resolver's answer must be exactly
// `<root>/.shared/<id>`), then `scanConfinedByWalk` from `<root>`. Linux-only
// walk; on macOS the hook answers `unavailable`. Error mapping is tested
// everywhere with an injected walk.
// ---------------------------------------------------------------------------

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const PLUGIN = '@ax/sandbox-subprocess';
const F1 = 'sf_AAAA1111';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-scan-root-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'agt_abc', userId: 'u1' });
}

function sharedMount(folderId: string, hostPath = path.join(root, '.shared', folderId)): MountSpec {
  return {
    kind: 'localDir',
    mountPath: `/shared/${folderId}`,
    hostPath,
    readOnly: false,
    role: 'shared-folder',
    folderId,
  };
}

function busLocating(answer: (folderId: string) => MountSpec): HookBus {
  const bus = new HookBus();
  bus.registerService<LocateSharedFolderInput, LocateSharedFolderOutput>(
    'sandbox:locate-shared-folder',
    'mock-resolver',
    async (_c, input) => ({ mount: answer(input.folderId) }),
  );
  return bus;
}

const doneOut = {
  kind: 'done' as const,
  files: [{ path: 'a.md', size: 1, mtimeMs: 2, ino: 3 }],
  truncated: false,
};

describe('scanSharedFolder (subprocess)', () => {
  it('the default/ceiling matches the protocol constant', () => {
    expect(MAX_WALK_ENTRIES).toBe(SCAN_SHARED_FOLDER_MAX_ENTRIES);
  });

  it('answers unavailable when no resolver can locate folders', async () => {
    const walk = vi.fn();
    expect(await scanSharedFolder(ctx(), new HookBus(), PLUGIN, { folderId: F1 }, walk)).toEqual({
      kind: 'unavailable',
    });
    expect(walk).not.toHaveBeenCalled();
  });

  it.each([['../x'], ['.shared'], ['sf_a/b'], [7]])(
    'SECURITY: refuses folderId %j with invalid-payload, before locating or walking',
    async (folderId) => {
      const walk = vi.fn();
      const locate = vi.fn(sharedMount);
      const err = await scanSharedFolder(
        ctx(),
        busLocating(locate),
        PLUGIN,
        { folderId: folderId as string },
        walk,
      ).catch((e: unknown) => e);
      expect((err as PluginError).code).toBe('invalid-payload');
      expect(locate).not.toHaveBeenCalled();
      expect(walk).not.toHaveBeenCalled();
    },
  );

  it.each([[0], [-1], [2.5], [10_001], ['5']])(
    'refuses maxEntries %j with invalid-payload, before locating or walking',
    async (maxEntries) => {
      const walk = vi.fn();
      const locate = vi.fn(sharedMount);
      const err = await scanSharedFolder(
        ctx(),
        busLocating(locate),
        PLUGIN,
        { folderId: F1, maxEntries: maxEntries as number },
        walk,
      ).catch((e: unknown) => e);
      expect((err as PluginError).code).toBe('invalid-payload');
      expect(locate).not.toHaveBeenCalled();
      expect(walk).not.toHaveBeenCalled();
    },
  );

  it('walks [.shared, id] from the root above .shared, 10,000 files by default', async () => {
    const walk = vi.fn(async () => doneOut);
    expect(await scanSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1 }, walk)).toEqual(
      doneOut,
    );
    expect(walk).toHaveBeenCalledWith(root, ['.shared', F1], { maxEntries: 10_000 });
    await scanSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, maxEntries: 4 }, walk);
    expect(walk).toHaveBeenLastCalledWith(root, ['.shared', F1], { maxEntries: 4 });
  });

  it.each([
    ['another folder', () => sharedMount('sf_other', path.join(root, '.shared', 'sf_other'))],
    ['a path outside .shared', () => sharedMount(F1, path.join(root, 'agents', F1))],
    ['a non-normalized path', () => sharedMount(F1, `${root}/x/../.shared/${F1}`)],
  ])('SECURITY: refuses a located %s without walking', async (_label, located) => {
    const walk = vi.fn();
    const err = await scanSharedFolder(ctx(), busLocating(located), PLUGIN, { folderId: F1 }, walk).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('unsafe-shared-folder-location');
    expect(walk).not.toHaveBeenCalled();
  });

  it('refuses an nfs location (a mis-wired preset)', async () => {
    const walk = vi.fn();
    const bus = busLocating((folderId) => ({
      kind: 'nfs',
      mountPath: `/shared/${folderId}`,
      server: '10.0.0.2',
      exportPath: '/vol',
      subPath: `.shared/${folderId}`,
      readOnly: false,
      role: 'shared-folder',
      folderId,
    }));
    const err = await scanSharedFolder(ctx(), bus, PLUGIN, { folderId: F1 }, walk).catch((e: unknown) => e);
    expect((err as PluginError).code).toBe('unrealizable-mount-kind');
    expect(walk).not.toHaveBeenCalled();
  });

  it('a missing folder is an empty, complete scan', async () => {
    const walk = vi.fn(async () => ({ kind: 'absent' as const, reason: 'missing' as const }));
    expect(await scanSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1 }, walk)).toEqual({
      kind: 'done',
      files: [],
      truncated: false,
    });
  });

  it('a folder whose name is a link or a file throws, never an empty scan', async () => {
    const walk = vi.fn(async () => ({ kind: 'absent' as const, reason: 'link-or-not-dir' as const }));
    await expect(
      scanSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1 }, walk),
    ).rejects.toMatchObject({ code: 'unsafe-shared-folder-location' });
  });

  it('a WalkPathError is invalid-payload', async () => {
    const walk = vi.fn(async () => {
      throw new WalkPathError('path is too deep');
    });
    await expect(
      scanSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1 }, walk),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('a platform with no /proc walk answers unavailable', async () => {
    const walk = vi.fn(async () => {
      throw new WalkReadError('no /proc', { code: 'unsupported-platform', depth: -1 });
    });
    expect(await scanSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1 }, walk)).toEqual({
      kind: 'unavailable',
    });
  });

  it('a failed scan (EACCES, EIO) throws — it is not an empty folder', async () => {
    for (const code of ['EACCES', 'EIO']) {
      const walk = vi.fn(async () => {
        throw new WalkReadError(`(${code})`, { code, depth: 1 });
      });
      await expect(
        scanSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1 }, walk),
      ).rejects.toMatchObject({ code });
    }
  });
});

describe('sandbox:scan-shared-folder through the bus, with the real localdir resolver', () => {
  async function bus(): Promise<HookBus> {
    const b = new HookBus();
    await createWorkspaceLocaldirPlugin({ root }).init({ bus: b, config: {} });
    await createSandboxSubprocessPlugin().init({ bus: b, config: {} });
    return b;
  }
  const scan = async (b: HookBus, input: ScanSharedFolderInput) =>
    b.call<ScanSharedFolderInput, ScanSharedFolderOutput>('sandbox:scan-shared-folder', ctx(), input);

  it('declares the service in registers', () => {
    expect(createSandboxSubprocessPlugin().manifest.registers).toContain('sandbox:scan-shared-folder');
  });

  it.skipIf(ON_LINUX)('answers unavailable off Linux (the walk needs /proc)', async () => {
    await fs.mkdir(path.join(root, '.shared', F1), { recursive: true });
    expect(await scan(await bus(), { folderId: F1 })).toEqual({ kind: 'unavailable' });
  });

  describe.skipIf(!ON_LINUX)('on Linux (/proc; runs in CI)', () => {
    it('scans recursively, sorted, and never follows a planted link', async () => {
      const folder = path.join(root, '.shared', F1);
      await fs.mkdir(path.join(folder, 'memory'), { recursive: true });
      await fs.writeFile(path.join(folder, 'memory', 'status.md'), 'all good');
      await fs.writeFile(path.join(folder, 'README.md'), 'hi');
      await fs.mkdir(path.join(root, 'outside'));
      await fs.writeFile(path.join(root, 'outside', 'SECRET'), 'x');
      await fs.symlink(path.join(root, 'outside'), path.join(folder, 'up'));
      await fs.symlink(path.join(root, 'outside', 'SECRET'), path.join(folder, 'leak'));
      const out = await scan(await bus(), { folderId: F1 });
      if (out.kind !== 'done') throw new Error(`expected done, got ${out.kind}`);
      expect(out.truncated).toBe(false);
      expect(out.files.map((f) => [f.path, f.size])).toEqual([
        ['README.md', 2],
        ['memory/status.md', 8],
      ]);
    });

    it('a folder never written is done with no files', async () => {
      expect(await scan(await bus(), { folderId: F1 })).toEqual({
        kind: 'done',
        files: [],
        truncated: false,
      });
    });

    it('SECURITY: a symlinked folder directory throws, never scans through', async () => {
      await fs.mkdir(path.join(root, '.shared'), { recursive: true });
      await fs.writeFile(path.join(root, 'SECRET'), 'x');
      await fs.symlink(root, path.join(root, '.shared', F1));
      await expect(scan(await bus(), { folderId: F1 })).rejects.toMatchObject({
        code: 'unsafe-shared-folder-location',
      });
    });
  });
});
