import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createWorkspaceLocaldirPlugin } from '@ax/workspace-localdir';
import type {
  AuthorizeMountsInput,
  AuthorizeMountsOutput,
  MountSpec,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';
import { TEST_PROXY_CONFIG } from './proxy-config.js';

// ---------------------------------------------------------------------------
// W2 shared folders — through the REAL `sandbox:open-session` (design §3.5-§3.8).
//
// Real subprocess provider + (usually) the real @ax/workspace-localdir resolver;
// only `shared-folders:authorize-mounts` is a stub (this package must not import
// @ax/shared-folders, I2 — the real plugin joins in the canary acceptance test).
// A runner stub (echo-stub.mjs) dumps its env on boot, so what is asserted is
// what a real runner would actually receive.
// ---------------------------------------------------------------------------

const ECHO_STUB = fileURLToPath(new URL('./fixtures/echo-stub.mjs', import.meta.url));

const AGENT = 'agt_abc';
const F1 = 'sf_AAAA1111';
const F2 = 'sf_BBBB-2222_x';

function owner(agentId = AGENT) {
  return {
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
  };
}

let root: string;
let ws: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-open-root-'));
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-open-ws-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(ws, { recursive: true, force: true }).catch(() => undefined);
});

type Authorize = (input: AuthorizeMountsInput) => AuthorizeMountsOutput;

const base = {
  'llm:call': async () => ({
    assistantMessage: { role: 'assistant', content: '' },
    toolCalls: [],
  }),
  'tool:list': async () => ({ tools: [] }),
  'workspace:read': async () => ({ found: false }),
};

/** Real localdir resolver over `root`; `authorize` stubs `shared-folders:authorize-mounts`. */
async function localdirHarness(authorize?: Authorize) {
  const authorizeCalls: AuthorizeMountsInput[] = [];
  const h = await createTestHarness({
    services: {
      ...base,
      ...(authorize !== undefined
        ? {
            'shared-folders:authorize-mounts': async (_ctx: unknown, raw: unknown) => {
              const input = raw as AuthorizeMountsInput;
              authorizeCalls.push(input);
              return authorize(input);
            },
          }
        : {}),
    },
    plugins: [
      createSessionInmemoryPlugin(),
      createIpcServerPlugin(),
      createWorkspaceLocaldirPlugin({ root }),
      createSandboxSubprocessPlugin(),
    ],
  });
  return { h, authorizeCalls };
}

/** A stub resolver (in place of localdir) that answers `mounts` — for malformed-output cases. */
async function stubResolverHarness(mounts: MountSpec[]) {
  const resolverInputs: ResolveMountsInput[] = [];
  const h = await createTestHarness({
    services: {
      ...base,
      'sandbox:resolve-mounts': async (_ctx: unknown, raw: unknown): Promise<ResolveMountsOutput> => {
        resolverInputs.push(raw as ResolveMountsInput);
        return { mounts };
      },
    },
    plugins: [
      createSessionInmemoryPlugin(),
      createIpcServerPlugin(),
      createSandboxSubprocessPlugin(),
    ],
  });
  return { h, resolverInputs };
}

type Harness = Awaited<ReturnType<typeof createTestHarness>>;

function open(h: Harness, sessionId: string, extra: Record<string, unknown>) {
  return h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', h.ctx(), {
    sessionId,
    workspaceRoot: ws,
    runnerBinary: ECHO_STUB,
    proxyConfig: TEST_PROXY_CONFIG,
    owner: owner(),
    ...extra,
  });
}

function readFirstStdoutLine(result: OpenSessionResult): Promise<string> {
  const stdout = result.handle.child?.stdout;
  if (stdout === undefined) throw new Error('expected handle.child.stdout');
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        stdout.off('data', onData);
        stdout.off('error', onErr);
        resolve(buf.slice(0, nl));
      }
    };
    const onErr = (err: Error): void => reject(err);
    stdout.on('data', onData);
    stdout.on('error', onErr);
  });
}

