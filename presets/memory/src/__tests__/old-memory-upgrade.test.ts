/**
 * TASK-576 canary: a deployment UPGRADING from Strata to the memory preset.
 *
 * Its own file (not canary.test.ts) because it boots three kernels against one
 * postgres + one repoRoot + one facts db, which would not fit that file's
 * single beforeAll budget.
 *
 * How the "before" state is made — the least artificial route to each piece:
 *   - Agents + workspace files: boot the plain k8s preset (what a Strata-era
 *     deployment ran), create an agent through `agents:create` and write
 *     Strata-shaped files through `workspace:apply`, several applies deep so
 *     the old memory sits in HISTORY as well as the tree. Then shut it down.
 *   - Facts rows: `@ax/memory-facts-sqlite` loaded standalone against the same
 *     db path, recording through its public `memory:facts:record` hook. The
 *     memory preset itself cannot seed them — its boot runs the wipe first.
 *   - Export slot: a file under the agent's slot in the export hostRoot.
 * Then the memory preset boots (the wipe), and boots again (the no-op).
 *
 * The sentinel string is in every seeded byte of old memory: it must vanish
 * from the tree, the history, the facts rows — and never appear in a log line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import {
  OLD_MEMORY_WIPE_COMPLETE_KEY,
  OLD_MEMORY_WIPED_EVENT,
  volumeAgentKey,
} from '@ax/memory';
import { createMemoryFactsSqlitePlugin } from '@ax/memory-facts-sqlite';
import { createK8sPlugins } from '@ax/preset-k8s';
import { createSandboxK8sPlugin, type K8sCoreApi } from '@ax/sandbox-k8s';
import { startTestContainer } from '@ax/test-harness';

import { createMemoryPlugins, type MemoryPresetConfig } from '../index.js';

const ALICE = 'user-alice';
const SENTINEL = 'STRATA-SENTINEL-7f3a9c';
const OPENROUTER_KEY = 'upgrade-openrouter-key';

const OLD_MEMORY_FILES: Record<string, string> = {
  'memory/docs/general/x.md': `# x\n${SENTINEL} doc\n`,
  'memory/inbox/2026-09-01T00-00-00Z.md': `${SENTINEL} inbox\n`,
  'memory/system/user.md': `${SENTINEL} user profile\n`,
  'permanent/memory/facts/profile.md': `${SENTINEL} facts export\n`,
};
const KEPT_FILES: Record<string, string> = {
  'memory/system/rules.md': 'Be brief.\n',
  '.ax/IDENTITY.md': '# Identity\nI am the upgrade canary.\n',
  'notes/keep.md': 'keep me\n',
};

function authStub(): Plugin {
  const name = '@ax/canary/auth-stub';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: [
        'auth:require-user',
        'auth:get-user',
        'auth:create-bootstrap-user',
        'auth:complete-bootstrap-user',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<{ req?: { headers?: Record<string, string> } }, unknown>(
        'auth:require-user',
        name,
        async (_ctx, input) => {
          const id = input?.req?.headers?.['x-test-user'];
          if (typeof id !== 'string' || id === '') {
            throw new PluginError({
              code: 'unauthenticated',
              plugin: name,
              hookName: 'auth:require-user',
              message: 'no test identity header',
            });
          }
          return { user: { id, isAdmin: false } };
        },
      );
      bus.registerService<{ userId?: string }, unknown>('auth:get-user', name, async (_ctx, input) => ({
        user: { id: input?.userId ?? 'unknown', isAdmin: false },
      }));
      bus.registerService('auth:create-bootstrap-user', name, async () => ({
        user: { id: 'bootstrap', isAdmin: true },
      }));
      bus.registerService('auth:complete-bootstrap-user', name, async () => ({}));
    },
  };
}

function llmStub(): Plugin {
  const name = '@ax/canary/llm-stub';
  return {
    manifest: { name, version: '0.0.0', registers: ['llm:call:openrouter'], calls: [], subscribes: [] },
    init({ bus }) {
      bus.registerService('llm:call:openrouter', name, async () => ({
        text: JSON.stringify({ facts: [] }),
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }));
    },
  };
}

function fakeK8sApi(): K8sCoreApi {
  return {
    async createNamespacedPod() {
      return { metadata: { name: 'fake-runner' } };
    },
    async readNamespacedPod() {
      return {
        metadata: { name: 'fake-runner' },
        status: { phase: 'Running', podIP: '10.0.0.2', conditions: [{ type: 'Ready', status: 'True' }] },
      };
    },
    async deleteNamespacedPod() {
      return { status: 'Success' };
    },
    async listNamespacedPod() {
      return { items: [] };
    },
  } as unknown as K8sCoreApi;
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  if (new Headers(init?.headers).get('authorization') !== `Bearer ${OPENROUTER_KEY}`) {
    return new Response('unauthorized', { status: 401 });
  }
  if (url === 'https://openrouter.ai/api/v1/embeddings') {
    const data = (parsed.input as unknown[]).map((_, index) => ({
      object: 'embedding',
      index,
      embedding: new Array<number>(parsed.dimensions as number).fill(0.01),
    }));
    return new Response(JSON.stringify({ object: 'list', data }), { status: 200 });
  }
  if (url === 'https://openrouter.ai/api/v1/rerank') {
    const results = (parsed.documents as unknown[]).map((_, index) => ({
      index,
      relevance_score: 1 - index * 0.01,
    }));
    return new Response(JSON.stringify({ results }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

const DROPPED = new Set(['@ax/sandbox-k8s', '@ax/auth-better', '@ax/llm-openrouter']);

let container: StartedPostgreSqlContainer | null = null;
let tmp = '';
let config: MemoryPresetConfig;
let bus: HookBus;
let shutdown: (() => Promise<void>) | undefined;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}

function ctxFor(agentId: string, userId = ALICE): AgentContext {
  return makeAgentContext({ sessionId: 'upgrade-canary', agentId, userId });
}

function extraPlugins(): Plugin[] {
  return [
    createSandboxK8sPlugin({
      api: fakeK8sApi(),
      hostIpcUrl: config.ipc.hostIpcUrl,
      runtimeClassName: '',
      namespace: 'ax-next',
      image: 'ax-next/agent:stub',
    }),
    authStub(),
    llmStub(),
  ];
}

/** Boot a kernel; capture everything written to stderr WHILE it boots (the wipe logs there). */
async function bootKernel(plugins: Plugin[]): Promise<string> {
  const captured: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'));
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    bus = new HookBus();
    const handle = await bootstrap({ bus, plugins: [...plugins, ...extraPlugins()], config: {} });
    shutdown = () => handle.shutdown();
  } finally {
    process.stderr.write = realWrite;
  }
  return captured.join('');
}

