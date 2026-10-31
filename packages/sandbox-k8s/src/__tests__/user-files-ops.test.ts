import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFINED_READ_LIMITS } from '@ax/user-files-read';
import { HookBus, makeAgentContext, PluginError, type Logger } from '@ax/core';
import type {
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import { resolveConfig } from '../config.js';
import {
  buildCleanupCommand,
  cleanupUserFiles,
  measureUserFiles,
  ownerFromAgentId,
  parseReadOutput,
  readUserFiles,
} from '../user-files-ops.js';
import { makeMockK8sApi, type MockK8sApi } from './mock-k8s.js';

// ---------------------------------------------------------------------------
// TASK-167 (filestore-user-files §11) — the k8s provider's host-read + cleanup
// realizations against an `nfs` (Filestore) export, via a short-lived one-shot
// pod. The mock K8sCoreApi captures the pod spec the op builds; we assert the
// pod mounts the WHOLE export, operates on ONLY the validated subPath
// (cross-tenant safety), is fenced (`ax.io/plane: execution`, locked security
// ctx), and reads read-only. `watchPodExit` resolves as soon as the read
// response is a terminal phase, so the one-shot completes deterministically.
// ---------------------------------------------------------------------------

const CONFIG = resolveConfig({ hostIpcUrl: 'http://h:80', namespace: 'ax-test' });

// The host-mounted reader is the per-component no-follow walk, which needs
// Linux /proc. Off Linux it throws `unsupported-platform` (TASK-899), so the
// tests that read real files skip there. CI runs them on ubuntu.
const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');
// Root reads through a mode-000 folder, so permission tests skip as root.
const IS_ROOT = process.getuid?.() === 0;

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
}
const log: Logger = ctx().logger;

/** A bus whose resolver emits an nfs mount for the given owner, honoring
 *  readOnly. Records the readOnly value it was last asked for. */
function busWithNfs(server = '10.0.0.2', exportPath = '/vol1/agents') {
  const bus = new HookBus();
  const seen: { readOnly?: boolean } = {};
  bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
    'sandbox:resolve-mounts',
    'mock-filestore',
    async (_c, input) => {
      seen.readOnly = input.readOnly;
      return {
        mounts: input.owner.agentId
          ? [
              {
                kind: 'nfs' as const,
                mountPath: '/workspace',
                server,
                exportPath,
                subPath: input.owner.agentId,
                readOnly: input.readOnly === true,
                role: 'user-files' as const,
              },
            ]
          : [],
      };
    },
  );
  return { bus, seen };
}

/** The bits of the one-shot pod manifest the tests inspect. */
interface InspectablePod {
  metadata: { labels: Record<string, string> };
  spec: {
    restartPolicy: string;
    automountServiceAccountToken: boolean;
    volumes: Array<{ nfs?: { server: string; path: string } }>;
    containers: Array<{
      command: string[];
      env: Array<{ name: string; value: string }>;
      securityContext: {
        runAsNonRoot: boolean;
        runAsUser: number;
        runAsGroup: number;
        allowPrivilegeEscalation: boolean;
        readOnlyRootFilesystem: boolean;
        capabilities: { drop: string[]; add?: string[] };
      };
      volumeMounts: Array<{ readOnly: boolean }>;
    }>;
  };
}

/** Drive the one-shot pod to a terminal Succeeded phase so watchPodExit
 *  resolves immediately. Optionally stub the read pod's log output. */
function primeTerminal(api: MockK8sApi, log?: string, exitCode = 0) {
  api.setReadResponses({
    status: {
      phase: exitCode === 0 ? 'Succeeded' : 'Failed',
      containerStatuses: [{ name: 'userfiles', state: { terminated: { exitCode } } }],
    },
  });
  if (log !== undefined) api.setLogResponse('userfiles', log);
}

