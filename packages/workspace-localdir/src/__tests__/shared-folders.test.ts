import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginError, type Logger } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import {
  SHARED_FOLDERS_DIR,
  SHARED_FOLDERS_MOUNT_BASE,
} from '@ax/sandbox-mount-protocol';
import type {
  AuthorizeMountsInput,
  AuthorizeMountsOutput,
  LocateSharedFolderInput,
  LocateSharedFolderOutput,
  LocalDirMountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import type { OpenSessionInput } from '@ax/sandbox-protocol';
import { isValidAgentId } from '../agent-id.js';
import { createWorkspaceLocaldirPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// @ax/workspace-localdir — shared folders (W2).
//
// The resolver turns `input.sharedFolderIds` (a REQUEST from the host) into
// `role:'shared-folder'` localDir mounts, but only for the folders
// `shared-folders:authorize-mounts` hands back. These tests stub that service
// (the resolver must never import @ax/shared-folders — invariant I2) and pin:
//   - the user-files mount is untouched and still FIRST;
//   - what the authorizer does and doesn't see;
//   - fail-closed handling of a sloppy authorizer;
//   - `sandbox:locate-shared-folder` (deletion-only, no grant check) confines
//     the location to `.shared/<one safe segment>`.
// ---------------------------------------------------------------------------

const ROOT = '/var/lib/ax/userfiles';
const AGENT_ID = 'agt_Abc-123_xyz';
const F1 = 'sf_AAAA1111';
const F2 = 'sf_BBBB-2222_x';
const F3 = 'sf_CCCC3333';

const OWNER = (agentId: string): NonNullable<OpenSessionInput['owner']> => ({
  userId: 'user-1',
  agentId,
  agentConfig: {
    displayName: 'A',
    systemPromptAugment: '',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'claude',
    runner: 'claude-sdk',
  },
});

type AuthorizeStub = (input: AuthorizeMountsInput) => AuthorizeMountsOutput | Promise<AuthorizeMountsOutput>;

interface Setup {
  /** Present → the `shared-folders:authorize-mounts` service is registered. */
  authorize?: AuthorizeStub;
  logger?: Logger;
}

function makeLogger(): { logger: Logger; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const warn = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info,
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return { logger, info, warn };
}

type Harness = Awaited<ReturnType<typeof createTestHarness>>;

/** Boots the plugin (+ the optional authorizer stub); `calls` records every authorizer input. */
async function withHarness<T>(
  setup: Setup,
  fn: (h: Harness, calls: AuthorizeMountsInput[]) => Promise<T>,
): Promise<T> {
  const calls: AuthorizeMountsInput[] = [];
  const harness = await createTestHarness({
    ...(setup.authorize
      ? {
          services: {
            'shared-folders:authorize-mounts': async (_ctx, input) => {
              calls.push(input as AuthorizeMountsInput);
              return setup.authorize!(input as AuthorizeMountsInput);
            },
          },
        }
      : {}),
    plugins: [createWorkspaceLocaldirPlugin({ root: ROOT })],
  });
  try {
    return await fn(harness, calls);
  } finally {
    await harness.close();
  }
}

async function resolve(
  h: Harness,
  input: Partial<ResolveMountsInput> & { agentId?: string },
  logger?: Logger,
): Promise<ResolveMountsOutput> {
  const { agentId, ...rest } = input;
  return h.bus.call<ResolveMountsInput, ResolveMountsOutput>(
    'sandbox:resolve-mounts',
    // A silent logger by default: the resolver warns on every dropped id.
    h.ctx({ logger: logger ?? makeLogger().logger }),
    { owner: OWNER(agentId ?? AGENT_ID), ...rest },
  );
}

const grantAll: AuthorizeStub = (input) => ({
  folders: input.folderIds.map((folderId) => ({ folderId, readOnly: false })),
});

const USER_FILES: LocalDirMountSpec = {
  kind: 'localDir',
  mountPath: '/files',
  hostPath: join(ROOT, AGENT_ID),
  readOnly: false,
  role: 'user-files',
};

describe('@ax/workspace-localdir — shared folder constants', () => {
  it('keeps its local copies in lock-step with the protocol constants', () => {
    // The plugin cannot runtime-import @ax/sandbox-mount-protocol (eslint
    // crossPluginImports allows type-only), so it holds local copies. This
    // is the one place that drift is caught.
    expect(SHARED_FOLDERS_DIR).toBe('.shared');
    expect(SHARED_FOLDERS_MOUNT_BASE).toBe('/shared');
  });
});

describe('@ax/workspace-localdir — manifest', () => {
  it('declares authorize-mounts as an OPTIONAL call (never a hard dep) and registers locate', () => {
    const { manifest } = createWorkspaceLocaldirPlugin({ root: ROOT });
    expect(manifest.registers).toEqual(
      expect.arrayContaining(['sandbox:resolve-mounts', 'sandbox:locate-shared-folder']),
    );
    expect(manifest.calls).not.toContain('shared-folders:authorize-mounts');
    const optional = manifest.optionalCalls?.find((c) => c.hook === 'shared-folders:authorize-mounts');
    expect(optional).toBeDefined();
    expect(optional?.degradation).toMatch(/shared-folders/);
  });
});

describe('@ax/workspace-localdir — resolve-mounts with sharedFolderIds', () => {
  it('without sharedFolderIds emits exactly the old single user-files mount', async () => {
    await withHarness({ authorize: grantAll }, async (h, calls) => {
      const out = await resolve(h, {});
      expect(out.mounts).toEqual([USER_FILES]);
      expect(calls).toEqual([]);
    });
  });

  it('with an empty sharedFolderIds emits exactly the old single mount and never calls the authorizer', async () => {
    await withHarness({ authorize: grantAll }, async (h, calls) => {
      const out = await resolve(h, { sharedFolderIds: [] });
      expect(out.mounts).toEqual([USER_FILES]);
      expect(calls).toEqual([]);
    });
  });

  it('emits a writable shared-folder mount AFTER the user-files mount for an editor', async () => {
    await withHarness(
      { authorize: () => ({ folders: [{ folderId: F1, readOnly: false }] }) },
      async (h, calls) => {
        const out = await resolve(h, { sharedFolderIds: [F1] });
        expect(out.mounts).toHaveLength(2);
        // user-files first and unchanged.
        expect(out.mounts[0]).toEqual(USER_FILES);
        expect(out.mounts[1]).toEqual({
          kind: 'localDir',
          mountPath: `/shared/${F1}`,
          hostPath: join(ROOT, '.shared', F1),
          readOnly: false,
          role: 'shared-folder',
          folderId: F1,
        });
        // The authorizer is asked about the OWNER's agent, with the requested ids.
        expect(calls).toEqual([{ agentId: AGENT_ID, folderIds: [F1] }]);
      },
    );
  });

  it('keeps every shared hostPath exactly one segment under <root>/.shared', async () => {
    const ids = ['sf_a', 'sf_A-b_C', `sf_${'Z'.repeat(64)}`];
    await withHarness({ authorize: grantAll }, async (h) => {
      const out = await resolve(h, { sharedFolderIds: ids });
      const shared = out.mounts.slice(1) as LocalDirMountSpec[];
      expect(shared.map((m) => m.folderId)).toEqual(ids);
      for (const m of shared) {
        expect(dirname(m.hostPath)).toBe(join(ROOT, '.shared'));
        expect(m.hostPath).toBe(join(ROOT, '.shared', m.folderId!));
      }
    });
  });

  it('emits a readOnly mount for a viewer grant', async () => {
    await withHarness(
      { authorize: () => ({ folders: [{ folderId: F1, readOnly: true }] }) },
      async (h) => {
        const out = await resolve(h, { sharedFolderIds: [F1] });
        expect((out.mounts[1] as LocalDirMountSpec).readOnly).toBe(true);
        // The user-files mount stays writable: a viewer grant narrows ONLY the shared mount.
        expect((out.mounts[0] as LocalDirMountSpec).readOnly).toBe(false);
      },
    );
  });

  it('emits each authorized folder with its own readOnly, in request order', async () => {
    await withHarness(
      {
        // Deliberately returns them out of request order — the resolver
        // must stay deterministic regardless.
        authorize: () => ({
          folders: [
            { folderId: F2, readOnly: true },
            { folderId: F1, readOnly: false },
          ],
        }),
      },
      async (h) => {
        const out = await resolve(h, { sharedFolderIds: [F1, F2] });
        const shared = out.mounts.slice(1) as LocalDirMountSpec[];
        expect(shared.map((m) => [m.folderId, m.readOnly])).toEqual([
          [F1, false],
          [F2, true],
        ]);
      },
    );
  });

  it('does not emit a folder the authorizer left out, and logs why', async () => {
    const { logger, info, warn } = makeLogger();
    await withHarness(
      { authorize: () => ({ folders: [{ folderId: F1, readOnly: false }] }) },
      async (h) => {
        const out = await resolve(h, { sharedFolderIds: [F1, F2] }, logger);
        expect(out.mounts.map((m) => (m as LocalDirMountSpec).folderId)).toEqual([undefined, F1]);
        const logged = [...info.mock.calls, ...warn.mock.calls].filter(
          ([msg]) => msg === 'shared_folder_mount_dropped',
        );
        expect(logged).toHaveLength(1);
        expect(logged[0]![1]).toMatchObject({ folderId: F2, reason: 'not-authorized' });
      },
    );
  });

  it('never sends an invalid id to the authorizer, and drops it with a log', async () => {
    const { logger, info, warn } = makeLogger();
    const bad = ['../x', '.shared', 'sf_a/b', '', 'sf_', 'agt_notafolder', `sf_${'a'.repeat(65)}`];
    await withHarness({ authorize: grantAll }, async (h, calls) => {
      const out = await resolve(h, { sharedFolderIds: [...bad, F1] }, logger);
      expect(calls).toEqual([{ agentId: AGENT_ID, folderIds: [F1] }]);
      expect(out.mounts.map((m) => (m as LocalDirMountSpec).folderId)).toEqual([undefined, F1]);
      const dropped = [...info.mock.calls, ...warn.mock.calls].filter(
        ([msg]) => msg === 'shared_folder_mount_dropped',
      );
      expect(dropped).toHaveLength(bad.length);
      for (const [, bindings] of dropped) {
        expect(bindings).toMatchObject({ reason: 'invalid-id' });
      }
    });
  });

  it('skips the authorizer entirely when every requested id is invalid', async () => {
    await withHarness({ authorize: grantAll }, async (h, calls) => {
      const out = await resolve(h, { sharedFolderIds: ['../x', '.shared'] });
      expect(out.mounts).toEqual([USER_FILES]);
      expect(calls).toEqual([]);
    });
  });

  it('sends each requested id once even when the host repeats it', async () => {
    await withHarness({ authorize: grantAll }, async (h, calls) => {
      const out = await resolve(h, { sharedFolderIds: [F1, F1, F2, F1] });
      expect(calls).toEqual([{ agentId: AGENT_ID, folderIds: [F1, F2] }]);
      expect(out.mounts.map((m) => (m as LocalDirMountSpec).folderId)).toEqual([undefined, F1, F2]);
    });
  });

  it('ignores a folder the authorizer returns that was never requested', async () => {
    await withHarness(
      {
        authorize: () => ({
          folders: [
            { folderId: F1, readOnly: false },
            { folderId: F3, readOnly: false }, // not requested
            { folderId: '../escape', readOnly: false }, // not requested, not even valid
          ],
        }),
      },
      async (h) => {
        const out = await resolve(h, { sharedFolderIds: [F1] });
        expect(out.mounts.map((m) => (m as LocalDirMountSpec).folderId)).toEqual([undefined, F1]);
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain(F3);
        expect(serialized).not.toContain('escape');
      },
    );
  });

  it.each([
    ['writable then readOnly', [false, true]],
    ['readOnly then writable', [true, false]],
  ])('collapses a duplicate authorizer entry (%s) to ONE mount, keeping the stricter readOnly', async (_label, flags) => {
    await withHarness(
      {
        authorize: () => ({
          folders: flags.map((readOnly) => ({ folderId: F1, readOnly })),
        }),
      },
      async (h) => {
        const out = await resolve(h, { sharedFolderIds: [F1] });
        const shared = out.mounts.slice(1) as LocalDirMountSpec[];
        expect(shared).toHaveLength(1);
        expect(shared[0]!.readOnly).toBe(true);
      },
    );
  });

  it('treats anything but an explicit readOnly:false as read-only (fail narrow)', async () => {
    await withHarness(
      {
        authorize: () =>
          ({ folders: [{ folderId: F1 }] }) as unknown as AuthorizeMountsOutput,
      },
      async (h) => {
        const out = await resolve(h, { sharedFolderIds: [F1] });
        expect((out.mounts[1] as LocalDirMountSpec).readOnly).toBe(true);
      },
    );
  });

  it('emits NO shared mounts when the authorizer plugin is absent, and logs once', async () => {
    const { logger, info, warn } = makeLogger();
    await withHarness({}, async (h) => {
      expect(h.bus.hasService('shared-folders:authorize-mounts')).toBe(false);
      const out = await resolve(h, { sharedFolderIds: [F1, F2] }, logger);
      expect(out.mounts).toEqual([USER_FILES]);
      const logged = [...info.mock.calls, ...warn.mock.calls].filter(
        ([msg]) => typeof msg === 'string' && msg.startsWith('shared_folder_mount'),
      );
      expect(logged).toHaveLength(1);
      expect(logged[0]![1]).toMatchObject({ reason: 'no-authorizer' });
    });
  });

  it('input.readOnly forces every shared mount read-only, even for an editor', async () => {
    await withHarness({ authorize: grantAll }, async (h) => {
      const out = await resolve(h, { sharedFolderIds: [F1, F2], readOnly: true });
      expect(out.mounts).toHaveLength(3);
      for (const m of out.mounts) expect((m as LocalDirMountSpec).readOnly).toBe(true);
    });
  });

  it('input.readOnly:false leaves an editor mount writable', async () => {
    await withHarness({ authorize: grantAll }, async (h) => {
      const out = await resolve(h, { sharedFolderIds: [F1], readOnly: false });
      expect((out.mounts[1] as LocalDirMountSpec).readOnly).toBe(false);
    });
  });

  it('honors a custom user-files mountPath without moving the shared mountPath', async () => {
    const harness = await createTestHarness({
      services: { 'shared-folders:authorize-mounts': async (_c, i) => grantAll(i as AuthorizeMountsInput) },
      plugins: [createWorkspaceLocaldirPlugin({ root: ROOT, mountPath: '/data' })],
    });
    try {
      const out = await resolve(harness, { sharedFolderIds: [F1] });
      expect(out.mounts[0]!.mountPath).toBe('/data');
      expect(out.mounts[1]!.mountPath).toBe(`/shared/${F1}`);
    } finally {
      await harness.close();
    }
  });

  it('emits no shared mounts for an anonymous/invalid agentId, and never calls the authorizer', async () => {
    await withHarness({ authorize: grantAll }, async (h, calls) => {
      for (const bad of ['', '../x', '.shared', 'a/b']) {
        const out = await resolve(h, { agentId: bad, sharedFolderIds: [F1] });
        expect(out.mounts).toEqual([]);
      }
      expect(calls).toEqual([]);
    });
  });

  it('lets an authorizer failure propagate (the session open fails closed)', async () => {
    await withHarness(
      {
        authorize: () => {
          throw new Error('grants store down');
        },
      },
      async (h) => {
        await expect(resolve(h, { sharedFolderIds: [F1] })).rejects.toThrow(/grants store down/);
      },
    );
  });
});

describe('@ax/workspace-localdir — sandbox:locate-shared-folder', () => {
  async function locate(
    h: Harness,
    folderId: unknown,
  ): Promise<LocateSharedFolderOutput> {
    return h.bus.call<LocateSharedFolderInput, LocateSharedFolderOutput>(
      'sandbox:locate-shared-folder',
      h.ctx(),
      { folderId } as LocateSharedFolderInput,
    );
  }

  it('returns the confined, WRITABLE shared-folder spec — with NO grant check', async () => {
    // No authorize-mounts service is registered at all: locate must not need one.
    await withHarness({}, async (h) => {
      expect(h.bus.hasService('shared-folders:authorize-mounts')).toBe(false);
      const out = await locate(h, F1);
      expect(out).toEqual({
        mount: {
          kind: 'localDir',
          mountPath: `/shared/${F1}`,
          hostPath: join(ROOT, '.shared', F1),
          readOnly: false,
          role: 'shared-folder',
          folderId: F1,
        },
      });
    });
  });

  it('does not consult the authorizer even when one is loaded', async () => {
    await withHarness({ authorize: grantAll }, async (h, calls) => {
      await locate(h, F1);
      expect(calls).toEqual([]);
    });
  });

  it.each(['../x', '.shared', 'sf_a/b', '', 'sf_', '.', '..', 'sf_..', '/abs', 'agt_x', 'sf_a b', `sf_${'a'.repeat(65)}`])(
    'rejects %j with invalid-folder-id',
    async (bad) => {
      await withHarness({}, async (h) => {
        const err = await locate(h, bad).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PluginError);
        expect((err as PluginError).code).toBe('invalid-folder-id');
      });
    },
  );

  it.each([undefined, null, 42, {}, ['sf_a']])('rejects a non-string folderId (%j)', async (bad) => {
    await withHarness({}, async (h) => {
      const err = await locate(h, bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).code).toBe('invalid-folder-id');
    });
  });
});

describe('@ax/workspace-localdir — agent id can never name the shared subtree', () => {
  it.each(['.shared', '.', '..', 'shared/x', '.shared/sf_a'])('isValidAgentId(%j) is false', (bad) => {
    expect(isValidAgentId(bad)).toBe(false);
  });

  it('a session whose agentId is ".shared" gets no mounts at all (cannot mount every folder)', async () => {
    await withHarness({ authorize: grantAll }, async (h) => {
      const out = await resolve(h, { agentId: '.shared', sharedFolderIds: [F1] });
      expect(out.mounts).toEqual([]);
    });
  });
});
