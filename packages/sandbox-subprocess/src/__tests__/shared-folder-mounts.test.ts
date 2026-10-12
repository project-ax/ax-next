import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import type {
  LocalDirMountSpec,
  MountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import {
  SHARED_FOLDERS_DIR as PROTOCOL_SHARED_FOLDERS_DIR,
  SHARED_FOLDERS_MOUNT_BASE as PROTOCOL_SHARED_FOLDERS_MOUNT_BASE,
} from '@ax/sandbox-mount-protocol';
import {
  resolveUserFilesMount,
  type ResolveMountsOwner,
} from '../resolve-user-files-mount.js';
import { SHARED_FOLDERS_DIR, SHARED_FOLDERS_MOUNT_BASE } from '../shared-folders.js';
import {
  cleanupUserFiles,
  ownerFromAgentId,
  readUserFiles,
} from '../user-files-host-ops.js';

// ---------------------------------------------------------------------------
// W2 shared folders — the subprocess provider's REALIZATION of `shared-folder`
// mounts (design §3.5-§3.8).
//
// `resolveUserFilesMount` is where a session's resolver output becomes
// directories on the host + the runner's env. The resolver is a separate
// plugin, so everything it returns about a shared folder is re-validated here
// (a drifted or compromised resolver must fail the session open, never widen
// what gets mkdir'd/handed to a runner). The same file pins that the
// `user-files` lookups (session open, host-read, agent-delete cleanup) match on
// `role` — shared-folder mounts now sit in the same list, and "the first mount"
// is no longer the agent's own files.
// ---------------------------------------------------------------------------

const PLUGIN = '@ax/sandbox-subprocess';
const F1 = 'sf_AAAA1111';
const F2 = 'sf_BBBB-2222_x';

const OWNER: ResolveMountsOwner = {
  userId: 'u1',
  agentId: 'agt_abc',
  agentConfig: {
    displayName: 'A',
    systemPromptAugment: '',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude',
    runner: 'claude-sdk',
  },
};

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'agt_abc', userId: 'u1' });
}

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-mounts-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

const userFiles = (): LocalDirMountSpec => ({
  kind: 'localDir',
  mountPath: '/files',
  hostPath: path.join(root, 'agt_abc'),
  readOnly: false,
  role: 'user-files',
});

const shared = (
  folderId: string,
  readOnly = false,
  over: Partial<LocalDirMountSpec> = {},
): LocalDirMountSpec => ({
  kind: 'localDir',
  mountPath: `/shared/${folderId}`,
  hostPath: path.join(root, '.shared', folderId),
  readOnly,
  role: 'shared-folder',
  folderId,
  ...over,
});

/** A resolver stub that records each input and answers `out`. */
function busWithResolver(out: MountSpec[]): { bus: HookBus; inputs: ResolveMountsInput[] } {
  const bus = new HookBus();
  const inputs: ResolveMountsInput[] = [];
  bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
    'sandbox:resolve-mounts',
    'mock-resolver',
    async (_c, input) => {
      inputs.push(input);
      return { mounts: out };
    },
  );
  return { bus, inputs };
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