describe('cleanupUserFiles (k8s one-shot rm pod)', () => {
  it('creates a short-lived pod that mounts the export and rm -rf the agent subPath', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api);
    const { bus } = busWithNfs();
    await cleanupUserFiles(
      ctx(),
      bus,
      api,
      CONFIG,
      ownerFromAgentId('agent-abc', 'u1'),
      log,
    );

    expect(api.creates).toHaveLength(1);
    const pod = api.creates[0]!.body as InspectablePod;
    // Fenced + locked like a runner pod.
    expect(pod.metadata.labels['ax.io/plane']).toBe('execution');
    expect(pod.metadata.labels['app.kubernetes.io/component']).toBe('ax-next-userfiles');
    expect(pod.spec.restartPolicy).toBe('Never');
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    const c = pod.spec.containers[0];
    // TASK-718: the RECLAIM pod is root. The runner's chown init container hands
    // `/export/<agentId>` to uid 1000, but the export ROOT stays root-owned, so a
    // uid-1000 `rm -rf` removes the contents and is then refused the final unlink
    // of the directory entry (`rm: cannot remove '/export/<id>': Permission
    // denied`, exit 1, empty directory left behind — measured on prod, reproduced
    // locally with the prod image). Root needs exactly two capabilities to remove
    // a tree its agent owns: DAC_OVERRIDE (write into 1000-owned dirs, including
    // ones the agent chmod'd) and FOWNER (unlink inside a sticky dir it planted).
    expect(c.securityContext.runAsNonRoot).toBe(false);
    expect(c.securityContext.runAsUser).toBe(0);
    expect(c.securityContext.runAsGroup).toBe(0);
    expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(c.securityContext.capabilities.drop).toEqual(['ALL']);
    expect(c.securityContext.capabilities.add).toEqual(['DAC_OVERRIDE', 'FOWNER']);
    // Mounts the WHOLE export (read-WRITE for a delete), operates on the subPath.
    expect(pod.spec.volumes[0].nfs).toEqual({ server: '10.0.0.2', path: '/vol1/agents' });
    expect(c.volumeMounts[0].readOnly).toBe(false);
    // subPath rides in env (never spliced into the shell word).
    expect(c.env).toEqual([{ name: 'SUBPATH', value: 'agent-abc' }]);
    const cmd = (c.command as string[]).join(' ');
    expect(cmd).toMatch(/rm -rf -- "\/export\/\$SUBPATH"/);
    // ...and it is exactly the script the shell tests run.
    expect(c.command).toEqual(['sh', '-c', buildCleanupCommand()]);
    // The one-shot pod is deleted after it completes.
    expect(api.deletes).toHaveLength(1);
  });

  it.each([1, 7, 137])('reports a cleanup pod exit of %i as a failure and still deletes it', async (exitCode) => {
    const api = makeMockK8sApi();
    primeTerminal(api, undefined, exitCode);
    const { bus } = busWithNfs();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    try {
      await expect(
        cleanupUserFiles(ctx(), bus, api, CONFIG, ownerFromAgentId('agent-abc', 'u1'), log),
      ).resolves.toBeUndefined();
      // TASK-718: a failed reclaim leaves a tenant's data on disk after their
      // delete succeeded, so it is an ERROR an operator can alert on, not a warn.
      expect(error).toHaveBeenCalledWith(
        'user_files_cleanup_failed',
        expect.objectContaining({
          agentId: 'agent-abc',
          err: expect.stringContaining(`exited code=${exitCode}`),
        }),
      );
      expect(info).not.toHaveBeenCalledWith('user_files_cleanup_done', expect.anything());
      expect(api.deletes).toHaveLength(1);
    } finally {
      error.mockRestore();
      info.mockRestore();
    }
  });

  it('a failed reclaim says WHAT failed: the pod name, the directory left behind and the pod\'s own output', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'userfiles',
            state: {
              terminated: {
                exitCode: 1,
                reason: 'Error',
                // What kubelet copies from the log under FallbackToLogsOnError.
                message:
                  "rm: cannot remove '/export/agent-abc': Permission denied\nreclaim: /export/agent-abc still exists\n",
              },
            },
          },
        ],
      },
    });
    const { bus } = busWithNfs();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    try {
      await cleanupUserFiles(ctx(), bus, api, CONFIG, ownerFromAgentId('agent-abc', 'u1'), log);
      expect(error).toHaveBeenCalledTimes(1);
      const [event, fields] = error.mock.calls[0]! as [string, Record<string, unknown>];
      expect(event).toBe('user_files_cleanup_failed');
      expect(fields.agentId).toBe('agent-abc');
      expect(fields.subPath).toBe('agent-abc');
      expect(String(fields.podName)).toMatch(/^ax-userfiles-rm-/);
      expect(String(fields.err)).toContain('Permission denied');
      expect(String(fields.err)).toContain('exited code=1');
    } finally {
      error.mockRestore();
    }
  });

  it('bounds the pod output it carries into the log line (it names agent-written file names)', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'userfiles',
            state: { terminated: { exitCode: 1, reason: 'Error', message: 'x'.repeat(50_000) } },
          },
        ],
      },
    });
    const { bus } = busWithNfs();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    try {
      await cleanupUserFiles(ctx(), bus, api, CONFIG, ownerFromAgentId('agent-abc', 'u1'), log);
      const fields = error.mock.calls[0]![1] as Record<string, unknown>;
      expect(String(fields.err).length).toBeLessThan(2_000);
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    ['the pod vanished before it reported (404)', 'gone'],
    ['the pod reported no exit code', 'nocode'],
  ])('REGRESSION: %s is a FAILED reclaim, not a successful one', async (_label, mode) => {
    /*
      `runOneshotPod` treated `exit.code === null` as success. For a read that is
      tolerable (the log is parsed and a bad one fails there); for a delete it
      means "we do not know whether the data is gone" reported as "done".
    */
    const api = makeMockK8sApi();
    if (mode === 'gone') {
      api.setReadError(Object.assign(new Error('pods not found'), { code: 404 }));
    } else {
      api.setReadResponses({ status: { phase: 'Succeeded', containerStatuses: [{ name: 'userfiles' }] } });
    }
    const { bus } = busWithNfs();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    try {
      await cleanupUserFiles(ctx(), bus, api, CONFIG, ownerFromAgentId('agent-abc', 'u1'), log);
      expect(error).toHaveBeenCalledWith('user_files_cleanup_failed', expect.anything());
      expect(info).not.toHaveBeenCalledWith('user_files_cleanup_done', expect.anything());
    } finally {
      error.mockRestore();
      info.mockRestore();
    }
  });

  it('the READ pod stays non-root: only the reclaim pod is granted root', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api, 'ABSENT');
    const { bus } = busWithNfs();
    await readUserFiles(ctx(), bus, api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
    });
    const sc = (api.creates[0]!.body as InspectablePod).spec.containers[0].securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.runAsUser).toBe(1000);
    expect(sc.capabilities).toEqual({ drop: ['ALL'] });
  });

  it('CROSS-TENANT: the subPath in the rm target is EXACTLY the deleted agent id', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api);
    const { bus } = busWithNfs();
    await cleanupUserFiles(
      ctx(),
      bus,
      api,
      CONFIG,
      ownerFromAgentId('agt_OnlyMe', 'u1'),
      log,
    );
    const pod = api.creates[0]!.body as InspectablePod;
    // SUBPATH carries ONLY this agent's id — no sibling's subtree is reachable.
    expect(pod.spec.containers[0].env).toEqual([{ name: 'SUBPATH', value: 'agt_OnlyMe' }]);
  });

  it('SECURITY: refuses (logs, does not create a pod) when the resolved subPath is traversal-unsafe', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api);
    // A resolver that (bug/compromise) emits a subPath with a slash.
    const bus = new HookBus();
    bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      'bad',
      async () => ({
        mounts: [
          {
            kind: 'nfs',
            mountPath: '/workspace',
            server: '10.0.0.2',
            exportPath: '/vol1/agents',
            subPath: '../other-agent',
            readOnly: false,
            role: 'user-files',
          },
        ],
      }),
    );
    // Best-effort cleanup: it logs + returns, never throws, and creates NO pod.
    await expect(
      cleanupUserFiles(ctx(), bus, api, CONFIG, ownerFromAgentId('x', 'u1'), log),
    ).resolves.toBeUndefined();
    expect(api.creates).toHaveLength(0);
  });

  it('is a graceful no-op when no resolver is loaded', async () => {
    const api = makeMockK8sApi();
    const bus = new HookBus();
    await cleanupUserFiles(
      ctx(),
      bus,
      api,
      CONFIG,
      ownerFromAgentId('agent-abc', 'u1'),
      log,
    );
    expect(api.creates).toHaveLength(0);
  });

  it('does NOT throw when the resolver emits an unrealizable (localDir) kind', async () => {
    const api = makeMockK8sApi();
    const bus = new HookBus();
    bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      'mock-localdir',
      async () => ({
        mounts: [
          {
            kind: 'localDir',
            mountPath: '/workspace',
            hostPath: '/x/agent-abc',
            readOnly: false,
            role: 'user-files',
          },
        ],
      }),
    );
    await expect(
      cleanupUserFiles(ctx(), bus, api, CONFIG, ownerFromAgentId('agent-abc', 'u1'), log),
    ).resolves.toBeUndefined();
    expect(api.creates).toHaveLength(0);
  });
});

