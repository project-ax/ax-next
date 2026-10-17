import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import type {
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  MountSpec,
  ReadSharedFolderInput,
  ReadSharedFolderOutput,
} from '@ax/sandbox-mount-protocol';
import { WalkReadError } from '@ax/user-files-read';
import { createWorkspaceLocaldirPlugin } from '@ax/workspace-localdir';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import { readSharedFolder } from '../shared-folders.js';

// ---------------------------------------------------------------------------
// W3b — `sandbox:read-shared-folder` on the subprocess (dev) provider.
//
// The folder's location comes from the resolver's `sandbox:locate-shared-folder`
// and must be exactly `<root>/.shared/<id>`. The walk then starts at `<root>`
// (trusted) and opens `.shared`, `<id>` and every caller component with
// O_NOFOLLOW, so a symlink planted anywhere in the folder is never followed.
// The walk is Linux-only (/proc): on macOS the hook answers `unavailable`.
// Error mapping is tested everywhere with an injected walk.
// ---------------------------------------------------------------------------

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const PLUGIN = '@ax/sandbox-subprocess';
const F1 = 'sf_AAAA1111';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-read-root-')));
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

const fileOut = {
  kind: 'file' as const,
  contents: new Uint8Array([1]),
  truncated: false,
  size: 1,
};

describe('readSharedFolder (subprocess)', () => {
  it('answers unavailable when no resolver can locate folders', async () => {
    const walk = vi.fn();
    const out = await readSharedFolder(ctx(), new HookBus(), PLUGIN, { folderId: F1, limitBytes: 1 }, walk);
    expect(out).toEqual({ kind: 'unavailable' });
    expect(walk).not.toHaveBeenCalled();
  });

  it.each([['../x'], ['.shared'], ['sf_a/b'], [7]])(
    'SECURITY: refuses folderId %j with invalid-payload, before locating or walking',
    async (folderId) => {
      const walk = vi.fn();
      const locate = vi.fn(sharedMount);
      const err = await readSharedFolder(
        ctx(),
        busLocating(locate),
        PLUGIN,
        { folderId: folderId as string, limitBytes: 1 },
        walk,
      ).catch((e: unknown) => e);
      expect((err as PluginError).code).toBe('invalid-payload');
      expect(locate).not.toHaveBeenCalled();
      expect(walk).not.toHaveBeenCalled();
    },
  );

  it.each([['../sf_other'], ['/etc/passwd'], ['a//b'], ['a/']])(
    'SECURITY: refuses relPath %j with invalid-payload, before walking',
    async (relPath) => {
      const walk = vi.fn();
      const err = await readSharedFolder(
        ctx(),
        busLocating(sharedMount),
        PLUGIN,
        { folderId: F1, relPath, limitBytes: 1 },
        walk,
      ).catch((e: unknown) => e);
      expect((err as PluginError).code).toBe('invalid-payload');
      expect(walk).not.toHaveBeenCalled();
    },
  );

  it('walks .shared/<id>/<rel> from the root above .shared, with the caller limits', async () => {
    const walk = vi.fn(async () => fileOut);
    const out = await readSharedFolder(
      ctx(),
      busLocating(sharedMount),
      PLUGIN,
      { folderId: F1, relPath: 'memory/status.md', limitBytes: 9, maxEntries: 3 },
      walk,
    );
    expect(out).toEqual(fileOut);
    expect(walk).toHaveBeenCalledWith(root, ['.shared', F1, 'memory', 'status.md'], {
      limitBytes: 9,
      maxEntries: 3,
    });
  });

  it('defaults to the folder root and a 5000-entry listing cap', async () => {
    const walk = vi.fn(async () => ({ kind: 'dir' as const, entries: [], truncated: false }));
    await readSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, limitBytes: 1 }, walk);
    expect(walk).toHaveBeenCalledWith(root, ['.shared', F1], { limitBytes: 1, maxEntries: 5000 });
  });

  it.each([
    ['another folder', () => sharedMount('sf_other', path.join(root, '.shared', 'sf_other'))],
    ['a path outside .shared', () => sharedMount(F1, path.join(root, 'agents', F1))],
    ['a non-normalized path', () => sharedMount(F1, `${root}/x/../.shared/${F1}`)],
  ])('SECURITY: refuses a located %s without walking', async (_label, located) => {
    const walk = vi.fn();
    const err = await readSharedFolder(
      ctx(),
      busLocating(located),
      PLUGIN,
      { folderId: F1, limitBytes: 1 },
      walk,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('unsafe-shared-folder-location');
    expect(walk).not.toHaveBeenCalled();
  });

  it('refuses an nfs location (a mis-wired preset) rather than answering', async () => {
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
    const err = await readSharedFolder(ctx(), bus, PLUGIN, { folderId: F1, limitBytes: 1 }, walk).catch(
      (e: unknown) => e,
    );
    expect((err as PluginError).code).toBe('unrealizable-mount-kind');
    expect(walk).not.toHaveBeenCalled();
  });

  it('answers a bare absent (no reason for the caller)', async () => {
    const walk = vi.fn(async () => ({ kind: 'absent' as const, reason: 'link-or-not-dir' as const }));
    const out = await readSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, limitBytes: 1 }, walk);
    expect(out).toEqual({ kind: 'absent' });
  });

  it('a platform with no /proc walk answers unavailable', async () => {
    const walk = vi.fn(async () => {
      throw new WalkReadError('no /proc', { code: 'unsupported-platform', depth: -1 });
    });
    const out = await readSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, limitBytes: 1 }, walk);
    expect(out).toEqual({ kind: 'unavailable' });
  });

  it('a failed read (EACCES, EIO) throws — it is not an absence', async () => {
    for (const code of ['EACCES', 'EIO']) {
      const walk = vi.fn(async () => {
        throw new WalkReadError(`(${code})`, { code, depth: 1 });
      });
      await expect(
        readSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, limitBytes: 1 }, walk),
      ).rejects.toMatchObject({ code });
    }
  });
});

