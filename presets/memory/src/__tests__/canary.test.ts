import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

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
import { createSandboxK8sPlugin, type K8sCoreApi } from '@ax/sandbox-k8s';

import { createMemoryPlugins, type MemoryPresetConfig } from '../index.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const EVE = 'user-eve';

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
      bus.registerService<{ userId?: string }, unknown>(
        'auth:get-user',
        name,
        async (_ctx, input) => ({
          user: { id: input?.userId ?? 'unknown', isAdmin: false },
        }),
      );
      bus.registerService('auth:create-bootstrap-user', name, async () => ({
        user: { id: 'bootstrap', isAdmin: true },
      }));
      bus.registerService('auth:complete-bootstrap-user', name, async () => ({}));
    },
  };
}

const llmCalls: Array<Record<string, unknown>> = [];
let llmBehavior: 'facts' | 'missing-credential' = 'facts';
let llmFacts: Array<Record<string, unknown>> = [
  {
    subject: 'user',
    predicate: 'lives in',
    object: 'Lisbon',
    validStart: '2023-01-15T00:00:00Z',
  },
];

function llmStub(): Plugin {
  const name = '@ax/canary/llm-stub';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['llm:call:openrouter'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<Record<string, unknown>, unknown>(
        'llm:call:openrouter',
        name,
        async (_ctx, input) => {
          llmCalls.push({ ...input });
          if (llmBehavior === 'missing-credential') {
            throw new PluginError({
              code: 'no-openrouter-credential',
              plugin: name,
              hookName: 'llm:call:openrouter',
              message: 'no credential for ref=provider:openrouter',
            });
          }
          return {
            text: JSON.stringify({ facts: llmFacts }),
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      );
    },
  };
}

const createdPods: Array<Record<string, unknown>> = [];

function fakeK8sApi(): K8sCoreApi {
  return {
    async createNamespacedPod(args: { body?: unknown }) {
      createdPods.push((args as { body: Record<string, unknown> }).body);
      return { metadata: { name: 'fake-runner' } };
    },
    async readNamespacedPod() {
      return {
        metadata: { name: 'fake-runner' },
        status: {
          phase: 'Running',
          podIP: '10.0.0.2',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
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

let vertexCalls = 0;
let cohereCalls = 0;
let embeddingsUp = true;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  if (url.includes(':predict')) {
    vertexCalls += 1;
    if (!embeddingsUp) return new Response('down', { status: 500 });
    const instances = parsed.instances as unknown[];
    const predictions = instances.map(() => ({
      embeddings: { values: new Array<number>(384).fill(0.01) },
    }));
    return new Response(JSON.stringify({ predictions }), { status: 200 });
  }
  if (url.includes('/v2/rerank')) {
    cohereCalls += 1;
    if (!embeddingsUp) return new Response('down', { status: 500 });
    const docs = parsed.documents as unknown[];
    const results = docs.map((_, index) => ({ index, relevance_score: 1 - index * 0.01 }));
    return new Response(JSON.stringify({ results }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

const detached: Promise<void>[] = [];
let bus: HookBus;
let shutdown: () => Promise<void>;
let httpPort = 0;
let tmp = '';
let container: StartedPostgreSqlContainer | null = null;
let memoryPlugin: Plugin | undefined;
let exportHostRoot = '';

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}

function ctxFor(agentId: string, userId: string, extra: Partial<AgentContext> = {}): AgentContext {
  return makeAgentContext({
    sessionId: 'canary-session',
    agentId,
    userId,
    ...extra,
  });
}

const DROPPED = new Set(['@ax/sandbox-k8s', '@ax/auth-better', '@ax/llm-openrouter']);

async function boot(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const connectionString = container.getConnectionUri();
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-memory-preset-')));
  exportHostRoot = path.join(tmp, 'exports');

  setEnv('AX_CREDENTIALS_KEY', '42'.repeat(32));
  setEnv('AX_BOOTSTRAP_TOKEN', 'stub-bootstrap-token');
  setEnv('AX_HTTP_ALLOW_NO_ORIGINS', '1');

  const config: MemoryPresetConfig = {
    database: { connectionString },
    eventbus: { connectionString },
    session: { connectionString },
    workspace: { backend: 'local', repoRoot: path.join(tmp, 'repo') },
    sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
    ipc: {
      host: '127.0.0.1',
      port: 0,
      hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80',
    },
    chat: {
      runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' },
      chatTimeoutMs: 60_000,
    },
    http: {
      host: '127.0.0.1',
      port: 0,
      cookieKey: randomBytes(32).toString('hex'),
      allowedOrigins: [],
    },
    credentialProxy: {
      socketPath: path.join(tmp, 'proxy.sock'),
      caDir: path.join(tmp, 'proxy-ca'),
    },
    factsDatabasePath: path.join(tmp, 'facts', 'facts.db'),
    memoryExportVolume: {
      hostRoot: exportHostRoot,
      backing: { server: 'nfs.example.invalid', exportPath: '/exports/ax-memory' },
    },
    memoryEmbeddings: { projectId: 'memory-canary', fetchImpl: fakeFetch },
    agentWorkspacePreview: true,
    onObserverDetached: (work) => {
      detached.push(work);
    },
  };

  await fsp.mkdir(path.dirname(config.factsDatabasePath), { recursive: true });
  await fsp.mkdir(exportHostRoot, { recursive: true });

  const plugins = createMemoryPlugins(config).filter(
    (p) => !DROPPED.has(p.manifest.name),
  );
  const fakeSandbox = createSandboxK8sPlugin({
    api: fakeK8sApi(),
    hostIpcUrl: config.ipc.hostIpcUrl,
    runtimeClassName: '',
    namespace: 'ax-next',
    image: 'ax-next/agent:stub',
  });
  const all = [...plugins, fakeSandbox, authStub(), llmStub()];

  const names = all.map((p) => p.manifest.name);
  expect(new Set(names).size).toBe(names.length);
  memoryPlugin = all.find((p) => p.manifest.name === '@ax/memory');

  const httpPlugin = all.find((p) => p.manifest.name === '@ax/http-server') as
    | (Plugin & { boundPort?: () => number })
    | undefined;

  bus = new HookBus();
  const handle = await bootstrap({ bus, plugins: all, config: {} });
  shutdown = () => handle.shutdown();
  httpPort = httpPlugin?.boundPort?.() ?? 0;

  const seedCtx = ctxFor('canary-seed', ALICE);
  for (const ref of ['provider:vertex', 'provider:cohere']) {
    await bus.call('credentials:set', seedCtx, {
      scope: 'global',
      ownerId: null,
      ref,
      kind: 'api-key',
      payload: new TextEncoder().encode('canary-token'),
    });
  }
}

async function teardown(): Promise<void> {
  await shutdown?.();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (container !== null) await container.stop();
  if (tmp !== '') await fsp.rm(tmp, { recursive: true, force: true });
}

let aliceAgentId = '';
let bobAgentId = '';
let teamAgentId = '';
let teamId = '';

async function seedAgents(): Promise<void> {
  const alice = ctxFor('seed', ALICE);
  const mk = async (actor: { userId: string; isAdmin: boolean }, input: Record<string, unknown>) => {
    const out = await bus.call<
      { actor: { userId: string; isAdmin: boolean }; input: Record<string, unknown> },
      { agent: { id: string } }
    >('agents:create', alice, { actor, input });
    return out.agent.id;
  };
  aliceAgentId = await mk(
    { userId: ALICE, isAdmin: false },
    {
      displayName: 'Alice personal',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-sonnet-4-6',
      visibility: 'personal',
    },
  );
  bobAgentId = await mk(
    { userId: BOB, isAdmin: false },
    {
      displayName: 'Bob personal',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-sonnet-4-6',
      visibility: 'personal',
    },
  );
  const team = await bus.call<
    { actor: { userId: string }; displayName: string },
    { team: { id: string } }
  >('teams:create', alice, { actor: { userId: ALICE }, displayName: 'canary team' });
  teamId = team.team.id;
  await bus.call('teams:add-member', alice, {
    actor: { userId: ALICE },
    teamId,
    userId: BOB,
    role: 'member',
  });
  teamAgentId = await mk(
    { userId: ALICE, isAdmin: false },
    {
      displayName: 'Team agent',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-sonnet-4-6',
      visibility: 'team',
      teamId,
    },
  );
}

function http(user: string | null, init: RequestInit = {}): RequestInit {
  const headers: Record<string, string> = {
    'x-requested-with': 'ax-admin',
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (user !== null) headers['x-test-user'] = user;
  return { ...init, headers };
}

function url(p: string): string {
  return `http://127.0.0.1:${httpPort}${p}`;
}

async function apiJson(
  method: string,
  p: string,
  user: string | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(url(p), {
    method,
    ...http(user),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function settleObserver(): Promise<void> {
  const pending = detached.splice(0);
  await Promise.all(pending);
}

describe('@ax/preset-memory canary', () => {
  beforeAll(async () => {
    await boot();
    await seedAgents();
  }, 120_000);

  afterAll(async () => {
    await teardown();
  }, 120_000);

  it('boots the real assembly: memory hooks + rules + tools, no strata/PG facts', () => {
    expect(memoryPlugin?.manifest.registers).toContain('memory:rules:read');
    expect(bus.hasService('memory:facts:record')).toBe(true);
    expect(bus.hasService('memory:facts:recall')).toBe(true);
    expect(bus.hasService('memory:facts:supersede')).toBe(true);
    expect(bus.hasService('memory:facts:clear')).toBe(true);
    expect(bus.hasService('memory:rules:read')).toBe(true);
    expect(bus.hasService('memory:rules:write')).toBe(true);
    expect(bus.hasService('tool:execute:memory_note')).toBe(true);
    expect(bus.hasService('tool:execute:memory_recall')).toBe(true);
    expect(bus.hasService('memory:export:flush')).toBe(true);
    expect(bus.hasService('sandbox:memory-mounts')).toBe(true);
    expect(bus.hasService('embeddings:embed')).toBe(true);
    expect(bus.hasService('embeddings:rerank')).toBe(true);
    expect(bus.hasService('memory:learned:read')).toBe(false);
  });

  it('agent detail exposes the memory surface; rules save+read round-trip over HTTP', async () => {
    const detail = await apiJson('GET', `/api/workspace/agents/${aliceAgentId}`, ALICE);
    expect(detail.status).toBe(200);
    const memory = detail.json.memory as {
      factsAvailable?: boolean;
      factsVisibility?: string;
      rules?: { status?: string; doc?: { body?: string } | null };
    };
    expect(memory.factsAvailable).toBe(true);
    expect(memory.factsVisibility).toBe('personal');
    expect(memory.rules?.status).toBe('ok');
    expect(memory.rules?.doc?.body ?? '').toBe('');

    const saved = await apiJson(
      'PUT',
      `/api/workspace/agents/${aliceAgentId}/memory/rules`,
      ALICE,
      { body: 'Be brief.\nPrefer UTC timestamps.' },
    );
    expect(saved.status).toBe(200);
    expect(saved.json.saved).toBe(true);

    const again = await apiJson('GET', `/api/workspace/agents/${aliceAgentId}`, ALICE);
    const mem2 = again.json.memory as { rules?: { doc?: { body?: string } | null } };
    expect(mem2.rules?.doc?.body).toContain('Be brief.');

    const read = await bus.call<
      { path: string },
      { found: boolean; bytes?: Uint8Array }
    >('workspace:read', ctxFor(aliceAgentId, ALICE), { path: 'memory/system/rules.md' });
    expect(read.found).toBe(true);
    expect(Buffer.from(read.bytes!).toString('utf-8')).toContain('Be brief.');
  });

  it('remember → recall → history → forget over the real routes', async () => {
    const paris = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/remember`,
      ALICE,
      { about: 'user', relation: 'lives in', value: 'Paris', when: '2023-01-01T00:00:00Z' },
    );
    expect(paris.status).toBe(200);
    const rome = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/remember`,
      ALICE,
      { about: 'user', relation: 'lives in', value: 'Rome', when: '2023-02-01T00:00:00Z' },
    );
    expect(rome.status).toBe(200);
    const romeId = rome.json.id as string;
    expect(typeof romeId).toBe('string');

    const vertexBefore = vertexCalls;
    const cohereBefore = cohereCalls;
    const active = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { query: 'where does the user live' },
    );
    expect(active.status).toBe(200);
    expect(vertexCalls).toBeGreaterThan(vertexBefore);
    expect(cohereCalls).toBeGreaterThan(cohereBefore);
    expect(active.json.degraded).toEqual([]);
    const activeStmts = active.json.statements as Array<{ value: string }>;
    expect(activeStmts.some((s) => s.value === 'Rome')).toBe(true);
    expect(activeStmts.some((s) => s.value === 'Paris')).toBe(false);

    const history = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { query: 'where does the user live', history: true },
    );
    const histStmts = history.json.statements as Array<{
      id: string;
      value: string;
      closure?: string;
      closedBy?: string;
    }>;
    const parisRow = histStmts.find((s) => s.value === 'Paris');
    const romeRow = histStmts.find((s) => s.value === 'Rome');
    expect(parisRow?.closure).toBe('replaced');
    expect(parisRow?.closedBy).toBe(romeRow?.id);

    const forgotten = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/forget`,
      ALICE,
      { ids: [romeId] },
    );
    expect(forgotten.status).toBe(200);
    const afterActive = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { query: 'where does the user live' },
    );
    const afterStmts = afterActive.json.statements as Array<{ value: string }>;
    expect(afterStmts.some((s) => s.value === 'Rome')).toBe(false);
    const afterHistory = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { query: 'where does the user live', history: true },
    );
    const romeAfter = (afterHistory.json.statements as Array<{
      value: string;
      closure?: string;
    }>).find((s) => s.value === 'Rome');
    expect(romeAfter?.closure).toBe('forgotten');
  });

  it('unauthenticated and foreign callers are denied; CSRF and authority payloads enforced', async () => {
    const unauth = await apiJson('GET', `/api/workspace/agents/${aliceAgentId}`, null);
    expect(unauth.status).toBe(401);

    const foreign = await apiJson('GET', `/api/workspace/agents/${aliceAgentId}`, EVE);
    expect([403, 404]).toContain(foreign.status);

    const bobsPersonal = await apiJson(
      'POST',
      `/api/workspace/agents/${bobAgentId}/memory/recall`,
      ALICE,
      { query: 'anything' },
    );
    expect([403, 404]).toContain(bobsPersonal.status);

    const noCsrf = await fetch(url(`/api/workspace/agents/${aliceAgentId}/memory/remember`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': ALICE },
      body: JSON.stringify({ about: 'user', relation: 'likes', value: 'tea' }),
    });
    expect(noCsrf.status).toBe(403);

    const badBody = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/remember`,
      ALICE,
      { about: 'user', relation: 'likes', value: 'tea', provenance: 'human' },
    );
    expect(badBody.status).toBe(400);
  });

  it('memory_note is in the tool catalog, stores agent provenance; memory_recall renders fresh rows', async () => {
    const listed = await bus.call<
      Record<string, never>,
      {
        tools: Array<{
          name: string;
          executesIn?: string;
          inputSchema?: { properties?: Record<string, unknown> };
        }>;
      }
    >('tool:list', ctxFor(aliceAgentId, ALICE), {});
    const noteDesc = listed.tools.find((t) => t.name === 'memory_note');
    const recallDesc = listed.tools.find((t) => t.name === 'memory_recall');
    expect(noteDesc, 'memory_note descriptor').toBeDefined();
    expect(recallDesc, 'memory_recall descriptor').toBeDefined();
    expect(noteDesc?.executesIn).toBe('host');
    expect(recallDesc?.executesIn).toBe('host');
    expect(Object.keys(noteDesc?.inputSchema?.properties ?? {}).sort()).toEqual([
      'about',
      'relation',
      'value',
      'when',
    ]);

    const note = await bus.call<
      { input: { about: string; relation: string; value: string } },
      { ok?: boolean; error?: string }
    >(`tool:execute:${noteDesc!.name}`, ctxFor(aliceAgentId, ALICE), {
      input: { about: 'user', relation: 'works at', value: 'Acme Corp' },
    });
    expect(note.ok).toBe(true);

    const scan = await bus.call<
      Record<string, unknown>,
      { statements: Array<{ value: string; provenance?: string }> }
    >('memory:facts:scan', ctxFor(aliceAgentId, ALICE), {});
    const acme = scan.statements.find((s) => s.value === 'Acme Corp');
    expect(acme, 'scan finds the note row').toBeDefined();
    expect(acme?.provenance).toBe('agent');

    const table = await bus.call<{ input: { query: string } }, string>(
      `tool:execute:${recallDesc!.name}`,
      ctxFor(aliceAgentId, ALICE),
      { input: { query: 'work' } },
    );
    expect(table).toContain('| Network | When | Statement |');
    expect(table).toContain('[UNKNOWN]');
    expect(table).toContain('Acme Corp');

    const corrected = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/remember`,
      ALICE,
      { about: 'user', relation: 'works at', value: 'Globex' },
    );
    expect(corrected.status).toBe(200);
    const fresh = await bus.call<{ input: { query: string } }, string>(
      `tool:execute:${recallDesc!.name}`,
      ctxFor(aliceAgentId, ALICE),
      { input: { query: 'work' } },
    );
    expect(fresh).toContain('Globex');
    expect(fresh).not.toContain('Acme Corp');
  });

  it('chat:end drives the observer; extracted facts close by slot and never close human rows', async () => {
    const fireTurn = async (conversationId: string, content: string) => {
      const before = llmCalls.length;
      await bus.fire('chat:end', ctxFor(aliceAgentId, ALICE, { conversationId }), {
        outcome: {
          kind: 'complete',
          messages: [
            { role: 'user', content },
            { role: 'assistant', content: 'noted' },
          ],
        },
      });
      await settleObserver();
      expect(llmCalls.length).toBeGreaterThan(before);
      expect(String(llmCalls.at(-1)?.model)).toBe('z-ai/glm-5.3-flash:nitro');
    };
    const historyFor = async () => {
      const r = await apiJson(
        'POST',
        `/api/workspace/agents/${aliceAgentId}/memory/recall`,
        ALICE,
        { query: 'where does the user live', history: true },
      );
      return r.json.statements as Array<{
        id: string;
        value: string;
        until?: string;
        closedBy?: string;
        closure?: string;
      }>;
    };

    llmFacts = [
      {
        subject: 'user',
        predicate: 'lives in',
        object: 'Lisbon',
        validStart: '2023-01-15T00:00:00Z',
      },
    ];
    await fireTurn('conv-lisbon', 'I lived in Lisbon back in January 2023');

    llmFacts = [
      {
        subject: 'user',
        predicate: 'lives in',
        object: 'Coimbra',
        validStart: '2023-03-10T00:00:00Z',
      },
    ];
    await fireTurn('conv-coimbra', 'In March I moved to Coimbra');

    let hist = await historyFor();
    const lisbon = hist.find((s) => s.value === 'Lisbon');
    const coimbra = hist.find((s) => s.value === 'Coimbra');
    expect(lisbon?.closedBy).toBe(coimbra?.id);
    expect(lisbon?.until?.startsWith('2023-03-10')).toBe(true);
    expect(coimbra?.until).toBeUndefined();

    const active = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { query: 'where does the user live' },
    );
    const activeVals = (active.json.statements as Array<{ value: string }>).map(
      (s) => s.value,
    );
    expect(activeVals).toContain('Coimbra');
    expect(activeVals).not.toContain('Lisbon');

    const human = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/remember`,
      ALICE,
      { about: 'user', relation: 'lives in', value: 'Porto', when: '2023-04-01T00:00:00Z' },
    );
    expect(human.status).toBe(200);

    llmFacts = [
      {
        subject: 'user',
        predicate: 'lives in',
        object: 'Faro',
        validStart: '2023-05-20T00:00:00Z',
      },
    ];
    await fireTurn('conv-faro', 'I spent late May in Faro');

    hist = await historyFor();
    const porto = hist.find((s) => s.value === 'Porto');
    const faro = hist.find((s) => s.value === 'Faro');
    expect(porto, 'human Porto row exists').toBeDefined();
    expect(porto?.until, 'extracted Faro must not close the human Porto row').toBeUndefined();
    expect(faro, 'the fresh extracted fact is stored, not swallowed').toBeDefined();

    const profile = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { profile: true },
    );
    expect(profile.status).toBe(200);
    const profileBody = JSON.stringify(profile.json);
    expect(profileBody).toContain('Porto');
    expect(profileBody).not.toContain('Faro');
  });

  it('team agent shares memory across members and revokes on removal', async () => {
    const noteByAlice = await bus.call<
      { input: { about: string; relation: string; value: string } },
      { ok?: boolean }
    >('tool:execute:memory_note', ctxFor(teamAgentId, ALICE), {
      input: { about: 'user', relation: 'prefers', value: 'morning standup' },
    });
    expect(noteByAlice.ok).toBe(true);

    const bobRecall = await apiJson(
      'POST',
      `/api/workspace/agents/${teamAgentId}/memory/recall`,
      BOB,
      { query: 'standup' },
    );
    expect(JSON.stringify(bobRecall.json)).toContain('morning standup');

    const eveRecall = await apiJson(
      'POST',
      `/api/workspace/agents/${teamAgentId}/memory/recall`,
      EVE,
      { query: 'standup' },
    );
    expect([403, 404]).toContain(eveRecall.status);

    const aliceStandup = await apiJson(
      'POST',
      `/api/workspace/agents/${teamAgentId}/memory/remember`,
      ALICE,
      { about: 'team', relation: 'works at', value: 'Team HQ', when: '2023-01-05T00:00:00Z' },
    );
    expect(aliceStandup.status).toBe(200);
    const bobStandup = await apiJson(
      'POST',
      `/api/workspace/agents/${teamAgentId}/memory/remember`,
      BOB,
      { about: 'team', relation: 'works at', value: 'Remote HQ', when: '2023-02-05T00:00:00Z' },
    );
    expect(bobStandup.status).toBe(200);
    const bobSees = await apiJson(
      'POST',
      `/api/workspace/agents/${teamAgentId}/memory/recall`,
      BOB,
      { query: 'where does the team work' },
    );
    const bobVals = (bobSees.json.statements as Array<{ value: string }>).map((s) => s.value);
    expect(bobVals).toContain('Remote HQ');
    expect(bobVals).not.toContain('Team HQ');

    await bus.call('teams:remove-member', ctxFor('seed', ALICE), {
      actor: { userId: ALICE },
      teamId,
      userId: BOB,
    });
    const bobAfter = await apiJson(
      'POST',
      `/api/workspace/agents/${teamAgentId}/memory/recall`,
      BOB,
      { query: 'standup' },
    );
    expect([403, 404]).toContain(bobAfter.status);
    const bobNote = await bus.call<
      { input: { about: string; relation: string; value: string } },
      { ok?: boolean; error?: string }
    >('tool:execute:memory_note', ctxFor(teamAgentId, BOB), {
      input: { about: 'user', relation: 'prefers', value: 'late standup' },
    });
    expect(bobNote.error).toBe('forbidden');
  });

  it('flush writes exports under hostRoot; open-session mounts /memory read-only with the matching subPath', async () => {
    const flushed = await bus.call<Record<string, never>, { changed: boolean }>(
      'memory:export:flush',
      ctxFor(aliceAgentId, ALICE),
      {},
    );
    expect(typeof flushed.changed).toBe('boolean');

    const { volumeAgentKey } = await import('@ax/memory');
    const subPath = `${volumeAgentKey(aliceAgentId)}/permanent/memory/facts`;
    const exportedDir = path.join(exportHostRoot, subPath);
    expect(fs.existsSync(path.join(exportedDir, 'profile.md'))).toBe(true);
    const profileBytes = fs.readFileSync(path.join(exportedDir, 'profile.md'), 'utf-8');
    expect(profileBytes).toContain('Porto');

    const open = await bus.call<Record<string, unknown>, { runnerEndpoint: string }>(
      'sandbox:open-session',
      ctxFor(aliceAgentId, ALICE),
      {
        sessionId: 'canary-pod-session',
        workspaceRoot: '/tmp/workspace',
        runnerBinary: '/tmp/stub-runner.js',
        owner: {
          userId: ALICE,
          agentId: aliceAgentId,
          agentConfig: {
            displayName: 'Alice personal',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-6',
            runner: 'claude-sdk',
          },
        },
      },
    );
    expect(open.runnerEndpoint).toContain('ax-next-host');
    expect(createdPods.length).toBe(1);

    const pod = createdPods[0]! as {
      spec?: {
        containers?: Array<{
          volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }>;
          env?: Array<{ name: string; value?: string }>;
        }>;
        volumes?: Array<{ name: string; nfs?: { server?: string; path?: string; readOnly?: boolean } }>;
      };
    };
    const container0 = pod.spec?.containers?.[0];
    const memMount = container0?.volumeMounts?.find((m) => m.mountPath === '/memory');
    expect(memMount, 'pod has a /memory mount').toBeDefined();
    expect(memMount?.readOnly).toBe(true);
    expect(memMount?.subPath).toBe(subPath);
    const memVol = pod.spec?.volumes?.find((v) => v.name === memMount?.name);
    expect(memVol?.nfs?.server).toBe('nfs.example.invalid');
    expect(memVol?.nfs?.path).toBe('/exports/ax-memory');
    const envRoot = container0?.env?.find((e) => e.name === 'AX_MEMORY_ROOT');
    expect(envRoot?.value).toBe('/memory');
  });

  it('missing LLM credential produces memory_no_llm_credential without blocking chat:end', async () => {
    llmBehavior = 'missing-credential';
    const logLines: Array<{ msg: string; bindings?: Record<string, unknown> }> = [];
    const logCtx = makeAgentContext({
      sessionId: 'canary-nocred',
      agentId: aliceAgentId,
      userId: ALICE,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (msg: string, bindings?: Record<string, unknown>) => {
          logLines.push({ msg, bindings });
        },
        child() {
          return this;
        },
      },
    });
    try {
      await bus.fire('chat:end', logCtx, {
        outcome: {
          kind: 'complete',
          messages: [
            { role: 'user', content: 'remember this' },
            { role: 'assistant', content: 'ok' },
          ],
        },
      });
      await settleObserver();
      const events = logLines.map((l) => l.msg);
      expect(events).toContain('memory_no_llm_credential');
    } finally {
      llmBehavior = 'facts';
    }
  });

  it('embedding outage reports degraded flags instead of a local fallback', async () => {
    embeddingsUp = false;
    try {
      const recall = await apiJson(
        'POST',
        `/api/workspace/agents/${aliceAgentId}/memory/recall`,
        ALICE,
        { query: 'where does the user live' },
      );
      expect(recall.status).toBe(200);
      const degraded = recall.json.degraded as string[];
      expect(degraded).toContain('semantic');
      expect(degraded).toContain('ranking');
    } finally {
      embeddingsUp = true;
    }
  });

  it('missing embedding credentials degrade with no outbound provider call', async () => {
    const seedCtx = ctxFor('canary-seed', ALICE);
    for (const ref of ['provider:vertex', 'provider:cohere']) {
      await bus.call('credentials:delete', seedCtx, {
        scope: 'global',
        ownerId: null,
        ref,
      });
    }
    const vertexBefore = vertexCalls;
    const cohereBefore = cohereCalls;
    try {
      const recall = await apiJson(
        'POST',
        `/api/workspace/agents/${aliceAgentId}/memory/recall`,
        ALICE,
        { query: 'where does the user live' },
      );
      expect(recall.status).toBe(200);
      const degraded = recall.json.degraded as string[];
      expect(degraded).toContain('semantic');
      expect(degraded).toContain('ranking');
      expect(vertexCalls).toBe(vertexBefore);
      expect(cohereCalls).toBe(cohereBefore);
    } finally {
      for (const ref of ['provider:vertex', 'provider:cohere']) {
        await bus.call('credentials:set', seedCtx, {
          scope: 'global',
          ownerId: null,
          ref,
          kind: 'api-key',
          payload: new TextEncoder().encode('canary-token'),
        });
      }
    }
  });

  it('automatic writers never touch the rules file', async () => {
    const read = async () => {
      const r = await bus.call<{ path: string }, { found: boolean; bytes?: Uint8Array }>(
        'workspace:read',
        ctxFor(aliceAgentId, ALICE),
        { path: 'memory/system/rules.md' },
      );
      return r.found ? Buffer.from(r.bytes!).toString('utf-8') : null;
    };
    const beforeBytes = await read();
    expect(beforeBytes, 'rules file has the expected human text before writers run').toContain(
      'Be brief.',
    );

    const note = await bus.call<
      { input: { about: string; relation: string; value: string } },
      { ok?: boolean }
    >('tool:execute:memory_note', ctxFor(aliceAgentId, ALICE), {
      input: { about: 'user', relation: 'likes', value: 'espresso' },
    });
    expect(note.ok).toBe(true);
    await bus.fire('chat:end', ctxFor(aliceAgentId, ALICE), {
      outcome: {
        kind: 'complete',
        messages: [
          { role: 'user', content: 'I like espresso' },
          { role: 'assistant', content: 'got it' },
        ],
      },
    });
    await settleObserver();
    await bus.call('memory:export:flush', ctxFor(aliceAgentId, ALICE), {});

    expect(await read()).toBe(beforeBytes);
  });
});
