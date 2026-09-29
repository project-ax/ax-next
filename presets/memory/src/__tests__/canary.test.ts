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
import { startTestContainer } from '@ax/test-harness';

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

// TASK-523: both producers go through OpenRouter on the ONE credential the
// Provider keys screen writes. The fake answers only the two exact URLs, only
// with that key, and records the model each request asked for — so a preset
// that drifted to another host, another credential or another model shows up
// here rather than on the next live walk.
const OPENROUTER_KEY = 'canary-openrouter-key';
let embedCalls = 0;
let rerankCalls = 0;
const embedModels: unknown[] = [];
const rerankModels: unknown[] = [];
let embeddingsUp = true;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  const auth = new Headers(init?.headers).get('authorization');
  if (auth !== `Bearer ${OPENROUTER_KEY}`) return new Response('unauthorized', { status: 401 });
  if (url === 'https://openrouter.ai/api/v1/embeddings') {
    embedCalls += 1;
    embedModels.push(parsed.model);
    if (!embeddingsUp) return new Response('down', { status: 500 });
    const inputs = parsed.input as unknown[];
    const data = inputs.map((_, index) => ({
      object: 'embedding',
      index,
      embedding: new Array<number>(parsed.dimensions as number).fill(0.01),
    }));
    return new Response(JSON.stringify({ object: 'list', data }), { status: 200 });
  }
  if (url === 'https://openrouter.ai/api/v1/rerank') {
    rerankCalls += 1;
    rerankModels.push(parsed.model);
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
// TASK-717: the assembly mounts the SPA catchall exactly as the production
// host does (AX_STATIC_FILES_DIR), and reads the durable user-files tier from
// a host path, so the Files-tab routes can be exercised over the real socket.
let userFilesRoot = '';
let pluginNames: string[] = [];
const SPA_SHELL = '<!doctype html><html><body>AX-SPA-SHELL</body></html>';

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

async function boot(opts: { withVolume: boolean } = { withVolume: true }): Promise<void> {
  createdPods.length = 0;
  detached.length = 0;
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  const connectionString = container.getConnectionUri();
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-memory-preset-')));
  exportHostRoot = path.join(tmp, 'exports');
  userFilesRoot = path.join(tmp, 'user-files');
  const spaDir = path.join(tmp, 'spa');
  await fsp.mkdir(userFilesRoot, { recursive: true });
  await fsp.mkdir(spaDir, { recursive: true });
  await fsp.writeFile(path.join(spaDir, 'index.html'), SPA_SHELL);

  setEnv('AX_CREDENTIALS_KEY', '42'.repeat(32));
  setEnv('AX_BOOTSTRAP_TOKEN', 'stub-bootstrap-token');
  setEnv('AX_HTTP_ALLOW_NO_ORIGINS', '1');

  const config: MemoryPresetConfig = {
    database: { connectionString },
    eventbus: { connectionString },
    session: { connectionString },
    workspace: { backend: 'local', repoRoot: path.join(tmp, 'repo') },
    sandbox: {
      namespace: 'ax-next',
      image: 'ax-next/agent:stub',
      userFilesHostReadRoot: userFilesRoot,
    },
    // The durable per-agent tier: without a filestore the deployment has no
    // user-files tier at all and the durable routes (correctly) answer 503.
    filestore: { server: 'filestore.example.invalid', exportPath: '/exports/ax-user-files' },
    staticFiles: { dir: spaDir },
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
    ...(opts.withVolume
      ? {
          memoryExportVolume: {
            hostRoot: exportHostRoot,
            backing: { server: 'nfs.example.invalid', exportPath: '/exports/ax-memory' },
          },
        }
      : {}),
    memoryEmbeddings: { fetchImpl: fakeFetch },
    onObserverDetached: (work) => {
      detached.push(work);
    },
  };

  await fsp.mkdir(path.dirname(config.factsDatabasePath), { recursive: true });
  if (opts.withVolume) await fsp.mkdir(exportHostRoot, { recursive: true });

  const plugins = createMemoryPlugins(config).filter(
    (p) => !DROPPED.has(p.manifest.name),
  );
  const fakeSandbox = createSandboxK8sPlugin({
    api: fakeK8sApi(),
    hostIpcUrl: config.ipc.hostIpcUrl,
    runtimeClassName: '',
    namespace: 'ax-next',
    image: 'ax-next/agent:stub',
    userFilesHostReadRoot: userFilesRoot,
  });
  const all = [...plugins, fakeSandbox, authStub(), llmStub()];

  const names = all.map((p) => p.manifest.name);
  expect(new Set(names).size).toBe(names.length);
  pluginNames = names;
  memoryPlugin = all.find((p) => p.manifest.name === '@ax/memory');

  const httpPlugin = all.find((p) => p.manifest.name === '@ax/http-server') as
    | (Plugin & { boundPort?: () => number })
    | undefined;

  bus = new HookBus();
  const handle = await bootstrap({ bus, plugins: all, config: {} });
  shutdown = () => handle.shutdown();
  httpPort = httpPlugin?.boundPort?.() ?? 0;

  await seedOpenRouterKey();
}

async function seedOpenRouterKey(): Promise<void> {
  await bus.call('credentials:set', ctxFor('canary-seed', ALICE), {
    scope: 'global',
    ownerId: null,
    ref: 'provider:openrouter',
    kind: 'api-key',
    payload: new TextEncoder().encode(OPENROUTER_KEY),
  });
}

async function teardown(): Promise<void> {
  await shutdown?.();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (container !== null) await container.stop();
  if (tmp !== '') await fsp.rm(tmp, { recursive: true, force: true });
  container = null;
  tmp = '';
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
    expect(bus.hasService('memory:facts:reinstate')).toBe(true);
    expect(bus.hasService('memory:unforget')).toBe(true);
    expect(bus.hasService('memory:facts:revert')).toBe(true);
    expect(bus.hasService('memory:uncorrect')).toBe(true);
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

  it('skill-reflection runs the facts-memory prompt and can be turned on (TASK-611)', async () => {
    const ctx = ctxFor('canary-routines', ALICE);
    const def = await bus.call<
      { defaultRoutineId: string },
      { enabled: boolean; promptBody: string }
    >('routines:get-default', ctx, { defaultRoutineId: 'skill-reflection' });
    // The seed ships OFF (the operator rollout gate); what TASK-611 removes is
    // the TASK-609 refusal and the Strata-only recurrence gate.
    expect(def.enabled).toBe(false);
    expect(def.promptBody).toContain('memory_recall');
    expect(def.promptBody).toContain('2 or more different conversation numbers');
    expect(def.promptBody).not.toContain('memory/docs');
    expect(def.promptBody).not.toContain('source_conversations');
    expect(bus.hasService('tool:execute:memory_recall')).toBe(true);

    const sourceMd = [
      '---',
      'name: skill-reflection',
      'description: reflection',
      'trigger:',
      '  kind: interval',
      '  every: "24h"',
      'conversation: per-fire',
      '---',
      'reflect',
      '',
    ].join('\n');
    await bus.call('routines:upsert-default', ctx, { sourceMd, enabled: true });
    const after = await bus.call<{ defaultRoutineId: string }, { enabled: boolean }>(
      'routines:get-default', ctx, { defaultRoutineId: 'skill-reflection' },
    );
    expect(after.enabled).toBe(true);
    // Back off, so no later case in this file races a reflection fire.
    await bus.call('routines:upsert-default', ctx, { sourceMd, enabled: false });
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

    // TASK-612: the real save route announces the change, for the right
    // agent, so the orchestrator can retire that agent's live sessions at
    // their next turn and the new Rules reach the conversation.
    const announced: unknown[] = [];
    bus.subscribe('system-prompt:augment-changed', 'canary-rules-spy', async (_ctx, payload) => {
      announced.push(payload);
      return undefined;
    });

    const saved = await apiJson(
      'PUT',
      `/api/workspace/agents/${aliceAgentId}/memory/rules`,
      ALICE,
      { body: 'Be brief.\nPrefer UTC timestamps.' },
    );
    expect(saved.status).toBe(200);
    expect(saved.json.saved).toBe(true);
    expect(announced).toEqual([{ agentId: aliceAgentId }]);

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

    const embedBefore = embedCalls;
    const rerankBefore = rerankCalls;
    const active = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { query: 'where does the user live' },
    );
    expect(active.status).toBe(200);
    expect(embedCalls).toBeGreaterThan(embedBefore);
    expect(rerankCalls).toBeGreaterThan(rerankBefore);
    expect(active.json.degraded).toEqual([]);
    // The owner-chosen models, and only those, went on the wire.
    expect(new Set(embedModels)).toEqual(new Set(['google/gemini-embedding-001:nitro']));
    expect(new Set(rerankModels)).toEqual(new Set(['voyageai/rerank-2.5:nitro']));
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

  it('correct "never right" over the real route: the mistake reads retracted, the fix is active (TASK-624)', async () => {
    const remember = (value: string, when: string) =>
      apiJson('POST', `/api/workspace/agents/${aliceAgentId}/memory/remember`, ALICE, {
        about: 'user',
        relation: 'works at',
        value,
        when,
      });
    const acme = await remember('Acme', '2023-01-01T00:00:00Z');
    const globex = await remember('Globex', '2023-06-01T00:00:00Z');
    expect(acme.status).toBe(200);
    expect(globex.status).toBe(200);

    const fixed = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/correct`,
      ALICE,
      {
        id: globex.json.id,
        about: 'user',
        relation: 'works at',
        value: 'Initech',
        reason: 'never-right',
      },
    );
    expect(fixed.status).toBe(200);
    const initechId = fixed.json.id as string;
    expect(typeof initechId).toBe('string');

    const history = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { query: 'where does the user work', history: true },
    );
    expect(history.status).toBe(200);
    const rows = history.json.statements as Array<{
      id: string;
      value: string;
      until?: string;
      closure?: string;
      closedBy?: string;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(globex.json.id as string)?.closure).toBe('retracted');
    // The retracted row is not in the chain: Acme runs straight to Initech.
    expect(byId.get(acme.json.id as string)).toMatchObject({
      closure: 'replaced',
      closedBy: initechId,
    });
    const initech = byId.get(initechId);
    expect(initech?.value).toBe('Initech');
    expect(initech?.until).toBeUndefined();
    expect(initech?.closure).toBeUndefined();
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

  it('Undo after Forget over the real routes brings an agent note back as the same agent row (TASK-630)', async () => {
    const note = await bus.call<
      { input: { about: string; relation: string; value: string } },
      { ok?: boolean; error?: string }
    >('tool:execute:memory_note', ctxFor(aliceAgentId, ALICE), {
      input: { about: 'user', relation: 'plays', value: 'the oboe' },
    });
    expect(note.ok).toBe(true);
    const scanRow = async () =>
      (
        await bus.call<
          Record<string, unknown>,
          { statements: Array<{ id: string; value: string; provenance?: string; until?: string }> }
        >('memory:facts:scan', ctxFor(aliceAgentId, ALICE), {})
      ).statements.find((s) => s.value === 'the oboe');
    const before = await scanRow();
    expect(before?.provenance).toBe('agent');

    const forgotten = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/forget`,
      ALICE,
      { ids: [before!.id] },
    );
    expect(forgotten.status).toBe(200);
    expect((await scanRow())?.until).toBeDefined();

    const undone = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/unforget`,
      ALICE,
      { ids: [before!.id] },
    );
    expect(undone.status).toBe(200);
    expect(undone.json).toEqual({ restored: [before!.id] });
    const after = await scanRow();
    expect(after?.id).toBe(before!.id);
    expect(after?.provenance).toBe('agent');
    expect(after?.until).toBeUndefined();
  });

  it('Undo after Fix over the real routes puts the slot-less agent note back as it was (TASK-634)', async () => {
    // Slot-less on purpose: forgetting the new row would NOT re-open the old
    // one here (TASK-632), so only the revert path passes this.
    const note = await bus.call<
      { input: { about: string; relation: string; value: string } },
      { ok?: boolean; error?: string }
    >('tool:execute:memory_note', ctxFor(aliceAgentId, ALICE), {
      input: { about: 'user', relation: 'collects', value: 'stamps' },
    });
    expect(note.ok).toBe(true);
    const scan = async () =>
      (
        await bus.call<
          Record<string, unknown>,
          {
            statements: Array<{
              id: string;
              value: string;
              provenance?: string;
              until?: string;
              closedBy?: string;
            }>;
          }
        >('memory:facts:scan', ctxFor(aliceAgentId, ALICE), {})
      ).statements;
    const before = (await scan()).find((s) => s.value === 'stamps');
    expect(before?.provenance).toBe('agent');

    const fixed = await apiJson('POST', `/api/workspace/agents/${aliceAgentId}/memory/correct`, ALICE, {
      id: before!.id,
      about: 'user',
      relation: 'collects',
      value: 'coins',
      reason: 'changed',
    });
    expect(fixed.status).toBe(200);
    const newId = (fixed.json as { id: string }).id;
    expect((await scan()).find((s) => s.id === before!.id)?.closedBy).toBe(newId);

    const undone = await apiJson('POST', `/api/workspace/agents/${aliceAgentId}/memory/uncorrect`, ALICE, {
      id: newId,
      restore: before!.id,
    });
    expect(undone.status).toBe(200);
    expect(undone.json).toEqual({ undone: true });
    const rows = await scan();
    const after = rows.find((s) => s.id === before!.id);
    expect(after?.provenance).toBe('agent');
    expect(after?.until).toBeUndefined();
    expect(after?.closedBy).toBeUndefined();
    expect(rows.find((s) => s.id === newId)?.until).toBeDefined();

    const again = await apiJson('POST', `/api/workspace/agents/${aliceAgentId}/memory/uncorrect`, ALICE, {
      id: newId,
      restore: before!.id,
    });
    expect(again.json).toEqual({ undone: false });
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
    // TASK-611: the Conv column carries the per-answer conversation number.
    expect(table).toContain('| Network | When | Conv | Statement |');
    expect(table).toMatch(/Distinct conversations in this evidence: \d+\./);
    // TASK-526: a kind-less row says who saved it, and the caller's own
    // subject renders as DEM's literal `user`, never the stored `user:<id>`.
    expect(table).toContain('| [AGENT] |');
    expect(table).toContain('| user works at: Acme Corp |');
    expect(table).not.toContain('[UNKNOWN]');
    expect(table).not.toContain(`user:${ALICE}`);

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

  it('TASK-625: a conversation is extracted DURING the chat, from the real transcript, each fact pointing at its turn', async () => {
    const created = await bus.call<{ userId: string; agentId: string }, { conversationId: string }>(
      'conversations:create',
      ctxFor(aliceAgentId, ALICE),
      { userId: ALICE, agentId: aliceAgentId },
    );
    const conversationId = created.conversationId;
    const ctx = ctxFor(aliceAgentId, ALICE, { conversationId });
    llmFacts = [
      { subject: 'user', predicate: 'moved to', object: 'Braga', validStart: '2023-06-01T00:00:00Z' },
    ];
    // Only the memory extractor's calls: `@ax/conversation-titles` also calls
    // the provider on an early assistant turn of a real conversation.
    const extractions = () =>
      llmCalls.filter((c) => String(c.system ?? '').includes('memory-extraction engine')).length;
    const before = extractions();

    // Four completed exchanges, persisted and announced the way the host
    // does it: the turn lands in the display log, then `chat:turn-end`.
    // The fourth user turn is the default trigger; no chat:end yet.
    for (let i = 1; i <= 4; i++) {
      const userText = i === 1 ? 'I moved to Braga in June 2023' : `Follow-up question ${i}`;
      for (const [role, text] of [
        ['user', userText],
        ['assistant', 'noted'],
      ] as const) {
        await bus.call('conversations:append-event', ctx, {
          conversationId,
          kind: 'turn',
          role,
          payload: { blocks: [{ type: 'text', text }] },
        });
      }
      await bus.fire('chat:turn-end', ctx, {
        role: 'assistant',
        reqId: `req-canary-625-${i}`,
        reason: 'user-message-wait',
      });
    }
    await settleObserver();
    expect(extractions()).toBe(before + 1);

    const engine = await bus.call<
      { limit: number; ownerUserId: string },
      { statements: Array<{ value: string; sourceTurnId?: string; conversationId?: string }> }
    >('memory:facts:recall', ctx, { limit: 100, ownerUserId: ALICE });
    const braga = engine.statements.find((s) => s.value === 'Braga');
    expect(braga?.sourceTurnId).toBe('0');
    expect(braga?.conversationId).toBe(conversationId);

    // The session ends: nothing is left, so no second call and no second row.
    await bus.fire('chat:end', ctx, { outcome: { kind: 'complete', messages: [] } });
    await settleObserver();
    expect(extractions()).toBe(before + 1);
  });

  it('TASK-626: an extraction pass reaches the conversation memory stream, and the conversation feed returns what it recorded', async () => {
    const created = await bus.call<{ userId: string; agentId: string }, { conversationId: string }>(
      'conversations:create',
      ctxFor(aliceAgentId, ALICE),
      { userId: ALICE, agentId: aliceAgentId },
    );
    const conversationId = created.conversationId;
    const ctx = ctxFor(aliceAgentId, ALICE, { conversationId });
    llmFacts = [
      { subject: 'user', predicate: 'plays', object: 'the cello', validStart: '2024-02-01T00:00:00Z' },
    ];

    // Not enabled / not yours: a stranger's conversation is a 404, never a stream.
    const foreign = await fetch(url(`/api/chat/conversations/${conversationId}/memory-events`), http(BOB));
    expect(foreign.status).toBe(404);
    await foreign.body?.cancel();

    const events = await fetch(url(`/api/chat/conversations/${conversationId}/memory-events`), http(ALICE));
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const frames: Array<Record<string, unknown>> = [];
    const readUntil = async (done: () => boolean): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out; frames so far: ${JSON.stringify(frames)}`);
        const chunk = await reader.read();
        if (chunk.done) throw new Error('memory stream closed early');
        buffered += decoder.decode(chunk.value, { stream: true });
        let cut = buffered.indexOf('\n\n');
        while (cut !== -1) {
          const event = buffered.slice(0, cut);
          buffered = buffered.slice(cut + 2);
          for (const line of event.split('\n')) {
            if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
          cut = buffered.indexOf('\n\n');
        }
      }
    };

    // The snapshot comes first: nothing running, nothing paused.
    await readUntil(() => frames.length >= 1);
    expect(frames[0]).toEqual({ memoryStatus: { extraction: 'ok', conversation: 'idle' } });

    for (let i = 1; i <= 4; i++) {
      const userText = i === 1 ? 'I play the cello on weekends' : `Another question ${i}`;
      for (const [role, text] of [
        ['user', userText],
        ['assistant', 'lovely'],
      ] as const) {
        await bus.call('conversations:append-event', ctx, {
          conversationId,
          kind: 'turn',
          role,
          payload: { blocks: [{ type: 'text', text }] },
        });
      }
      await bus.fire('chat:turn-end', ctx, {
        role: 'assistant',
        reqId: `req-canary-626-${i}`,
        reason: 'user-message-wait',
      });
    }
    await settleObserver();
    await readUntil(() => frames.length >= 3);

    // Exactly one pass: extracting, then ONE recorded frame carrying ids and no text.
    expect(frames.slice(1).map((f) => (f.memoryActivity as { state: string }).state)).toEqual([
      'extracting',
      'recorded',
    ]);
    const recorded = frames[2]!.memoryActivity as { statementIds: string[] };
    expect(recorded.statementIds).toHaveLength(1);
    expect(JSON.stringify(frames)).not.toContain('cello');

    // The owner-scoped feed for that conversation answers with the recorded
    // row, pointing at the turn it came from.
    const feed = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { conversationId },
    );
    expect(feed.status).toBe(200);
    const statements = feed.json.statements as Array<{ id: string; value: string; sourceTurnId?: string }>;
    expect(statements.map((s) => s.id)).toEqual(recorded.statementIds);
    expect(statements[0]!.value).toBe('the cello');
    expect(statements[0]!.sourceTurnId).toBe('0');

    // Bob asking his own agent about Alice's conversation gets nothing.
    const bobFeed = await apiJson(
      'POST',
      `/api/workspace/agents/${bobAgentId}/memory/recall`,
      BOB,
      { conversationId },
    );
    expect(bobFeed.status).toBe(200);
    expect(bobFeed.json.statements).toEqual([]);

    await reader.cancel();
    await bus.fire('chat:end', ctx, { outcome: { kind: 'complete', messages: [] } });
    await settleObserver();
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

  it('a missing OpenRouter credential degrades with no outbound provider call', async () => {
    const seedCtx = ctxFor('canary-seed', ALICE);
    await bus.call('credentials:delete', seedCtx, {
      scope: 'global',
      ownerId: null,
      ref: 'provider:openrouter',
    });
    const embedBefore = embedCalls;
    const rerankBefore = rerankCalls;
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
      expect(embedCalls).toBe(embedBefore);
      expect(rerankCalls).toBe(rerankBefore);
    } finally {
      await seedOpenRouterKey();
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

  // -------------------------------------------------------------------------
  // TASK-717 — the Files tab, composed.
  //
  // In production `createMemoryPlugins` re-appends @ax/channel-web AFTER the
  // k8s base, whose last plugin is @ax/static-files. Both own a trailing-`*`
  // splat (`/*` and `/api/workspace/agents/:agentId/files/*`), the router used
  // to break that tie by registration order, and so every path-taking Files
  // route answered 200 with the SPA's index.html: the tab LISTED, and opening
  // any folder or file died on a JSON SyntaxError over `<!DOCTYPE`. Every unit
  // test in channel-web passed, because none of them had a catchall next to
  // the routes. This block is the one that does, on the real assembly, over a
  // real socket.
  // -------------------------------------------------------------------------
  describe('TASK-717: Files-tab splat routes behind the SPA catchall', () => {
    let aliceFiles = '';
    let bobFiles = '';

    async function mkAgent(userId: string, displayName: string): Promise<string> {
      const out = await bus.call<
        { actor: { userId: string; isAdmin: boolean }; input: Record<string, unknown> },
        { agent: { id: string } }
      >('agents:create', ctxFor('seed', userId), {
        actor: { userId, isAdmin: false },
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

    async function putGoverned(agentId: string, userId: string, rel: string, text: string) {
      await bus.call('workspace:apply', ctxFor(agentId, userId), {
        parent: null,
        changes: [{ path: rel, kind: 'put', content: new TextEncoder().encode(text) }],
        reason: 'TASK-717 seed',
      });
    }

    async function raw(p: string, user: string | null = ALICE) {
      const r = await fetch(url(p), {
        headers: user === null ? {} : { 'x-test-user': user },
      });
      const text = await r.text();
      return { status: r.status, type: r.headers.get('content-type') ?? '', text, headers: r.headers };
    }

    /** JSON, never the shell. The one assertion that would have caught it. */
    async function json(p: string, user: string | null = ALICE) {
      const r = await raw(p, user);
      expect(r.text, `${p} answered with the SPA shell`).not.toContain('AX-SPA-SHELL');
      expect(r.type, `${p} content-type`).toContain('application/json');
      return { status: r.status, body: JSON.parse(r.text) as Record<string, unknown> };
    }

    beforeAll(async () => {
      aliceFiles = await mkAgent(ALICE, 'Alice files');
      bobFiles = await mkAgent(BOB, 'Bob files');
      await putGoverned(aliceFiles, ALICE, 'docs/inner.txt', 'governed-inner\n');
      await putGoverned(bobFiles, BOB, 'secret.txt', 'BOB-GOVERNED-SECRET\n');

      const aliceDurable = path.join(userFilesRoot, aliceFiles);
      const bobDurable = path.join(userFilesRoot, bobFiles);
      await fsp.mkdir(path.join(aliceDurable, 'docs'), { recursive: true });
      await fsp.mkdir(bobDurable, { recursive: true });
      await fsp.writeFile(path.join(aliceDurable, 'docs', 'inner.txt'), 'durable-inner\n');
      await fsp.writeFile(path.join(bobDurable, 'secret.txt'), 'BOB-DURABLE-SECRET\n');
      // An agent-planted symlink out of its own subtree and into a neighbour's.
      await fsp.symlink(bobDurable, path.join(aliceDurable, 'link-to-bob'));
    }, 60_000);

    it('has the shape that broke: the SPA catchall is mounted, and registers before channel-web', async () => {
      const staticAt = pluginNames.indexOf('@ax/static-files');
      const channelAt = pluginNames.indexOf('@ax/channel-web');
      expect(staticAt, '@ax/static-files is in the assembly').toBeGreaterThanOrEqual(0);
      expect(channelAt, '@ax/channel-web is in the assembly').toBeGreaterThanOrEqual(0);
      // The precondition of the bug. If a preset change ever puts channel-web
      // first this test no longer exercises the hazard; it should be said so
      // loudly rather than passing for the wrong reason.
      expect(staticAt, 'static-files registers before channel-web in this preset').toBeLessThan(
        channelAt,
      );
      // And the catchall really is live: the SPA still owns what the API does not.
      for (const p of ['/', '/settings/agents', '/some/client/route']) {
        const r = await raw(p, null);
        expect(r.status, p).toBe(200);
        expect(r.type, p).toContain('text/html');
        expect(r.text, p).toContain('AX-SPA-SHELL');
      }
    });

    it('the governed tier: read and download answer, not index.html', async () => {
      const listing = await json(`/api/workspace/agents/${aliceFiles}/files`);
      expect(listing.status).toBe(200);

      const file = await json(`/api/workspace/agents/${aliceFiles}/files/docs/inner.txt`);
      expect(file.status).toBe(200);
      expect(file.body).toMatchObject({ path: 'docs/inner.txt', body: 'governed-inner\n', clipped: null });

      const dl = await raw(`/api/workspace/agents/${aliceFiles}/download/files/docs/inner.txt`);
      expect(dl.status).toBe(200);
      expect(dl.type).toContain('application/octet-stream');
      expect(dl.headers.get('content-disposition')).toContain('attachment; filename="inner.txt"');
      expect(dl.text).toBe('governed-inner\n');
      expect(dl.text).not.toContain('AX-SPA-SHELL');
    });

    it('the durable tier: folder, file and download answer, not index.html', async () => {
      const root = await json(`/api/workspace/agents/${aliceFiles}/user-files`);
      expect(root.status).toBe(200);
      expect(root.body.kind).toBe('dir');

      const dir = await json(`/api/workspace/agents/${aliceFiles}/user-files/docs`);
      expect(dir.status).toBe(200);
      expect(dir.body).toMatchObject({ kind: 'dir', path: 'docs' });
      expect((dir.body.entries as Array<{ path: string }>).map((e) => e.path)).toContain('docs/inner.txt');

      const file = await json(`/api/workspace/agents/${aliceFiles}/user-files/docs/inner.txt`);
      expect(file.status).toBe(200);
      expect(file.body).toMatchObject({ kind: 'file', path: 'docs/inner.txt', body: 'durable-inner\n' });

      const dl = await raw(`/api/workspace/agents/${aliceFiles}/download/user-files/docs/inner.txt`);
      expect(dl.status).toBe(200);
      expect(dl.type).toContain('application/octet-stream');
      expect(dl.text).toBe('durable-inner\n');
    });

    it('an unauthenticated caller gets the routes own JSON 401 on every splat route, not the shell', async () => {
      for (const p of [
        `/api/workspace/agents/${aliceFiles}/files/docs/inner.txt`,
        `/api/workspace/agents/${aliceFiles}/user-files/docs`,
        `/api/workspace/agents/${aliceFiles}/download/files/docs/inner.txt`,
        `/api/workspace/agents/${aliceFiles}/download/user-files/docs/inner.txt`,
      ]) {
        const r = await json(p, null);
        expect(r.status, p).toBe(401);
      }
    });

    it('an unknown /api path is a JSON 404, not the SPA', async () => {
      for (const p of [
        '/api/no-such-route',
        '/api/workspace/no/such/thing',
        `/api/workspace/agents/${aliceFiles}/no-such-tab/deeper`,
      ]) {
        const r = await json(p);
        expect(r.status, p).toBe(404);
        expect(r.body, p).toEqual({ error: 'not-found' });
      }
    });

    describe('traversal', () => {
      // Every splat route, and the attempts a browser (or an attacker with curl)
      // can actually put on the wire. `..` and `%2e%2e` as WHOLE segments are
      // collapsed by the URL parser before the router sees them; what survives
      // is the encoded-slash family, which the handler must decode exactly once.
      const ROUTES = [
        (a: string, tail: string) => `/api/workspace/agents/${a}/files/${tail}`,
        (a: string, tail: string) => `/api/workspace/agents/${a}/user-files/${tail}`,
        (a: string, tail: string) => `/api/workspace/agents/${a}/download/files/${tail}`,
        (a: string, tail: string) => `/api/workspace/agents/${a}/download/user-files/${tail}`,
      ];

      it('encoded ../ is refused on every splat route (400 invalid-path), never a file', async () => {
        for (const route of ROUTES) {
          for (const tail of ['..%2Fsecret.txt', '%2e%2e%2fsecret.txt', 'docs%2F..%2F..%2Fsecret.txt']) {
            const p = route(aliceFiles, tail);
            const r = await json(p);
            expect(r.status, p).toBe(400);
            expect(r.body, p).toEqual({ error: 'invalid-path' });
          }
        }
      });

      it('an encoded traversal to a neighbour by id is refused, and leaks nothing', async () => {
        for (const route of ROUTES) {
          const p = route(aliceFiles, `..%2F${bobFiles}%2Fsecret.txt`);
          const r = await raw(p);
          expect(r.status, p).toBe(400);
          expect(r.text, p).not.toContain('BOB-');
        }
      });

      it('double-encoded traversal is decoded once, so it is a literal filename that does not exist', async () => {
        for (const route of ROUTES) {
          const p = route(aliceFiles, '%252e%252e%252fsecret.txt');
          const r = await raw(p);
          expect([400, 404], p).toContain(r.status);
          expect(r.text, p).not.toContain('BOB-');
          expect(r.text, p).not.toContain('AX-SPA-SHELL');
        }
      });

      it('a plain ../ the URL parser collapses lands on no route and gets a JSON 404, not a file or the shell', async () => {
        const r = await json(
          `/api/workspace/agents/${aliceFiles}/user-files/../${bobFiles}/user-files/secret.txt`,
        );
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toContain('BOB-');
      });

      it('the durable-tier download of the root is a 400, not the shell', async () => {
        const r = await json(`/api/workspace/agents/${aliceFiles}/download/user-files/`);
        expect(r.status).toBe(400);
      });

      it('an agent-planted symlink into a neighbours subtree does not read through', async () => {
        for (const p of [
          `/api/workspace/agents/${aliceFiles}/user-files/link-to-bob/secret.txt`,
          `/api/workspace/agents/${aliceFiles}/download/user-files/link-to-bob/secret.txt`,
          `/api/workspace/agents/${aliceFiles}/user-files/link-to-bob`,
        ]) {
          const r = await raw(p);
          expect(r.status, p).toBe(404);
          expect(r.text, p).not.toContain('BOB-');
        }
      });
    });

    describe('cross-tenant', () => {
      it("Alice cannot open Bob's agent on any splat route, and cannot tell it from an agent that does not exist", async () => {
        const missing = 'agt_does_not_exist';
        const tails = [
          ['files', 'secret.txt'],
          ['user-files', 'secret.txt'],
          ['download/files', 'secret.txt'],
          ['download/user-files', 'secret.txt'],
          // A MALFORMED path must not read differently from a well-formed one
          // on someone else's agent: 400-vs-404 there is a free oracle.
          ['files', '..%2Fsecret.txt'],
          ['user-files', '..%2Fsecret.txt'],
          ['download/files', '..%2Fsecret.txt'],
          ['download/user-files', '..%2Fsecret.txt'],
        ] as const;
        for (const [seg, tail] of tails) {
          const theirs = await json(`/api/workspace/agents/${bobFiles}/${seg}/${tail}`);
          const nowhere = await json(`/api/workspace/agents/${missing}/${seg}/${tail}`);
          expect(theirs.status, `${seg}/${tail}`).toBe(404);
          expect(theirs.status).toBe(nowhere.status);
          expect(theirs.body).toEqual(nowhere.body);
          expect(JSON.stringify(theirs.body)).not.toContain('BOB-');
        }
      });

      it('a third user sees Alice as absent too, and Bob still reads his own files', async () => {
        const eve = await json(`/api/workspace/agents/${aliceFiles}/files/docs/inner.txt`, EVE);
        expect(eve.status).toBe(404);
        const eveDurable = await json(`/api/workspace/agents/${aliceFiles}/user-files/docs`, EVE);
        expect(eveDurable.status).toBe(404);

        const bob = await json(`/api/workspace/agents/${bobFiles}/files/secret.txt`, BOB);
        expect(bob.status).toBe(200);
        expect(bob.body).toMatchObject({ body: 'BOB-GOVERNED-SECRET\n' });
        const bobDurable = await json(`/api/workspace/agents/${bobFiles}/user-files/secret.txt`, BOB);
        expect(bobDurable.status).toBe(200);
        expect(bobDurable.body).toMatchObject({ kind: 'file', body: 'BOB-DURABLE-SECRET\n' });
      });
    });
  });
});

// TASK-576: the NFS export volume is optional. Without it the assembly still
// boots, recall works and the workspace facts export still runs; runners just
// get no /memory mount.
describe('@ax/preset-memory canary without the export volume', () => {
  beforeAll(async () => {
    await boot({ withVolume: false });
    await seedAgents();
  }, 120_000);

  afterAll(async () => {
    await teardown();
  }, 120_000);

  it('boots with no sandbox:memory-mounts; remember, recall and the workspace export still work; no /memory on the pod', async () => {
    expect(bus.hasService('sandbox:memory-mounts')).toBe(false);
    expect(bus.hasService('memory:export:flush')).toBe(true);
    expect(bus.hasService('memory:facts:recall')).toBe(true);

    const lisbon = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/remember`,
      ALICE,
      { about: 'user', relation: 'lives in', value: 'Lisbon', when: '2023-01-01T00:00:00Z' },
    );
    expect(lisbon.status).toBe(200);
    const recalled = await apiJson(
      'POST',
      `/api/workspace/agents/${aliceAgentId}/memory/recall`,
      ALICE,
      { query: 'where does the user live' },
    );
    expect(recalled.status).toBe(200);
    const stmts = recalled.json.statements as Array<{ value: string }>;
    expect(stmts.some((st) => st.value === 'Lisbon')).toBe(true);

    await bus.call('memory:export:flush', ctxFor(aliceAgentId, ALICE), {});
    const read = await bus.call<{ path: string }, { found: boolean; bytes?: Uint8Array }>(
      'workspace:read',
      ctxFor(aliceAgentId, ALICE),
      { path: 'permanent/memory/facts/profile.md' },
    );
    expect(read.found).toBe(true);
    expect(new TextDecoder().decode(read.bytes)).toContain('Lisbon');
    expect(fs.existsSync(exportHostRoot)).toBe(false);

    await bus.call('sandbox:open-session', ctxFor(aliceAgentId, ALICE), {
      sessionId: 'canary-pod-session-novol',
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
    });
    expect(createdPods.length).toBe(1);
    const pod = createdPods[0]! as {
      spec?: {
        containers?: Array<{
          volumeMounts?: Array<{ mountPath: string }>;
          env?: Array<{ name: string }>;
        }>;
      };
    };
    const c0 = pod.spec?.containers?.[0];
    expect(c0?.volumeMounts?.some((m) => m.mountPath === '/memory') ?? false).toBe(false);
    expect(c0?.env?.some((e) => e.name === 'AX_MEMORY_ROOT') ?? false).toBe(false);
  });
});
