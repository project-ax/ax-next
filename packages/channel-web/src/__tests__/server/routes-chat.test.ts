// @vitest-environment node
import { randomBytes } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createConversationsPlugin } from '@ax/conversations';
import type {
  CreateInput as ConvCreateInput,
  CreateOutput as ConvCreateOutput,
} from '@ax/conversations';
import { createAttachmentsPlugin } from '@ax/attachments';
import type { AttachmentsConfig } from '@ax/attachments';
import {
  createMockWorkspacePlugin,
  createTestHarness,
  type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createChannelWebServerPlugin } from '../../server/plugin';

// ---------------------------------------------------------------------------
// POST /api/chat/messages — chat-flow producer (Task 9 of Week 10–12).
//
// Same testcontainers-postgres harness as stream-e2e.test.ts: real
// @ax/conversations + http-server + channel-web; auth, agents, and agent:invoke
// are mocked. The agent:invoke mock captures the dispatched ctx so we can
// assert it carries the server-minted reqId + the right conversationId.
//
// Cases:
//   1. Anonymous → 401
//   2. Foreign agent → 403
//   3. Agent not-found → 404 (agent-not-found)
//   4. New conversation happy path → 202 + conversation row + agent:invoke dispatch
//   5. Existing conversation happy path → 202, no new conversation row, no append-turn call
//   6. Mismatched agent → 400 (agent-mismatch, I10)
//   7. Conversation not-found → 404 (conversation-not-found)
//   8. Cross-tenant conversation → 404 (no leak; not 403)
//   9. Body too large → 413 (http-server's 1 MiB cap)
//  10. Foreign Origin → 403 (CSRF gate, J8)
//  11. Invalid payload → 400
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const ALLOWED_ORIGIN = 'https://app.example.com';
const HEADERS_OK = {
  'content-type': 'application/json',
  origin: ALLOWED_ORIGIN,
};

function authMockPlugin(args: {
  user: { id: string; isAdmin: boolean } | null;
}): Plugin {
  return {
    manifest: {
      name: 'mock-auth',
      version: '0.0.0',
      registers: ['auth:require-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('auth:require-user', 'mock-auth', async () => {
        if (args.user === null) {
          throw new PluginError({
            code: 'unauthenticated',
            plugin: 'mock-auth',
            message: 'no session',
          });
        }
        return { user: args.user };
      });
    },
  };
}

function agentsMockPlugin(args: {
  /** Users for whom resolve allows access. */
  allowedFor: Set<string>;
  /** Agents whose resolve raises 'not-found'. */
  notFound?: Set<string>;
  /** Per-user list of agents the agents:list-for-user mock returns. */
  listFor?: Record<
    string,
    Array<{ id: string; displayName: string; visibility: 'personal' | 'team' }>
  >;
}): Plugin {
  return {
    manifest: {
      name: 'mock-agents',
      version: '0.0.0',
      registers: ['agents:resolve', 'agents:list-for-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService(
        'agents:resolve',
        'mock-agents',
        async (_ctx, input: unknown) => {
          const { agentId, userId } = input as {
            agentId: string;
            userId: string;
          };
          if (args.notFound?.has(agentId)) {
            throw new PluginError({
              code: 'not-found',
              plugin: 'mock-agents',
              message: `agent '${agentId}' not found`,
            });
          }
          if (!args.allowedFor.has(userId)) {
            throw new PluginError({
              code: 'forbidden',
              plugin: 'mock-agents',
              message: `agent '${agentId}' not accessible to '${userId}'`,
            });
          }
          return { agent: { id: agentId, visibility: 'personal' } };
        },
      );
      bus.registerService(
        'agents:list-for-user',
        'mock-agents',
        async (_ctx, input: unknown) => {
          const { userId } = input as { userId: string };
          const agents = args.listFor?.[userId] ?? [];
          return { agents };
        },
      );
    },
  };
}

interface ChatRunCapture {
  ctx: AgentContext;
  input: {
    message: {
      role: string;
      content: string;
      contentBlocks?: Array<Record<string, unknown>>;
      turnId?: string;
    };
  };
}

