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
import { PluginError, type Plugin } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createConversationsPlugin } from '@ax/conversations';
import type {
  CreateInput,
  CreateOutput,
} from '@ax/conversations';
import {
  createMockWorkspacePlugin,
  createTestHarness,
  type TestHarness,
} from '@ax/test-harness';
import { createChannelWebServerPlugin } from '../../server/plugin';

// ---------------------------------------------------------------------------
// Week 10-12 acceptance test: 7 user-flow scenarios + 3 hardening checks.
//
// Scope (Task 24): cover the user-facing chat flow (POST messages, SSE
// stream, conversation reload, multi-tab, soft delete) plus three security
// hardening probes (reqId spoof, foreign Origin, cookie tamper).
//
// Strategy: COPY the harness from stream-e2e.test.ts (boot, mocks,
// readUntil, setReqIdViaStore, afterEach). Each scenario is a tight 5-30
// line `it()` body. Scenarios that require real LLM/workspace are
// expressed as proxy tests via direct bus.fire (the spirit of the
// behavior, not the full producer chain).
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
      bus.registerService(
        'auth:require-user',
        'mock-auth',
        async (_ctx, input: unknown) => {
          // Cookie-tamper proxy: a synthetic header signals a forged or
          // otherwise rejected cookie. The real cookie-tamper test lives
          // in @ax/auth-oidc; this proxy exercises the channel-web 401
          // path the auth-oidc plugin would trigger in production.
          const { req } = input as {
            req: { headers: Record<string, string> };
          };
          if (req?.headers?.['x-test-tampered'] === 'yes') {
            throw new PluginError({
              code: 'unauthenticated',
              plugin: 'mock-auth',
              message: 'cookie tamper',
            });
          }
          if (args.user === null) {
            throw new PluginError({
              code: 'unauthenticated',
              plugin: 'mock-auth',
              message: 'no session',
            });
          }
          return { user: args.user };
        },
      );
    },
  };
}

function chatRunMockPlugin(): Plugin {
  return {
    manifest: {
      name: 'mock-chat-run',
      version: '0.0.0',
      registers: ['agent:invoke'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('agent:invoke', 'mock-chat-run', async () => {
        return { kind: 'complete', messages: [] };
      });
    },
  };
}

function agentsMockPlugin(args: { allowedFor: Set<string> }): Plugin {
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
          const { userId, agentId } = input as {
            userId: string;
            agentId: string;
          };
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
      bus.registerService('agents:list-for-user', 'mock-agents', async () => {
        return { agents: [] };
      });
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
  /** Override allowedOrigins on the http-server (default: [ALLOWED_ORIGIN]). */
  allowedOrigins?: readonly string[];
}

async function boot(args: BootArgs): Promise<{
  harness: TestHarness;
  port: number;
  http: HttpServerPlugin;
}> {
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: args.allowedOrigins ?? [ALLOWED_ORIGIN],
  });
  const harness = await createTestHarness({
    plugins: [
      http,
      createDatabasePostgresPlugin({ connectionString }),
      authMockPlugin({ user: args.user }),
      agentsMockPlugin({ allowedFor: args.allowedFor }),
      // Phase D — conversations plugin declares workspace:list/read
      // calls. Empty mock workspace satisfies bootstrap.
      createMockWorkspacePlugin(),
      createConversationsPlugin(),
      chatRunMockPlugin(),
      createChannelWebServerPlugin({}),
    ],
  });
  return { harness, port: http.boundPort(), http };
}

async function setReqIdViaStore(
  conversationId: string,
  reqId: string | null,
): Promise<void> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'UPDATE conversations_v1_conversations SET active_req_id = $1, updated_at = NOW() WHERE conversation_id = $2',
      [reqId, conversationId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

const harnesses: TestHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

async function readUntil(
  res: Response,
  predicate: (received: string) => boolean,
  opts: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  let bytes = 0;
  try {
    while (!predicate(received)) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`SSE read exceeded ${maxBytes} bytes`);
      }
      received += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already aborted / closed
    }
  }
  return received;
}

