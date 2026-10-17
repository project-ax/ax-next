import { describe, expect, it } from 'vitest';
import type { ServiceHandler } from '@ax/core';
import type { OpenSessionInput } from '@ax/sandbox-protocol';
import type {
  MountSpec,
  NfsMountSpec,
  LocalDirMountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
  ResolveMountsHandler,
  ReadUserFilesInput,
  ReadUserFilesOutput,
  ReadUserFilesHandler,
  UserFileDirEntry,
  AuthorizeMountsInput,
  AuthorizeMountsOutput,
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  DeleteSharedFolderInput,
  DeleteSharedFolderOutput,
} from '../index.js';
import { SHARED_FOLDERS_DIR, SHARED_FOLDERS_MOUNT_BASE } from '../index.js';

// This package is pure TS types — the contract IS the type (no zod, no runtime).
// `sandbox:resolve-mounts` is a HOST-INTERNAL service hook consumed as a
// `registerService<In,Out>` / `bus.call<In,Out>` generic; it never crosses the
// sandbox edge, so there is no untrusted wire to validate here (mirrors
// @ax/workspace-bundle-protocol — ARCH-3 / invariant I1). These tests pin the
// contract: a typed literal must satisfy each member of the union, the
// discriminator must be the ONLY safe key to branch on, and the hook signature
// must line up with @ax/core's ServiceHandler and @ax/sandbox-protocol's owner.

describe('MountSpec — nfs member', () => {
  it('carries the Filestore/NFS backend fields per design §4', () => {
    const nfs: NfsMountSpec = {
      kind: 'nfs',
      mountPath: '/files',
      server: '10.0.0.2',
      exportPath: '/vol1/agents',
      subPath: 'agent-abc',
      readOnly: false,
      role: 'user-files',
    };
    expect(nfs.kind).toBe('nfs');
    expect(nfs.mountPath).toBe('/files');
    expect(nfs.server).toBe('10.0.0.2');
    expect(nfs.exportPath).toBe('/vol1/agents');
    expect(nfs.subPath).toBe('agent-abc');
    expect(nfs.readOnly).toBe(false);
    expect(nfs.role).toBe('user-files');
  });

  it('makes role optional (host-read realization may omit it)', () => {
    const nfs: NfsMountSpec = {
      kind: 'nfs',
      mountPath: '/files',
      server: '10.0.0.2',
      exportPath: '/vol1/agents',
      subPath: 'agent-abc',
      readOnly: true,
    };
    expect(nfs.role).toBeUndefined();
    expect(nfs.readOnly).toBe(true);
  });

  it('is assignable to the MountSpec union', () => {
    const spec: MountSpec = {
      kind: 'nfs',
      mountPath: '/files',
      server: '10.0.0.2',
      exportPath: '/vol1/agents',
      subPath: 'agent-abc',
      readOnly: false,
      role: 'user-files',
    };
    expect(spec.kind).toBe('nfs');
  });
});

describe('MountSpec — localDir member', () => {
  it('carries the dev-host backend fields per design §4', () => {
    const local: LocalDirMountSpec = {
      kind: 'localDir',
      mountPath: '/files',
      hostPath: '/var/lib/ax/userfiles/agent-abc',
      readOnly: false,
      role: 'user-files',
    };
    expect(local.kind).toBe('localDir');
    expect(local.mountPath).toBe('/files');
    expect(local.hostPath).toBe('/var/lib/ax/userfiles/agent-abc');
    expect(local.readOnly).toBe(false);
    expect(local.role).toBe('user-files');
  });

  it('is assignable to the MountSpec union', () => {
    const spec: MountSpec = {
      kind: 'localDir',
      mountPath: '/files',
      hostPath: '/tmp/ax/agent-abc',
      readOnly: false,
    };
    expect(spec.kind).toBe('localDir');
  });
});