async function stopKernel(): Promise<void> {
  const s = shutdown;
  shutdown = undefined;
  await s?.();
}

const bootMemoryPreset = (): Promise<string> =>
  bootKernel(createMemoryPlugins(config).filter((p) => !DROPPED.has(p.manifest.name)));

async function createAgent(displayName: string): Promise<string> {
  const out = await bus.call<unknown, { agent: { id: string } }>('agents:create', ctxFor('seed'), {
    actor: { userId: ALICE, isAdmin: false },
    input: {
      displayName,
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-sonnet-4-6',
      visibility: 'personal',
    },
  });
  return out.agent.id;
}

// The tip each agent's workspace is at, from our own applies (nothing else
// writes these workspaces while the seeding kernel is up).
const heads = new Map<string, string | null>();

async function apply(
  agentId: string,
  changes: Array<{ path: string; kind: 'put'; content: Uint8Array } | { path: string; kind: 'delete' }>,
): Promise<void> {
  const out = await bus.call<unknown, { version: string }>('workspace:apply', ctxFor(agentId), {
    parent: heads.get(agentId) ?? null,
    reason: 'upgrade canary seed',
    changes,
  });
  heads.set(agentId, out.version);
}

async function applyFiles(agentId: string, files: Record<string, string>): Promise<void> {
  await apply(
    agentId,
    Object.entries(files).map(([p, text]) => ({
      path: p,
      kind: 'put' as const,
      content: new TextEncoder().encode(text),
    })),
  );
}

async function listPaths(agentId: string): Promise<string[]> {
  const out = await bus.call<unknown, { paths: string[] }>('workspace:list', ctxFor(agentId), {});
  return out.paths;
}

async function readText(agentId: string, p: string): Promise<string | null> {
  const r = await bus.call<{ path: string }, { found: boolean; bytes?: Uint8Array }>(
    'workspace:read',
    ctxFor(agentId),
    { path: p },
  );
  return r.found ? Buffer.from(r.bytes!).toString('utf-8') : null;
}

async function scanValues(agentId: string): Promise<string[]> {
  const out = await bus.call<unknown, { statements: Array<{ value: string }> }>(
    'memory:facts:scan',
    ctxFor(agentId),
    {},
  );
  return out.statements.map((s) => s.value);
}

async function recordFact(agentId: string, value: string): Promise<void> {
  await bus.call('memory:facts:record', ctxFor(agentId), {
    statements: [{ about: 'user', relation: 'likes', value, when: '2026-09-01T00:00:00.000Z' }],
  });
}

