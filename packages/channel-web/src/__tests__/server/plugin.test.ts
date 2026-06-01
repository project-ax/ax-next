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
      registers: [
        'conversations:get-by-req-id',
        // The channel-web plugin's manifest now also declares calls
        // for these (Task 9 — POST /api/chat/messages, and Tasks
        // 10-12 — list/get/delete). The bootstrap-time verifyCalls
        // walk will fail unless someone registers them; we no-op since
        // this test suite doesn't exercise the chat-flow producer or
        // the read+delete surface (those are covered in
        // routes-chat.test.ts).
        'conversations:create',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
      ],
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
      bus.registerService('conversations:create', 'mock-conversations', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-conversations',
          message: 'conversations:create stub (not exercised by this suite)',
        });
      });
      bus.registerService('conversations:get', 'mock-conversations', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-conversations',
          message: 'conversations:get stub (not exercised by this suite)',
        });
      });
      bus.registerService('conversations:list', 'mock-conversations', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-conversations',
          message: 'conversations:list stub (not exercised by this suite)',
        });
      });
      bus.registerService('conversations:delete', 'mock-conversations', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-conversations',
          message: 'conversations:delete stub (not exercised by this suite)',
        });
      });
    },
  };
}

/**
 * Stub for `attachments:store-temp` / `attachments:commit` / `attachments:download`.
 * Channel-web declares all three as hard calls (Phase 3). This suite doesn't
 * exercise the attachment paths — a no-op registration satisfies the
 * bootstrap verifyCalls walk. The real plugin (`@ax/attachments`) needs a
 * postgres testcontainer + workspace registration; using a stub keeps the
 * suite's existing scope (SSE wire shape) intact.
 */
function attachmentsMockPlugin(): Plugin {
  return {
    manifest: {
      name: 'mock-attachments',
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
      bus.registerService('attachments:store-temp', 'mock-attachments', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-attachments',
          message: 'attachments:store-temp stub (not exercised by this suite)',
        });
      });
      bus.registerService('attachments:commit', 'mock-attachments', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-attachments',
          message: 'attachments:commit stub (not exercised by this suite)',
        });
      });
      bus.registerService('attachments:download', 'mock-attachments', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-attachments',
          message: 'attachments:download stub (not exercised by this suite)',
        });
      });
    },
  };
}

/**
 * Stub for `agent:invoke` + `agent:apply-capability-grant` (TASK-36). The
 * plugin manifest declares both as hard calls; this suite doesn't drive the
 * chat-flow producer or the permission-decision endpoint, so no-op
 * registrations satisfy the bootstrap verifyCalls walk.
 */
function chatRunMockPlugin(): Plugin {
  return {
    manifest: {
      name: 'mock-chat-run',
      version: '0.0.0',
      // agent:apply-capability-grant (TASK-36) + proxy:add-host (TASK-37) are
      // hard calls of channel-web; no-op registrations satisfy the bootstrap
      // verifyCalls walk for this SSE-wire-shape suite.
      registers: ['agent:invoke', 'agent:apply-capability-grant', 'proxy:add-host'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('agent:invoke', 'mock-chat-run', async () => {
        return { kind: 'complete', messages: [] };
      });
      bus.registerService(
        'agent:apply-capability-grant',
        'mock-chat-run',
        async () => ({ attached: true }),
      );
      bus.registerService('proxy:add-host', 'mock-chat-run', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-chat-run',
          message: 'proxy:add-host stub (not exercised by this suite)',
        });
      });
    },
  };
}

function agentsMockPlugin(args: { allow: boolean }): Plugin {
  return {
    manifest: {
      name: 'mock-agents',
      version: '0.0.0',
      registers: ['agents:resolve', 'agents:list-for-user'],
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
      // Channel-web's manifest declares this as a hard call (Task 13);
      // this suite doesn't exercise GET /api/chat/agents, so a no-op
      // registration satisfies the bootstrap verifyCalls walk.
      bus.registerService('agents:list-for-user', 'mock-agents', async () => {
        return { agents: [] };
      });
    },
  };
}

