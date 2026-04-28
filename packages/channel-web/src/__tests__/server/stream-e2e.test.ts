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
import type { CreateInput, CreateOutput } from '@ax/conversations';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createChannelWebServerPlugin } from '../../server/plugin';

// ---------------------------------------------------------------------------
// End-to-end streaming test: chat:stream-chunk → bus → channel-web SSE
// handler → real HTTP listener → fetch consumer.
//
// Tasks 9–13 will land the chat-flow HTTP endpoints (POST /api/chat/messages
// mints a reqId and dispatches agent:invoke). Task 8 is sequenced BEFORE those
// endpoints, so this e2e SHORT-CIRCUITS the POST handler by:
//
//   1. Creating a real conversation through @ax/conversations (testcontainers
//      postgres).
//   2. Setting `active_req_id` directly via raw SQL (mirroring the acl tests
//      until Task 14 ships `conversations:bind-session`).
//   3. Subscribing to the SSE endpoint via fetch.
//   4. Manually firing chat:stream-chunk + chat:turn-end on the bus.
//   5. Asserting the SSE consumer receives the expected frames.
//
// We keep auth + agents mocked. The point of this test is the FULL streaming
// chain — auth's wire integration is covered by sse.test.ts and the auth-oidc
// suite. Substituting real auth here would gain nothing and add a lot of
// HMAC/cookie setup.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);

function authMockPlugin(args: {
  user: { id: string; isAdmin: boolean };
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
        return { user: args.user };
      });
    },
  };
}

/**
 * Stub for `agent:invoke`. The channel-web plugin's manifest declares it as a
 * hard call (Task 9 — POST /api/chat/messages); this suite doesn't
 * exercise the chat-flow producer endpoint, so a no-op registration is
 * enough to satisfy the bootstrap verifyCalls walk.
 */
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
  // The conversations plugin AND the SSE handler both call
  // agents:resolve(agentId, userId). The mock allows resolution only when
  // the userId is in `allowedFor`; otherwise it throws 'forbidden'. This
  // gives us cross-tenant rejection without a second user owning anything.
  //
  // Also registers `agents:list-for-user` as a no-op (returns empty list).
  // The channel-web plugin's manifest declares it as a hard call (Task 13
  // — GET /api/chat/agents); this suite doesn't exercise that endpoint,
  // but the bootstrap verifyCalls walk requires the registration.
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
          const { userId, agentId } = input as { userId: string; agentId: string };
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
  user: { id: string; isAdmin: boolean };
  /** Users whom agents:resolve will accept. */
  allowedFor: Set<string>;
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
    allowedOrigins: [],
  });
  const harness = await createTestHarness({
    plugins: [
      http,
      createDatabasePostgresPlugin({ connectionString }),
      authMockPlugin({ user: args.user }),
      agentsMockPlugin({ allowedFor: args.allowedFor }),
      createConversationsPlugin(),
      chatRunMockPlugin(),
      createChannelWebServerPlugin({}),
    ],
  });
  return { harness, port: http.boundPort(), http };
}

/**
 * Fixture an `active_req_id` directly via the store. Mirrors
 * `setReqIdViaStore` in conversations/__tests__/acl.test.ts — once Task 14
 * ships `conversations:bind-session` this becomes the production writer,
 * but for now raw SQL through pg.Client is the simplest fixture.
 */
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

/**
 * Read SSE frames from a Response body until `predicate` returns true OR
 * the stream ends. Returns the accumulated UTF-8 text. Bounded read budget
 * (1 MiB) so a runaway stream can't OOM the test process.
 */
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

