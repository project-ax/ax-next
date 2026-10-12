import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PluginError, type ServiceHandler } from '@ax/core';
import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createWorkspaceLocaldirPlugin } from '@ax/workspace-localdir';
import { createSharedFoldersPlugin } from '@ax/shared-folders';
import type { MountSpec, ResolveMountsInput, ResolveMountsOutput } from '@ax/sandbox-mount-protocol';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';
import { TEST_PROXY_CONFIG } from './proxy-config.js';

// ---------------------------------------------------------------------------
// W2 shared folders — CANARY acceptance (design §4).
//
// Real files, real providers: the real subprocess sandbox provider, the real
// @ax/workspace-localdir resolver, and the REAL @ax/shared-folders plugin on a
// real Postgres. Only `@ax/agents` is stood in for (two of alice's personal
// agents, A and B, plus C with no grant) — the folder/grant/authorize/cleanup
// chain under test is entirely production code.
//
// The runner stub (shared-folders-stub.mjs) reads AX_SHARED_FOLDERS on boot,
// appends its session id to `<folder>/canary.txt` for every writable folder,
// and echoes what it saw. So "A writes, a fresh session of B reads it" is an
// assertion about bytes on disk crossing two agents' sessions, not about a
// mock's return value.
//
// The read-only WRITE FAILURE is k8s-only (the subprocess provider is not a
// security boundary — §3.8); here we prove the read-only flag reaches both the
// resolved mount spec and the runner's env. The pod-spec side lives in the
// presets/memory canary.
// ---------------------------------------------------------------------------

const STUB = fileURLToPath(new URL('./fixtures/shared-folders-stub.mjs', import.meta.url));

const ALICE = 'alice';
const A = 'agent-a';
const B = 'agent-b';
const C = 'agent-c'; // alice's, but never granted

const AGENTS: Record<string, { ownerType: 'user'; ownerId: string }> = {
  [A]: { ownerType: 'user', ownerId: ALICE },
  [B]: { ownerType: 'user', ownerId: ALICE },
  [C]: { ownerType: 'user', ownerId: ALICE },
};

function notFound(hookName: string, agentId: string): PluginError {
  return new PluginError({ code: 'not-found', plugin: 'stub-agents', hookName, message: `no ${agentId}` });
}

const agentServices: Record<string, ServiceHandler> = {
  'agents:can-manage-sharing': async (ctx, raw) => {
    const { agentId } = raw as { agentId: string };
    const a = AGENTS[agentId];
    if (!a) throw notFound('agents:can-manage-sharing', agentId);
    return { allowed: a.ownerId === ctx.userId };
  },
  'agents:resolve': async (_ctx, raw) => {
    const { agentId, userId } = raw as { agentId: string; userId: string };
    const a = AGENTS[agentId];
    if (!a) throw notFound('agents:resolve', agentId);
    if (a.ownerId !== userId) {
      throw new PluginError({ code: 'forbidden', plugin: 'stub-agents', hookName: 'agents:resolve', message: 'no' });
    }
    return { agent: { id: agentId, ...a } };
  },
};

function owner(agentId: string) {
  return {
    userId: ALICE,
    agentId,
    agentConfig: {
      displayName: 'Canary',
      systemPromptAugment: '',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'claude',
      runner: 'claude-sdk',
    },
  };
}

interface FolderProbe {
  id: string;
  path: string;
  readOnly: boolean;
  before: string | null;
  contents: string | null;
}
interface Probe {
  sessionId: string;
  userFilesRoot: string | null;
  sharedFoldersEnv: string | null;
  folders: FolderProbe[];
  error?: string;
}

// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const tmpDirs: string[] = [];

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end().catch(() => {});
  }
}

async function mkTmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

interface World {
  h: TestHarness;
  root: string;
  reduced: { folderId: string; agentIds: string[] }[];
  /** A host call as alice (the person who manages A, B and C). */
  asAlice<O = unknown>(hook: string, input: unknown): Promise<O>;
  /** Open a fresh session for `agentId`, read the stub's one line, kill it. */
  session(agentId: string, sharedFolderIds?: string[]): Promise<Probe>;
  resolveMounts(agentId: string, sharedFolderIds: string[]): Promise<MountSpec[]>;
}

let sessionSeq = 0;