describe('resolveUserFilesMount — shared folders', () => {
  it('the local path constants equal the protocol constants (no drift)', () => {
    // Plugins may only `import type` from @ax/sandbox-mount-protocol, so this
    // package keeps local copies of the two runtime values; this is the check
    // that a rename there cannot silently move a mount here.
    expect(SHARED_FOLDERS_DIR).toBe(PROTOCOL_SHARED_FOLDERS_DIR);
    expect(SHARED_FOLDERS_MOUNT_BASE).toBe(PROTOCOL_SHARED_FOLDERS_MOUNT_BASE);
  });

  it('passes the requested sharedFolderIds through to sandbox:resolve-mounts', async () => {
    const { bus, inputs } = busWithResolver([userFiles(), shared(F1), shared(F2)]);
    await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, async () => undefined, [F1, F2]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.sharedFolderIds).toEqual([F1, F2]);
  });

  it('omits the sharedFolderIds key entirely when none are requested', async () => {
    const { bus, inputs } = busWithResolver([userFiles()]);
    await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, async () => undefined);
    await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, async () => undefined, []);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect('sharedFolderIds' in input).toBe(false);
  });

  it('mkdir -p each shared-folder hostPath (mode 0700, recursive) on the real filesystem', async () => {
    const { bus } = busWithResolver([userFiles(), shared(F1), shared(F2, true)]);
    // No injected mkdir: exercise the default, which must create `.shared` too.
    const res = await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, undefined, [F1, F2]);
    for (const dir of [path.join(root, '.shared', F1), path.join(root, '.shared', F2)]) {
      const st = await fs.stat(dir);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o700 & ~process.umask());
    }
    expect(res.sharedFolders).toHaveLength(2);
  });

  it('returns {id, path, readOnly} per shared mount — HOST paths, in resolver order', async () => {
    const { bus } = busWithResolver([userFiles(), shared(F2, true), shared(F1, false)]);
    const res = await resolveUserFilesMount(
      ctx(),
      bus,
      OWNER,
      PLUGIN,
      async () => undefined,
      [F1, F2],
    );
    expect(res.sharedFolders).toEqual([
      { id: F2, path: path.join(root, '.shared', F2), readOnly: true },
      { id: F1, path: path.join(root, '.shared', F1), readOnly: false },
    ]);
    // Exact JSON key order is part of the runner-facing contract.
    expect(JSON.stringify(res.sharedFolders)).toBe(
      `[{"id":"${F2}","path":${JSON.stringify(path.join(root, '.shared', F2))},"readOnly":true},` +
        `{"id":"${F1}","path":${JSON.stringify(path.join(root, '.shared', F1))},"readOnly":false}]`,
    );
  });

  it('only an explicit readOnly:false is writable — anything else narrows to read-only', async () => {
    const odd = shared(F1) as unknown as Record<string, unknown>;
    delete odd.readOnly;
    const { bus } = busWithResolver([userFiles(), odd as unknown as MountSpec]);
    const res = await resolveUserFilesMount(
      ctx(),
      bus,
      OWNER,
      PLUGIN,
      async () => undefined,
      [F1],
    );
    expect(res.sharedFolders).toEqual([
      { id: F1, path: path.join(root, '.shared', F1), readOnly: true },
    ]);
  });

  it('leaves sharedFolders absent when no shared mount comes back', async () => {
    const { bus } = busWithResolver([userFiles()]);
    const res = await resolveUserFilesMount(
      ctx(),
      bus,
      OWNER,
      PLUGIN,
      async () => undefined,
      [F1],
    );
    expect(res.sharedFolders).toBeUndefined();
    expect(res.userFilesRoot).toBe(path.join(root, 'agt_abc'));
  });

  describe('user-files is matched by ROLE, never by position', () => {
    it.each([
      ['shared first', (): MountSpec[] => [shared(F1), shared(F2), userFiles()]],
      ['shared between', (): MountSpec[] => [shared(F1), userFiles(), shared(F2)]],
      ['shared after', (): MountSpec[] => [userFiles(), shared(F1), shared(F2)]],
    ])('userFilesRoot is the user-files hostPath (%s)', async (_label, mounts) => {
      const { bus } = busWithResolver(mounts());
      const res = await resolveUserFilesMount(
        ctx(),
        bus,
        OWNER,
        PLUGIN,
        async () => undefined,
        [F1, F2],
      );
      expect(res.userFilesRoot).toBe(path.join(root, 'agt_abc'));
    });

    it('a shared mount never becomes userFilesRoot when there is no user-files mount', async () => {
      const { bus } = busWithResolver([shared(F1)]);
      const res = await resolveUserFilesMount(
        ctx(),
        bus,
        OWNER,
        PLUGIN,
        async () => undefined,
        [F1],
      );
      expect(res.userFilesRoot).toBeUndefined();
    });
  });

  describe('fails closed on a malformed shared-folder mount', () => {
    const cases: Array<[string, () => MountSpec[], string[]]> = [
      ['hostPath is the agent dir, not under .shared', () => [shared(F1, false, { hostPath: path.join(root, 'agt_x') })], [F1]],
      ['hostPath basename is another folder', () => [shared(F1, false, { hostPath: path.join(root, '.shared', 'sf_other') })], [F1]],
      ['hostPath parent is not .shared', () => [shared(F1, false, { hostPath: path.join(root, 'other', F1) })], [F1]],
      ['hostPath is nested one level too deep', () => [shared(F1, false, { hostPath: path.join(root, '.shared', F1, 'x') })], [F1]],
      ['hostPath is relative', () => [shared(F1, false, { hostPath: `.shared/${F1}` })], [F1]],
      ['hostPath is not normalized (..)', () => [shared(F1, false, { hostPath: `${root}/.shared/../.shared/${F1}` })], [F1]],
      ['hostPath has a trailing slash', () => [shared(F1, false, { hostPath: `${root}/.shared/${F1}/` })], [F1]],
      ['mountPath is not /shared/<id> (agent files path)', () => [shared(F1, false, { mountPath: '/files' })], [F1]],
      ['mountPath names another folder', () => [shared(F1, false, { mountPath: '/shared/sf_other' })], [F1]],
      [
        'folderId is missing',
        () => {
          const m = shared(F1);
          delete m.folderId;
          return [m];
        },
        [F1],
      ],
      ['folderId is not a valid id', () => [shared('../x', false, { hostPath: path.join(root, '.shared', 'x') })], [F1]],
      ['folderId differs from hostPath/mountPath', () => [shared(F1, false, { folderId: F2 })], [F1, F2]],
      ['the folder was never requested', () => [shared(F2)], [F1]],
      ['shared mount comes back when none were requested', () => [shared(F1)], []],
      ['the same folder is mounted twice', () => [shared(F1), shared(F1)], [F1]],
    ];

    it.each(cases)('%s', async (_label, mounts, requested) => {
      const { bus } = busWithResolver(mounts());
      const mkdir = vi.fn(async () => undefined);
      const caught = await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, mkdir, requested).catch(
        (e: unknown) => e,
      );
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('mount-resolve-failed');
      expect((caught as PluginError).plugin).toBe(PLUGIN);
      // Nothing was realized: validation precedes every mkdir, including the
      // user-files mount and any valid sibling.
      expect(mkdir).not.toHaveBeenCalled();
    });

    it('one bad mount among valid ones realizes none of them (real filesystem)', async () => {
      const { bus } = busWithResolver([
        userFiles(),
        shared(F1),
        shared(F2, false, { hostPath: path.join(root, 'agt_x') }),
      ]);
      await expect(
        resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, undefined, [F1, F2]),
      ).rejects.toBeInstanceOf(PluginError);
      expect(await exists(path.join(root, '.shared'))).toBe(false);
      expect(await exists(path.join(root, 'agt_x'))).toBe(false);
      expect(await exists(path.join(root, 'agt_abc'))).toBe(false);
    });

    // F10 — realization must never FOLLOW a link out of the root. `mkdir -p`
    // resolves symlinks, so a `.shared` (or `.shared/<id>`) that is a symlink
    // would make the provider create, and then hand the runner, a directory
    // somewhere else entirely. The delete path already refuses these shapes;
    // the open path now does too, BEFORE any mkdir and before anything is stamped.
    describe('refuses a symlinked or non-directory .shared / folder dir (nothing is created)', () => {
      let outside: string;
      beforeEach(async () => {
        outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-mounts-outside-'));
      });
      afterEach(async () => {
        await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
      });

      async function expectRefused(requested: string[]): Promise<void> {
        const { bus } = busWithResolver([userFiles(), shared(F1), shared(F2)]);
        const mkdir = vi.fn(async () => undefined);
        const caught = await resolveUserFilesMount(
          ctx(),
          bus,
          OWNER,
          PLUGIN,
          mkdir,
          requested,
        ).catch((e: unknown) => e);
        expect(caught).toBeInstanceOf(PluginError);
        expect((caught as PluginError).code).toBe('mount-resolve-failed');
        expect((caught as PluginError).plugin).toBe(PLUGIN);
        // Validation + confinement precede every mkdir — including the agent's own files.
        expect(mkdir).not.toHaveBeenCalled();
        expect(await exists(path.join(root, 'agt_abc'))).toBe(false);
      }

      it('a symlinked .shared: refused, and the symlink target is untouched (real mkdir)', async () => {
        await fs.symlink(outside, path.join(root, '.shared'));
        const { bus } = busWithResolver([userFiles(), shared(F1)]);
        const caught = await resolveUserFilesMount(
          ctx(),
          bus,
          OWNER,
          PLUGIN,
          undefined, // the default, real, recursive mkdir
          [F1],
        ).catch((e: unknown) => e);
        expect(caught).toBeInstanceOf(PluginError);
        expect((caught as PluginError).code).toBe('mount-resolve-failed');
        // Nothing was created through the link, and nothing else was realized.
        expect(await fs.readdir(outside)).toEqual([]);
        expect((await fs.lstat(path.join(root, '.shared'))).isSymbolicLink()).toBe(true);
        expect(await exists(path.join(root, 'agt_abc'))).toBe(false);
      });

      it('a dangling symlinked .shared: refused too (mkdir -p would create its target)', async () => {
        await fs.symlink(path.join(outside, 'not-yet'), path.join(root, '.shared'));
        await expectRefused([F1, F2]);
        expect(await exists(path.join(outside, 'not-yet'))).toBe(false);
      });

      it('a symlinked folder directory: refused, and the symlink target is untouched (real mkdir)', async () => {
        await fs.mkdir(path.join(root, '.shared'));
        await fs.mkdir(path.join(outside, 'target'));
        await fs.symlink(path.join(outside, 'target'), path.join(root, '.shared', F1));
        const { bus } = busWithResolver([userFiles(), shared(F1)]);
        const caught = await resolveUserFilesMount(
          ctx(),
          bus,
          OWNER,
          PLUGIN,
          undefined,
          [F1],
        ).catch((e: unknown) => e);
        expect(caught).toBeInstanceOf(PluginError);
        expect((caught as PluginError).code).toBe('mount-resolve-failed');
        expect(await fs.readdir(path.join(outside, 'target'))).toEqual([]);
        expect((await fs.lstat(path.join(root, '.shared', F1))).isSymbolicLink()).toBe(true);
      });

      it('one folder is a symlink among clean siblings: the whole open is refused', async () => {
        await fs.mkdir(path.join(root, '.shared'));
        await fs.symlink(outside, path.join(root, '.shared', F2));
        await expectRefused([F1, F2]);
        expect(await exists(path.join(root, '.shared', F1))).toBe(false);
      });

      it('.shared as a regular file: refused', async () => {
        await fs.writeFile(path.join(root, '.shared'), 'i am a file');
        await expectRefused([F1, F2]);
        expect(await fs.readFile(path.join(root, '.shared'), 'utf-8')).toBe('i am a file');
      });

      it('a folder directory that is a regular file: refused', async () => {
        await fs.mkdir(path.join(root, '.shared'));
        await fs.writeFile(path.join(root, '.shared', F1), 'i am a file');
        await expectRefused([F1, F2]);
        expect(await fs.readFile(path.join(root, '.shared', F1), 'utf-8')).toBe('i am a file');
      });

      it('control — real directories (and nothing yet) are realized exactly as before', async () => {
        await fs.mkdir(path.join(root, '.shared', F1), { recursive: true });
        const { bus } = busWithResolver([userFiles(), shared(F1), shared(F2)]);
        const res = await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, undefined, [F1, F2]);
        expect(res.sharedFolders?.map((f) => f.id)).toEqual([F1, F2]);
        expect((await fs.lstat(path.join(root, '.shared', F1))).isDirectory()).toBe(true);
        expect((await fs.lstat(path.join(root, '.shared', F2))).isDirectory()).toBe(true);
      });
    });

    it('an nfs shared-folder mount is unrealizable here (never a silent skip)', async () => {
      const nfs: MountSpec = {
        kind: 'nfs',
        mountPath: `/shared/${F1}`,
        server: '10.0.0.2',
        exportPath: '/vol1/agents',
        subPath: `.shared/${F1}`,
        readOnly: false,
        role: 'shared-folder',
        folderId: F1,
      };
      const { bus } = busWithResolver([userFiles(), nfs]);
      const mkdir = vi.fn(async () => undefined);
      const caught = await resolveUserFilesMount(ctx(), bus, OWNER, PLUGIN, mkdir, [F1]).catch(
        (e: unknown) => e,
      );
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('unrealizable-mount-kind');
      expect(mkdir).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// The two OTHER user-files lookups in this package. Both resolve through
// `sandbox:resolve-mounts` and used to be safe by accident (the resolver only
// ever returned one mount); with shared-folder mounts in the list they are safe
// only because they match on `role`.
// ---------------------------------------------------------------------------

describe('host-read + agent-delete cleanup ignore shared-folder mounts', () => {
  // A resolver that lists a shared folder BEFORE the agent's own files, so a
  // first-match lookup would land in the wrong place.
  function busSharedFirst(): HookBus {
    return busWithResolver([shared(F1), userFiles()]).bus;
  }

  async function seed(): Promise<{ agentDir: string; sharedDir: string }> {
    const agentDir = path.join(root, 'agt_abc');
    const sharedDir = path.join(root, '.shared', F1);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'mine.txt'), 'agent file');
    await fs.writeFile(path.join(sharedDir, 'team.txt'), 'shared file');
    return { agentDir, sharedDir };
  }

  it('readUserFiles lists the agent files, not the shared folder', async () => {
    await seed();
    const out = await readUserFiles(ctx(), busSharedFirst(), PLUGIN, {
      owner: ownerFromAgentId('agt_abc', 'u1'),
    });
    if (out.kind !== 'dir') throw new Error(`expected dir, got ${out.kind}`);
    const names = out.entries.map((e) => e.name);
    expect(names).toContain('mine.txt');
    expect(names).not.toContain('team.txt');
  });

  it('cleanupUserFiles removes the agent subtree and leaves the shared folder intact', async () => {
    const { agentDir, sharedDir } = await seed();
    await cleanupUserFiles(
      ctx(),
      busSharedFirst(),
      PLUGIN,
      ownerFromAgentId('agt_abc', 'u1'),
      ctx().logger,
    );
    expect(await exists(agentDir)).toBe(false);
    expect(await fs.readFile(path.join(sharedDir, 'team.txt'), 'utf-8')).toBe('shared file');
  });
});
