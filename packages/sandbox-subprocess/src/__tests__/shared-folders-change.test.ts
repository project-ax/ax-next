import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import type {
  ChangeSharedFolderInput,
  ChangeSharedFolderOutput,
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  MountSpec,
  SharedFolderChange,
} from '@ax/sandbox-mount-protocol';
import {
  SHARED_FOLDER_CHANGE_MAX_CHANGES,
  SHARED_FOLDER_CHANGE_MAX_FILE_BYTES,
  SHARED_FOLDER_CHANGE_MAX_TOTAL_BYTES,
} from '@ax/sandbox-mount-protocol';
import {
  WalkChangeError,
  WalkPathError,
  WalkReadError,
  type WalkChangeErrorCode,
} from '@ax/user-files-read';
import { createWorkspaceLocaldirPlugin } from '@ax/workspace-localdir';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import {
  CHANGE_MAX_CHANGES,
  CHANGE_MAX_FILE_BYTES,
  CHANGE_MAX_TOTAL_BYTES,
  changeSharedFolder,
} from '../shared-folders.js';

// ---------------------------------------------------------------------------
// W3c — `sandbox:change-shared-folder` on the subprocess (dev) provider.
//
// Same location rules as the read: the resolver's `sandbox:locate-shared-folder`
// answer must be exactly `<root>/.shared/<id>`. The changes go through
// `changeConfinedByWalk` from `<root>` with no chown, so a symlink planted
// anywhere in the folder is refused, never written through. The walk is
// Linux-only (/proc): on macOS the hook answers `unavailable`. Validation and
// error mapping are tested everywhere with an injected walk; the real disk
// tests run on Linux (CI).
// ---------------------------------------------------------------------------

const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
const PLUGIN = '@ax/sandbox-subprocess';
const F1 = 'sf_AAAA1111';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-change-root-')));
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

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const write = (p: string, s: string): SharedFolderChange => ({ op: 'write', path: p, content: bytes(s) });

async function refusal(p: Promise<unknown>): Promise<PluginError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginError);
  return err as PluginError;
}

describe('change limits', () => {
  it('pins the local caps to the hook contract (plugins may only import types from it)', () => {
    expect(CHANGE_MAX_CHANGES).toBe(SHARED_FOLDER_CHANGE_MAX_CHANGES);
    expect(CHANGE_MAX_FILE_BYTES).toBe(SHARED_FOLDER_CHANGE_MAX_FILE_BYTES);
    expect(CHANGE_MAX_TOTAL_BYTES).toBe(SHARED_FOLDER_CHANGE_MAX_TOTAL_BYTES);
  });
});