function chatRunMockPlugin(captures: ChatRunCapture[]): Plugin {
  return {
    manifest: {
      name: 'mock-chat-run',
      version: '0.0.0',
      // channel-web hard-calls proxy:add-host (TASK-37 reactive wall); a no-op
      // registration satisfies bootstrap's verifyCalls walk for this suite,
      // which boots channel-web without @ax/credential-proxy.
      registers: ['agent:invoke', 'proxy:add-host'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('proxy:add-host', 'mock-chat-run', async () => ({
        added: true,
      }));
      bus.registerService(
        'agent:invoke',
        'mock-chat-run',
        async (ctx, input: unknown) => {
          captures.push({
            ctx,
            input: input as { message: { role: string; content: string } },
          });
          // Mimic agent:invoke's contract — return a AgentOutcome shape; the
          // route handler's dispatch is fire-and-forget so the value is
          // unobserved, but we keep the shape correct in case a future
          // assertion reads it.
          return { kind: 'complete', messages: [] };
        },
      );
    },
  };
}

interface GrantCapture {
  ctx: AgentContext;
  input: { conversationId: string; userId: string; agentId: string; skillId: string };
}

// Module-level routing trace for the authored-first routing tests (Task 6).
// Reset in beforeEach inside those tests.
const grantTrace = { authored: [] as string[], catalog: [] as string[] };

// Mock `agent:apply-capability-grant` (TASK-36). Channel-web declares it as a
// hard `call`, so bootstrap's verifyCalls needs SOMEONE registered. Captures
// the inputs so the decision-endpoint test can assert the resolved agentId +
// userId thread through.
//
// Also registers `agent:apply-authored-capability-grant` (Task 6 / Phase 4
// PR-B): skillId 'authored-draft' → {applied:true}, otherwise
// {applied:false, reason:'not-authored'}. Both handlers push into grantTrace.
function grantMockPlugin(captures: GrantCapture[]): Plugin {
  return {
    manifest: {
      name: 'mock-grant',
      version: '0.0.0',
      registers: ['agent:apply-capability-grant', 'agent:apply-authored-capability-grant'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService(
        'agent:apply-capability-grant',
        'mock-grant',
        async (ctx, input: unknown) => {
          const i = input as GrantCapture['input'];
          grantTrace.catalog.push(i.skillId);
          captures.push({ ctx, input: i });
          return { attached: true };
        },
      );
      bus.registerService(
        'agent:apply-authored-capability-grant',
        'mock-grant',
        async (_c, input: unknown) => {
          const i = input as { skillId: string };
          grantTrace.authored.push(i.skillId);
          return i.skillId === 'authored-draft'
            ? { applied: true, respawned: false }
            : { applied: false, reason: 'not-authored' };
        },
      );
    },
  };
}

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

interface BootArgs {
  user: { id: string; isAdmin: boolean } | null;
  allowedFor: Set<string>;
  notFound?: Set<string>;
  /** Per-user agents:list-for-user mock data. */
  listFor?: Record<
    string,
    Array<{ id: string; displayName: string; visibility: 'personal' | 'team' }>
  >;
  /** Override allowedOrigins on the http-server. */
  allowedOrigins?: readonly string[];
  /**
   * Phase 3 (attachments): when true, boot `@ax/attachments` alongside a
   * permissive in-memory workspace stub (so `attachments:commit`'s
   * `workspace:apply` calls — which pass `parent: null` — don't hit
   * `createMockWorkspacePlugin`'s parent-CAS check on the second commit).
   */
  includeAttachments?: boolean;
  /** Phase 3 (attachments): per-test attachments config (e.g. maxFileBytes). */
  attachmentsConfig?: AttachmentsConfig;
}

interface BootResult {
  harness: TestHarness;
  port: number;
  http: HttpServerPlugin;
  chatRunCaptures: ChatRunCapture[];
  grantCaptures: GrantCapture[];
}

// In-memory store stub used by the Phase-3 attachment-ref tests. TASK-68:
// `attachments:commit` now writes upload bytes to the content-addressed blob
// store (blob:put) + a metadata row, NOT the git workspace. For the chat-route
// tests we only need blob:put/blob:get to behave as a black-box content store;
// the workspace:* hooks stay registered for OTHER plugins booted here that still
// call them (chat-orchestrator etc.). Mirrors the inline stub in
// `packages/attachments/src/__tests__/contract.test.ts`.
function permissiveWorkspacePlugin(): Plugin {
  const blobs = new Map<string, Uint8Array>();
  const cas = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mock-workspace-permissive',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
        // TASK-68: the content-addressed blob store the attachments commit/
        // download path now rides.
        'blob:put',
        'blob:get',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService(
        'workspace:apply',
        'mock-workspace-permissive',
        async (_ctx, input: unknown) => {
          const { changes } = input as {
            changes: Array<{
              path: string;
              kind: 'put' | 'delete';
              content?: Uint8Array;
            }>;
          };
          for (const change of changes) {
            if (change.kind === 'put' && change.content !== undefined) {
              blobs.set(change.path, change.content);
            } else if (change.kind === 'delete') {
              blobs.delete(change.path);
            }
          }
          return {
            version: 'v-permissive',
            delta: { before: null, after: 'v-permissive', changes: [] },
          };
        },
      );
      bus.registerService(
        'workspace:read',
        'mock-workspace-permissive',
        async (_ctx, input: unknown) => {
          const { path } = input as { path: string };
          const bytes = blobs.get(path);
          if (bytes === undefined) return { found: false };
          return { found: true, bytes };
        },
      );
      bus.registerService(
        'workspace:list',
        'mock-workspace-permissive',
        async () => ({ paths: [] as string[] }),
      );
      bus.registerService(
        'workspace:diff',
        'mock-workspace-permissive',
        async () => ({
          delta: { before: null, after: 'v-permissive', changes: [] },
        }),
      );
      // Content-addressed in-memory blob store (length+first-byte key is enough
      // for these tests — they don't assert cross-content de-dup).
      bus.registerService(
        'blob:put',
        'mock-workspace-permissive',
        async (_ctx, input: unknown) => {
          const bytes = (input as { bytes: Uint8Array }).bytes;
          const sha256 = `${bytes.length.toString(16).padStart(8, '0')}${(bytes[0] ?? 0)
            .toString(16)
            .padStart(2, '0')}`.padEnd(64, '0');
          cas.set(sha256, bytes);
          return { sha256, size: bytes.length };
        },
      );
      bus.registerService(
        'blob:get',
        'mock-workspace-permissive',
        async (_ctx, input: unknown) => {
          const bytes = cas.get((input as { sha256: string }).sha256);
          return bytes === undefined ? { found: false } : { bytes };
        },
      );
    },
  };
}

/**
 * No-op stub for `attachments:*`. Channel-web declares `attachments:store-temp`
 * / `:commit` / `:download` as hard calls (Phase 3); tests that don't load
 * the real `@ax/attachments` (because they don't exercise upload/commit/
 * download) still need someone registered or bootstrap's verifyCalls walk
 * fails. The real plugin runs alongside this stub when `includeAttachments`
 * is true — duplicate-service registration would throw, so we only push
 * the stub on the false path.
 */
function attachmentsStubPlugin(): Plugin {
  return {
    manifest: {
      name: 'mock-attachments-stub',
      version: '0.0.0',
      registers: [
        'attachments:store-temp',
        'attachments:commit',
        'attachments:download',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      const notImpl = async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-attachments-stub',
          message: 'attachments stub (not exercised by this case)',
        });
      };
      bus.registerService('attachments:store-temp', 'mock-attachments-stub', notImpl);
      bus.registerService('attachments:commit', 'mock-attachments-stub', notImpl);
      bus.registerService('attachments:download', 'mock-attachments-stub', notImpl);
    },
  };
}

/**
 * Channel-web declares the Settings Connections skills hooks as hard calls
 * (TASK-42). These chat-route cases don't drive the connections surface, so
 * no-op registrations satisfy the bootstrap verifyCalls walk.
 */
function skillsStubPlugin(): Plugin {
  return {
    manifest: {
      name: 'mock-skills-stub',
      version: '0.0.0',
      registers: ['skills:list', 'skills:list-user-attachments', 'skills:detach-for-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('skills:list', 'mock-skills-stub', async () => ({ skills: [] }));
      bus.registerService('skills:list-user-attachments', 'mock-skills-stub', async () => ({
        attachments: [],
      }));
      bus.registerService('skills:detach-for-user', 'mock-skills-stub', async () => ({
        removed: false,
      }));
    },
  };
}

async function boot(args: BootArgs): Promise<BootResult> {
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: args.allowedOrigins ?? [ALLOWED_ORIGIN],
  });
  const chatRunCaptures: ChatRunCapture[] = [];
  const grantCaptures: GrantCapture[] = [];
  // When the attachments plugin is booted, swap in the permissive
  // workspace stub — `createMockWorkspacePlugin`'s parent-CAS rejects
  // the second `attachments:commit` (parent: null vs latest: 'mock-0').
  const workspacePlugin =
    args.includeAttachments === true
      ? permissiveWorkspacePlugin()
      : createMockWorkspacePlugin();
  const plugins: Plugin[] = [
    http,
    createDatabasePostgresPlugin({ connectionString }),
    authMockPlugin({ user: args.user }),
    agentsMockPlugin({
      allowedFor: args.allowedFor,
      ...(args.notFound !== undefined ? { notFound: args.notFound } : {}),
      ...(args.listFor !== undefined ? { listFor: args.listFor } : {}),
    }),
    // Phase D — @ax/conversations declares `workspace:list` /
    // `workspace:read` calls (used by conversations:get to read
    // runner-native jsonl). Bootstrap verifies them at boot, so
    // every harness that boots conversations needs a workspace
    // plugin registered. Empty mock workspace = no jsonl found =
    // empty turns, which is what these tests expect.
    workspacePlugin,
    createConversationsPlugin(),
    chatRunMockPlugin(chatRunCaptures),
    grantMockPlugin(grantCaptures),
  ];
  if (args.includeAttachments === true) {
    plugins.push(createAttachmentsPlugin(args.attachmentsConfig ?? {}));
  } else {
    // Channel-web declares `attachments:*` as hard calls (Phase 3) — when
    // the real plugin isn't loaded, bootstrap still needs SOMEONE
    // registered for those hooks.
    plugins.push(attachmentsStubPlugin());
  }
  plugins.push(skillsStubPlugin());
  plugins.push(createChannelWebServerPlugin({}));
  const harness = await createTestHarness({ plugins });
  return { harness, port: http.boundPort(), http, chatRunCaptures, grantCaptures };
}

