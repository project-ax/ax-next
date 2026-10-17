import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import type {
  DeleteSharedFolderInput,
  DeleteSharedFolderOutput,
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  MountSpec,
} from '@ax/sandbox-mount-protocol';
import { createWorkspaceLocaldirPlugin } from '@ax/workspace-localdir';
import { createSandboxSubprocessPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// W2 shared folders — `sandbox:delete-shared-folder` (design §3.7).
//
// The subprocess provider realizes a folder DELETE: it asks the mount resolver
// WHERE the folder lives (`sandbox:locate-shared-folder`, no grant check — by
// then the grants are gone) and `rm -rf`s that one directory. The location is a
// bus answer from ANOTHER plugin, so the provider treats it as untrusted: it
// must be exactly `<root>/.shared/<the requested id>`, or nothing is deleted.
// A delete that did not happen THROWS (the caller keeps its tombstone and
// retries); "already gone" is a success.
// ---------------------------------------------------------------------------

const PLUGIN = '@ax/sandbox-subprocess';
const F1 = 'sf_AAAA1111';
const F2 = 'sf_BBBB-2222_x';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-del-root-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-del-outside-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
});

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'agt_abc', userId: 'u1' });
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

async function write(p: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, contents);
}

/** The provider on a bus with the REAL localdir resolver (and so the real locate). */
async function busWithRealResolver(): Promise<HookBus> {
  const bus = new HookBus();
  await createWorkspaceLocaldirPlugin({ root }).init({ bus, config: {} });
  await createSandboxSubprocessPlugin().init({ bus, config: {} });
  return bus;
}

/** The provider on a bus whose `sandbox:locate-shared-folder` answers `mount` (a hostile/buggy resolver). */
async function busWithLocate(
  answer: (folderId: string) => MountSpec,
): Promise<{ bus: HookBus; locate: ReturnType<typeof vi.fn> }> {
  const bus = new HookBus();
  const locate = vi.fn(async (_c: unknown, input: LocateSharedFolderInput) => ({
    mount: answer(input.folderId),
  }));
  bus.registerService<LocateSharedFolderInput, LocateSharedFolderOutput>(
    'sandbox:locate-shared-folder',
    'mock-resolver',
    locate,
  );
  await createSandboxSubprocessPlugin().init({ bus, config: {} });
  return { bus, locate };
}

function del(bus: HookBus, input: unknown): Promise<DeleteSharedFolderOutput> {
  return bus.call<DeleteSharedFolderInput, DeleteSharedFolderOutput>(
    'sandbox:delete-shared-folder',
    ctx(),
    input as DeleteSharedFolderInput,
  );
}

describe('manifest', () => {
  it('registers sandbox:delete-shared-folder and declares the locate hook as an optional call', () => {
    const { manifest } = createSandboxSubprocessPlugin();
    expect(manifest.registers).toContain('sandbox:delete-shared-folder');
    const locate = manifest.optionalCalls?.find((c) => c.hook === 'sandbox:locate-shared-folder');
    expect(locate).toBeDefined();
    // A degradation sentence is mandatory for an optional call; it must say
    // what happens WITHOUT the resolver (the delete throws, it does not skip).
    expect(locate!.degradation.length).toBeGreaterThan(20);
  });

  it('registers the service at init', async () => {
    const bus = new HookBus();
    await createSandboxSubprocessPlugin().init({ bus, config: {} });
    expect(bus.hasService('sandbox:delete-shared-folder')).toBe(true);
  });
});

