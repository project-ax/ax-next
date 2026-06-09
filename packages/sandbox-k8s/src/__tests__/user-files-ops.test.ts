import { describe, expect, it } from 'vitest';
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
    // RELPATH is scoped under the agent's own subPath.
    expect(pod.spec.containers[0].env).toEqual([
      { name: 'RELPATH', value: 'agent-abc' },
    ]);
    expect(api.deletes).toHaveLength(1);
  });

  it('scopes a nested relPath under the agent subPath', async () => {
    const api = makeMockK8sApi();
    primeTerminal(api, 'FILE ' + Buffer.from('hi').toString('base64'));
    const { bus } = busWithNfs();
    const out = await readUserFiles(ctx(), bus, api, CONFIG, log, {
      owner: ownerFromAgentId('agent-abc', 'u1'),
      relPath: 'docs/note.md',
    });
    const pod = api.creates[0]!.body as InspectablePod;
    expect(pod.spec.containers[0].env).toEqual([
      { name: 'RELPATH', value: 'agent-abc/docs/note.md' },
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
});

describe('parseReadOutput (one-shot pod log → ReadUserFilesOutput)', () => {
  it('parses a DIR line (base64 of name<TAB>kind rows)', () => {
    const rows = 'hello.txt\tfile\ndocs\tdir\n';
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

  it('maps ABSENT, BIG, and empty/garbage to absent', () => {
    expect(parseReadOutput('ABSENT')).toEqual({ kind: 'absent' });
    expect(parseReadOutput('BIG')).toEqual({ kind: 'absent' });
    expect(parseReadOutput('')).toEqual({ kind: 'absent' });
    expect(parseReadOutput('unexpected noise')).toEqual({ kind: 'absent' });
  });

  it('takes the LAST meaningful line (tolerates leading container noise)', () => {
    const raw = 'some startup noise\nABSENT';
    expect(parseReadOutput(raw)).toEqual({ kind: 'absent' });
  });
});