const harnesses: TestHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Drop tables so each test starts fresh.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
    // Phase 3 (attachments): some tests boot `@ax/attachments`; drop
    // its temp table here too so a per-test temp doesn't leak into the
    // next test (where it'd pass the storage-uniqueness check but
    // belong to a different user, masking forbidden/not-found cases).
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_temps');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

async function countConversations(): Promise<number> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    const r = await client.query(
      'SELECT COUNT(*)::int AS n FROM conversations_v1_conversations',
    );
    return (r.rows[0] as { n: number }).n;
  } finally {
    await client.end().catch(() => {});
  }
}

// Phase E (2026-05-09): the `listTurns` helper that queried
// `conversations_v1_turns` was deleted alongside the table itself. The
// runner-native workspace jsonl is now the source of truth for transcripts
// (Task E-6 dropped the table from the migration), so any "no turn was
// written" assertion is implicit — there is no host-side table to peek
// into. The remaining tests still assert agent:invoke dispatch + the
// absence of any conversations:append-turn hook call, which is the
// real behavioral contract.

async function postMessage(
  port: number,
  body: unknown,
  opts: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/chat/messages`, {
    method: 'POST',
    headers: opts.headers ?? HEADERS_OK,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('@ax/channel-web POST /api/chat/messages', () => {
  it('1. returns 401 when unauthenticated and writes nothing', async () => {
    const booted = await boot({
      user: null,
      allowedFor: new Set(),
    });
    harnesses.push(booted.harness);

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });

    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
    expect(await countConversations()).toBe(0);
    expect(booted.chatRunCaptures).toHaveLength(0);
  });

  it('2. returns 403 when agents:resolve says forbidden', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(), // userA NOT allowed
    });
    harnesses.push(booted.harness);

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_other',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });

    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'forbidden' });
    expect(await countConversations()).toBe(0);
    expect(booted.chatRunCaptures).toHaveLength(0);
  });

  it('3. returns 404 (agent-not-found) when agents:resolve says not-found', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
      notFound: new Set(['agt_missing']),
    });
    harnesses.push(booted.harness);

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_missing',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });

    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'agent-not-found' });
    expect(await countConversations()).toBe(0);
  });

  it('4. new conversation happy path: 202, row created, agent:invoke dispatched with server-minted reqId, no append-turn call', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    // Phase E: channel-web no longer calls conversations:append-turn —
    // the runner's first SDK turn writes the user message to the
    // workspace jsonl, which is the source of truth for transcripts.
    // Spy on bus.call to prove the route never invokes the append-turn
    // hook even on the happy path.
    const callSpy = vi.spyOn(booted.harness.bus, 'call');

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      // Throw a client-supplied `reqId` into the body — it MUST be ignored.
      // (zod's PostMessageRequest doesn't carry a reqId field, so anything
      // extra is silently dropped.)
      reqId: 'evil-client-supplied',
      contentBlocks: [{ type: 'text', text: 'hello there' }],
    });

    expect(r.status).toBe(202);
    const body = (await r.json()) as { conversationId: string; reqId: string };
    expect(typeof body.conversationId).toBe('string');
    expect(body.conversationId.length).toBeGreaterThan(0);
    expect(typeof body.reqId).toBe('string');
    expect(body.reqId.length).toBeGreaterThan(0);
    // Server-minted reqId — never the client-supplied one.
    expect(body.reqId).not.toBe('evil-client-supplied');
    // Default makeReqId shape: 'req-' + 12 hex chars.
    expect(body.reqId).toMatch(/^req-[0-9a-f]{12}$/);

    expect(await countConversations()).toBe(1);
    // Phase E (Task E-6): the conversations_v1_turns table is gone.
    // The runner-native jsonl in the workspace is the source of truth
    // for transcripts. "No host-side turn was written" is implicit —
    // there is no table left to peek into.

    // agent:invoke dispatch — give the void-returning call a tick to flush.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(booted.chatRunCaptures).toHaveLength(1);
    const cap = booted.chatRunCaptures[0]!;
    expect(cap.ctx.reqId).toBe(body.reqId);
    expect(cap.ctx.conversationId).toBe(body.conversationId);
    expect(cap.ctx.userId).toBe('userA');
    expect(cap.ctx.agentId).toBe('agt_test');
    // agent:invoke's first-turn message — extracted from the first text block.
    // `content` carries the typed text; `contentBlocks` is omitted because
    // a text-only message has no non-text blocks to ship. The runner's
    // user-message handoff would otherwise prepend `content` ALONGSIDE
    // the same text already present in contentBlocks — duplicating it in
    // the SDK input and jsonl transcript.
    expect(cap.input.message.role).toBe('user');
    expect(cap.input.message.content).toBe('hello there');
    expect(cap.input.message.contentBlocks).toBeUndefined();
    expect(typeof cap.input.message.turnId).toBe('string');
    expect(cap.input.message.turnId!.length).toBeGreaterThan(0);

    // Phase E invariant: conversations:append-turn must not be called
    // anywhere in the POST handler chain. (The hook is still registered
    // by @ax/conversations until Task E-3 deletes it; this assertion
    // proves the writer side is gone today.)
    const appendCalls = callSpy.mock.calls.filter(
      ([hookName]) => hookName === 'conversations:append-turn',
    );
    expect(appendCalls).toHaveLength(0);
    callSpy.mockRestore();
  });

  it('5. existing conversation: 202 returned, no new conversation created, no append-turn call', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    // Pre-create a conversation through the conversations plugin so the
    // store has a real row with the right user_id + agent_id.
    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );

    expect(await countConversations()).toBe(1);

    const callSpy = vi.spyOn(booted.harness.bus, 'call');

    const r = await postMessage(booted.port, {
      conversationId: created.conversationId,
      agentId: 'agt_test',
      contentBlocks: [{ type: 'text', text: 'follow-up' }],
    });

    expect(r.status).toBe(202);
    const body = (await r.json()) as { conversationId: string; reqId: string };
    expect(body.conversationId).toBe(created.conversationId);

    // Still ONE conversation row.
    expect(await countConversations()).toBe(1);
    // Phase E (Task E-6): conversations_v1_turns was dropped; the
    // workspace jsonl is the transcript source of truth.

    // Phase E invariant: no append-turn call.
    const appendCalls = callSpy.mock.calls.filter(
      ([hookName]) => hookName === 'conversations:append-turn',
    );
    expect(appendCalls).toHaveLength(0);
    callSpy.mockRestore();
  });

  it('6. mismatched agent on existing conversation → 400 (agent-mismatch, I10)', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );

    const r = await postMessage(booted.port, {
      conversationId: created.conversationId,
      agentId: 'agt_DIFFERENT',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });

    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'agent-mismatch' });
    // Phase E (Task E-6): conversations_v1_turns was dropped; the
    // 400 response above is the load-bearing assertion that no work
    // was kicked off for the mismatched agent.
  });

  it('7. conversation not-found → 404 (conversation-not-found)', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const r = await postMessage(booted.port, {
      conversationId: 'cnv_does_not_exist',
      agentId: 'agt_test',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });

    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'conversation-not-found' });
  });

  it('8. cross-tenant conversation → 404 (NOT 403, no existence leak)', async () => {
    // userA owns the conversation; userB tries to post into it. We boot
    // with userA first to create the row, then re-boot with userB as
    // the auth principal. The agents:resolve mock allows BOTH users so
    // the rejection MUST come from the conversation-ownership check.
    const userA = { id: 'userA', isAdmin: false };
    const userB = { id: 'userB', isAdmin: false };

    const bootA = await boot({
      user: userA,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootA.harness);
    const created = await bootA.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      bootA.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );
    await bootA.harness.close({ onError: () => {} });
    harnesses.pop();

    const bootB = await boot({
      user: userB,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootB.harness);

    const r = await postMessage(bootB.port, {
      conversationId: created.conversationId,
      agentId: 'agt_test',
      contentBlocks: [{ type: 'text', text: 'sneaking' }],
    });

    expect(r.status).toBe(404); // NOT 403.
    expect(await r.json()).toEqual({ error: 'conversation-not-found' });
    // Phase E (Task E-6): conversations_v1_turns was dropped; the
    // chatRunCaptures assertion below is the load-bearing proof that
    // userB's request never reached agent:invoke.
    expect(bootB.chatRunCaptures).toHaveLength(0);
  });

  it('9. body > 1 MiB → 413 from http-server cap (handler never runs)', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    // 1.5 MiB of payload — well over the http-server's MAX_BODY_BYTES (1 MiB).
    // We send raw text so we exceed the cap regardless of JSON validity.
    const huge = 'x'.repeat(1.5 * 1024 * 1024);
    const r = await postMessage(booted.port, huge, { headers: HEADERS_OK });

    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'body-too-large' });
    expect(await countConversations()).toBe(0);
    expect(booted.chatRunCaptures).toHaveLength(0);
  });

  it('10. foreign Origin without X-Requested-With → 403 (CSRF gate, J8)', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const r = await postMessage(
      booted.port,
      {
        conversationId: null,
        agentId: 'agt_test',
        contentBlocks: [{ type: 'text', text: 'hi' }],
      },
      {
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
      },
    );

    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error.startsWith('csrf-failed:')).toBe(true);
    expect(await countConversations()).toBe(0);
    expect(booted.chatRunCaptures).toHaveLength(0);
  });

  it('11. invalid payload (missing required fields) → 400', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const r = await postMessage(booted.port, {
      conversationId: null,
      // agentId missing
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });

    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid-payload' });
    expect(await countConversations()).toBe(0);
  });

  it('11b. invalid payload (contentBlocks empty) → 400', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: [],
    });

    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid-payload' });
  });

  it('11c. invalid payload (contentBlocks > 20) → 400', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      type: 'text',
      text: `block ${i}`,
    }));
    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: tooMany,
    });

    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid-payload' });
  });

  it('11d. invalid JSON body → 400', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const r = await postMessage(booted.port, '{ this is not json', {
      headers: HEADERS_OK,
    });

    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid-payload' });
  });

  it('12. follow-up turn preserves existing activeSessionId (J6 routing intact)', async () => {
    // Regression: the early `conversations:bind-session` used to pass a
    // fresh placeholder `sessionId` regardless of any existing active
    // session. On a follow-up turn, that clobbered the live session id
    // the orchestrator's J6 routing reads back; `session:is-alive` then
    // returned false on the placeholder and forced a fresh sandbox spawn
    // even when the runner was still alive. The early bind must
    // preserve the existing activeSessionId and only update active_req_id.
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    // Pre-create a conversation and bind it to a "live" session, mimicking
    // the state after a prior turn opened a sandbox.
    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );
    const liveSessionId = 'sess_live_from_prior_turn';
    const priorReqId = 'req-priorprior01';
    await booted.harness.bus.call<
      { conversationId: string; sessionId: string; reqId: string },
      void
    >('conversations:bind-session', booted.harness.ctx({ userId: 'userA' }), {
      conversationId: created.conversationId,
      sessionId: liveSessionId,
      reqId: priorReqId,
    });

    const r = await postMessage(booted.port, {
      conversationId: created.conversationId,
      agentId: 'agt_test',
      contentBlocks: [{ type: 'text', text: 'follow-up' }],
    });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { conversationId: string; reqId: string };
    expect(body.reqId).not.toBe(priorReqId);

    // After the early bind: activeSessionId stays pointed at the live
    // session, active_req_id advances to the new reqId. This is what the
    // orchestrator's J6 routing reads back when deciding whether to route
    // into the existing sandbox.
    interface GetInput {
      conversationId: string;
      userId: string;
    }
    interface GetOutput {
      conversation: {
        activeSessionId: string | null;
        activeReqId: string | null;
      };
    }
    const got = await booted.harness.bus.call<GetInput, GetOutput>(
      'conversations:get',
      booted.harness.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.conversation.activeSessionId).toBe(liveSessionId);
    expect(got.conversation.activeReqId).toBe(body.reqId);
  });

  it('13. (TASK-89) happy path: active_req_id is bound BEFORE the 202, binding exactly once (no added latency)', async () => {
    // The early bind is authoritative but must not cost the common case
    // anything: when the bind lands first try, the route calls
    // conversations:bind-session exactly once and returns 202 with the
    // reqId already resolvable via conversations:get-by-req-id — i.e. the
    // SSE GET racing in right after the 202 finds the row (no 404 window).
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const callSpy = vi.spyOn(booted.harness.bus, 'call');

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });

    expect(r.status).toBe(202);
    const body = (await r.json()) as { conversationId: string; reqId: string };

    // Bound exactly once on the happy path — the retry loop never spins.
    const bindCalls = callSpy.mock.calls.filter(
      ([hookName]) => hookName === 'conversations:bind-session',
    );
    expect(bindCalls).toHaveLength(1);
    callSpy.mockRestore();

    // The reqId resolves the conversation NOW (before any orchestrator bind) —
    // the cold-respawn 404 window is closed at the source.
    interface ByReqIdInput {
      reqId: string;
      userId: string;
    }
    interface ByReqIdOutput {
      conversationId: string;
      activeReqId: string | null;
    }
    const resolved = await booted.harness.bus.call<ByReqIdInput, ByReqIdOutput>(
      'conversations:get-by-req-id',
      booted.harness.ctx({ userId: 'userA' }),
      { reqId: body.reqId, userId: 'userA' },
    );
    expect(resolved.conversationId).toBe(body.conversationId);
    expect(resolved.activeReqId).toBe(body.reqId);
  });

  it('14. (TASK-89) bind never establishes → 503 (not 202), agent:invoke NOT dispatched', async () => {
    // When the bind can't be established within the retry budget, the POST
    // returns 503 so the client retries the whole turn — rather than a 202
    // for a reqId whose stream could never open. Critically: no turn is
    // started (agent:invoke is dispatched only AFTER a successful bind), so
    // a 503 can't leave a half-started turn behind.
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    // Force every conversations:bind-session call to reject, simulating a
    // bind backend that's down for the whole retry window. All OTHER hooks
    // pass through to the real implementations.
    const realCall = booted.harness.bus.call.bind(booted.harness.bus);
    const callSpy = vi
      .spyOn(booted.harness.bus, 'call')
      .mockImplementation((hookName: string, ...rest: unknown[]) => {
        if (hookName === 'conversations:bind-session') {
          return Promise.reject(
            new PluginError({
              code: 'unknown',
              plugin: 'mock-conversations',
              hookName,
              message: 'bind backend unavailable (test)',
            }),
          );
        }
        return (realCall as (...a: unknown[]) => Promise<unknown>)(
          hookName,
          ...rest,
        );
      });

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    });

    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'bind-unavailable' });

    // It retried (bounded), not a single best-effort attempt.
    const bindCalls = callSpy.mock.calls.filter(
      ([hookName]) => hookName === 'conversations:bind-session',
    );
    expect(bindCalls.length).toBeGreaterThan(1);

    // No turn was started — agent:invoke must NOT have been dispatched.
    const invokeCalls = callSpy.mock.calls.filter(
      ([hookName]) => hookName === 'agent:invoke',
    );
    expect(invokeCalls).toHaveLength(0);

    callSpy.mockRestore();
    // Give any (non-existent) async dispatch a tick — proves the capture
    // really is empty, not just not-yet-flushed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(booted.chatRunCaptures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers shared across the read+delete describes.
// ---------------------------------------------------------------------------

// Seed the conversation's transcript into the DISPLAY EVENT LOG (TASK-66) so
// conversations:get (and GET /api/chat/conversations/:id) can return turns.
// The legacy workspace-jsonl seed is gone (TASK-70 / out-of-git Phase 5):
// conversations:get reads only the event log now. Each turn becomes one
// `conversations:append-event` of kind 'turn'; a raw-string user `content`
// maps to a single text block (mirroring the runner's emit + the old jsonl
// parser). `conversationId` keys the read (no runner_session_id bind needed).
async function seedWorkspaceJsonl(
  harness: TestHarness,
  conversationId: string,
  turns: Array<{
    role: 'user' | 'assistant';
    contentBlocks?: Array<{ type: string; [k: string]: unknown }>;
    /** raw string `content` instead of structured blocks (user role only). */
    content?: string;
  }>,
): Promise<void> {
  for (const t of turns) {
    const blocks =
      t.contentBlocks ??
      (t.content !== undefined ? [{ type: 'text', text: t.content }] : []);
    await harness.bus.call(
      'conversations:append-event',
      harness.ctx({ conversationId }),
      { conversationId, kind: 'turn', role: t.role, payload: { blocks } },
    );
  }
}

async function softDeleteConversation(
  conversationId: string,
): Promise<void> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'UPDATE conversations_v1_conversations SET deleted_at = NOW() WHERE conversation_id = $1',
      [conversationId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// POST /api/chat/permission-decision — apply a user-approved JIT capability
// grant (TASK-36). Auth-gated + agent-ACL'd + scoped to the actor's own
// conversation (agentId resolved from conversations:get, not the body) +
// CSRF-guarded (origin/x-requested-with) by http-server.
// ---------------------------------------------------------------------------

async function postDecision(
  port: number,
  body: unknown,
  opts: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/chat/permission-decision`, {
    method: 'POST',
    headers: opts.headers ?? HEADERS_OK,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * Mint a real conversation row tied to `agt_test` via the message route. The
 * row is owned by whichever user the harness was booted with (the message
 * route reads the authed user, not the body).
 */
async function createConversation(port: number): Promise<string> {
  const r = await postMessage(port, {
    conversationId: null,
    agentId: 'agt_test',
    contentBlocks: [{ type: 'text', text: 'hi' }],
  });
  const body = (await r.json()) as { conversationId: string };
  return body.conversationId;
}

describe('@ax/channel-web POST /api/chat/permission-decision', () => {
  it('auths, resolves the conversation owner + agent, and calls agent:apply-capability-grant', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const conversationId = await createConversation(booted.port);

    const r = await postDecision(booted.port, { conversationId, skillId: 'linear' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, attached: true });

    expect(booted.grantCaptures).toHaveLength(1);
    const grant = booted.grantCaptures[0]!;
    expect(grant.input).toEqual({
      conversationId,
      userId: 'userA',
      agentId: 'agt_test',
      skillId: 'linear',
    });
  });

  it('401 when unauthenticated and never calls the grant', async () => {
    const booted = await boot({ user: null, allowedFor: new Set() });
    harnesses.push(booted.harness);
    const r = await postDecision(booted.port, { conversationId: 'cnv-x', skillId: 'linear' });
    expect(r.status).toBe(401);
    expect(booted.grantCaptures).toHaveLength(0);
  });

  it('400 on a malformed body (missing skillId)', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);
    const r = await postDecision(booted.port, { conversationId: 'cnv-1' });
    expect(r.status).toBe(400);
    expect(booted.grantCaptures).toHaveLength(0);
  });

  it('404 when the conversation is unknown / not owned by the actor', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);
    const r = await postDecision(booted.port, {
      conversationId: 'cnv-does-not-exist',
      skillId: 'linear',
    });
    expect(r.status).toBe(404);
    expect(booted.grantCaptures).toHaveLength(0);
  });

  it('403 (CSRF) on a foreign Origin', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);
    const r = await postDecision(
      booted.port,
      { conversationId: 'cnv-1', skillId: 'linear' },
      { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } },
    );
    expect(r.status).toBe(403);
    expect(booted.grantCaptures).toHaveLength(0);
  });

  it('routes an authored draft to agent:apply-authored-capability-grant', async () => {
    grantTrace.authored.length = 0;
    grantTrace.catalog.length = 0;
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);
    const conversationId = await createConversation(booted.port);
    const res = await postDecision(booted.port, { conversationId, skillId: 'authored-draft' });
    expect(res.status).toBe(200);
    expect(grantTrace.authored).toContain('authored-draft');
    expect(grantTrace.catalog).not.toContain('authored-draft');
  });

  it('falls back to the catalog grant when the skill is not an authored draft', async () => {
    grantTrace.authored.length = 0;
    grantTrace.catalog.length = 0;
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);
    const conversationId = await createConversation(booted.port);
    const res = await postDecision(booted.port, { conversationId, skillId: 'catalog-skill' });
    expect(res.status).toBe(200);
    expect(grantTrace.authored).toContain('catalog-skill'); // tried authored first
    expect(grantTrace.catalog).toContain('catalog-skill');  // then fell back
  });
});