describe('Week 10-12 acceptance', () => {
  // -------------------------------------------------------------------------
  // Scenario 1 — streaming response (POST → 202 → SSE → chunk frame).
  // -------------------------------------------------------------------------
  it('1. streaming response: POST mints reqId, SSE delivers chunk', async () => {
    const userA = { id: 'userA', isAdmin: false };
    const booted = await boot({ user: userA, allowedFor: new Set(['userA']) });
    harnesses.push(booted.harness);

    const post = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/messages`,
      {
        method: 'POST',
        headers: HEADERS_OK,
        body: JSON.stringify({
          conversationId: null,
          agentId: 'agt',
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      },
    );
    expect(post.status).toBe(202);
    const { conversationId, reqId } = (await post.json()) as {
      conversationId: string;
      reqId: string;
    };

    // POST handler doesn't bind reqId on the row (Task 14 wires
    // bind-session via chat:start). Bind it by hand so the SSE handler's
    // conversations:get-by-req-id can resolve.
    await setReqIdViaStore(conversationId, reqId);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/stream/${reqId}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const ctx = booted.harness.ctx({ userId: userA.id, conversationId });
      await booted.harness.bus.fire('chat:stream-chunk', ctx, {
        reqId,
        text: 'hello',
        kind: 'text',
      });
      await booted.harness.bus.fire('chat:turn-end', ctx, {
        reqId,
        reason: 'complete',
      });
    })();

    const received = await readUntil(r, (s) => s.includes('"done":true'));
    expect(received).toContain(`"text":"hello"`);
    expect(received).toContain('"done":true');
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — reload mid-conversation: a fresh GET sees persisted turns.
  // -------------------------------------------------------------------------
  it('2. reload mid-conversation: GET returns turns in order', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt' },
    );
    const cid = created.conversationId;
    // Phase D: GET reads from the runner's native jsonl in the
    // workspace, not conversation_turns. Seed the mock workspace with
    // a synthetic SDK transcript and bind the runner_session_id on the
    // row so the lookup hits.
    const sessId = 'sess-reload-1';
    const lines = [
      ['user', 'one'],
      ['assistant', 'two'],
      ['user', 'three'],
    ].map(([role, text], i) => {
      const ts = new Date(2026, 3, 29, 12, 0, i).toISOString();
      if (role === 'user') {
        return JSON.stringify({
          type: 'user',
          message: { role: 'user', content: text },
          uuid: `u-${i}`,
          timestamp: ts,
        });
      }
      return JSON.stringify({
        type: 'assistant',
        message: {
          id: `m-${i}`,
          role: 'assistant',
          content: [{ type: 'text', text }],
        },
        uuid: `u-${i}`,
        timestamp: ts,
      });
    });
    const bytes = new TextEncoder().encode(lines.join('\n'));
    await booted.harness.bus.call(
      'workspace:apply',
      booted.harness.ctx({ userId: 'system' }),
      {
        changes: [
          {
            path: `.claude/projects/-permanent/${sessId}.jsonl`,
            kind: 'put',
            content: bytes,
          },
        ],
        parent: null,
        reason: 'seed-jsonl',
      },
    );
    const pgClient = new (await import('pg')).default.Client({
      connectionString,
    });
    await pgClient.connect();
    try {
      await pgClient.query(
        'UPDATE conversations_v1_conversations SET runner_session_id = $1, updated_at = NOW() WHERE conversation_id = $2',
        [sessId, cid],
      );
    } finally {
      await pgClient.end().catch(() => {});
    }

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${cid}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      turns: Array<{
        turnIndex: number;
        role: string;
        contentBlocks: Array<{ type: string; text: string }>;
      }>;
    };
    expect(body.turns.map((t) => t.contentBlocks[0]!.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(body.turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — multi-tab: two SSE consumers on the same reqId both receive
  // the same chunk.
  // -------------------------------------------------------------------------
  it('3. multi-tab: two SSE listeners on the same reqId both receive chunks', async () => {
    const userA = { id: 'userA', isAdmin: false };
    const booted = await boot({ user: userA, allowedFor: new Set(['userA']) });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      booted.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt' },
    );
    const reqId = 'rMulti';
    await setReqIdViaStore(created.conversationId, reqId);

    const [tab1, tab2] = await Promise.all([
      fetch(`http://127.0.0.1:${booted.port}/api/chat/stream/${reqId}`),
      fetch(`http://127.0.0.1:${booted.port}/api/chat/stream/${reqId}`),
    ]);
    expect(tab1.status).toBe(200);
    expect(tab2.status).toBe(200);

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const ctx = booted.harness.ctx({
        userId: userA.id,
        conversationId: created.conversationId,
      });
      await booted.harness.bus.fire('chat:stream-chunk', ctx, {
        reqId,
        text: 'broadcast',
        kind: 'text',
      });
      await booted.harness.bus.fire('chat:turn-end', ctx, {
        reqId,
        reason: 'complete',
      });
    })();

    const [r1, r2] = await Promise.all([
      readUntil(tab1, (s) => s.includes('"done":true')),
      readUntil(tab2, (s) => s.includes('"done":true')),
    ]);
    expect(r1).toContain('"text":"broadcast"');
    expect(r2).toContain('"text":"broadcast"');
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — team agent: a teammate can read a sibling's conversation.
  //
  // Documentation-as-test (Tier C): the conversations store today scopes
  // every read by user_id (store.ts `scopedConversations` / `getById`
  // filter), so a teammate GET returns 404 even when agents:resolve allows
  // both users. Delivering "team-shared conversations" is a future slice
  // (would require a `conversations:get-for-team` hook OR a visibility
  // column on the row). We assert today's behavior: foreign user → 404.
  // When team-sharing lands, this test gets the inverse expectation.
  // -------------------------------------------------------------------------
  it('4. team agent: foreign-user read currently → 404 (team-sharing TBD)', async () => {
    const userA = { id: 'userA', isAdmin: false };
    const userB = { id: 'userB', isAdmin: false };

    const bootA = await boot({
      user: userA,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootA.harness);
    const created = await bootA.harness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      bootA.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt_team' },
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
    // TODO(team-sharing): expect 200 with the conversation once the
    // store grows a per-team visibility check.
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'conversation-not-found' });
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — non-member rejection: unrelated user → 404 (existence-leak
  // prevention). Body is exactly `{error: 'conversation-not-found'}`.
  // -------------------------------------------------------------------------
  it('5. non-member rejection: foreign user → 404 with no leak', async () => {
    const userA = { id: 'userA', isAdmin: false };
    const userC = { id: 'userC', isAdmin: false };

    const bootA = await boot({ user: userA, allowedFor: new Set(['userA']) });
    harnesses.push(bootA.harness);
    const created = await bootA.harness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      bootA.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt' },
    );
    await bootA.harness.close({ onError: () => {} });
    harnesses.pop();

    const bootC = await boot({ user: userC, allowedFor: new Set(['userC']) });
    harnesses.push(bootC.harness);

    const r = await fetch(
      `http://127.0.0.1:${bootC.port}/api/chat/conversations/${created.conversationId}`,
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toEqual({ error: 'conversation-not-found' });
  });

  // -------------------------------------------------------------------------
  // Scenario 6 — soft delete: DELETE → GET 404 → list omits.
  // -------------------------------------------------------------------------
  it('6. soft delete: DELETE 204 → GET 404 → list excludes', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      booted.harness.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt' },
    );
    const cid = created.conversationId;

    const del = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${cid}`,
      { method: 'DELETE', headers: HEADERS_OK },
    );
    expect(del.status).toBe(204);

    const get = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations/${cid}`,
    );
    expect(get.status).toBe(404);

    const list = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/conversations`,
    );
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<{ conversationId: string }>;
    expect(items.find((c) => c.conversationId === cid)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — mid-tool-call reload: chunks fire BEFORE the SSE listener
  // attaches, then the listener replays them via the host-side ring buffer
  // and live-tails the next chunk. This is the spirit of "browser refresh
  // mid-stream reattaches."
  // -------------------------------------------------------------------------
  it('7. mid-tool-call reload: ring buffer replay + live tail', async () => {
    const userA = { id: 'userA', isAdmin: false };
    const booted = await boot({ user: userA, allowedFor: new Set(['userA']) });
    harnesses.push(booted.harness);

    const created = await booted.harness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      booted.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt' },
    );
    const reqId = 'rReplay';
    await setReqIdViaStore(created.conversationId, reqId);

    // Pre-fire 3 chunks BEFORE any SSE listener exists. The host-side
    // buffer-fill subscriber captures them.
    const ctx = booted.harness.ctx({
      userId: userA.id,
      conversationId: created.conversationId,
    });
    for (const text of ['alpha', 'beta', 'gamma']) {
      await booted.harness.bus.fire('chat:stream-chunk', ctx, {
        reqId,
        text,
        kind: 'text',
      });
    }

    // NOW open the SSE stream — the handler drains the buffer first.
    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/stream/${reqId}`,
    );
    expect(r.status).toBe(200);

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await booted.harness.bus.fire('chat:stream-chunk', ctx, {
        reqId,
        text: 'delta',
        kind: 'text',
      });
      await booted.harness.bus.fire('chat:turn-end', ctx, {
        reqId,
        reason: 'complete',
      });
    })();

    const received = await readUntil(r, (s) => s.includes('"done":true'));
    // All 3 backlog chunks + 1 live-tail chunk in order.
    const aIdx = received.indexOf('"text":"alpha"');
    const bIdx = received.indexOf('"text":"beta"');
    const gIdx = received.indexOf('"text":"gamma"');
    const dIdx = received.indexOf('"text":"delta"');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(gIdx).toBeGreaterThan(bIdx);
    expect(dIdx).toBeGreaterThan(gIdx);
  });

  // -------------------------------------------------------------------------
  // Hardening H1 — reqId spoof: an unbound reqId must not stream.
  // -------------------------------------------------------------------------
  it('H1. reqId spoof: random unbound reqId → 404', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const spoof = randomBytes(16).toString('hex'); // 32 hex chars
    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/stream/${spoof}`,
    );
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not-found' });
  });

  // -------------------------------------------------------------------------
  // Hardening H2 — Origin spoof: foreign Origin without bypass → 403.
  // -------------------------------------------------------------------------
  it('H2. Origin spoof: foreign Origin → 403', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
      // Restrict allowedOrigins to a single origin we will NOT send.
    });
    harnesses.push(booted.harness);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
        body: JSON.stringify({
          conversationId: null,
          agentId: 'agt',
          contentBlocks: [{ type: 'text', text: 'spoof' }],
        }),
      },
    );
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error.startsWith('csrf-failed:')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Hardening H3 — cookie tamper proxy: synthetic header drives the
  // mock-auth into the same 401 path that auth-oidc would produce on a
  // tampered HMAC. Real cookie-tamper flow is covered by auth-oidc's own
  // suite (Week 9.5).
  // -------------------------------------------------------------------------
  it('H3. cookie tamper (proxy): tampered header → 401', async () => {
    const booted = await boot({
      user: { id: 'userA', isAdmin: false },
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/messages`,
      {
        method: 'POST',
        headers: {
          ...HEADERS_OK,
          'x-test-tampered': 'yes',
        },
        body: JSON.stringify({
          conversationId: null,
          agentId: 'agt',
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      },
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });
});
