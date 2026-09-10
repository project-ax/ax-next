import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFINED_READ_LIMITS } from '@ax/user-files-read';
import { HookBus, makeAgentContext, PluginError, type Logger } from '@ax/core';
import type {
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import { resolveConfig } from '../config.js';
import {
  cleanupUserFiles,
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
        readOnlyRootFilesystem: boolean;
        capabilities: { drop: string[] };
      };
      volumeMounts: Array<{ readOnly: boolean }>;
    }>;
  };
}

/** Drive the one-shot pod to a terminal Succeeded phase so watchPodExit
 *  resolves immediately. Optionally stub the read pod's log output. */
function primeTerminal(api: MockK8sApi, log?: string) {
  api.setReadResponses({
    status: {
      phase: 'Succeeded',
      containerStatuses: [{ name: 'userfiles', state: { terminated: { exitCode: 0 } } }],
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
    expect(c.securityContext.runAsNonRoot).toBe(true);
    expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(c.securityContext.capabilities.drop).toEqual(['ALL']);
    // Mounts the WHOLE export (read-WRITE for a delete), operates on the subPath.
    expect(pod.spec.volumes[0].nfs).toEqual({ server: '10.0.0.2', path: '/vol1/agents' });
    expect(c.volumeMounts[0].readOnly).toBe(false);
    // subPath rides in env (never spliced into the shell word).
    expect(c.env).toEqual([{ name: 'SUBPATH', value: 'agent-abc' }]);
    const cmd = (c.command as string[]).join(' ');
    expect(cmd).toMatch(/rm -rf -- "\/export\/\$SUBPATH"/);
    // The one-shot pod is deleted after it completes.
    expect(api.deletes).toHaveLength(1);
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

  it('returns absent when no resolver is loaded', async () => {
    const api = makeMockK8sApi();
    const out = await readUserFiles(ctx(), new HookBus(), api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
    });
    expect(out).toEqual({ kind: 'absent' });
    expect(api.creates).toHaveLength(0);
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

  it('lists the agent subtree WITHOUT creating a pod', async () => {
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

  it('reads a nested file, exact bytes, no pod', async () => {
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

  it('returns absent for a missing path', async () => {
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

  it('returns absent when the resolver has no mount (no pod either)', async () => {
    const api = makeMockK8sApi();
    expect(
      await readUserFiles(ctx(), new HookBus(), api, hostReadConfig(), log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
      }),
    ).toEqual({ kind: 'absent' });
    expect(api.creates).toHaveLength(0);
  });

  it('CROSS-TENANT: the read is confined to THIS agent subPath', async () => {
    await seed('agent-abc');
    const other = await seed('agent-xyz');
    await fs.writeFile(path.join(other, 'secret.txt'), 'XYZ-SECRET');
    const api = makeMockK8sApi();
    const { bus } = busWithNfs();
    // A traversal is refused outright (our own caller would be malformed)…
    await expect(
      readUserFiles(ctx(), bus, api, hostReadConfig(), log, {
        owner: ownerFromAgentId('agent-abc', 'u1'),
        relPath: '../agent-xyz/secret.txt',
      }),
    ).rejects.toBeInstanceOf(PluginError);
    // …and an INTERMEDIATE symlink planted in agent-abc's own subtree, which no
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

  it('SECURITY: never opens a writable handle — a read-only root still reads', async () => {
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
    expect(script).toContain(
      `head -c ${String(DEFAULT_CONFINED_READ_LIMITS.maxFileBytes)}`,
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

  it('maps ABSENT, empty, and any unrecognized token to absent', () => {
    expect(parseReadOutput('ABSENT')).toEqual({ kind: 'absent' });
    // `BIG` was the retired over-cap marker: the script now emits the file's
    // first READ_MAX_FILE_BYTES bytes as a normal FILE line, matching what
    // @ax/user-files-read does. Kept here because an unknown token from an
    // older image must still land on absent rather than on a crash.
    expect(parseReadOutput('BIG')).toEqual({ kind: 'absent' });
    expect(parseReadOutput('')).toEqual({ kind: 'absent' });
    expect(parseReadOutput('unexpected noise')).toEqual({ kind: 'absent' });
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