// ---------------------------------------------------------------------------
// POST /api/chat/approve-authored-skill — early approval from "My Skills"
// (TASK-83). Auth-gated + agent-ACL'd (agentId from the body, then resolved) +
// CSRF-guarded. Fires the authored grant with NO conversationId.
// ---------------------------------------------------------------------------

async function postApprove(
  port: number,
  body: unknown,
  opts: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/chat/approve-authored-skill`, {
    method: 'POST',
    headers: opts.headers ?? HEADERS_OK,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('@ax/channel-web POST /api/chat/approve-authored-skill', () => {
  it('auths, ACL-checks the agent, and fires the authored grant with NO conversationId', async () => {
    grantTrace.authored.length = 0;
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const r = await postApprove(booted.port, {
      agentId: 'agt_test',
      skillId: 'authored-draft',
      shown: { hosts: ['api.linear.app'], slots: ['LINEAR_API_KEY'], npm: [], pypi: [] },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(grantTrace.authored).toContain('authored-draft');
  });

  it('401 when unauthenticated', async () => {
    const booted = await boot({ user: null, allowedFor: new Set() });
    harnesses.push(booted.harness);
    const r = await postApprove(booted.port, { agentId: 'agt_test', skillId: 'authored-draft' });
    expect(r.status).toBe(401);
  });

  it('400 on a malformed body (missing skillId)', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);
    const r = await postApprove(booted.port, { agentId: 'agt_test' });
    expect(r.status).toBe(400);
  });

  it('403 when the actor cannot reach the agent (ownership gate)', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(), // userA is allowed for nothing → forbidden
    });
    harnesses.push(booted.harness);
    const r = await postApprove(booted.port, { agentId: 'agt_test', skillId: 'authored-draft' });
    expect(r.status).toBe(403);
  });

  it('404 when the agent is not found', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
      notFound: new Set(['agt_missing']),
    });
    harnesses.push(booted.harness);
    const r = await postApprove(booted.port, { agentId: 'agt_missing', skillId: 'authored-draft' });
    expect(r.status).toBe(404);
  });

  it('409 (not-authored) when the skill is not one of the agent\'s pending drafts', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);
    // 'catalog-skill' → the authored grant returns {applied:false}; early
    // approval has no catalog fallback, so the route surfaces 409.
    const r = await postApprove(booted.port, { agentId: 'agt_test', skillId: 'catalog-skill' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'not-authored' });
  });

  it('403 (CSRF) on a foreign Origin', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);
    const r = await postApprove(
      booted.port,
      { agentId: 'agt_test', skillId: 'authored-draft' },
      { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } },
    );
    expect(r.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/chat/conversations — list user's conversations (Task 10).
// ---------------------------------------------------------------------------

describe('@ax/channel-web GET /api/chat/conversations', () => {
  it('returns 401 when unauthenticated', async () => {
    const booted = await boot({
      user: null,
      allowedFor: new Set(),
    });
    harnesses.push(booted.harness);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations`,
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });

  it('cross-tenant: returns ONLY the requesting user\'s conversations', async () => {
    // Boot as userA, create two conversations. Then re-boot as userB,
    // create one conversation. List as userB — only the one row.
    const userA = { id: 'userA', isAdmin: false };
    const userB = { id: 'userB', isAdmin: false };

    const bootA = await boot({
      user: userA,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootA.harness);
    await bootA.harness.bus.call<ConvCreateInput, ConvCreateOutput>(
      'conversations:create',
      bootA.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt_test' },
    );
    await bootA.harness.bus.call<ConvCreateInput, ConvCreateOutput>(
      'conversations:create',
      bootA.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt_test' },
    );
    await bootA.harness.close({ onError: () => {} });
    harnesses.pop();

    const bootB = await boot({
      user: userB,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootB.harness);
    const userBConv = await bootB.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      bootB.harness.ctx({ userId: userB.id }),
      { userId: userB.id, agentId: 'agt_test' },
    );

    const r = await fetch(
      `http://127.0.0.1:${bootB.port}/api/chat/conversations`,
    );
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{
      conversationId: string;
      userId: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.conversationId).toBe(userBConv.conversationId);
    expect(list[0]!.userId).toBe(userB.id);
  });

  it('?agentId= filter narrows the result', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    await booted.harness.bus.call<ConvCreateInput, ConvCreateOutput>(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_alpha' },
    );
    const beta = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_beta' },
    );

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations?agentId=agt_beta`,
    );
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{
      conversationId: string;
      agentId: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.conversationId).toBe(beta.conversationId);
    expect(list[0]!.agentId).toBe('agt_beta');
  });

  it('soft-deleted conversations are excluded (J5)', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const live = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );
    const tombstoned = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );
    await softDeleteConversation(tombstoned.conversationId);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations`,
    );
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{ conversationId: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.conversationId).toBe(live.conversationId);
  });
});

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id — load with turns (Task 11).
// ---------------------------------------------------------------------------