describe('MountSpec — opaque discriminated union', () => {
  it('narrows on kind and never exposes one member backend fields on the other', () => {
    // A consumer MUST switch on `kind`. After narrowing to 'nfs', the NFS
    // fields are present; after narrowing to 'localDir', `hostPath` is. The
    // narrowing functions below would NOT type-check if a consumer tried to
    // read `spec.server` without first checking `kind === 'nfs'`.
    const describeMount = (spec: MountSpec): string => {
      switch (spec.kind) {
        case 'nfs':
          return `${spec.server}:${spec.exportPath}/${spec.subPath} -> ${spec.mountPath}`;
        case 'localDir':
          return `${spec.hostPath} -> ${spec.mountPath}`;
        default: {
          // Exhaustiveness: a future `kind` makes this assignment fail to
          // compile, forcing every consumer to handle the new member.
          const _exhaustive: never = spec;
          return _exhaustive;
        }
      }
    };

    expect(
      describeMount({
        kind: 'nfs',
        mountPath: '/files',
        server: '10.0.0.2',
        exportPath: '/vol1/agents',
        subPath: 'agent-abc',
        readOnly: false,
      }),
    ).toBe('10.0.0.2:/vol1/agents/agent-abc -> /files');

    expect(
      describeMount({
        kind: 'localDir',
        mountPath: '/files',
        hostPath: '/tmp/ax/agent-abc',
        readOnly: false,
      }),
    ).toBe('/tmp/ax/agent-abc -> /files');
  });
});

describe('sandbox:resolve-mounts signature', () => {
  it('input carries the session owner (reused from @ax/sandbox-protocol)', () => {
    const owner: NonNullable<OpenSessionInput['owner']> = {
      userId: 'user-1',
      agentId: 'agent-abc',
      agentConfig: {
        displayName: 'A',
        systemPromptAugment: '',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude',
        runner: 'claude-sdk',
      },
    };
    const input: ResolveMountsInput = { owner };
    expect(input.owner.agentId).toBe('agent-abc');
    expect(input.owner.userId).toBe('user-1');
  });

  // TASK-167 (§11 host-read): a NON-runner caller may request a read-only
  // realization of the same owner-keyed mount. The field is optional — the
  // runner's session-open call omits it.
  it('input carries an optional readOnly flag for a host-read realization', () => {
    const owner: NonNullable<OpenSessionInput['owner']> = {
      userId: 'user-1',
      agentId: 'agent-abc',
      agentConfig: {
        displayName: 'A',
        systemPromptAugment: '',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude',
        runner: 'claude-sdk',
      },
    };
    const ro: ResolveMountsInput = { owner, readOnly: true };
    expect(ro.readOnly).toBe(true);
    const runner: ResolveMountsInput = { owner };
    expect(runner.readOnly).toBeUndefined();
  });

  it('output is { mounts: MountSpec[] } and may be empty (ownerless / no-mount)', () => {
    const out: ResolveMountsOutput = { mounts: [] };
    expect(out.mounts).toEqual([]);

    const withMount: ResolveMountsOutput = {
      mounts: [
        {
          kind: 'nfs',
          mountPath: '/files',
          server: '10.0.0.2',
          exportPath: '/vol1/agents',
          subPath: 'agent-abc',
          readOnly: false,
          role: 'user-files',
        },
      ],
    };
    expect(withMount.mounts).toHaveLength(1);
    expect(withMount.mounts[0]?.kind).toBe('nfs');
  });

  it('ResolveMountsHandler is a @ax/core ServiceHandler over the in/out pair', () => {
    // Assignability proves the alias holds: a handler typed against the raw
    // ServiceHandler generic must be assignable to ResolveMountsHandler and
    // back. This is the contract a provider's `bus.call` / a plugin's
    // `registerService` keys off.
    const raw: ServiceHandler<ResolveMountsInput, ResolveMountsOutput> = async (
      _ctx,
      input,
    ) => ({ mounts: input.owner.agentId ? [] : [] });
    const handler: ResolveMountsHandler = raw;
    const back: ServiceHandler<ResolveMountsInput, ResolveMountsOutput> = handler;
    expect(typeof back).toBe('function');
  });
});

