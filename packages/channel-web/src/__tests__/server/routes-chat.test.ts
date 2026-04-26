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
} from 'vitest';
import { PluginError, type ChatContext, type Plugin } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createConversationsPlugin } from '@ax/conversations';
import type {
  CreateInput as ConvCreateInput,
  CreateOutput as ConvCreateOutput,
} from '@ax/conversations';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createChannelWebServerPlugin } from '../../server/plugin';

// ---------------------------------------------------------------------------
// POST /api/chat/messages — chat-flow producer (Task 9 of Week 10–12).
//
// Same testcontainers-postgres harness as stream-e2e.test.ts: real
// @ax/conversations + http-server + channel-web; auth, agents, and chat:run
// are mocked. The chat:run mock captures the dispatched ctx so we can
// assert it carries the server-minted reqId + the right conversationId.
//
// Cases:
//   1. Anonymous → 401
//   2. Foreign agent → 403
//   3. Agent not-found → 404 (agent-not-found)
//   4. New conversation happy path → 202 + conversation row + chat:run dispatch
//   5. Existing conversation happy path → no new conversation row, turn appended
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
}): Plugin {
  return {
    manifest: {
      name: 'mock-agents',
      version: '0.0.0',
      registers: ['agents:resolve'],
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
    },
  };
}

interface ChatRunCapture {
  ctx: ChatContext;
  input: { message: { role: string; content: string } };
}

function chatRunMockPlugin(captures: ChatRunCapture[]): Plugin {
  return {
    manifest: {
      name: 'mock-chat-run',
      version: '0.0.0',
      registers: ['chat:run'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService(
        'chat:run',
        'mock-chat-run',
        async (ctx, input: unknown) => {
          captures.push({
            ctx,
            input: input as { message: { role: string; content: string } },
          });
          // Mimic chat:run's contract — return a ChatOutcome shape; the
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
      }),
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

async function listTurns(
  conversationId: string,
): Promise<Array<{ role: string; turn_index: number }>> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    const r = await client.query(
      'SELECT role, turn_index FROM conversations_v1_turns WHERE conversation_id = $1 ORDER BY turn_index ASC',
      [conversationId],
    );
    return r.rows as Array<{ role: string; turn_index: number }>;
  } finally {
    await client.end().catch(() => {});
  }
}

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

  it('4. new conversation happy path: 202, row created, user turn appended, chat:run dispatched with server-minted reqId', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

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
    const turns = await listTurns(body.conversationId);
    expect(turns).toEqual([{ role: 'user', turn_index: 0 }]);

    // chat:run dispatch — give the void-returning call a tick to flush.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(booted.chatRunCaptures).toHaveLength(1);
    const cap = booted.chatRunCaptures[0]!;
    expect(cap.ctx.reqId).toBe(body.reqId);
    expect(cap.ctx.conversationId).toBe(body.conversationId);
    expect(cap.ctx.userId).toBe('userA');
    expect(cap.ctx.agentId).toBe('agt_test');
    // chat:run's first-turn message — extracted from the first text block.
    expect(cap.input.message).toEqual({ role: 'user', content: 'hello there' });
  });

  it('5. existing conversation: turn appended, no new conversation created', async () => {
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
    const turns = await listTurns(created.conversationId);
    expect(turns).toEqual([{ role: 'user', turn_index: 0 }]);
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
    // No turn appended.
    const turns = await listTurns(created.conversationId);
    expect(turns).toHaveLength(0);
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
    // userA's conversation has no turns.
    const turns = await listTurns(created.conversationId);
    expect(turns).toHaveLength(0);
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
});