describe('readUserFiles (k8s one-shot read pod)', () => {
  it('mounts the export READ-ONLY and requests a readOnly realization', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api, 'ABSENT');
    const { bus, seen } = busWithNfs();
    await readUserFiles(ctx(), bus, api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
    });
    // The resolver was asked for a read-only realization (host-read, §11).
    expect(seen.readOnly).toBe(true);
    const pod = api.creates[0]!.body as InspectablePod;
    expect(pod.spec.containers[0].volumeMounts[0].readOnly).toBe(true);
    expect(pod.metadata.labels['ax.io/plane']).toBe('execution');
    // SUBPATH (the agent's own subtree) + RELPATH (relative to it) ride
    // SEPARATELY via env; the script realpath-confines under $EXPORT/$SUBPATH.
    expect(pod.spec.containers[0].env).toEqual([
      { name: 'SUBPATH', value: 'agent-abc' },
      { name: 'RELPATH', value: '.' },
    ]);
    expect(api.deletes).toHaveLength(1);
  });

  it('scopes a nested relPath relative to the agent subPath', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api, 'FILE ' + Buffer.from('hi').toString('base64'));
    const { bus } = busWithNfs();
    const out = await readUserFiles(ctx(), bus, api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
      relPath: 'docs/note.md',
    });
    const pod = api.creates[0]!.body as InspectablePod;
    expect(pod.spec.containers[0].env).toEqual([
      { name: 'SUBPATH', value: 'agent-abc' },
      { name: 'RELPATH', value: 'docs/note.md' },
    ]);
    expect(out.kind).toBe('file');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).toString('utf-8')).toBe('hi');
  });

  it('returns UNAVAILABLE (not absent) when no resolver is loaded', async () => {
    /*
      TASK-403. No resolver means this deployment keeps no durable files for
      the agent AT ALL, which is a fact about the deployment. It used to answer
      `absent` — the same word a path that is simply not there gets — and the
      Files tab could then only hedge: "either your agent wrote nothing or this
      server isn't keeping them, we can't tell which", on every deployment,
      working ones included.
    */
    const api = makeMockK8sApi();
    const out = await readUserFiles(ctx(), new HookBus(), api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
    });
    expect(out).toEqual({ kind: 'unavailable' });
    expect(api.creates).toHaveLength(0);
  });

  it('REGRESSION: a non-zero pod exit is a failure even when its log PARSES', async () => {
    /*
      TASK-403. The exit code was not checked at all, and an empty log alone
      does not cover the gap: the script runs under `set -eu`, so it can print
      `FILE ` and then die when `head` fails. That parses cleanly as a
      zero-byte file — an EMPTY FILE served over a read that did not finish,
      which is the same class of lie as an empty tier. The guard's whole value
      is this case, so this is the case the test drives.
    */
    const api = makeMockK8sApi();
    primeTerminal(api, 'FILE ', 137);
    const { bus } = busWithNfs();
    await expect(
      readUserFiles(ctx(), bus, api, CONFIG, log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
        relPath: 'report.md',
      }),
    ).rejects.toBeInstanceOf(PluginError);
    // The pod is still cleaned up — a failed read must not leak a pod.
    expect(api.deletes.length).toBeGreaterThan(0);
  });

  it('parses a FAILED line from the reader as a failure', async () => {
    // The script's own word for "I could not resolve this agent's subtree
    // although the export still lists it". Two guards, deliberately: the
    // non-zero exit AND the token, because the day one is bypassed is the day
    // the answer silently becomes "this agent wrote nothing".
    expect(() => parseReadOutput('FAILED')).toThrow(PluginError);
  });

  it('SECURITY: rejects a traversal relPath before creating a pod', async () => {
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    await expect(
      readUserFiles(ctx(), bus, api, CONFIG, log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
        relPath: '../agent-b',
      }),
    ).rejects.toBeInstanceOf(PluginError);
    expect(api.creates).toHaveLength(0);
  });

  it('SECURITY: rejects an absolute relPath before creating a pod', async () => {
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    await expect(
      readUserFiles(ctx(), bus, api, CONFIG, log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
        relPath: '/etc/passwd',
      }),
    ).rejects.toBeInstanceOf(PluginError);
    expect(api.creates).toHaveLength(0);
  });

  // SECURITY (cross-tenant, the bug the review caught): a lexical relPath guard
  // is NOT enough — an agent can plant an INTERMEDIATE symlink in its own
  // subtree pointing at a sibling's subPath or `/`. The reader script must
  // REALPATH-confine the target under the agent's OWN subtree before reading,
  // and skip symlink children when listing. We assert the generated script
  // carries that confinement (a unit test can't run a real NFS pod; the kind
  // walk exercises it live).
  it('SECURITY: the read script realpath-confines to the per-agent subPath and skips symlink children', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api, 'ABSENT');
    const { bus } = busWithNfs();
    await readUserFiles(ctx(), bus, api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
    });
    const pod = api.creates[0]!.body as InspectablePod;
    const script = pod.spec.containers[0].command.join('\n');
    // Resolves every component (intermediate symlinks too)…
    expect(script).toMatch(/realpath -- "\$target"/);
    // …and confines under the agent's OWN subtree, not just the export.
    expect(script).toContain('base="/export/$SUBPATH"');
    expect(script).toMatch(/"\$realbase"\)/);
    expect(script).toMatch(/"\$realbase"\/\*\)/);
    // A non-confined resolution → ABSENT (no disclosure).
    expect(script).toMatch(/\*\) echo ABSENT; exit 0/);
    // Listing skips any symlink child.
    expect(script).toContain('if [ -L "$entry" ]; then continue; fi');
  });
});