describe('sandbox:read-shared-folder through the bus, with the real localdir resolver', () => {
  async function bus(): Promise<HookBus> {
    const b = new HookBus();
    await createWorkspaceLocaldirPlugin({ root }).init({ bus: b, config: {} });
    await createSandboxSubprocessPlugin().init({ bus: b, config: {} });
    return b;
  }
  const read = async (b: HookBus, input: ReadSharedFolderInput) =>
    b.call<ReadSharedFolderInput, ReadSharedFolderOutput>('sandbox:read-shared-folder', ctx(), input);

  it('declares the service in registers', () => {
    expect(createSandboxSubprocessPlugin().manifest.registers).toContain('sandbox:read-shared-folder');
  });

  it.skipIf(ON_LINUX)('answers unavailable off Linux (the walk needs /proc)', async () => {
    await fs.mkdir(path.join(root, '.shared', F1), { recursive: true });
    expect(await read(await bus(), { folderId: F1, limitBytes: 10 })).toEqual({ kind: 'unavailable' });
  });

  describe.skipIf(!ON_LINUX)('on Linux (/proc; runs in CI)', () => {
    async function seed(): Promise<void> {
      const folder = path.join(root, '.shared', F1);
      await fs.mkdir(path.join(folder, 'memory'), { recursive: true });
      await fs.writeFile(path.join(folder, 'memory', 'status.md'), 'all good');
      await fs.writeFile(path.join(root, 'SECRET'), 'SECRET-do-not-return');
    }

    it('reads a file and lists a directory', async () => {
      await seed();
      const b = await bus();
      const file = await read(b, { folderId: F1, relPath: 'memory/status.md', limitBytes: 100 });
      if (file.kind !== 'file') throw new Error(`expected file, got ${file.kind}`);
      expect(Buffer.from(file.contents).toString()).toBe('all good');
      expect(file).toMatchObject({ truncated: false, size: 8 });
      const dir = await read(b, { folderId: F1, limitBytes: 100 });
      if (dir.kind !== 'dir') throw new Error(`expected dir, got ${dir.kind}`);
      expect(dir.entries).toEqual([{ name: 'memory', kind: 'dir' }]);
    });

    it('a folder never written is absent', async () => {
      expect(await read(await bus(), { folderId: F1, limitBytes: 1 })).toEqual({ kind: 'absent' });
    });

    it('SECURITY: symlinks in the folder are absent, never followed', async () => {
      await seed();
      const folder = path.join(root, '.shared', F1);
      await fs.symlink(path.join(root, 'SECRET'), path.join(folder, 'leak'));
      await fs.symlink(root, path.join(folder, 'up'));
      const b = await bus();
      expect(await read(b, { folderId: F1, relPath: 'leak', limitBytes: 100 })).toEqual({ kind: 'absent' });
      expect(await read(b, { folderId: F1, relPath: 'up/SECRET', limitBytes: 100 })).toEqual({ kind: 'absent' });
    });

    it('SECURITY: a symlinked folder directory is absent', async () => {
      await fs.mkdir(path.join(root, '.shared'), { recursive: true });
      await fs.writeFile(path.join(root, 'SECRET'), 'SECRET-do-not-return');
      await fs.symlink(root, path.join(root, '.shared', F1));
      expect(await read(await bus(), { folderId: F1, relPath: 'SECRET', limitBytes: 100 })).toEqual({
        kind: 'absent',
      });
    });
  });
});