describe('changeSharedFolder (subprocess)', () => {
  it('answers unavailable when no resolver can locate folders', async () => {
    const walk = vi.fn();
    const out = await changeSharedFolder(
      ctx(),
      new HookBus(),
      PLUGIN,
      { folderId: F1, changes: [write('a.md', 'x')] },
      walk,
    );
    expect(out).toEqual({ kind: 'unavailable' });
    expect(walk).not.toHaveBeenCalled();
  });

  it.each([['../x'], ['.shared'], ['sf_a/b'], [7]])(
    'SECURITY: refuses folderId %j with invalid-payload, before locating or walking',
    async (folderId) => {
      const walk = vi.fn();
      const locate = vi.fn(sharedMount);
      const err = await refusal(
        changeSharedFolder(
          ctx(),
          busLocating(locate),
          PLUGIN,
          { folderId: folderId as string, changes: [] },
          walk,
        ),
      );
      expect(err.code).toBe('invalid-payload');
      expect(locate).not.toHaveBeenCalled();
      expect(walk).not.toHaveBeenCalled();
    },
  );

  it.each<[string, () => unknown, string]>([
    ['changes not an array', () => 'nope', 'invalid-change'],
    ['a change with no path', () => [{ op: 'mkdir' }], 'invalid-change'],
    ['a null change', () => [null], 'invalid-change'],
    [
      'more than 64 changes',
      () => Array.from({ length: 65 }, (_, i) => ({ op: 'mkdir', path: `d${i}` })),
      'too-many-changes',
    ],
    [
      'a file over 10 MiB',
      () => [{ op: 'write', path: 'big', content: new Uint8Array(10 * 1024 * 1024 + 1) }],
      'too-large',
    ],
    [
      'more than 25 MiB in total',
      () =>
        [0, 1, 2].map((i) => ({ op: 'write', path: `f${i}`, content: new Uint8Array(9 * 1024 * 1024) })),
      'too-large',
    ],
    ['an escaping path', () => [write('../sf_other/x', 'x')], 'invalid-path'],
    ['an absolute path', () => [write('/etc/passwd', 'x')], 'invalid-path'],
    ['an empty segment', () => [write('a//b', 'x')], 'invalid-path'],
  ])(
    'SECURITY: refuses %s with invalid-payload before locating, creating or walking',
    async (_label, changes, reasonCode) => {
      const walk = vi.fn();
      const locate = vi.fn(sharedMount);
      const err = await refusal(
        changeSharedFolder(
          ctx(),
          busLocating(locate),
          PLUGIN,
          { folderId: F1, changes: changes() as SharedFolderChange[], createFolder: true },
          walk,
        ),
      );
      expect(err.code).toBe('invalid-payload');
      expect(err.reasonCode).toBe(reasonCode);
      expect(locate).not.toHaveBeenCalled();
      expect(walk).not.toHaveBeenCalled();
      expect(existsSync(path.join(root, '.shared'))).toBe(false);
    },
  );

  it('walks .shared/<id> from the root above .shared with the contract caps and no chown', async () => {
    const results = [{ path: 'a.md', outcome: 'created' as const }];
    const walk = vi.fn(() => results);
    const changes = [write('a.md', 'x')];
    const out = await changeSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, changes }, walk);
    expect(out).toEqual({ kind: 'done', results });
    expect(walk).toHaveBeenCalledWith(root, ['.shared', F1], changes, {
      maxChanges: 64,
      maxFileBytes: 10 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
    });
    expect(existsSync(path.join(root, '.shared'))).toBe(false); // no createFolder → nothing made
  });

  it('createFolder makes a missing .shared (0700, like session open) and asks the walk to create the folder', async () => {
    const walk = vi.fn(() => []);
    await changeSharedFolder(
      ctx(),
      busLocating(sharedMount),
      PLUGIN,
      { folderId: F1, changes: [], createFolder: true },
      walk,
    );
    const st = await fs.lstat(path.join(root, '.shared'));
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(walk).toHaveBeenCalledWith(root, ['.shared', F1], [], expect.objectContaining({ createBase: true }));
    expect(walk.mock.calls[0]![3]).not.toHaveProperty('chown');
  });

  it('createFolder keeps an existing .shared as it is', async () => {
    await fs.mkdir(path.join(root, '.shared'), { mode: 0o711 });
    await fs.chmod(path.join(root, '.shared'), 0o711);
    const walk = vi.fn(() => []);
    await changeSharedFolder(
      ctx(),
      busLocating(sharedMount),
      PLUGIN,
      { folderId: F1, changes: [], createFolder: true },
      walk,
    );
    expect((await fs.lstat(path.join(root, '.shared'))).mode & 0o777).toBe(0o711);
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a symlink', async () => fs.symlink(os.tmpdir(), path.join(root, '.shared'))],
    ['a file', async () => fs.writeFile(path.join(root, '.shared'), 'x')],
  ])('SECURITY: createFolder refuses a .shared that is %s, without walking', async (_label, plant) => {
    await plant();
    const walk = vi.fn();
    const err = await refusal(
      changeSharedFolder(
        ctx(),
        busLocating(sharedMount),
        PLUGIN,
        { folderId: F1, changes: [], createFolder: true },
        walk,
      ),
    );
    expect(err.code).toBe('unsafe-shared-folder-location');
    expect(walk).not.toHaveBeenCalled();
  });

  it.each([
    ['another folder', () => sharedMount('sf_other', path.join(root, '.shared', 'sf_other'))],
    ['a path outside .shared', () => sharedMount(F1, path.join(root, 'agents', F1))],
    ['a non-normalized path', () => sharedMount(F1, `${root}/x/../.shared/${F1}`)],
  ])('SECURITY: refuses a located %s without creating or walking', async (_label, located) => {
    const walk = vi.fn();
    const err = await refusal(
      changeSharedFolder(
        ctx(),
        busLocating(located),
        PLUGIN,
        { folderId: F1, changes: [], createFolder: true },
        walk,
      ),
    );
    expect(err.code).toBe('unsafe-shared-folder-location');
    expect(walk).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, '.shared'))).toBe(false);
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
    const err = await refusal(changeSharedFolder(ctx(), bus, PLUGIN, { folderId: F1, changes: [] }, walk));
    expect(err.code).toBe('unrealizable-mount-kind');
    expect(walk).not.toHaveBeenCalled();
  });

  it('a conflict is a result, not an error', async () => {
    const results = [
      { path: 'a.md', outcome: 'written' as const },
      { path: 'b.md', outcome: 'conflict' as const },
    ];
    const walk = vi.fn(() => results);
    const out = await changeSharedFolder(
      ctx(),
      busLocating(sharedMount),
      PLUGIN,
      { folderId: F1, changes: [write('a.md', 'x'), { ...write('b.md', 'y'), ifMatch: sha('z') }] },
      walk,
    );
    expect(out).toEqual({ kind: 'done', results });
  });

  it.each<WalkChangeErrorCode>([
    'too-large',
    'too-many-changes',
    'invalid-change',
    'link-or-not-dir',
    'not-empty',
    'is-directory',
  ])('maps a WalkChangeError %s to invalid-payload with that reasonCode', async (code) => {
    const applied = [{ path: 'a.md', outcome: 'created' as const }];
    const walkErr = new WalkChangeError('refused', { code, index: 1, applied });
    const walk = vi.fn(() => {
      throw walkErr;
    });
    const err = await refusal(
      changeSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, changes: [] }, walk),
    );
    expect(err.code).toBe('invalid-payload');
    expect(err.reasonCode).toBe(code);
    expect(err.hookName).toBe('sandbox:change-shared-folder');
    expect(err.cause).toBe(walkErr);
    expect((err.cause as WalkChangeError).applied).toEqual(applied);
  });

  it('maps a WalkPathError from the walk (e.g. too deep) to invalid-payload / invalid-path, as W3b does', async () => {
    const walk = vi.fn(() => {
      throw new WalkPathError('path is too deep');
    });
    const err = await refusal(
      changeSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, changes: [] }, walk),
    );
    expect(err.code).toBe('invalid-payload');
    expect(err.reasonCode).toBe('invalid-path');
  });

  it('a platform with no /proc walk answers unavailable', async () => {
    const walk = vi.fn(() => {
      throw new WalkReadError('no /proc', { code: 'unsupported-platform', depth: -1 });
    });
    const out = await changeSharedFolder(ctx(), busLocating(sharedMount), PLUGIN, { folderId: F1, changes: [] }, walk);
    expect(out).toEqual({ kind: 'unavailable' });
  });

  it('a storage failure (EACCES, EIO, missing folder) throws unchanged — it is not a refusal', async () => {
    for (const code of ['EACCES', 'EIO', 'ENOENT']) {
      const walk = vi.fn(() => {
        throw new WalkReadError(`(${code})`, { code, depth: 1 });
      });
      const err = await changeSharedFolder(
        ctx(),
        busLocating(sharedMount),
        PLUGIN,
        { folderId: F1, changes: [] },
        walk,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WalkReadError);
      expect(err).toMatchObject({ code });
    }
  });
});