// ---------------------------------------------------------------------------
// The HOST-MOUNTED realization: `userFilesHostReadRoot` set, so host-read is a
// direct confined filesystem read and NO pod is created. Same signature, same
// registration — the provider picks the realization, which is why there is no
// second plugin racing to register the hook.
// ---------------------------------------------------------------------------
describe('readUserFiles (host-mounted realization)', () => {
  let hostRoot: string;
  beforeEach(async () => {
    hostRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-k8s-hostread-')),
    );
  });
  afterEach(async () => {
    await fs.rm(hostRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  function hostReadConfig() {
    return resolveConfig({
      hostIpcUrl: 'http://h:80',
      namespace: 'ax-test',
      userFilesHostReadRoot: hostRoot,
    });
  }

  async function seed(agentId: string): Promise<string> {
    const dir = path.join(hostRoot, agentId);
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'hello.txt'), 'hi from ' + agentId);
    await fs.writeFile(path.join(dir, 'docs', 'note.md'), '# note');
    return dir;
  }

  it.skipIf(!ON_LINUX)('lists the agent subtree WITHOUT creating a pod', async () => {
    await seed('agent-abc');
    const api = makeMockK8sApi();
    const { bus, seen } = busWithNfs();
    const out = await readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
    });
    // The whole point: no pod per directory click.
    expect(api.creates).toHaveLength(0);
    expect(api.deletes).toHaveLength(0);
    // Still asks the resolver for a READ-ONLY realization.
    expect(seen.readOnly).toBe(true);
    if (out.kind !== 'dir') throw new Error('expected dir');
    const byName = new Map(out.entries.map((e) => [e.name, e.kind]));
    expect(byName.get('hello.txt')).toBe('file');
    expect(byName.get('docs')).toBe('dir');
  });

  it.skipIf(!ON_LINUX)('reads a nested file, exact bytes, no pod', async () => {
    await seed('agent-abc');
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    const out = await readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
      relPath: 'docs/note.md',
    });
    expect(api.creates).toHaveLength(0);
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).toString('utf-8')).toBe('# note');
  });

  it.skipIf(!ON_LINUX)('returns absent for a missing path', async () => {
    await seed('agent-abc');
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    expect(
      await readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
        relPath: 'nope.txt',
      }),
    ).toEqual({ kind: 'absent' });
  });

  it('returns UNAVAILABLE when the resolver has no mount (no pod either)', async () => {
    const api = makeMockK8sApi();
    expect(
      await readUserFiles(ctx(), new HookBus(), api, hostReadConfig(), log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(api.creates).toHaveLength(0);
  });

  it('CROSS-TENANT: a traversal relPath is refused before any read', async () => {
    await seed('agent-abc');
    const other = await seed('agent-xyz');
    await fs.writeFile(path.join(other, 'secret.txt'), 'XYZ-SECRET');
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    // A traversal is refused outright (our own caller would be malformed).
    await expect(
      readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
        relPath: '../agent-xyz/secret.txt',
      }),
    ).rejects.toBeInstanceOf(PluginError);
    expect(api.creates).toHaveLength(0);
  });

  it.skipIf(!ON_LINUX)('CROSS-TENANT: an intermediate symlink to a sibling subtree discloses nothing', async () => {
    await seed('agent-abc');
    const other = await seed('agent-xyz');
    await fs.writeFile(path.join(other, 'secret.txt'), 'XYZ-SECRET');
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    // An INTERMEDIATE symlink planted in agent-abc's own subtree, which no
    // lexical guard catches, discloses nothing.
    await fs.symlink(other, path.join(hostRoot, 'agent-abc', 'escape'));
    expect(
      await readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
        relPath: 'escape/secret.txt',
      }),
    ).toEqual({ kind: 'absent' });
    expect(api.creates).toHaveLength(0);
  });

  it.skipIf(!ON_LINUX)('an in-root symlink is absent: the host-mounted read is the per-component walk', async () => {
    // A realpath reader serves both of these (they stay inside the subtree);
    // only the walk refuses a symlink at any depth, so this pins the reader.
    const dir = await seed('agent-abc');
    await fs.symlink('hello.txt', path.join(dir, 'alias.md'));
    await fs.symlink('docs', path.join(dir, 'alias'));
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    for (const relPath of ['alias.md', 'alias/note.md']) {
      expect(
        await readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
          owner: ownerFromAgentId('agent-abc', 'u1'),
          relPath,
        }),
      ).toEqual({ kind: 'absent' });
    }
    expect(api.creates).toHaveLength(0);
  });

  it.skipIf(!ON_LINUX)('an agent that has never written anything reads as absent, not an error', async () => {
    // No seed: the agent's subtree does not exist yet. This is production's
    // most common case, and it must not be a 5xx.
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    expect(
      await readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
      }),
    ).toEqual({ kind: 'absent' });
    expect(api.creates).toHaveLength(0);
  });

  it.skipIf(!ON_LINUX)('SECURITY: never opens a writable handle — a read-only root still reads', async () => {
    // In production the host volumeMount is `readOnly: true`. A writable temp
    // dir would hide a reader that opened for write, so take write away.
    const dir = await seed('agent-abc');
    await fs.chmod(dir, 0o555);
    try {
      const api = makeMockK8sApi();
      const { bus } = busWithNfs();
      const out = await readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
        relPath: 'hello.txt',
      });
      if (out.kind !== 'file') throw new Error('expected file');
      expect(Buffer.from(out.contents).toString('utf-8')).toBe('hi from agent-abc');
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });

  it('falls back to the one-shot pod when the root is unset', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api, 'ABSENT');
    const { bus } = busWithNfs();
    await readUserFiles(ctx(), bus, api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
    });
    // The default config has no host-read root, so the pod path is still live.
    expect(api.creates).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // TASK-993 — `sandbox:user-files-usage`: how much an agent's /files holds,
  // for the storage limit. Host mount only: never a pod per turn end.
  // -------------------------------------------------------------------------
  describe('measureUserFiles (TASK-993)', () => {
    /** Allocated bytes of the tree at `dir`, never following a link: the
     *  root plus every entry, sized with lstat. */
    async function lstatOracle(dir: string): Promise<number> {
      const st = await fs.lstat(dir);
      let total = st.blocks * 512;
      if (!st.isDirectory()) return total;
      for (const name of await fs.readdir(dir)) total += await lstatOracle(path.join(dir, name));
      return total;
    }

    /** A logger that keeps its warnings, so a test can read them. */
    function captureLog(): { log: Logger; warns: Array<[string, unknown]> } {
      const warns: Array<[string, unknown]> = [];
      const make = (): Logger => ({
        debug: () => undefined,
        info: () => undefined,
        warn: (msg, bindings) => {
          warns.push([msg, bindings]);
        },
        error: () => undefined,
        child: () => make(),
      });
      return { log: make(), warns };
    }

    it('measureUserFiles: no resolver means home-unavailable', async () => {
      await expect(
        measureUserFiles(ctx(), new HookBus(), hostReadConfig(), log, { agentId: 'agent-abc' }),
      ).rejects.toMatchObject({ code: 'home-unavailable' });
    });

    it('a resolver with no user-files mount means home-unavailable', async () => {
      const bus = new HookBus();
      bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
        'sandbox:resolve-mounts',
        'mock-filestore',
        async () => ({ mounts: [] }),
      );
      await expect(
        measureUserFiles(ctx(), bus, hostReadConfig(), log, { agentId: 'agent-abc' }),
      ).rejects.toMatchObject({ code: 'home-unavailable' });
    });

    it('without a host read root it throws user-files-usage-unavailable', async () => {
      // `measureUserFiles` takes no k8s API, so it cannot fall back to a pod;
      // plugin.test.ts pins that the registered hook creates none.
      const { bus } = busWithNfs('files.example.invalid');
      await expect(
        measureUserFiles(ctx(), bus, CONFIG, log, { agentId: 'agent-abc' }),
      ).rejects.toMatchObject({ code: 'user-files-usage-unavailable' });
    });

    it('asks the resolver for a READ-ONLY realization', async () => {
      const { bus, seen } = busWithNfs('files.example.invalid');
      // Off Linux the walk itself throws unsupported-platform; the resolve
      // happens first either way.
      await measureUserFiles(ctx(), bus, hostReadConfig(), log, { agentId: 'agent-abc' }).catch(
        () => undefined,
      );
      expect(seen.readOnly).toBe(true);
    });

    it('an unsafe subPath is refused before any read', async () => {
      const bus = new HookBus();
      bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
        'sandbox:resolve-mounts',
        'mock-filestore',
        async (_c, input) => ({
          mounts: [
            {
              kind: 'nfs',
              mountPath: '/workspace',
              server: 'files.example.invalid',
              exportPath: '/vol1/agents',
              subPath: `../${input.owner.agentId}`,
              readOnly: true,
              role: 'user-files',
            },
          ],
        }),
      );
      await expect(
        measureUserFiles(ctx(), bus, hostReadConfig(), log, { agentId: 'agent-abc' }),
      ).rejects.toMatchObject({ code: 'unsafe-subpath' });
    });

    it('a localDir mount is unrealizable here', async () => {
      const bus = new HookBus();
      bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
        'sandbox:resolve-mounts',
        'mock-localdir',
        async () => ({
          mounts: [
            {
              kind: 'localDir',
              mountPath: '/workspace',
              hostPath: '/x/agent-abc',
              readOnly: true,
              role: 'user-files',
            },
          ],
        }),
      );
      await expect(
        measureUserFiles(ctx(), bus, hostReadConfig(), log, { agentId: 'agent-abc' }),
      ).rejects.toMatchObject({ code: 'unrealizable-mount-kind' });
    });

    it('a missing or empty agentId is invalid-input', async () => {
      const { bus, seen } = busWithNfs('files.example.invalid');
      for (const input of [{ agentId: '' }, {}, undefined, { agentId: 7 }]) {
        await expect(
          measureUserFiles(
            ctx(),
            bus,
            hostReadConfig(),
            log,
            input as unknown as { agentId: string },
          ),
        ).rejects.toMatchObject({ code: 'invalid-input' });
      }
      // Refused before the resolver was even asked.
      expect(seen.readOnly).toBeUndefined();
    });

    it.skipIf(!ON_LINUX)('measures <hostReadRoot>/<subPath>: bytes equal the lstat oracle', async () => {
      const dir = await seed('agent-abc');
      await fs.writeFile(path.join(dir, 'docs', 'big.bin'), Buffer.alloc(256 * 1024, 7));
      const { bus } = busWithNfs('files.example.invalid');
      const out = await measureUserFiles(ctx(), bus, hostReadConfig(), log, {
        agentId: 'agent-abc',
      });
      expect(out).toEqual({ bytes: await lstatOracle(dir) });
      expect(out.bytes).toBeGreaterThanOrEqual(256 * 1024);
    });

    it.skipIf(!ON_LINUX)("CROSS-TENANT: a sibling agent's folder, even behind a symlink in this one, is never counted", async () => {
      const mine = await seed('agent-abc');
      const other = await seed('agent-xyz');
      // The sibling holds far more than this agent's own folder.
      const SIBLING_BYTES = 4 * 1024 * 1024;
      await fs.writeFile(path.join(other, 'huge.bin'), Buffer.alloc(SIBLING_BYTES, 1));
      // Links planted in this agent's own folder: to the sibling, to the
      // export root, and to the host's `/`. Each counts as the link itself.
      await fs.symlink(other, path.join(mine, 'escape'));
      await fs.symlink('..', path.join(mine, 'up'));
      await fs.symlink('/', path.join(mine, 'slash'));
      const { bus } = busWithNfs('files.example.invalid');
      const out = await measureUserFiles(ctx(), bus, hostReadConfig(), log, {
        agentId: 'agent-abc',
      });
      expect(out.bytes).toBe(await lstatOracle(mine));
      expect(out.bytes).toBeLessThan(SIBLING_BYTES);
    });

    it.skipIf(!ON_LINUX || IS_ROOT)('a partial reading still answers bytes and logs user_files_usage_partial', async () => {
      const dir = await seed('agent-abc');
      const locked = path.join(dir, 'locked');
      await fs.mkdir(locked);
      const HIDDEN_BYTES = 256 * 1024;
      await fs.writeFile(path.join(locked, 'hidden.bin'), Buffer.alloc(HIDDEN_BYTES, 3));
      await fs.chmod(locked, 0o000);
      try {
        const { bus } = busWithNfs('files.example.invalid');
        const { log: captured, warns } = captureLog();
        const out = await measureUserFiles(ctx(), bus, hostReadConfig(), captured, {
          agentId: 'agent-abc',
        });
        // A lower bound: what could be seen is counted, the locked folder's
        // contents are not, and the gap is logged rather than silent.
        expect(out.bytes).toBeGreaterThan(0);
        expect(out.bytes).toBeLessThan(HIDDEN_BYTES);
        const partial = warns.filter(([msg]) => msg === 'user_files_usage_partial');
        expect(partial).toHaveLength(1);
        expect(partial[0]![1]).toEqual({ agentId: 'agent-abc', entries: expect.any(Number) });
      } finally {
        await fs.chmod(locked, 0o755);
      }
    });

    it.skipIf(!ON_LINUX)('a complete reading logs no partial warning', async () => {
      await seed('agent-abc');
      const { bus } = busWithNfs('files.example.invalid');
      const { log: captured, warns } = captureLog();
      await measureUserFiles(ctx(), bus, hostReadConfig(), captured, { agentId: 'agent-abc' });
      expect(warns).toEqual([]);
    });
  });
});