/**
 * Stub for `skills:list` / `skills:list-user-attachments` /
 * `skills:detach-for-user`. Channel-web declares all three as hard calls
 * (TASK-42, the Settings Connections BFF). This SSE-wire-shape suite doesn't
 * drive the connections routes, so no-op registrations satisfy the bootstrap
 * verifyCalls walk.
 */
function skillsMockPlugin(): Plugin {
  return {
    manifest: {
      name: 'mock-skills',
      version: '0.0.0',
      registers: ['skills:list', 'skills:list-user-attachments', 'skills:detach-for-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('skills:list', 'mock-skills', async () => ({ skills: [] }));
      bus.registerService('skills:list-user-attachments', 'mock-skills', async () => ({
        attachments: [],
      }));
      bus.registerService('skills:detach-for-user', 'mock-skills', async () => ({
        removed: false,
      }));
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
      chatRunMockPlugin(),
      attachmentsMockPlugin(),
      skillsMockPlugin(),
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
    // TASK-23: the first content chunk for this reqId carries the host-minted seq:1.
    expect(received).toContain('data: {"reqId":"r-test","text":"hello","kind":"text","seq":1}\n\n');
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
    while (true) {
      const result = await reader.read();
      if (result.done) {
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
        'agents:list-for-user',
        'conversations:get-by-req-id',
        'conversations:create',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
        'agent:invoke',
        'agent:apply-capability-grant',
        'attachments:store-temp',
        'attachments:commit',
        'attachments:download',
        'proxy:add-host',
        'skills:list',
        'skills:list-user-attachments',
        'skills:detach-for-user',
      ],
      optionalCalls: [
        {
          hook: 'host-grants:grant',
          degradation:
            'the reactive-wall "Always for this agent" button persists nothing across sessions (the live proxy:add-host grant still applies for the current session); the Settings "Add a site" control returns 503',
        },
        {
          hook: 'host-grants:list',
          degradation:
            'the Settings "Allowed sites" panel shows no persisted hosts (the live reactive wall still applies per session)',
        },
        {
          hook: 'host-grants:revoke',
          degradation:
            'the Settings "Allowed sites" Revoke control is a no-op (no persisted grants to remove)',
        },
      ],
      subscribes: ['chat:stream-chunk', 'chat:phase', 'chat:turn-end', 'chat:turn-error', 'chat:permission-request', 'conversations:title-updated'],
    });
  });

  describe('connections routes (TASK-42)', () => {
    it('declares the Settings Connections skills hooks in manifest.calls', () => {
      const plugin = createChannelWebServerPlugin();
      expect(plugin.manifest.calls).toContain('skills:list');
      expect(plugin.manifest.calls).toContain('skills:list-user-attachments');
      expect(plugin.manifest.calls).toContain('skills:detach-for-user');
    });

    it('registers GET /api/chat/connections/:agentId at boot (401, not 404)', async () => {
      const booted = await boot({ user: null });
      harness = booted.harness;
      // user=null → auth throws → 401 (a 404 would mean the route is missing).
      const r = await fetch(
        `http://127.0.0.1:${booted.port}/api/chat/connections/agt_test`,
      );
      expect(r.status).toBe(401);
    });
  });

  describe('Settings panels (TASK-54)', () => {
    it('declares the host-grants list/revoke hooks in manifest.optionalCalls', () => {
      const plugin = createChannelWebServerPlugin();
      const hooks = (plugin.manifest.optionalCalls ?? []).map((o) => o.hook);
      expect(hooks).toContain('host-grants:list');
      expect(hooks).toContain('host-grants:revoke');
    });

    it('registers GET /api/chat/allowed-sites/:agentId at boot (401, not 404)', async () => {
      const booted = await boot({ user: null });
      harness = booted.harness;
      const r = await fetch(
        `http://127.0.0.1:${booted.port}/api/chat/allowed-sites/agt_test`,
      );
      expect(r.status).toBe(401);
    });

    it('declares the host-grants grant hook in manifest.optionalCalls (TASK-131)', () => {
      const plugin = createChannelWebServerPlugin();
      const hooks = (plugin.manifest.optionalCalls ?? []).map((o) => o.hook);
      expect(hooks).toContain('host-grants:grant');
    });

    it('registers POST /api/chat/allowed-sites/:agentId at boot (401, not 404) (TASK-131)', async () => {
      const booted = await boot({ user: null });
      harness = booted.harness;
      // user=null → auth throws → 401 (a 404 would mean the route is missing).
      // The X-Requested-With header passes the CSRF subscriber so the request
      // reaches the route handler (otherwise it'd short-circuit to 403 first).
      const r = await fetch(
        `http://127.0.0.1:${booted.port}/api/chat/allowed-sites/agt_test`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-requested-with': 'ax-admin',
          },
          body: JSON.stringify({ host: 'example.com' }),
        },
      );
      expect(r.status).toBe(401);
    });

    it('registers GET /api/chat/account-usage at boot (401, not 404)', async () => {
      const booted = await boot({ user: null });
      harness = booted.harness;
      const r = await fetch(`http://127.0.0.1:${booted.port}/api/chat/account-usage`);
      expect(r.status).toBe(401);
    });
  });

  it('GET /api/chat/title-events is registered (returns 401, not 404)', async () => {
    const booted = await boot({ user: null });
    harness = booted.harness;
    // With user=null, auth:require-user throws unauthenticated → 401.
    // A 404 body {"error":"not-found"} would mean the route was never
    // registered — any other status proves the route handler ran.
    const r = await fetch(`http://127.0.0.1:${booted.port}/api/chat/title-events`);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });

  describe('attachments routes', () => {
    it('declares attachments:* hooks in manifest.calls', () => {
      const plugin = createChannelWebServerPlugin();
      expect(plugin.manifest.calls).toContain('attachments:store-temp');
      expect(plugin.manifest.calls).toContain('attachments:commit');
      expect(plugin.manifest.calls).toContain('attachments:download');
    });

    it('registers POST /api/attachments and GET /api/files at boot', async () => {
      const booted = await boot();
      harness = booted.harness;

      // Probe route existence via real HTTP. A 404 with body
      // `{"error":"not-found"}` from the http-server's no-match path
      // would mean the route was never registered; ANY other status
      // (400 invalid-payload, 401 unauth, 415 unsupported, etc.)
      // proves the route is wired.
      //
      // POST uses the `X-Requested-With: ax-admin` header to bypass the
      // CSRF subscriber (which would otherwise short-circuit to 403
      // BEFORE the router runs — see `csrf.ts`). Routes-attachments'
      // POST handler will then auth + try to parse multipart, returning
      // 400 invalid-payload for our empty body. That's good enough — it
      // means the route handler ran.
      const post = await fetch(
        `http://127.0.0.1:${booted.port}/api/attachments`,
        {
          method: 'POST',
          headers: {
            'x-requested-with': 'ax-admin',
            'content-type': 'multipart/form-data; boundary=----test',
          },
          body: '------test--\r\n',
        },
      );
      expect(post.status).not.toBe(404);

      // GET /api/files: cookie auth only, no CSRF gate. Our auth mock
      // accepts any request, so the route dispatches into the
      // attachments stub (which throws not-implemented). The route
      // handler maps that to a 5xx via the unhandled-error path — but
      // it's NOT a 404, which is what proves the route exists.
      const get = await fetch(
        `http://127.0.0.1:${booted.port}/api/files?path=foo&conversationId=cnv_test`,
      );
      expect(get.status).not.toBe(404);
    });
  });
});