async function makeWorld(): Promise<World> {
  const root = await mkTmp('ax-sf-canary-root-');
  const h = await createTestHarness({
    services: {
      'llm:call': async () => ({ assistantMessage: { role: 'assistant', content: '' }, toolCalls: [] }),
      'tool:list': async () => ({ tools: [] }),
      'workspace:read': async () => ({ found: false }),
      ...agentServices,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      // sweepIntervalMs: 0 — no background sweep; cleanup runs only inline in
      // `shared-folders:delete`, so a passing delete case proves THAT path.
      createSharedFoldersPlugin({ sweepIntervalMs: 0 }),
      createSessionInmemoryPlugin(),
      createIpcServerPlugin(),
      createWorkspaceLocaldirPlugin({ root }),
      createSandboxSubprocessPlugin(),
    ],
  });
  harnesses.push(h);
  const reduced: World['reduced'] = [];
  h.bus.subscribe<{ folderId: string; agentIds: string[] }>(
    'shared-folders:access-reduced',
    'canary-test',
    async (_c, p) => {
      reduced.push({ folderId: p.folderId, agentIds: [...p.agentIds].sort() });
      return undefined;
    },
  );
  const ctx = () => h.ctx({ userId: ALICE });

  return {
    h,
    root,
    reduced,
    asAlice: (hook, input) => h.bus.call(hook, ctx(), input),
    async session(agentId, sharedFolderIds) {
      const ws = await mkTmp('ax-sf-canary-ws-');
      const sessionId = `sf-canary-${++sessionSeq}`;
      const result = await h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', ctx(), {
        sessionId,
        workspaceRoot: ws,
        runnerBinary: STUB,
        proxyConfig: TEST_PROXY_CONFIG,
        owner: owner(agentId),
        ...(sharedFolderIds !== undefined ? { sharedFolderIds } : {}),
      });
      try {
        const probe = JSON.parse(await readFirstStdoutLine(result)) as Probe;
        if (probe.error !== undefined) throw new Error(`stub failed: ${probe.error}`);
        return probe;
      } finally {
        await result.handle.kill();
      }
    },
    async resolveMounts(agentId, sharedFolderIds) {
      const out = await h.bus.call<ResolveMountsInput, ResolveMountsOutput>('sandbox:resolve-mounts', ctx(), {
        owner: owner(agentId),
        sharedFolderIds,
      });
      return out.mounts;
    },
  };
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

/** Folder owned by A, with B granted editor — the starting point of every case. */
async function sharedAB(w: World): Promise<string> {
  const { folderId } = await w.asAlice<{ folderId: string }>('shared-folders:create', { ownerAgentId: A });
  await w.asAlice('shared-folders:grant', { folderId, agentId: B, role: 'editor' });
  return folderId;
}

const sharedDir = (w: World, folderId: string) => path.join(w.root, '.shared', folderId);

// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  while (tmpDirs.length > 0) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {});
  await q('DROP TABLE IF EXISTS shared_folders_v1_grants');
  await q('DROP TABLE IF EXISTS shared_folders_v1_folders');
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('shared-folders canary (subprocess + localDir + real @ax/shared-folders)', () => {
  it('A writes in the shared folder; a fresh session of B reads it and its own write lands; /files stay separate', async () => {
    const w = await makeWorld();
    const folderId = await sharedAB(w);
    const dir = sharedDir(w, folderId);

    const a = await w.session(A, [folderId]);
    expect(a.folders).toHaveLength(1);
    expect(a.folders[0]).toMatchObject({ id: folderId, path: dir, readOnly: false, before: null });
    expect(a.folders[0]!.contents).toBe(`${a.sessionId}\n`);

    // A FRESH session of a DIFFERENT agent sees A's bytes, and appends its own.
    const b = await w.session(B, [folderId]);
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.folders).toHaveLength(1);
    expect(b.folders[0]).toMatchObject({ id: folderId, path: dir, readOnly: false });
    expect(b.folders[0]!.before).toBe(`${a.sessionId}\n`);
    expect(b.folders[0]!.contents).toBe(`${a.sessionId}\n${b.sessionId}\n`);
    expect(await fs.readFile(path.join(dir, 'canary.txt'), 'utf-8')).toBe(`${a.sessionId}\n${b.sessionId}\n`);

    // Each agent's own /files is its own subtree, and the shared folder lives
    // in neither (it's under `.shared`, which no agent id can name).
    expect(a.userFilesRoot).toBe(path.join(w.root, A));
    expect(b.userFilesRoot).toBe(path.join(w.root, B));
    for (const own of [a.userFilesRoot!, b.userFilesRoot!]) {
      expect(dir.startsWith(own + path.sep)).toBe(false);
      expect(await fs.readdir(own)).toEqual([]);
    }

    // A grant (an increase) fires nothing.
    expect(w.reduced).toEqual([]);
  });

  it('after a downgrade, B’s next session gets a read-only mount, the stub does not write, and access-reduced fires', async () => {
    const w = await makeWorld();
    const folderId = await sharedAB(w);
    const a = await w.session(A, [folderId]);
    const seeded = `${a.sessionId}\n`;

    // Before: B's mount spec is writable — so the read-only assertion below
    // is a change, not the resolver's default.
    const beforeMounts = await w.resolveMounts(B, [folderId]);
    expect(beforeMounts.find((m) => m.role === 'shared-folder')).toMatchObject({ folderId, readOnly: false });

    await w.asAlice('shared-folders:grant', { folderId, agentId: B, role: 'viewer' });
    expect(w.reduced).toEqual([{ folderId, agentIds: [B] }]);

    const mounts = await w.resolveMounts(B, [folderId]);
    const shared = mounts.filter((m) => m.role === 'shared-folder');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      kind: 'localDir',
      folderId,
      mountPath: `/shared/${folderId}`,
      hostPath: sharedDir(w, folderId),
      readOnly: true,
    });
    // B's own /files is untouched by the downgrade.
    expect(mounts.find((m) => m.role === 'user-files')).toMatchObject({ readOnly: false });

    const b = await w.session(B, [folderId]);
    expect(JSON.parse(b.sharedFoldersEnv!)).toEqual([{ id: folderId, path: sharedDir(w, folderId), readOnly: true }]);
    expect(b.folders).toEqual([
      { id: folderId, path: sharedDir(w, folderId), readOnly: true, before: seeded, contents: seeded },
    ]);

    // The owner is still writable.
    const a2 = await w.session(A, [folderId]);
    expect(a2.folders[0]).toMatchObject({ readOnly: false, contents: `${seeded}${a2.sessionId}\n` });
  });

  it('after a revoke, B’s next session has no folder (AX_SHARED_FOLDERS absent) and access-reduced fires', async () => {
    const w = await makeWorld();
    const folderId = await sharedAB(w);

    // B had it before the revoke.
    const b1 = await w.session(B, [folderId]);
    expect(b1.folders.map((f) => f.id)).toEqual([folderId]);

    await w.asAlice('shared-folders:revoke', { folderId, agentId: B });
    expect(w.reduced).toEqual([{ folderId, agentIds: [B] }]);

    const b2 = await w.session(B, [folderId]);
    expect(b2.sharedFoldersEnv).toBeNull();
    expect(b2.folders).toEqual([]);
    expect((await w.resolveMounts(B, [folderId])).filter((m) => m.role === 'shared-folder')).toEqual([]);

    // The owner keeps it.
    const a = await w.session(A, [folderId]);
    expect(a.folders.map((f) => f.id)).toEqual([folderId]);
  });

  it('after a delete, the folder directory and row are gone (grants were removed first); A’s and B’s own files survive', async () => {
    const w = await makeWorld();
    const folderId = await sharedAB(w);
    const dir = sharedDir(w, folderId);
    const a = await w.session(A, [folderId]);
    const b = await w.session(B, [folderId]);
    // Something in each agent's own /files, to prove the delete is confined.
    await fs.writeFile(path.join(a.userFilesRoot!, 'mine.txt'), 'a');
    await fs.writeFile(path.join(b.userFilesRoot!, 'mine.txt'), 'b');

    // Preconditions — otherwise "gone" below would prove nothing.
    expect(await exists(path.join(dir, 'canary.txt'))).toBe(true);
    expect(await q('SELECT 1 FROM shared_folders_v1_folders WHERE folder_id = $1', [folderId])).toHaveLength(1);
    expect(await q('SELECT 1 FROM shared_folders_v1_grants WHERE folder_id = $1', [folderId])).not.toHaveLength(0);

    await w.asAlice('shared-folders:delete', { folderId });

    // Bytes removed through the real sandbox:delete-shared-folder →
    // sandbox:locate-shared-folder path (no sweep is running).
    expect(await exists(dir)).toBe(false);
    // Not merely tombstoned: cleanup succeeded, so the row is removed too.
    expect(await q('SELECT 1 FROM shared_folders_v1_folders WHERE folder_id = $1', [folderId])).toEqual([]);
    expect(await q('SELECT 1 FROM shared_folders_v1_grants WHERE folder_id = $1', [folderId])).toEqual([]);
    // Former grantees were told.
    expect(w.reduced).toEqual([{ folderId, agentIds: [A, B].sort() }]);

    expect(await fs.readFile(path.join(w.root, A, 'mine.txt'), 'utf-8')).toBe('a');
    expect(await fs.readFile(path.join(w.root, B, 'mine.txt'), 'utf-8')).toBe('b');

    // And it can never be mounted again.
    const after = await w.session(A, [folderId]);
    expect(after.folders).toEqual([]);
    expect(await exists(dir)).toBe(false);
  });

  it('a folder the agent has no grant on, or an unknown id, gets no mount; an invalid id is refused at open', async () => {
    const w = await makeWorld();
    const folderId = await sharedAB(w);
    const unknownId = 'sf_doesNotExist123';

    // C (alice's, never granted) asking for the folder gets nothing.
    const c = await w.session(C, [folderId]);
    expect(c.sharedFoldersEnv).toBeNull();
    expect(c.folders).toEqual([]);

    // An unknown (well-formed) id alongside a real grant: only the real one mounts.
    const a = await w.session(A, [unknownId, folderId]);
    expect(a.folders.map((f) => f.id)).toEqual([folderId]);
    expect(await exists(sharedDir(w, unknownId))).toBe(false);

    // An ill-formed id never reaches a path: the open is refused outright...
    await expect(w.session(A, ['../agent-b'])).rejects.toMatchObject({ code: 'invalid-payload' });
    // ...and the resolver, asked directly, drops it rather than mounting it.
    const mounts = await w.resolveMounts(A, ['../agent-b', '.shared']);
    expect(mounts.filter((m) => m.role === 'shared-folder')).toEqual([]);

    // C's own /files never contains the folder either.
    expect(await fs.readdir(c.userFilesRoot!)).toEqual([]);
  });
});