describe('sandbox:read-user-files signature (TASK-167 §11 host-read)', () => {
  it('input carries the owner + an optional relPath', () => {
    const owner: NonNullable<OpenSessionInput['owner']> = {
      userId: 'user-1',
      agentId: 'agent-abc',
      agentConfig: {
        displayName: 'A',
        systemPromptAugment: '',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude',
        runner: 'claude-sdk',
      },
    };
    const root: ReadUserFilesInput = { owner };
    expect(root.relPath).toBeUndefined();
    const nested: ReadUserFilesInput = { owner, relPath: 'docs/notes.md' };
    expect(nested.relPath).toBe('docs/notes.md');
  });

  it('output is a discriminated union: file | dir | absent | unavailable', () => {
    const file: ReadUserFilesOutput = {
      kind: 'file',
      contents: new Uint8Array([1, 2, 3]),
    };
    const entries: UserFileDirEntry[] = [
      { name: 'a.txt', kind: 'file' },
      { name: 'sub', kind: 'dir' },
    ];
    const dir: ReadUserFilesOutput = { kind: 'dir', entries };
    const absent: ReadUserFilesOutput = { kind: 'absent' };

    // The union narrows on `kind` exactly like MountSpec.
    const describe1 = (o: ReadUserFilesOutput): string => {
      switch (o.kind) {
        case 'file':
          return `file:${o.contents.length}`;
        case 'dir':
          return `dir:${o.entries.length}`;
        case 'absent':
          return 'absent';
        case 'unavailable':
          return 'unavailable';
        default: {
          const _exhaustive: never = o;
          return _exhaustive;
        }
      }
    };
    expect(describe1({ kind: 'unavailable' })).toBe('unavailable');
    expect(describe1(file)).toBe('file:3');
    expect(describe1(dir)).toBe('dir:2');
    expect(describe1(absent)).toBe('absent');
  });

  it('ReadUserFilesHandler is a @ax/core ServiceHandler over the in/out pair', () => {
    const raw: ServiceHandler<ReadUserFilesInput, ReadUserFilesOutput> = async () => ({
      kind: 'absent',
    });
    const handler: ReadUserFilesHandler = raw;
    const back: ServiceHandler<ReadUserFilesInput, ReadUserFilesOutput> = handler;
    expect(typeof back).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// W2 shared folders — the `'shared-folder'` mount role, its `folderId`, and the
// three new host-internal service-hook contracts.
// ---------------------------------------------------------------------------

describe('shared-folder mount role (W2)', () => {
  it('nfs member carries role "shared-folder" + folderId', () => {
    const nfs: NfsMountSpec = {
      kind: 'nfs',
      mountPath: `${SHARED_FOLDERS_MOUNT_BASE}/sf_abc`,
      server: '10.0.0.2',
      exportPath: '/vol1/agents',
      subPath: `${SHARED_FOLDERS_DIR}/sf_abc`,
      readOnly: true,
      role: 'shared-folder',
      folderId: 'sf_abc',
    };
    expect(nfs.role).toBe('shared-folder');
    expect(nfs.folderId).toBe('sf_abc');
    expect(nfs.mountPath).toBe('/shared/sf_abc');
    expect(nfs.subPath).toBe('.shared/sf_abc');
  });

  it('localDir member carries role "shared-folder" + folderId', () => {
    const local: LocalDirMountSpec = {
      kind: 'localDir',
      mountPath: `${SHARED_FOLDERS_MOUNT_BASE}/sf_abc`,
      hostPath: `/var/lib/ax/userfiles/${SHARED_FOLDERS_DIR}/sf_abc`,
      readOnly: false,
      role: 'shared-folder',
      folderId: 'sf_abc',
    };
    expect(local.role).toBe('shared-folder');
    expect(local.folderId).toBe('sf_abc');
  });

  it('folderId is optional (non-shared roles omit it)', () => {
    const nfs: NfsMountSpec = {
      kind: 'nfs',
      mountPath: '/files',
      server: '10.0.0.2',
      exportPath: '/vol1/agents',
      subPath: 'agent-abc',
      readOnly: false,
      role: 'user-files',
    };
    const local: LocalDirMountSpec = {
      kind: 'localDir',
      mountPath: '/files',
      hostPath: '/tmp/ax/agent-abc',
      readOnly: false,
    };
    expect(nfs.folderId).toBeUndefined();
    expect(local.folderId).toBeUndefined();
  });

  it('every role is exhaustively switchable on both members', () => {
    // A future role makes the `never` assignment fail to compile, forcing every
    // consumer that switches on `role` to handle it.
    const roleOf = (spec: MountSpec): string => {
      const role = spec.role;
      switch (role) {
        case 'user-files':
          return 'user-files';
        case 'memory':
          // `memory` exists only on the nfs member.
          return spec.kind === 'nfs' ? 'memory' : 'impossible';
        case 'shared-folder':
          return `shared-folder:${spec.folderId ?? ''}`;
        case undefined:
          return 'none';
        default: {
          const _exhaustive: never = role;
          return _exhaustive;
        }
      }
    };
    expect(
      roleOf({
        kind: 'nfs',
        mountPath: '/shared/sf_a',
        server: 's',
        exportPath: '/e',
        subPath: '.shared/sf_a',
        readOnly: false,
        role: 'shared-folder',
        folderId: 'sf_a',
      }),
    ).toBe('shared-folder:sf_a');
    expect(
      roleOf({
        kind: 'localDir',
        mountPath: '/files',
        hostPath: '/tmp/x',
        readOnly: false,
        role: 'user-files',
      }),
    ).toBe('user-files');
    expect(
      roleOf({ kind: 'localDir', mountPath: '/files', hostPath: '/tmp/x', readOnly: false }),
    ).toBe('none');
  });

  it('localDir does NOT allow role "memory" (memory is nfs-only)', () => {
    const bad: LocalDirMountSpec = {
      kind: 'localDir',
      mountPath: '/memory',
      hostPath: '/tmp/x',
      readOnly: true,
      // @ts-expect-error — 'memory' is an nfs-only role
      role: 'memory',
    };
    expect(bad.kind).toBe('localDir');
  });
});

describe('shared-folder constants', () => {
  it('pins the backing-store dir and sandbox mount base', () => {
    expect(SHARED_FOLDERS_DIR).toBe('.shared');
    expect(SHARED_FOLDERS_MOUNT_BASE).toBe('/shared');
  });
});

describe('sandbox:resolve-mounts sharedFolderIds (W2)', () => {
  it('input carries an optional readonly sharedFolderIds list', () => {
    const owner: NonNullable<OpenSessionInput['owner']> = {
      userId: 'user-1',
      agentId: 'agent-abc',
      agentConfig: {
        displayName: 'A',
        systemPromptAugment: '',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude',
        runner: 'claude-sdk',
      },
    };
    const without: ResolveMountsInput = { owner };
    expect(without.sharedFolderIds).toBeUndefined();
    const ids: readonly string[] = ['sf_a', 'sf_b'];
    const withIds: ResolveMountsInput = { owner, sharedFolderIds: ids };
    expect(withIds.sharedFolderIds).toEqual(['sf_a', 'sf_b']);
  });
});

describe('shared-folder service-hook contracts (W2)', () => {
  it('shared-folders:authorize-mounts: { agentId, folderIds } -> { folders }', () => {
    const input: AuthorizeMountsInput = { agentId: 'agent-abc', folderIds: ['sf_a', 'sf_b'] };
    const output: AuthorizeMountsOutput = {
      folders: [
        { folderId: 'sf_a', readOnly: false },
        { folderId: 'sf_b', readOnly: true },
      ],
    };
    expect(input.folderIds).toHaveLength(2);
    expect(output.folders.map((f) => f.readOnly)).toEqual([false, true]);
    const empty: AuthorizeMountsOutput = { folders: [] };
    expect(empty.folders).toEqual([]);
  });

  it('sandbox:locate-shared-folder: { folderId } -> { mount: MountSpec }', () => {
    const input: LocateSharedFolderInput = { folderId: 'sf_a' };
    const output: LocateSharedFolderOutput = {
      mount: {
        kind: 'localDir',
        mountPath: '/shared/sf_a',
        hostPath: '/root/.shared/sf_a',
        readOnly: false,
        role: 'shared-folder',
        folderId: input.folderId,
      },
    };
    expect(output.mount.kind).toBe('localDir');
  });

  it('sandbox:delete-shared-folder: { folderId } -> { deleted: true }', () => {
    const input: DeleteSharedFolderInput = { folderId: 'sf_a' };
    const output: DeleteSharedFolderOutput = { deleted: true };
    expect(input.folderId).toBe('sf_a');
    expect(output.deleted).toBe(true);
    // @ts-expect-error — `deleted` is the literal `true`; a failed delete throws instead.
    const bad: DeleteSharedFolderOutput = { deleted: false };
    expect(bad).toBeDefined();
  });
});