// Byte-for-byte copy of @ax/workspace-git-core's `workspaceIdForAgent` — the
// on-disk name of an agent's bare repo under the local backend's repoRoot.
function repoDirFor(agentId: string): string {
  const id = `ws-${createHash('sha256').update(JSON.stringify([agentId])).digest('hex').slice(0, 16)}`;
  return path.join(config.workspace.backend === 'local' ? config.workspace.repoRoot : '', `${id}.git`);
}

function git(gitdir: string, ...args: string[]): string {
  return execFileSync('git', ['--git-dir', gitdir, ...args], { encoding: 'utf-8' });
}
const mainSha = (agentId: string): string => git(repoDirFor(agentId), 'rev-parse', 'refs/heads/main').trim();
const commitCount = (agentId: string): number =>
  Number(git(repoDirFor(agentId), 'rev-list', '--count', '--all').trim());

let oldAgent = '';
let newAgent = '';
let commitsBefore = 0;
let firstBootLog = '';
let exportSlotFile = '';

describe('@ax/preset-memory — upgrade from Strata wipes old memory once (TASK-576)', () => {
  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    const connectionString = container.getConnectionUri();
    tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-memory-upgrade-')));
    setEnv('AX_CREDENTIALS_KEY', '42'.repeat(32));
    setEnv('AX_BOOTSTRAP_TOKEN', 'stub-bootstrap-token');
    setEnv('AX_HTTP_ALLOW_NO_ORIGINS', '1');

    config = {
      database: { connectionString },
      eventbus: { connectionString },
      session: { connectionString },
      workspace: { backend: 'local', repoRoot: path.join(tmp, 'repo') },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { host: '127.0.0.1', port: 0, hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' }, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: randomBytes(32).toString('hex'), allowedOrigins: [] },
      credentialProxy: { socketPath: path.join(tmp, 'proxy.sock'), caDir: path.join(tmp, 'proxy-ca') },
      factsDatabasePath: path.join(tmp, 'facts', 'facts.db'),
      memoryExportVolume: {
        hostRoot: path.join(tmp, 'exports'),
        backing: { server: 'nfs.example.invalid', exportPath: '/exports/ax-memory' },
      },
      memoryEmbeddings: { fetchImpl: fakeFetch },
    };
    await fsp.mkdir(path.dirname(config.factsDatabasePath), { recursive: true });
    await fsp.mkdir(config.memoryExportVolume.hostRoot, { recursive: true });

    // --- The Strata-era deployment: the plain k8s preset. -----------------
    await bootKernel(createK8sPlugins(config).filter((p) => !DROPPED.has(p.manifest.name)));
    await bus.call('credentials:set', ctxFor('seed'), {
      scope: 'global',
      ownerId: null,
      ref: 'provider:openrouter',
      kind: 'api-key',
      payload: new TextEncoder().encode(OPENROUTER_KEY),
    });
    oldAgent = await createAgent('Strata-era agent');
    // Several applies, so old memory is in past versions, then edited/deleted
    // in later ones — history, not just the tip.
    await applyFiles(oldAgent, { ...KEPT_FILES, 'memory/system/user.md': `${SENTINEL} v1\n` });
    await applyFiles(oldAgent, {
      'memory/docs/general/x.md': OLD_MEMORY_FILES['memory/docs/general/x.md']!,
      'memory/system/.map-cache.json': `{"s":"${SENTINEL}"}`,
    });
    await applyFiles(oldAgent, OLD_MEMORY_FILES);
    await apply(oldAgent, [{ path: 'memory/system/.map-cache.json', kind: 'delete' }]);
    await stopKernel();
    commitsBefore = commitCount(oldAgent);
    expect(commitsBefore).toBeGreaterThanOrEqual(4);
    expect(git(repoDirFor(oldAgent), 'log', '--all', '--name-only', '--format=')).toContain(
      'memory/system/.map-cache.json',
    );

    // --- Facts rows, written through the engine's own hook. ----------------
    const facts = createMemoryFactsSqlitePlugin({ databasePath: config.factsDatabasePath });
    const factsBus = new HookBus();
    await facts.init({ bus: factsBus, config: {} });
    await factsBus.call('memory:facts:record', ctxFor(oldAgent), {
      statements: [{ about: 'user', relation: 'lives in', value: SENTINEL, when: '2023-01-01T00:00:00.000Z' }],
    });
    const seeded = await factsBus.call<unknown, { statements: Array<{ value: string }> }>(
      'memory:facts:scan',
      ctxFor(oldAgent),
      {},
    );
    expect(seeded.statements.map((s) => s.value)).toEqual([SENTINEL]);
    await facts.shutdown?.();

    // --- The agent's export slot (what the runner mounts at /memory). ------
    exportSlotFile = path.join(
      config.memoryExportVolume.hostRoot,
      volumeAgentKey(oldAgent),
      'permanent/memory/facts/profile.md',
    );
    await fsp.mkdir(path.dirname(exportSlotFile), { recursive: true });
    await fsp.writeFile(exportSlotFile, `${SENTINEL} volume\n`);

    // --- The switch-over: first boot of the memory preset. -----------------
    firstBootLog = await bootMemoryPreset();
  }, 120_000);

  afterAll(async () => {
    await stopKernel();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (container !== null) await container.stop();
    if (tmp !== '') await fsp.rm(tmp, { recursive: true, force: true });
  }, 120_000);

  it('removes old memory from the tree and keeps rules, identity and other files byte-identical', async () => {
    const paths = await listPaths(oldAgent);
    expect(paths.filter((p) => p.startsWith('memory/'))).toEqual(['memory/system/rules.md']);
    expect(paths.filter((p) => p.startsWith('permanent/memory/facts/'))).toEqual([]);
    for (const [p, text] of Object.entries(KEPT_FILES)) {
      expect(await readText(oldAgent, p), p).toBe(text);
    }
  });

  it('purges old memory from every past version on disk, with the same number of versions', () => {
    const gitdir = repoDirFor(oldAgent);
    const purged = [...Object.keys(OLD_MEMORY_FILES), 'memory/system/.map-cache.json'];
    const logged = git(gitdir, 'log', '--all', '--name-only', '--format=').split('\n');
    const objects = git(gitdir, 'rev-list', '--all', '--objects')
      .split('\n')
      .map((l) => l.slice(l.indexOf(' ') + 1));
    for (const p of purged) {
      expect(logged, `history still names ${p}`).not.toContain(p);
      expect(objects, `an object is still reachable at ${p}`).not.toContain(p);
    }
    expect(logged).toContain('memory/system/rules.md');
    expect(commitCount(oldAgent)).toBe(commitsBefore);
    // No blob anywhere in the object store still carries the old text.
    const blobs = git(gitdir, 'cat-file', '--batch-all-objects', '--batch-check')
      .split('\n')
      .filter((l) => l.includes(' blob '))
      .map((l) => l.split(' ')[0]!);
    for (const oid of blobs) {
      expect(git(gitdir, 'cat-file', '-p', oid)).not.toContain(SENTINEL);
    }
  });

  it('clears the agent’s facts rows and empties its export slot', async () => {
    expect(await scanValues(oldAgent)).toEqual([]);
    expect(fs.existsSync(exportSlotFile)).toBe(false);
  });

  it('logs one line per agent with the removed paths and never the content; sets the complete marker', async () => {
    const wiped = firstBootLog
      .split('\n')
      .filter((l) => l.includes(OLD_MEMORY_WIPED_EVENT));
    expect(wiped).toHaveLength(1);
    expect(wiped[0]).toContain(oldAgent);
    expect(wiped[0]).toContain('memory/docs/general/x.md');
    expect(wiped[0]).toContain('permanent/memory/facts/profile.md');
    expect(firstBootLog).not.toContain(SENTINEL);

    const marker = await bus.call<{ key: string }, { value?: Uint8Array }>(
      'storage:get',
      ctxFor('seed'),
      { key: OLD_MEMORY_WIPE_COMPLETE_KEY },
    );
    expect(marker.value?.length ?? 0).toBeGreaterThan(0);
  });

  it('a second boot is a no-op: the same history, new facts and a newer agent’s memory survive', async () => {
    await recordFact(oldAgent, 'post-switch fact');
    newAgent = await createAgent('Post-switch agent');
    await applyFiles(newAgent, { 'memory/docs/new.md': 'written after the switch\n' });
    await recordFact(newAgent, 'newer agent fact');
    await stopKernel();

    const shaBefore = mainSha(oldAgent);
    const newShaBefore = mainSha(newAgent);
    const secondBootLog = await bootMemoryPreset();

    expect(secondBootLog).not.toContain(OLD_MEMORY_WIPED_EVENT);
    expect(mainSha(oldAgent)).toBe(shaBefore);
    expect(mainSha(newAgent)).toBe(newShaBefore);
    expect(await scanValues(oldAgent)).toEqual(['post-switch fact']);
    expect(await scanValues(newAgent)).toEqual(['newer agent fact']);
    expect(await readText(newAgent, 'memory/docs/new.md')).toBe('written after the switch\n');
  });
});
