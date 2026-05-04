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
import { PluginError, type AgentContext, type Plugin } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createConversationsPlugin } from '@ax/conversations';
import type {
  CreateInput as ConvCreateInput,
  CreateOutput as ConvCreateOutput,
} from '@ax/conversations';
import {
  createMockWorkspacePlugin,
  createTestHarness,
  type TestHarness,
} from '@ax/test-harness';
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
  input: { message: { role: string; content: string } };
}

function chatRunMockPlugin(captures: ChatRunCapture[]): Plugin {
  return {
    manifest: {
      name: 'mock-chat-run',
      version: '0.0.0',
      registers: ['agent:invoke'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
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

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  if (container) await container.stop();
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
}

interface BootResult {
  harness: TestHarness;
  port: number;
  http: HttpServerPlugin;
  chatRunCaptures: ChatRunCapture[];
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
  const harness = await createTestHarness({
    plugins: [
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
      createMockWorkspacePlugin(),
      createConversationsPlugin(),
      chatRunMockPlugin(chatRunCaptures),
      createChannelWebServerPlugin({}),
    ],
  });
  return { harness, port: http.boundPort(), http, chatRunCaptures };
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
    expect(cap.input.message).toEqual({ role: 'user', content: 'hello there' });

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
});

// ---------------------------------------------------------------------------
// Helpers shared across the read+delete describes.
// ---------------------------------------------------------------------------

// Phase D: seed the workspace's runner-native jsonl path with synthetic
// SDK lines so conversations:get can return turns. Pairs with
// `bindRunnerSession` below — both must run for the round-trip read to
// see anything.
async function seedWorkspaceJsonl(
  harness: TestHarness,
  runnerSessionId: string,
  turns: Array<{
    role: 'user' | 'assistant';
    contentBlocks?: Array<{ type: string; [k: string]: unknown }>;
    /** raw string `content` instead of structured blocks (user role only). */
    content?: string;
  }>,
): Promise<void> {
  const lines = turns.map((t, i) => {
    const ts = new Date(2026, 3, 29, 12, 0, i).toISOString();
    if (t.role === 'user') {
      return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: t.content ?? t.contentBlocks ?? '' },
        uuid: `u-${i}`,
        timestamp: ts,
      });
    }
    return JSON.stringify({
      type: 'assistant',
      message: {
        id: `m-${i}`,
        role: 'assistant',
        content: t.contentBlocks ?? [],
      },
      uuid: `u-${i}`,
      timestamp: ts,
    });
  });
  const bytes = new TextEncoder().encode(lines.join('\n'));
  const path = `.claude/projects/-permanent/${runnerSessionId}.jsonl`;
  await harness.bus.call(
    'workspace:apply',
    harness.ctx({ userId: 'system' }),
    {
      changes: [{ path, kind: 'put', content: bytes }],
      parent: null,
      reason: 'seed-jsonl',
    },
  );
}

// Phase D: bind `runner_session_id` so conversations:get hits the
// workspace lookup path. Direct SQL — Phase B's
// `conversations:store-runner-session` hook ships in the same plugin,
// but raw SQL is the simplest fixture.
async function bindRunnerSession(
  conversationId: string,
  runnerSessionId: string,
): Promise<void> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'UPDATE conversations_v1_conversations SET runner_session_id = $1, updated_at = NOW() WHERE conversation_id = $2',
      [runnerSessionId, conversationId],
    );
  } finally {
    await client.end().catch(() => {});
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

    // Phase D: conversations:get reads the runner-native jsonl from
    // the workspace. Seed it via the mock workspace + bind the
    // runner_session_id on the row.
    const sessId = 'sess-test-1';
    await seedWorkspaceJsonl(booted.harness, sessId, [
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
    await bindRunnerSession(created.conversationId, sessId);

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
    // Phase D: seed the runner-native jsonl in the mock workspace +
    // bind runner_session_id on the row.
    const sessId = 'sess-test-thinking';
    await seedWorkspaceJsonl(booted.harness, sessId, [
      {
        role: 'assistant',
        contentBlocks: [
          { type: 'thinking', thinking: 'pondering...', signature: 'sig123' },
          { type: 'redacted_thinking', data: 'opaque-bytes' },
          { type: 'text', text: 'hello!' },
        ],
      },
    ]);
    await bindRunnerSession(created.conversationId, sessId);

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