describe('sandbox:delete-shared-folder', () => {
  it('removes the folder directory and ONLY it (sibling folder, agent files, .shared survive)', async () => {
    const bus = await busWithRealResolver();
    await write(path.join(root, '.shared', F1, 'a.txt'), 'a');
    await write(path.join(root, '.shared', F1, 'sub', 'deep', 'b.txt'), 'b');
    await write(path.join(root, '.shared', F2, 'keep.txt'), 'keep');
    await write(path.join(root, 'agt_x', 'own.txt'), 'own');

    expect(await del(bus, { folderId: F1 })).toEqual({ deleted: true });

    expect(await exists(path.join(root, '.shared', F1))).toBe(false);
    expect(await fs.readFile(path.join(root, '.shared', F2, 'keep.txt'), 'utf-8')).toBe('keep');
    expect(await fs.readFile(path.join(root, 'agt_x', 'own.txt'), 'utf-8')).toBe('own');
    expect(await exists(path.join(root, '.shared'))).toBe(true);
  });

  it('is idempotent: a folder that is already gone (or never existed) is a success', async () => {
    const bus = await busWithRealResolver();
    // Neither `.shared` nor the folder exists.
    expect(await del(bus, { folderId: F1 })).toEqual({ deleted: true });
    // `.shared` exists, the folder does not.
    await write(path.join(root, '.shared', F2, 'keep.txt'), 'keep');
    expect(await del(bus, { folderId: F1 })).toEqual({ deleted: true });
    expect(await exists(path.join(root, '.shared', F2, 'keep.txt'))).toBe(true);
  });

  it('asks the resolver to locate exactly the requested folder', async () => {
    const { bus, locate } = await busWithLocate((folderId) => ({
      kind: 'localDir',
      mountPath: `/shared/${folderId}`,
      hostPath: path.join(root, '.shared', folderId),
      readOnly: false,
      role: 'shared-folder',
      folderId,
    }));
    await write(path.join(root, '.shared', F1, 'a.txt'), 'a');
    await del(bus, { folderId: F1 });
    expect(locate).toHaveBeenCalledTimes(1);
    expect(locate.mock.calls[0]![1]).toEqual({ folderId: F1 });
    expect(await exists(path.join(root, '.shared', F1))).toBe(false);
  });

  describe('refuses an invalid folder id before locating or deleting anything', () => {
    const bad: unknown[] = [
      '../x',
      '..',
      '.shared',
      'sf_a/b',
      'sf_',
      '',
      'agt_abc',
      `sf_${'a'.repeat(65)}`,
      42,
      null,
      undefined,
      {},
    ];
    it.each(bad.map((b) => [JSON.stringify(b) ?? 'undefined', b] as const))(
      'folderId %s',
      async (_label, folderId) => {
        const { bus, locate } = await busWithLocate(() => {
          throw new Error('locate must not be called');
        });
        await write(path.join(root, '.shared', F1, 'a.txt'), 'a');
        const caught = await del(bus, { folderId }).catch((e: unknown) => e);
        expect(caught).toBeInstanceOf(PluginError);
        expect((caught as PluginError).code).toBe('invalid-folder-id');
        expect((caught as PluginError).plugin).toBe(PLUGIN);
        expect(locate).not.toHaveBeenCalled();
        expect(await exists(path.join(root, '.shared', F1, 'a.txt'))).toBe(true);
      },
    );

    it('a missing input object', async () => {
      const { bus } = await busWithLocate(() => {
        throw new Error('locate must not be called');
      });
      const caught = await del(bus, undefined).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('invalid-folder-id');
    });
  });

  it('throws no-mount-resolver when nothing registers sandbox:locate-shared-folder (never a silent success)', async () => {
    const bus = new HookBus();
    await createSandboxSubprocessPlugin().init({ bus, config: {} });
    await write(path.join(root, '.shared', F1, 'a.txt'), 'a');
    const caught = await del(bus, { folderId: F1 }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('no-mount-resolver');
    expect(await exists(path.join(root, '.shared', F1, 'a.txt'))).toBe(true);
  });

  describe('refuses a located path that is not exactly <root>/.shared/<requested id>', () => {
    // Every case leaves a victim at the "wrong" location; the delete must throw
    // and every victim must survive.
    const victims = () => [
      path.join(root, 'agt_x', 'own.txt'),
      path.join(root, '.shared', 'sf_other', 'keep.txt'),
      path.join(root, '.shared', F1, 'a.txt'),
      path.join(root, 'top.txt'),
    ];
    async function seedVictims(): Promise<void> {
      for (const v of victims()) await write(v, 'x');
    }

    const cases: Array<[string, (id: string) => MountSpec, string?]> = [
      [
        'the agent user-files dir',
        () => ({
          kind: 'localDir',
          mountPath: '/files',
          hostPath: path.join(root, 'agt_x'),
          readOnly: false,
          role: 'user-files',
        }),
      ],
      [
        'a shared-folder mount whose hostPath is the agent dir',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: path.join(root, 'agt_x'),
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
      [
        'a different folder under .shared',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: path.join(root, '.shared', 'sf_other'),
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
      [
        'a mount for a different folderId (consistent, but not the requested one)',
        () => ({
          kind: 'localDir',
          mountPath: '/shared/sf_other',
          hostPath: path.join(root, '.shared', 'sf_other'),
          readOnly: false,
          role: 'shared-folder',
          folderId: 'sf_other',
        }),
      ],
      [
        'the .shared directory itself',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: path.join(root, '.shared'),
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
      [
        'the root itself',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: root,
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
      [
        'a relative path',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: `.shared/${id}`,
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
      [
        'a non-normalized path (..)',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: `${root}/agt_x/../.shared/${id}`,
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
      [
        'a path with a trailing slash',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: `${root}/.shared/${id}/`,
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
      [
        'a path one level too deep',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: path.join(root, '.shared', id, 'sub'),
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
      [
        'the right path with the wrong role',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: path.join(root, '.shared', id),
          readOnly: false,
          role: 'user-files',
          // Even carrying a matching folderId, only a shared-folder mount is
          // something this provider will delete.
          folderId: id,
        }),
      ],
      [
        'the right path with no folderId',
        (id) => ({
          kind: 'localDir',
          mountPath: `/shared/${id}`,
          hostPath: path.join(root, '.shared', id),
          readOnly: false,
          role: 'shared-folder',
        }),
      ],
      [
        'the right path with a mismatched mountPath',
        (id) => ({
          kind: 'localDir',
          mountPath: '/files',
          hostPath: path.join(root, '.shared', id),
          readOnly: false,
          role: 'shared-folder',
          folderId: id,
        }),
      ],
    ];

    it.each(cases.map((c) => [c[0], c[1]] as const))('%s', async (_label, answer) => {
      await seedVictims();
      const { bus } = await busWithLocate(answer);
      const caught = await del(bus, { folderId: F1 }).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('unsafe-shared-folder-location');
      expect((caught as PluginError).plugin).toBe(PLUGIN);
      for (const v of victims()) expect(await exists(v)).toBe(true);
    });

    it('an nfs location is unrealizable here (a mis-wired preset), not silently skipped', async () => {
      await seedVictims();
      const { bus } = await busWithLocate((id) => ({
        kind: 'nfs',
        mountPath: `/shared/${id}`,
        server: '10.0.0.2',
        exportPath: '/vol1/agents',
        subPath: `.shared/${id}`,
        readOnly: false,
        role: 'shared-folder',
        folderId: id,
      }));
      const caught = await del(bus, { folderId: F1 }).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('unrealizable-mount-kind');
      for (const v of victims()) expect(await exists(v)).toBe(true);
    });
  });

  describe('never follows a symlink out of the root', () => {
    it('a symlinked FOLDER directory: only the link is removed, its target is untouched', async () => {
      const bus = await busWithRealResolver();
      await write(path.join(outside, 'target', 'precious.txt'), 'precious');
      await fs.mkdir(path.join(root, '.shared'), { recursive: true });
      await fs.symlink(path.join(outside, 'target'), path.join(root, '.shared', F1));

      expect(await del(bus, { folderId: F1 })).toEqual({ deleted: true });

      expect(await exists(path.join(root, '.shared', F1))).toBe(false);
      expect(await fs.readFile(path.join(outside, 'target', 'precious.txt'), 'utf-8')).toBe(
        'precious',
      );
    });

    it('a symlinked .shared directory: refuses, and the target folder survives', async () => {
      const bus = await busWithRealResolver();
      await write(path.join(outside, F1, 'precious.txt'), 'precious');
      await fs.symlink(outside, path.join(root, '.shared'));

      const caught = await del(bus, { folderId: F1 }).catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('unsafe-shared-folder-location');
      expect(await fs.readFile(path.join(outside, F1, 'precious.txt'), 'utf-8')).toBe('precious');
    });

    it('a symlink INSIDE the folder is unlinked, not followed', async () => {
      const bus = await busWithRealResolver();
      await write(path.join(outside, 'precious.txt'), 'precious');
      await fs.mkdir(path.join(root, '.shared', F1), { recursive: true });
      await fs.symlink(outside, path.join(root, '.shared', F1, 'escape'));

      await del(bus, { folderId: F1 });

      expect(await exists(path.join(root, '.shared', F1))).toBe(false);
      expect(await fs.readFile(path.join(outside, 'precious.txt'), 'utf-8')).toBe('precious');
    });

    it('.shared that is a regular file is refused, not "deleted"', async () => {
      const bus = await busWithRealResolver();
      await write(path.join(root, '.shared'), 'i am a file');
      const caught = await del(bus, { folderId: F1 }).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('unsafe-shared-folder-location');
      expect(await fs.readFile(path.join(root, '.shared'), 'utf-8')).toBe('i am a file');
    });
  });
});