describe('@ax/channel-web GET /api/chat/conversations/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    const booted = await boot({ user: null, allowedFor: new Set() });
    harnesses.push(booted.harness);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/cnv_anything`,
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });

  it('foreign-user → 404 (no existence leak)', async () => {
    const userA = { id: 'userA', isAdmin: false };
    const userB = { id: 'userB', isAdmin: false };

    const bootA = await boot({
      user: userA,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootA.harness);
    const created = await bootA.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      bootA.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt_test' },
    );
    await bootA.harness.close({ onError: () => {} });
    harnesses.pop();

    const bootB = await boot({
      user: userB,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootB.harness);

    const r = await fetch(
      `http://127.0.0.1:${bootB.port}/api/chat/conversations/${created.conversationId}`,
    );
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'conversation-not-found' });
  });

  it('soft-deleted → 404', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );
    await softDeleteConversation(created.conversationId);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${created.conversationId}`,
    );
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'conversation-not-found' });
  });

  it('happy path: turns in order, thinking blocks hidden by default', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );

    // conversations:get reads the display event log (TASK-66). Seed two
    // turns into it.
    await seedWorkspaceJsonl(booted.harness, created.conversationId, [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        contentBlocks: [
          { type: 'thinking', thinking: 'pondering...', signature: 'sig123' },
          { type: 'redacted_thinking', data: 'opaque-bytes' },
          { type: 'text', text: 'hello!' },
        ],
      },
    ]);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${created.conversationId}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      conversation: { conversationId: string };
      turns: Array<{
        turnIndex: number;
        role: string;
        contentBlocks: Array<{ type: string }>;
      }>;
    };
    expect(body.conversation.conversationId).toBe(created.conversationId);
    expect(body.turns).toHaveLength(2);
    expect(body.turns[0]!.turnIndex).toBe(0);
    expect(body.turns[0]!.role).toBe('user');
    expect(body.turns[1]!.turnIndex).toBe(1);
    expect(body.turns[1]!.role).toBe('assistant');
    // thinking + redacted_thinking filtered out by default.
    const types = body.turns[1]!.contentBlocks.map((b) => b.type);
    expect(types).toEqual(['text']);
  });

  it('?includeThinking=true returns thinking blocks', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );
    // conversations:get reads the display event log (TASK-66). Seed one
    // assistant turn carrying thinking + redacted_thinking + text blocks.
    await seedWorkspaceJsonl(booted.harness, created.conversationId, [
      {
        role: 'assistant',
        contentBlocks: [
          { type: 'thinking', thinking: 'pondering...', signature: 'sig123' },
          { type: 'redacted_thinking', data: 'opaque-bytes' },
          { type: 'text', text: 'hello!' },
        ],
      },
    ]);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${created.conversationId}?includeThinking=true`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      turns: Array<{ contentBlocks: Array<{ type: string }> }>;
    };
    const types = body.turns[0]!.contentBlocks.map((b) => b.type);
    expect(types).toEqual(['thinking', 'redacted_thinking', 'text']);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/chat/conversations/:id — soft delete (Task 12).