/** Open a session, capture the runner's env dump, and kill the child. */
async function openAndReadEnv(
  h: Harness,
  sessionId: string,
  extra: Record<string, unknown>,
): Promise<Record<string, string | null>> {
  const result = await open(h, sessionId, extra);
  try {
    return JSON.parse(await readFirstStdoutLine(result)) as Record<string, string | null>;
  } finally {
    await result.handle.kill();
    await result.handle.exited;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

const grantAll: Authorize = (input) => ({
  folders: input.folderIds.map((folderId) => ({ folderId, readOnly: false })),
});

describe('sandbox:open-session — shared folders', () => {
  it('creates <root>/.shared/<id> and stamps AX_SHARED_FOLDERS with the exact JSON (host paths)', async () => {
    const { h, authorizeCalls } = await localdirHarness(grantAll);
    const env = await openAndReadEnv(h, 'sf-1', { sharedFolderIds: [F1] });

    const dir = path.join(root, '.shared', F1);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    // The subprocess runner sees the HOST filesystem, so the path it is handed
    // is the host path — not the logical /shared/<id> label.
    expect(env.AX_SHARED_FOLDERS).toBe(
      JSON.stringify([{ id: F1, path: dir, readOnly: false }]),
    );
    // The host's request reached the resolver, which asked the authorizer.
    expect(authorizeCalls).toEqual([{ agentId: AGENT, folderIds: [F1] }]);
  });

  it('lists several folders in request order, and a viewer grant is readOnly:true in the env', async () => {
    const { h } = await localdirHarness((input) => ({
      folders: input.folderIds.map((folderId) => ({ folderId, readOnly: folderId === F1 })),
    }));
    const env = await openAndReadEnv(h, 'sf-2', { sharedFolderIds: [F1, F2] });

    expect(JSON.parse(env.AX_SHARED_FOLDERS!)).toEqual([
      { id: F1, path: path.join(root, '.shared', F1), readOnly: true },
      { id: F2, path: path.join(root, '.shared', F2), readOnly: false },
    ]);
    expect((await fs.stat(path.join(root, '.shared', F2))).isDirectory()).toBe(true);
  });

  it('a shared folder written by one session is visible in the next session of ANOTHER agent', async () => {
    // The directory is the shared state: the provider only has to give both
    // sessions the same host path.
    const { h } = await localdirHarness(grantAll);
    const envA = await openAndReadEnv(h, 'sf-a', { sharedFolderIds: [F1], owner: owner('agt_a') });
    const dirA = (JSON.parse(envA.AX_SHARED_FOLDERS!) as Array<{ path: string }>)[0]!.path;
    await fs.writeFile(path.join(dirA, 'note.txt'), 'from a');

    const envB = await openAndReadEnv(h, 'sf-b', { sharedFolderIds: [F1], owner: owner('agt_b') });
    const dirB = (JSON.parse(envB.AX_SHARED_FOLDERS!) as Array<{ path: string }>)[0]!.path;
    expect(dirB).toBe(dirA);
    expect(await fs.readFile(path.join(dirB, 'note.txt'), 'utf-8')).toBe('from a');
  });

  it('does not stamp AX_SHARED_FOLDERS (or create .shared) when no folders are requested', async () => {
    const { h, authorizeCalls } = await localdirHarness(grantAll);
    const env = await openAndReadEnv(h, 'sf-none', {});
    expect(env.AX_SHARED_FOLDERS).toBeNull();
    expect(env.AX_USERFILES_ROOT).toBe(path.join(root, AGENT));
    expect(await exists(path.join(root, '.shared'))).toBe(false);
    expect(authorizeCalls).toEqual([]);
  });

  it('does not stamp AX_SHARED_FOLDERS when the grants authorize none of the requested folders', async () => {
    const { h } = await localdirHarness(() => ({ folders: [] }));
    const env = await openAndReadEnv(h, 'sf-denied', { sharedFolderIds: [F1] });
    expect(env.AX_SHARED_FOLDERS).toBeNull();
    expect(await exists(path.join(root, '.shared'))).toBe(false);
    // The session still opens with its own files.
    expect(env.AX_USERFILES_ROOT).toBe(path.join(root, AGENT));
  });

  it('does not stamp AX_SHARED_FOLDERS when @ax/shared-folders is not loaded (resolver emits nothing)', async () => {
    const { h } = await localdirHarness(undefined);
    const env = await openAndReadEnv(h, 'sf-noplugin', { sharedFolderIds: [F1] });
    expect(env.AX_SHARED_FOLDERS).toBeNull();
    expect(await exists(path.join(root, '.shared'))).toBe(false);
  });

  it('AX_USERFILES_ROOT is still the agent own dir with shared folders mounted alongside', async () => {
    const { h } = await localdirHarness(grantAll);
    const env = await openAndReadEnv(h, 'sf-uf', { sharedFolderIds: [F1, F2] });
    expect(env.AX_USERFILES_ROOT).toBe(path.join(root, AGENT));
    expect(
      (JSON.parse(env.AX_SHARED_FOLDERS!) as Array<{ id: string }>).map((f) => f.id),
    ).toEqual([F1, F2]);
  });

  // F10 — through the real open path (real localdir resolver): a `.shared` or
  // `.shared/<id>` that is a symlink / not a directory must fail the open
  // closed. `mkdir -p` would otherwise follow the link and the runner would be
  // handed (and write into) a path outside `<root>/.shared`.
  describe('fails the session open when .shared or the folder dir is a symlink or not a directory', () => {
    let outside: string;
    beforeEach(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-sf-open-outside-'));
    });
    afterEach(async () => {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
    });

    async function expectOpenRefused(sessionId: string): Promise<void> {
      const { h } = await localdirHarness(grantAll);
      const caught = await open(h, sessionId, { sharedFolderIds: [F1, F2] }).catch(
        (e: unknown) => e,
      );
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('mount-resolve-failed');
      // No runner was spawned, no session minted, and the agent's own dir was not realized.
      await expect(
        h.bus.call('session:is-alive', h.ctx(), { sessionId }),
      ).resolves.toMatchObject({ alive: false });
      expect(await exists(path.join(root, AGENT))).toBe(false);
    }

    it('a symlinked .shared: the open fails and the symlink target is untouched', async () => {
      await fs.writeFile(path.join(outside, 'precious.txt'), 'precious');
      await fs.symlink(outside, path.join(root, '.shared'));

      await expectOpenRefused('sf-link-shared');

      expect(await fs.readdir(outside)).toEqual(['precious.txt']);
      expect(await fs.readFile(path.join(outside, 'precious.txt'), 'utf-8')).toBe('precious');
    });

    it('a symlinked folder directory: the open fails and the symlink target is untouched', async () => {
      await fs.mkdir(path.join(root, '.shared'));
      await fs.writeFile(path.join(outside, 'precious.txt'), 'precious');
      await fs.symlink(outside, path.join(root, '.shared', F1));

      await expectOpenRefused('sf-link-folder');

      expect(await fs.readdir(outside)).toEqual(['precious.txt']);
      // The clean sibling was not realized either: all-or-nothing.
      expect(await exists(path.join(root, '.shared', F2))).toBe(false);
    });

    it('.shared as a regular file: the open fails', async () => {
      await fs.writeFile(path.join(root, '.shared'), 'i am a file');
      await expectOpenRefused('sf-file-shared');
      expect(await fs.readFile(path.join(root, '.shared'), 'utf-8')).toBe('i am a file');
    });

    it('a folder directory that is a regular file: the open fails', async () => {
      await fs.mkdir(path.join(root, '.shared'));
      await fs.writeFile(path.join(root, '.shared', F1), 'i am a file');
      await expectOpenRefused('sf-file-folder');
      expect(await fs.readFile(path.join(root, '.shared', F1), 'utf-8')).toBe('i am a file');
    });

    it('control — pre-existing real directories open normally and are stamped', async () => {
      await fs.mkdir(path.join(root, '.shared', F1), { recursive: true });
      const { h } = await localdirHarness(grantAll);
      const env = await openAndReadEnv(h, 'sf-real-dirs', { sharedFolderIds: [F1, F2] });
      expect(JSON.parse(env.AX_SHARED_FOLDERS!)).toEqual([
        { id: F1, path: path.join(root, '.shared', F1), readOnly: false },
        { id: F2, path: path.join(root, '.shared', F2), readOnly: false },
      ]);
    });
  });

  describe('fails the session open (fail closed) on malformed resolver output', () => {
    const cases: Array<[string, () => MountSpec[]]> = [
      [
        'a shared mount whose hostPath is another agent dir',
        () => [
          {
            kind: 'localDir',
            mountPath: `/shared/${F1}`,
            hostPath: path.join(root, 'agt_victim'),
            readOnly: false,
            role: 'shared-folder',
            folderId: F1,
          },
        ],
      ],
      [
        'a shared mount for a folder that was never requested',
        () => [
          {
            kind: 'localDir',
            mountPath: `/shared/${F2}`,
            hostPath: path.join(root, '.shared', F2),
            readOnly: false,
            role: 'shared-folder',
            folderId: F2,
          },
        ],
      ],
      [
        'a shared mount with a traversal hostPath',
        () => [
          {
            kind: 'localDir',
            mountPath: `/shared/${F1}`,
            hostPath: `${root}/.shared/../agt_victim/${F1}`,
            readOnly: false,
            role: 'shared-folder',
            folderId: F1,
          },
        ],
      ],
    ];

    it.each(cases)('%s', async (_label, mounts) => {
      const { h, resolverInputs } = await stubResolverHarness(mounts());
      const caught = await open(h, 'sf-bad', { sharedFolderIds: [F1] }).catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('mount-resolve-failed');
      // The request did reach the (stub) resolver verbatim...
      expect(resolverInputs[0]!.sharedFolderIds).toEqual([F1]);
      // ...and the bad answer realized nothing on disk.
      expect(await exists(path.join(root, 'agt_victim'))).toBe(false);
      expect(await exists(path.join(root, '.shared'))).toBe(false);
      // No session was minted for the failed open.
      await expect(
        h.bus.call('session:is-alive', h.ctx(), { sessionId: 'sf-bad' }),
      ).resolves.toMatchObject({ alive: false });
    });
  });
});