describe('@ax/channel-web stream e2e (chat:stream-chunk → SSE)', () => {
  it('streams chunks end-to-end then closes on turn-end', async () => {
    const userA = { id: 'userA', isAdmin: false };
    const booted = await boot({
      user: userA,
      allowedFor: new Set(['userA']),
    });
    harnesses.push(booted.harness);

    // Create a real conversation through the conversations plugin so the
    // postgres row exists with the right user_id + agent_id. The
    // conversations:create hook calls agents:resolve under the hood, which
    // our mock allows for userA.
    const created = await booted.harness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      booted.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt_test' },
    );
    const conversationId = created.conversationId;

    // Bind the in-flight reqId via raw SQL. Once Task 14 lands, this
    // becomes a `conversations:bind-session` call.
    const reqId = 'rE1';
    await setReqIdViaStore(conversationId, reqId);

    // Open the SSE stream on a real fetch.
    const ac = new AbortController();
    const r = await fetch(
      `http://127.0.0.1:${booted.port}/api/chat/stream/${reqId}`,
      { signal: ac.signal },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);

    // Fire two chunks + a turn-end. We do this from a separate
    // microtask so we don't deadlock on the read; a small delay gives
    // the SSE handler time to attach its per-connection subscriber
    // BEFORE we fire (otherwise the live tail wouldn't see the chunk —
    // though the buffer-fill subscriber would still capture it for
    // replay, the test is more deterministic if we fire after attach).
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const ctx = booted.harness.ctx({
        userId: userA.id,
        conversationId,
      });
      await booted.harness.bus.fire('chat:stream-chunk', ctx, {
        reqId,
        text: 'hello',
        kind: 'text',
      });
      await booted.harness.bus.fire('chat:stream-chunk', ctx, {
        reqId,
        text: ' world',
        kind: 'text',
      });
      // Turn-end: the SSE handler's per-connection subscriber filters by
      // ctx.conversationId. The conversations plugin's chat:turn-end
      // subscriber only writes to the DB when contentBlocks are present;
      // we omit them so this turn-end is a pure SSE-close signal.
      await booted.harness.bus.fire('chat:turn-end', ctx, {
        reqId,
        reason: 'complete',
      });
    })();

    const received = await readUntil(r, (s) => s.includes('"done":true'));

    // Two chunk frames + one done frame, in order.
    expect(received).toContain(
      'data: {"reqId":"rE1","text":"hello","kind":"text"}\n\n',
    );
    expect(received).toContain(
      'data: {"reqId":"rE1","text":" world","kind":"text"}\n\n',
    );
    expect(received).toContain('data: {"reqId":"rE1","done":true}\n\n');

    // Order: hello < world < done. (indexOf returns first byte of match.)
    const helloIdx = received.indexOf('"text":"hello"');
    const worldIdx = received.indexOf('"text":" world"');
    const doneIdx = received.indexOf('"done":true');
    expect(helloIdx).toBeGreaterThan(-1);
    expect(worldIdx).toBeGreaterThan(helloIdx);
    expect(doneIdx).toBeGreaterThan(worldIdx);

    ac.abort();
  });

  it('rejects cross-tenant SSE with 404 (J9)', async () => {
    // userA owns the conversation; userB is the caller. agents:resolve
    // permits BOTH users (so we know the rejection comes from the
    // conversations:get-by-req-id user_id filter, not the agents gate).
    const userA = { id: 'userA', isAdmin: false };
    const userB = { id: 'userB', isAdmin: false };

    // First boot: create the conversation as userA, set its reqId. We
    // shut this harness down so we can boot a fresh one with userB as
    // the auth principal. The postgres row persists across the harness
    // restart because we don't drop tables until afterEach.
    const bootA = await boot({
      user: userA,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootA.harness);
    const created = await bootA.harness.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      bootA.harness.ctx({ userId: userA.id }),
      { userId: userA.id, agentId: 'agt_test' },
    );
    const reqId = 'rE-secret';
    await setReqIdViaStore(created.conversationId, reqId);
    await bootA.harness.close({ onError: () => {} });
    // Pop bootA so afterEach doesn't double-close it.
    harnesses.pop();

    // Second boot: userB is now the auth principal. The same postgres
    // row from above is still there (we share `connectionString`).
    const bootB = await boot({
      user: userB,
      allowedFor: new Set(['userA', 'userB']),
    });
    harnesses.push(bootB.harness);

    const r = await fetch(
      `http://127.0.0.1:${bootB.port}/api/chat/stream/${reqId}`,
    );
    // 404 — NOT 403. We collapse forbidden + not-found at the SSE
    // handler boundary so callers can't tell "your reqId doesn't exist"
    // from "you don't own it" (J9).
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('not-found');
  });
});