// ---------------------------------------------------------------------------

describe('@ax/channel-web DELETE /api/chat/conversations/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    const booted = await boot({ user: null, allowedFor: new Set() });
    harnesses.push(booted.harness);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/cnv_anything`,
      { method: 'DELETE', headers: HEADERS_OK },
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });

  it('foreign-user: 204 idempotent (no existence leak) AND row preserved', async () => {
    // The conversations:delete plugin collapses foreign-user → not-found
    // (J5 — never confirms a row exists for somebody who doesn't own it).
    // The handler maps not-found → 204 (idempotent — same response shape
    // as already-deleted, so an attacker can't distinguish either case).
    // Critically the foreign user's DELETE MUST NOT actually tombstone
    // the owner's row — we assert that explicitly via direct SQL.
    const userA = { id: 'userA', isAdmin: false };
    const userB = { id: 'userB', isAdmin: false };

    const bootA = await boot({
      user: userA,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootA.harness);
    const created = await bootA.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      bootA.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt_test' },
    );
    await bootA.harness.close({ onError: () => {} });
    harnesses.pop();

    const bootB = await boot({
      user: userB,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootB.harness);

    const r = await fetch(
      `http://127.0.0.1:${bootB.port}/api/chat/conversations/${created.conversationId}`,
      { method: 'DELETE', headers: HEADERS_OK },
    );
    // 204 idempotent — same response shape as already-deleted, so the
    // wire-layer behavior gives no signal a foreign attacker can use.
    expect(r.status).toBe(204);

    // userA's row still alive — userB's foreign DELETE didn't tombstone it.
    const client = new (await import('pg')).default.Client({
      connectionString,
    });
    await client.connect();
    try {
      const out = await client.query(
        'SELECT deleted_at FROM conversations_v1_conversations WHERE conversation_id = $1',
        [created.conversationId],
      );
      expect(out.rows[0]!.deleted_at).toBeNull();
    } finally {
      await client.end().catch(() => {});
    }
  });

  it('happy path: 204, then GET → 404', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );

    const del = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${created.conversationId}`,
      { method: 'DELETE', headers: HEADERS_OK },
    );
    expect(del.status).toBe(204);

    const get = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${created.conversationId}`,
    );
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'conversation-not-found' });
  });

  it('idempotent on already-deleted: 204', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );
    await softDeleteConversation(created.conversationId);

    const del = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${created.conversationId}`,
      { method: 'DELETE', headers: HEADERS_OK },
    );
    expect(del.status).toBe(204);
  });

  it('CSRF foreign Origin → 403', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<
      ConvCreateInput,
      ConvCreateOutput
    >(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_test' },
    );

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${created.conversationId}`,
      {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
      },
    );
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error.startsWith('csrf-failed:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/chat/agents — list user's agents (Task 13).
// ---------------------------------------------------------------------------

describe('@ax/channel-web GET /api/chat/agents', () => {
  it('returns 401 when unauthenticated', async () => {
    const booted = await boot({ user: null, allowedFor: new Set() });
    harnesses.push(booted.harness);

    const r = await fetch(`http://127.0.0.1:${booted.port}/api/chat/agents`);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });

  it('lists user\'s agents only with display-relevant fields', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
      listFor: {
        userA: [
          {
            id: 'agt_alpha',
            displayName: 'Alpha Agent',
            visibility: 'personal',
          },
          {
            id: 'agt_beta',
            displayName: 'Beta Agent',
            visibility: 'team',
          },
        ],
        userB: [
          {
            id: 'agt_other',
            displayName: 'Should Not Appear',
            visibility: 'personal',
          },
        ],
      },
    });
    harnesses.push(booted.harness);

    const r = await fetch(`http://127.0.0.1:${booted.port}/api/chat/agents`);
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{
      agentId: string;
      displayName: string;
      visibility: string;
    }>;
    expect(list).toEqual([
      {
        agentId: 'agt_alpha',
        displayName: 'Alpha Agent',
        visibility: 'personal',
      },
      {
        agentId: 'agt_beta',
        displayName: 'Beta Agent',
        visibility: 'team',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/chat/messages — attachment_ref handling (Phase 3, Task 4).
//
// The wire schema accepts `attachment_ref` blocks. The handler commits each
// one via `attachments:commit` (which validates ownership, applies the
// bytes to the workspace, and returns a stable workspace path), then
// replaces the ref with a canonical `attachment` block BEFORE dispatching
// agent:invoke. Failure modes:
//
//   - attachmentId not found in temp store → 400 attachment-not-found
//   - attachmentId belongs to a different user → 400 attachment-foreign-user
//   - cumulative attachment bytes > 100 MiB → 413 attachment-total-too-large
//
// Atomicity: commits are per-row atomic; a partial-fail leaves the
// successful commits orphaned in the workspace (the temp janitor reaps
// stale temps; the orphan blobs sit until the next git GC). Acceptable
// per the Phase-3 design.
// ---------------------------------------------------------------------------

describe('POST /api/chat/messages — attachment_ref handling', () => {
  // Helper: build a user ctx for direct `attachments:store-temp` calls
  // (we pre-stage the temp row via the bus, not via POST /api/attachments).
  function userCtx(userId: string): AgentContext {
    return makeAgentContext({
      sessionId: 'test-store-temp',
      agentId: 'agt_test',
      userId,
    });
  }

  it('commits attachment_ref blocks and dispatches agent:invoke with attachment blocks', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
      includeAttachments: true,
    });
    harnesses.push(booted.harness);

    // Pre-stage a temp via attachments:store-temp.
    const stored = await booted.harness.bus.call<
      unknown,
      { attachmentId: string; sizeBytes: number; expiresAt: string }
    >('attachments:store-temp', userCtx('userA'), {
      bytes: Buffer.from('hello pdf bytes'),
      displayName: 'note.pdf',
      mediaType: 'application/pdf',
    });

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: [
        { type: 'text', text: 'hi here is a doc' },
        { type: 'attachment_ref', attachmentId: stored.attachmentId },
      ],
    });
    expect(r.status).toBe(202);

    // agent:invoke dispatch is async — wait a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(booted.chatRunCaptures).toHaveLength(1);
    const cap = booted.chatRunCaptures[0]!;
    const msg = cap.input.message;
    expect(msg.role).toBe('user');
    // `content` carries the typed text; `contentBlocks` carries the
    // committed attachment only. Including the text-block here as well
    // would duplicate the user's prompt once the runner prepends `content`.
    expect(msg.content).toBe('hi here is a doc');
    expect(msg.contentBlocks).toBeTruthy();
    expect(msg.contentBlocks).toHaveLength(1);
    const att = msg.contentBlocks![0]!;
    expect(att.type).toBe('attachment');
    expect(att.mediaType).toBe('application/pdf');
    expect(att.displayName).toBe('note.pdf');
    expect(typeof att.path).toBe('string');
    // Path shape: .ax/uploads/<conversationId>/<turnId>/<sanitized-filename>
    // — sanitized filename has an 8-hex prefix per
    // `sanitizeFilenameComponent` in @ax/attachments.
    expect(att.path).toMatch(
      /^\.ax\/uploads\/[^/]+\/[^/]+\/[0-9a-f]{8}__note\.pdf$/,
    );
    expect(typeof msg.turnId).toBe('string');
  });

  it('returns 400 attachment-not-found for an unknown attachmentId', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
      includeAttachments: true,
    });
    harnesses.push(booted.harness);

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: [
        { type: 'attachment_ref', attachmentId: 'does-not-exist' },
      ],
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'attachment-not-found' });
    // No agent:invoke fired.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(booted.chatRunCaptures).toHaveLength(0);
  });

  it('returns 400 attachment-foreign-user for an attachmentId belonging to another user', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
      includeAttachments: true,
    });
    harnesses.push(booted.harness);

    // userB stores a temp; userA tries to redeem it.
    const stored = await booted.harness.bus.call<
      unknown,
      { attachmentId: string }
    >('attachments:store-temp', userCtx('userB'), {
      bytes: Buffer.from('foreign'),
      displayName: 'x.txt',
      mediaType: 'text/plain',
    });

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: [
        { type: 'attachment_ref', attachmentId: stored.attachmentId },
      ],
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'attachment-foreign-user' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(booted.chatRunCaptures).toHaveLength(0);
  });

  it('returns 413 attachment-total-too-large when cumulative bytes exceed 100 MiB', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
      includeAttachments: true,
      // Raise per-file cap so each 60 MiB upload passes store-temp;
      // also raise per-user pending quota above 120 MiB so two 60 MiB
      // temps can co-exist before redemption.
      attachmentsConfig: {
        maxFileBytes: 60 * 1024 * 1024,
        maxPendingBytesPerUser: 200 * 1024 * 1024,
      },
    });
    harnesses.push(booted.harness);

    // Two 60 MiB pretend uploads — sum is 120 MiB > 100 MiB cap.
    const big1 = Buffer.alloc(60 * 1024 * 1024, 0xab);
    const big2 = Buffer.alloc(60 * 1024 * 1024, 0xcd);
    const s1 = await booted.harness.bus.call<
      unknown,
      { attachmentId: string }
    >('attachments:store-temp', userCtx('userA'), {
      bytes: big1,
      displayName: 'a.bin',
      mediaType: 'application/octet-stream',
    });
    const s2 = await booted.harness.bus.call<
      unknown,
      { attachmentId: string }
    >('attachments:store-temp', userCtx('userA'), {
      bytes: big2,
      displayName: 'b.bin',
      mediaType: 'application/octet-stream',
    });

    const r = await postMessage(booted.port, {
      conversationId: null,
      agentId: 'agt_test',
      contentBlocks: [
        { type: 'attachment_ref', attachmentId: s1.attachmentId },
        { type: 'attachment_ref', attachmentId: s2.attachmentId },
      ],
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'attachment-total-too-large' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(booted.chatRunCaptures).toHaveLength(0);
    // This case allocates and stores two real 60 MiB buffers (120 MiB total)
    // through the SQLite-backed temp store, then POSTs both through a full HTTP
    // harness. That throughput sits right at vitest's 5 s default timeout and
    // flaked at 5187 ms on a loaded CI runner. Give it explicit headroom so the
    // deadline tracks the work, not the runner's mood. (Every other test here
    // fits the default — only the 120 MiB payload needs this.)
  }, 30_000);
});