describe('the two realizations agree on their bounds', () => {
  it('the reader pod script caps bytes + entries at the shared reader defaults', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api, 'ABSENT');
    const { bus } = busWithNfs();
    await readUserFiles(ctx(), bus, api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
    });
    const pod = api.creates[0]!.body as InspectablePod;
    const script = pod.spec.containers[0].command.join('\n');
    // One hook returning a different amount of the same file depending on
    // which realization the deployment loaded is a browser nobody can reason
    // about — so the numbers are pinned to each other here.
    // ONE BYTE PAST the cap, and the off-by-one is the point: its presence is
    // how `parseReadOutput` tells a file of exactly the cap from a longer one,
    // and it is dropped there. The pin is still against the SHARED cap, so the
    // two realizations cannot drift apart on how much of a file they serve.
    expect(script).toContain(
      `head -c ${String(DEFAULT_CONFINED_READ_LIMITS.maxFileBytes + 1)}`,
    );
    expect(script).toContain(
      `-lt ${String(DEFAULT_CONFINED_READ_LIMITS.maxDirEntries)}`,
    );
  });
});

describe('parseReadOutput (one-shot pod log → ReadUserFilesOutput)', () => {
  it('parses a DIR line (base64 rows of base64-name<TAB>kind)', () => {
    const b64 = (n: string) => Buffer.from(n).toString('base64');
    const rows = `${b64('hello.txt')}\tfile\n${b64('docs')}\tdir\n`;
    const out = parseReadOutput('DIR ' + Buffer.from(rows).toString('base64'));
    expect(out.kind).toBe('dir');
    if (out.kind !== 'dir') throw new Error('expected dir');
    expect(out.entries).toEqual([
      { name: 'hello.txt', kind: 'file' },
      { name: 'docs', kind: 'dir' },
    ]);
  });

  it('parses a FILE line (base64 of bytes, binary-safe)', () => {
    const bytes = Uint8Array.from([0, 1, 2, 255, 254]);
    const out = parseReadOutput('FILE ' + Buffer.from(bytes).toString('base64'));
    expect(out.kind).toBe('file');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Array.from(out.contents)).toEqual([0, 1, 2, 255, 254]);
  });

  it('a FILE line at or under the cap is WHOLE, and says so', () => {
    const exact = Buffer.alloc(DEFAULT_CONFINED_READ_LIMITS.maxFileBytes, 0x41);
    const out = parseReadOutput('FILE ' + exact.toString('base64'));
    if (out.kind !== 'file') throw new Error('expected file');
    // Exactly the cap and NOT truncated — the case a length cannot answer on
    // its own, and the one a `length >= cap` check gets wrong. Refusing this
    // file would refuse a complete one.
    expect(out.contents.byteLength).toBe(DEFAULT_CONFINED_READ_LIMITS.maxFileBytes);
    expect(out.truncated).toBe(false);
  });

  it('a FILE line PAST the cap is truncated, and is cut back to the cap', () => {
    /*
      The script reads `cap + 1`. That extra byte is a measurement: it proves
      the file is longer than we will serve. It must never reach the caller —
      a consumer bounding its own response at the cap would be off by one — and
      the answer must say `truncated`, because a prefix handed to a person as
      the file is a corrupt file that looks like a whole one.
    */
    const over = Buffer.alloc(DEFAULT_CONFINED_READ_LIMITS.maxFileBytes + 1, 0x42);
    const out = parseReadOutput('FILE ' + over.toString('base64'));
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.contents.byteLength).toBe(DEFAULT_CONFINED_READ_LIMITS.maxFileBytes);
    expect(out.truncated).toBe(true);
  });

  it('maps ONLY the ABSENT token to absent', () => {
    expect(parseReadOutput('ABSENT')).toEqual({ kind: 'absent' });
  });

  it('REGRESSION: a silent reader pod is a failure, not an empty tier', () => {
    /*
      TASK-403. The read script runs under `set -eu`, so any failing command in
      it kills the pod with nothing on stdout. That empty log used to parse as
      `ABSENT`, and the Files tab drew it as "your agent hasn't put any files
      here yet" — a confident claim about the agent manufactured out of our own
      reader falling over. A throw becomes a 5xx and the tab offers a retry.
    */
    expect(() => parseReadOutput('')).toThrow(PluginError);
    expect(() => parseReadOutput('   \n  \n')).toThrow(PluginError);
  });

  it('REGRESSION: output this host cannot parse is a failure, not an absence', () => {
    /*
      `BIG` was the retired over-cap marker, so this is also the rolling-deploy
      case: a new host reading an old image's output. "I do not understand what
      the reader said" and "the agent has no such file" are different answers,
      and guessing the second is guessing in the one direction the reader
      cannot tell is a guess.
    */
    expect(() => parseReadOutput('BIG')).toThrow(PluginError);
    expect(() => parseReadOutput('unexpected noise')).toThrow(PluginError);
  });

  it('REGRESSION: a bare DIR is an EMPTY directory, not an absence', () => {
    /*
      base64 of no bytes is the empty string, so an empty directory's line is
      `DIR ` and arrives here trimmed to `DIR`. That did not match the
      `startsWith('DIR ')` branch and fell through to `absent` — so the file
      browser said "not found" about a folder the agent had definitely created.
      The TypeScript realization has always answered an empty listing here, so
      this is the two realizations agreeing as well as the honest answer.
    */
    expect(parseReadOutput('DIR')).toEqual({ kind: 'dir', entries: [] });
    expect(parseReadOutput('DIR ')).toEqual({ kind: 'dir', entries: [] });
  });

  it('REGRESSION: a bare FILE is an EMPTY file, not an absence', () => {
    const out = parseReadOutput('FILE');
    expect(out.kind).toBe('file');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.contents.byteLength).toBe(0);
    // An empty file is a WHOLE empty file. Reporting `undefined` here would
    // make a consumer that refuses unknowns refuse a zero-byte file.
    expect(out.truncated).toBe(false);
  });

  it('base64-decodes each entry NAME, so a delimiter in a filename is data', () => {
    // The script encodes names individually — see buildReadCommand. A row is
    // `<base64 name><TAB><kind>`, and a filename carrying a tab or a newline
    // therefore cannot invent a second row.
    const hostile = 'x\tdir\nphantom';
    const rows = `${Buffer.from(hostile).toString('base64')}\tfile\n`;
    const out = parseReadOutput('DIR ' + Buffer.from(rows).toString('base64'));
    if (out.kind !== 'dir') throw new Error('expected dir');
    expect(out.entries).toEqual([{ name: hostile, kind: 'file' }]);
  });

  it('takes the LAST meaningful line (tolerates leading container noise)', () => {
    const raw = 'some startup noise\nABSENT';
    expect(parseReadOutput(raw)).toEqual({ kind: 'absent' });
  });
});
