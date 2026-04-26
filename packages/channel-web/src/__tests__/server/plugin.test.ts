// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginError, type Plugin } from '@ax/core';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createChannelWebServerPlugin } from '../../server/plugin';

// ---------------------------------------------------------------------------
// Integration test for the channel-web server plugin shell.
//
// Uses real @ax/http-server (no mocks) + mocked auth/conversations/agents
// service hooks. We open a real fetch() to /api/chat/stream/:reqId and
// drive the bus from outside; the SSE wire shape (data: {…}\n\n) is
// asserted exactly.
//
// We don't testcontainer postgres here — the hook surface (conversations:
// get-by-req-id) is mocked. The conversations side already has a
// testcontainer integration test for the hook itself.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);

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

function conversationsMockPlugin(args: {
  byReqId: Map<
    string,
    { conversationId: string; agentId: string; userId: string; activeReqId: string } | null
  >;
}): Plugin {
  return {
    manifest: {
      name: 'mock-conversations',
      version: '0.0.0',
      registers: ['conversations:get-by-req-id'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService(
        'conversations:get-by-req-id',
        'mock-conversations',
        async (_ctx, input: unknown) => {
          const { reqId, userId } = input as { reqId: string; userId: string };
          const row = args.byReqId.get(`${userId}|${reqId}`);
          if (row === undefined || row === null) {
            throw new PluginError({
              code: 'not-found',
              plugin: 'mock-conversations',
              message: 'reqId not found',
            });
          }
          return row;
        },
      );
    },
  };
}

function agentsMockPlugin(args: { allow: boolean }): Plugin {
  return {
    manifest: {
      name: 'mock-agents',
      version: '0.0.0',
      registers: ['agents:resolve'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('agents:resolve', 'mock-agents', async () => {
        if (!args.allow) {
          throw new PluginError({
            code: 'forbidden',
            plugin: 'mock-agents',
            message: 'forbidden',
          });
        }
        return { agent: { id: 'agt_test', visibility: 'personal' } };
      });
    },
  };
}

interface BootArgs {
  user?: { id: string; isAdmin: boolean } | null;
  byReqId?: Map<
    string,
    | { conversationId: string; agentId: string; userId: string; activeReqId: string }
    | null
  >;
  agentsAllow?: boolean;
}

async function boot(args: BootArgs = {}): Promise<{
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
  const user = args.user === undefined ? { id: 'userA', isAdmin: false } : args.user;
  const byReqId =
    args.byReqId ??
    new Map<
      string,
      | { conversationId: string; agentId: string; userId: string; activeReqId: string }
      | null
    >([
      [
        'userA|r-test',
        {
          conversationId: 'cnv_test',
          agentId: 'agt_test',
          userId: 'userA',
          activeReqId: 'r-test',
        },
      ],
    ]);
  const harness = await createTestHarness({
    plugins: [
      http,
      authMockPlugin({ user }),
      conversationsMockPlugin({ byReqId }),
      agentsMockPlugin({ allow: args.agentsAllow ?? true }),
      createChannelWebServerPlugin({}),
    ],
  });
  return { harness, port: http.boundPort(), http };
}

describe('@ax/channel-web server plugin (integration)', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.close({ onError: () => {} });
      harness = null;
    }
  });

  it('GET /api/chat/stream/:reqId returns 401 unauthenticated', async () => {
    const booted = await boot({ user: null });
    harness = booted.harness;
    const r = await fetch(`http://127.0.0.1:${booted.port}/api/chat/stream/r-test`);
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('unauthenticated');
  });

  it('GET /api/chat/stream/:reqId returns 404 when reqId is foreign (J9)', async () => {
    const booted = await boot();
    harness = booted.harness;
    const r = await fetch(`http://127.0.0.1:${booted.port}/api/chat/stream/r-someone-elses`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not-found' });
  });

  it('GET /api/chat/stream/:reqId opens an SSE stream and emits a chunk', async () => {
    const booted = await boot();
    harness = booted.harness;
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${booted.port}/api/chat/stream/r-test`, {
      signal: ac.signal,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);

    // Fire a chunk on the bus from the test side. The plugin's per-
    // connection subscriber should write a `data:` frame.
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    // Fire from a separate microtask so we don't deadlock on the read.
    void (async () => {
      // Small delay to let the subscriber attach.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await booted.harness.bus.fire('chat:stream-chunk', booted.harness.ctx(), {
        reqId: 'r-test',
        text: 'hello',
        kind: 'text',
      });
    })();

    let received = '';
    while (received.indexOf('data:') < 0) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    expect(received).toContain('data: {"reqId":"r-test","text":"hello","kind":"text"}\n\n');
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // already aborted
    }
  });

  it('SSE done frame fires on chat:turn-end with matching conversationId', async () => {
    const booted = await boot();
    harness = booted.harness;
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${booted.port}/api/chat/stream/r-test`, {
      signal: ac.signal,
    });
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const ctx = booted.harness.ctx({ conversationId: 'cnv_test' });
      await booted.harness.bus.fire('chat:turn-end', ctx, {
        reqId: 'r-test',
        reason: 'complete',
      });
    })();

    let received = '';
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        break;
      }
      received += decoder.decode(result.value, { stream: true });
      if (received.includes('"done":true')) break;
    }
    expect(received).toContain('"done":true');
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // already aborted
    }
  });

  it('manifest declares the channel-web subscriber + caller surface', async () => {
    const plugin = createChannelWebServerPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/channel-web',
      version: '0.0.0',
      registers: [],
      calls: [
        'http:register-route',
        'auth:require-user',
        'agents:resolve',
        'conversations:get-by-req-id',
      ],
      subscribes: ['chat:stream-chunk', 'chat:turn-end'],
    });
  });
});