describe('sandbox:change-shared-folder through the bus, with the real localdir resolver', () => {
  async function bus(): Promise<HookBus> {
    const b = new HookBus();
    await createWorkspaceLocaldirPlugin({ root }).init({ bus: b, config: {} });
    await createSandboxSubprocessPlugin().init({ bus: b, config: {} });
    return b;
  }
  const change = async (b: HookBus, input: ChangeSharedFolderInput) =>
    b.call<ChangeSharedFolderInput, ChangeSharedFolderOutput>('sandbox:change-shared-folder', ctx(), input);
  const folder = () => path.join(root, '.shared', F1);

  it('declares the service in registers, and calls nothing new (no boot edge)', () => {
    const manifest = createSandboxSubprocessPlugin().manifest;
    expect(manifest.registers).toContain('sandbox:change-shared-folder');
    expect(manifest.calls).toEqual(['session:create', 'session:terminate', 'ipc:start', 'ipc:stop']);
    expect((manifest.optionalCalls ?? []).map((c) => c.hook)).toEqual([
      'sandbox:resolve-mounts',
      'sandbox:locate-shared-folder',
    ]);
  });

  it('answers unavailable with no resolver loaded', async () => {
    const b = new HookBus();
    await createSandboxSubprocessPlugin().init({ bus: b, config: {} });
    expect(await change(b, { folderId: F1, changes: [write('a', 'x')] })).toEqual({ kind: 'unavailable' });
  });

  it.skipIf(ON_LINUX)('answers unavailable off Linux (the walk needs /proc), writing nothing', async () => {
    await fs.mkdir(folder(), { recursive: true });
    expect(await change(await bus(), { folderId: F1, changes: [write('a.md', 'x')] })).toEqual({
      kind: 'unavailable',
    });
    expect(existsSync(path.join(folder(), 'a.md'))).toBe(false);
  });

  describe.skipIf(!ON_LINUX)('on Linux (/proc; runs in CI)', () => {
    const read = (rel: string) => fs.readFile(path.join(folder(), rel), 'utf8');

    it('createFolder seeds a new folder (0700) with nested files and directories', async () => {
      const out = await change(await bus(), {
        folderId: F1,
        createFolder: true,
        changes: [
          { ...write('instructions.md', 'brief'), ifAbsent: true },
          { ...write('memory/status.md', 'ok'), ifAbsent: true },
          { op: 'mkdir', path: 'work', ifAbsent: true },
        ],
      });
      expect(out).toEqual({
        kind: 'done',
        results: [
          { path: 'instructions.md', outcome: 'created' },
          { path: 'memory/status.md', outcome: 'created' },
          { path: 'work', outcome: 'created' },
        ],
      });
      expect(await read('instructions.md')).toBe('brief');
      expect(await read('memory/status.md')).toBe('ok');
      expect((await fs.lstat(path.join(root, '.shared'))).mode & 0o777).toBe(0o700);
      expect((await fs.lstat(folder())).mode & 0o777).toBe(0o700);
    });

    it('without createFolder, a missing folder throws and nothing is made', async () => {
      const err = await change(await bus(), { folderId: F1, changes: [write('a', 'x')] }).catch(
        (e: unknown) => e,
      );
      // The bus wraps a non-PluginError throw; the walk's error is the cause.
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).cause).toBeInstanceOf(WalkReadError);
      expect((err as PluginError).cause).toMatchObject({ code: 'ENOENT' });
      expect(existsSync(path.join(root, '.shared'))).toBe(false);
    });

    it('write, overwrite, ifAbsent, ifMatch and a conflict that stops the batch', async () => {
      await fs.mkdir(folder(), { recursive: true });
      const b = await bus();
      expect(await change(b, { folderId: F1, changes: [write('a.md', 'one')] })).toEqual({
        kind: 'done',
        results: [{ path: 'a.md', outcome: 'created' }],
      });
      const out = await change(b, {
        folderId: F1,
        changes: [
          write('a.md', 'two'),
          { ...write('a.md', 'nope'), ifAbsent: true },
          { ...write('a.md', 'three'), ifMatch: sha('two') },
          { ...write('a.md', 'stale'), ifMatch: sha('two') },
          write('never.md', 'x'),
        ],
      });
      expect(out).toEqual({
        kind: 'done',
        results: [
          { path: 'a.md', outcome: 'written' },
          { path: 'a.md', outcome: 'exists' },
          { path: 'a.md', outcome: 'written' },
          { path: 'a.md', outcome: 'conflict' },
        ],
      });
      expect(await read('a.md')).toBe('three');
      expect(existsSync(path.join(folder(), 'never.md'))).toBe(false);
    });

    it('mkdir and delete (file, empty dir, absent); a non-empty dir is refused', async () => {
      await fs.mkdir(folder(), { recursive: true });
      const b = await bus();
      expect(
        await change(b, {
          folderId: F1,
          changes: [
            { op: 'mkdir', path: 'a/b' },
            { op: 'mkdir', path: 'a/b' },
            write('a/f.md', 'x'),
            { op: 'delete', path: 'a/f.md' },
            { op: 'delete', path: 'a/b' },
            { op: 'delete', path: 'gone' },
          ],
        }),
      ).toEqual({
        kind: 'done',
        results: [
          { path: 'a/b', outcome: 'created' },
          { path: 'a/b', outcome: 'exists' },
          { path: 'a/f.md', outcome: 'created' },
          { path: 'a/f.md', outcome: 'deleted' },
          { path: 'a/b', outcome: 'deleted' },
          { path: 'gone', outcome: 'absent' },
        ],
      });
      await fs.writeFile(path.join(folder(), 'a', 'keep'), 'x');
      const err = await refusal(change(b, { folderId: F1, changes: [{ op: 'delete', path: 'a' }] }));
      expect(err.code).toBe('invalid-payload');
      expect(err.reasonCode).toBe('not-empty');
      expect(existsSync(path.join(folder(), 'a', 'keep'))).toBe(true);
    });

    it('SECURITY: a symlink in the folder is refused, never written through', async () => {
      await fs.mkdir(folder(), { recursive: true });
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(folder(), 'up'));
      const err = await refusal(
        change(await bus(), { folderId: F1, changes: [write('ok.md', 'x'), write('up/pwned', 'x')] }),
      );
      expect(err.code).toBe('invalid-payload');
      expect(err.reasonCode).toBe('link-or-not-dir');
      expect((err.cause as WalkChangeError).applied).toEqual([{ path: 'ok.md', outcome: 'created' }]);
      expect(existsSync(path.join(outside, 'pwned'))).toBe(false);
    });

    it('SECURITY: a symlinked folder directory is refused, even with createFolder', async () => {
      await fs.mkdir(path.join(root, '.shared'), { recursive: true });
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      await fs.symlink(outside, folder());
      const err = await refusal(
        change(await bus(), { folderId: F1, createFolder: true, changes: [write('pwned', 'x')] }),
      );
      expect(err.code).toBe('invalid-payload');
      expect(err.reasonCode).toBe('link-or-not-dir');
      expect(existsSync(path.join(outside, 'pwned'))).toBe(false);
    });
  });
});
