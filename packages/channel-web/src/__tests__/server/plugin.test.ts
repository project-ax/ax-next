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

interface MockConversationRow {
  conversationId: string;
  userId: string;
  agentId: string;
  title: string | null;
  activeSessionId: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

function conversationsMockPlugin(args: {
  byReqId: Map<
    string,
    { conversationId: string; agentId: string; userId: string; activeReqId: string } | null
  >;
  /**
   * TASK-230 — the agent-workspace detail route reads these through the REAL
   * http-server, which is the only place the query-string projection
   * (`query[k.toLowerCase()]`) is exercised. A handler-level test cannot see
   * that, so `?conversationId=` needs a row to fetch here.
   */
  rows?: MockConversationRow[];
  turns?: Map<string, Array<Record<string, unknown>>>;
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
        // TASK-230 — channel-web declares session:is-alive as an OPTIONAL call
        // (the workspace roster's working/resting probe). Registering it here
        // keeps the flag-on boot exercising the real path.
        'session:is-alive',
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
      bus.registerService(
        'conversations:get',
        'mock-conversations',
        async (_ctx, input: unknown) => {
          const { conversationId, userId } = input as {
            conversationId: string;
            userId: string;
          };
          const row = (args.rows ?? []).find(
            (r) => r.conversationId === conversationId && r.userId === userId,
          );
          if (row === undefined) {
            throw new PluginError({
              code: args.rows === undefined ? 'not-implemented' : 'not-found',
              plugin: 'mock-conversations',
              message: 'conversations:get',
            });
          }
          return { conversation: row, turns: args.turns?.get(conversationId) ?? [] };
        },
      );
      bus.registerService(
        'conversations:list',
        'mock-conversations',
        async (_ctx, input: unknown) => {
          if (args.rows === undefined) {
            throw new PluginError({
              code: 'not-implemented',
              plugin: 'mock-conversations',
              message: 'conversations:list stub (not exercised by this suite)',
            });
          }
          const { userId, agentId } = input as { userId: string; agentId?: string };
          return args.rows.filter(
            (r) =>
              r.userId === userId && (agentId === undefined || r.agentId === agentId),
          );
        },
      );
      bus.registerService('conversations:delete', 'mock-conversations', async () => {
        throw new PluginError({
          code: 'not-implemented',
          plugin: 'mock-conversations',
          message: 'conversations:delete stub (not exercised by this suite)',
        });
      });
      // TASK-230 — the agent-workspace roster probes session liveness through
      // this optional hook. Nothing here is alive, which is the honest answer
      // for a suite that never starts a session.
      bus.registerService('session:is-alive', 'mock-conversations', async () => ({
        alive: false,
      }));
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
      registers: [
        'agents:resolve',
        'agents:list-for-user',
        'agents:create',
        'workspace:apply',
        'workspace:read',
        'workspace:list',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      // TASK-140: channel-web declares workspace:apply as a hard call (the
      // bootstrap route seeds .ax/BOOTSTRAP.md). TASK-142: workspace:read too
      // (the identity editor reads .ax/ files). This suite doesn't drive those
      // routes, so no-op registrations satisfy the verifyCalls walk.
      // TASK-233: workspace:list joins them (the Files tab lists the tree).
      bus.registerService('workspace:apply', 'mock-agents', async () => {
        return { version: 'v0', delta: { before: null, after: 'v0', changes: [] } };
      });
      bus.registerService('workspace:read', 'mock-agents', async () => {
        return { found: false };
      });
      bus.registerService('workspace:list', 'mock-agents', async () => {
        return { paths: [] };
      });
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
      // Channel-web declares agents:create as a hard call (first-run
      // personal-agent bootstrap, POST /api/agents/bootstrap). This suite
      // doesn't exercise that route, so a no-op registration satisfies the
      // bootstrap verifyCalls walk.
      bus.registerService('agents:create', 'mock-agents', async () => {
        return { agent: { id: 'agt_new', displayName: 'New', visibility: 'personal' } };
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

/**
 * AW-13 — @ax/memory-strata's Memory-tab hooks, in memory.
 *
 * Deliberately records the CTX each call arrives on. `memory:rules:write`
 * reaches `workspace:apply`, which routes by `(userId, agentId)`; a route that
 * fires with the wrong ctx writes another agent's workspace, and only a test
 * that looks at the ctx can see it.
 */
function memoryMockPlugin(state: {
  rules: string;
  learned: Array<{ name: string; body: string }>;
  writeCtx: Array<{ agentId: string; userId: string; payloadAgentId: string }>;
  failWrite?: PluginError;
}): Plugin {
  return {
    manifest: {
      name: 'mock-memory',
      version: '0.0.0',
      registers: ['memory:rules:read', 'memory:rules:write', 'memory:learned:read'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('memory:rules:read', 'mock-memory', async () => ({
        body: state.rules,
      }));
      bus.registerService('memory:rules:write', 'mock-memory', async (ctx, input) => {
        const { agentId, body } = input as { agentId: string; body: string };
        state.writeCtx.push({
          agentId: ctx.agentId,
          userId: ctx.userId ?? '',
          payloadAgentId: agentId,
        });
        if (state.failWrite !== undefined) throw state.failWrite;
        state.rules = body;
        return { written: true, body };
      });
      bus.registerService('memory:learned:read', 'mock-memory', async () => ({
        docs: state.learned,
      }));
    },
  };
}

interface BootArgs {
  user?: { id: string; isAdmin: boolean } | null;
  /** TASK-230 — mount the /api/workspace/* preview surface. */
  agentWorkspacePreview?: boolean;
  /** AW-13 — load the Memory-tab hooks. Omitted = no memory plugin at all. */
  memory?: Parameters<typeof memoryMockPlugin>[0];
  /** TASK-230 — conversation rows the workspace detail route can read. */
  conversationRows?: MockConversationRow[];
  conversationTurns?: Map<string, Array<Record<string, unknown>>>;
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
      conversationsMockPlugin({
        byReqId,
        ...(args.conversationRows === undefined
          ? {}
          : { rows: args.conversationRows }),
        ...(args.conversationTurns === undefined
          ? {}
          : { turns: args.conversationTurns }),
      }),
      agentsMockPlugin({ allow: args.agentsAllow ?? true }),
      chatRunMockPlugin(),
      attachmentsMockPlugin(),
      skillsMockPlugin(),
      ...(args.memory === undefined ? [] : [memoryMockPlugin(args.memory)]),
      createChannelWebServerPlugin(
        args.agentWorkspacePreview === undefined
          ? {}
          : { agentWorkspacePreview: args.agentWorkspacePreview },
      ),
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
        'agents:create',
        'workspace:apply',
        'workspace:read',
        'workspace:list',
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
          hook: 'teams:list-for-user',
          degradation:
            'team agents are omitted from the chat agent picker (personal agents only)',
        },
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
          hook: 'host-grants:list-for-user',
          degradation:
            'the Settings "Allowed sites" one-list panel shows no persisted hosts',
        },
        {
          hook: 'host-grants:revoke',
          degradation:
            'the Settings "Allowed sites" Revoke control is a no-op (no persisted grants to remove)',
        },
        {
          hook: 'session:is-alive',
          degradation:
            'every agent in the workspace roster reads as resting (liveness cannot be probed, and a guess would be worse than a blank)',
        },
        {
          hook: 'routines:recent-fires-for-agent',
          degradation:
            'the workspace Activity feed is empty (this deployment keeps no routine fire history)',
        },
        {
          hook: 'routines:list',
          degradation:
            'Activity rows are labelled with the routine path instead of its authored name',
        },
        {
          hook: 'tool-policy:list-capabilities',
          degradation:
            'the rail says it cannot show what the agent may do alone, rather than showing an empty list',
        },
        {
          hook: 'tool-policy:evaluate',
          degradation:
            'the rail omits the tools no rule describes and says the list is incomplete',
        },
        {
          hook: 'tool:list',
          degradation:
            'the rail cannot list third-party (MCP) tools or undescribed ones, and says the list is incomplete',
        },
        {
          hook: 'agent-activity:get',
          degradation:
            'the rail shows the agent state word alone instead of a live activity line',
        },
        {
          hook: 'skills:approved-caps-list',
          degradation:
            'the rail\'s "Granted by you" group omits capabilities approved at a skill or connection install gate',
        },
        {
          hook: 'skills:approved-caps-revoke',
          degradation:
            'approved-capability grants render without a Revoke control (there is no writer to honour one)',
        },
        {
          hook: 'decisions:list',
          degradation:
            'the rail renders no "This week" counters (nothing records decisions here)',
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
  });

  describe('agent-workspace routes (TASK-230)', () => {
    it('declares session:is-alive in manifest.optionalCalls', () => {
      const plugin = createChannelWebServerPlugin();
      const hooks = (plugin.manifest.optionalCalls ?? []).map((o) => o.hook);
      expect(hooks).toContain('session:is-alive');
    });

    it('mounts /api/workspace/* and echoes the flag when the preview is on', async () => {
      const booted = await boot({ user: null, agentWorkspacePreview: true });
      harness = booted.harness;

      // user=null → auth throws → 401. A 404 would mean the route is missing,
      // which is exactly the bug this asserts against.
      const state = await fetch(
        `http://127.0.0.1:${booted.port}/api/workspace/state`,
      );
      expect(state.status).toBe(401);

      // The flag echo needs no session at all — the SPA reads it before it
      // knows whether anyone is signed in.
      const features = await fetch(`http://127.0.0.1:${booted.port}/api/features`);
      expect(features.status).toBe(200);
      expect(await features.json()).toEqual({ agentWorkspacePreview: true });
    });

    it('honours ?conversationId= through the real http-server query projection', async () => {
      // The regression this pins: http-server projects the query string with
      // `query[k.toLowerCase()] = v`, so a handler reading `conversationId`
      // gets undefined forever and silently serves the CURRENT conversation
      // under a past row's title — plausible wrong data, no error. A
      // handler-level test can't see it, because it writes the query object
      // itself. Only a round trip through the real server can.
      const rows = [
        {
          conversationId: 'cnv_now',
          userId: 'userA',
          agentId: 'agt_test',
          title: 'Today',
          activeSessionId: null,
          createdAt: '2026-08-20T10:00:00.000Z',
          lastActivityAt: '2026-08-20T10:00:00.000Z',
        },
        {
          conversationId: 'cnv_march',
          userId: 'userA',
          agentId: 'agt_test',
          title: 'March',
          activeSessionId: null,
          createdAt: '2026-03-01T10:00:00.000Z',
          lastActivityAt: '2026-03-01T10:00:00.000Z',
        },
      ];
      const turns = new Map<string, Array<Record<string, unknown>>>([
        [
          'cnv_now',
          [
            {
              turnId: 't-now',
              turnIndex: 0,
              role: 'user',
              contentBlocks: [{ type: 'text', text: 'happening today' }],
              createdAt: '2026-08-20T10:00:00.000Z',
            },
          ],
        ],
        [
          'cnv_march',
          [
            {
              turnId: 't-march',
              turnIndex: 0,
              role: 'user',
              contentBlocks: [{ type: 'text', text: 'happened in March' }],
              createdAt: '2026-03-01T10:00:00.000Z',
            },
          ],
        ],
      ]);
      const booted = await boot({
        agentWorkspacePreview: true,
        conversationRows: rows,
        conversationTurns: turns,
      });
      harness = booted.harness;

      const base = `http://127.0.0.1:${booted.port}/api/workspace/agents/agt_test`;

      const current = await fetch(base);
      expect(current.status).toBe(200);
      const currentBody = (await current.json()) as {
        conversationId: string | null;
        thread: Array<{ text: string }>;
      };
      expect(currentBody.conversationId).toBe('cnv_now');
      expect(currentBody.thread[0]?.text).toBe('happening today');

      const past = await fetch(`${base}?conversationId=cnv_march`);
      expect(past.status).toBe(200);
      const pastBody = (await past.json()) as {
        conversationId: string | null;
        thread: Array<{ text: string }>;
      };
      expect(pastBody.conversationId).toBe('cnv_march');
      expect(pastBody.thread[0]?.text).toBe('happened in March');
    });

    /*
      AW-13 — the human-owned memory tier, through the real server.

      A handler-level test writes its own `params` object, so it cannot see
      whether the PUT route was ever registered, whether http-server accepts
      PUT on a path with a param in the middle of it, or whether the CSRF gate
      lets the SPA's header through. Only a round trip can.
    */
    it('PUT /api/workspace/agents/:agentId/memory/rules saves the human tier', async () => {
      const memory = {
        rules: '',
        learned: [{ name: 'What it knows about you', body: '# User\n\nLikes oat milk.\n' }],
        writeCtx: [] as Array<{ agentId: string; userId: string; payloadAgentId: string }>,
      };
      const booted = await boot({
        agentWorkspacePreview: true,
        conversationRows: [],
        memory,
      });
      harness = booted.harness;
      const base = `http://127.0.0.1:${booted.port}/api/workspace/agents/agt_test`;

      // Before: the editor is present and empty, and the agent's own doc is
      // listed separately. An absent rules row would mean no editor at all.
      const before = (await (await fetch(base)).json()) as {
        memory: Array<{ name: string; scope: string; body: string }>;
      };
      expect(before.memory.map((d) => d.scope)).toEqual(['rules', 'learned']);
      expect(before.memory[0]!.body).toBe('');

      const put = await fetch(`${base}/memory/rules`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ body: '- Always cc Priya' }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ saved: true, body: '- Always cc Priya' });

      // The write was routed to the agent the caller named, on the
      // authenticated user's identity — not on `initCtx`'s system identity.
      expect(memory.writeCtx).toEqual([
        { agentId: 'agt_test', userId: 'userA', payloadAgentId: 'agt_test' },
      ]);

      const after = (await (await fetch(base)).json()) as {
        memory: Array<{ scope: string; body: string }>;
      };
      expect(after.memory[0]).toEqual({
        name: 'Your rules',
        scope: 'rules',
        body: '- Always cc Priya',
      });
    });

    it('reports a refused rules write instead of claiming it saved', async () => {
      const memory = {
        rules: '',
        learned: [],
        writeCtx: [] as Array<{ agentId: string; userId: string; payloadAgentId: string }>,
        failWrite: new PluginError({
          code: 'invalid-payload',
          plugin: 'mock-memory',
          message: 'rules must be 16384 characters or fewer',
        }),
      };
      const booted = await boot({ agentWorkspacePreview: true, memory });
      harness = booted.harness;

      const put = await fetch(
        `http://127.0.0.1:${booted.port}/api/workspace/agents/agt_test/memory/rules`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
          body: JSON.stringify({ body: 'x' }),
        },
      );
      expect(put.status).toBe(400);
      expect((await put.json()) as { error: string }).toMatchObject({
        error: 'invalid-body',
      });
    });

    it('503s the rules write when no memory plugin is loaded', async () => {
      // No `memory` in BootArgs → the hooks are simply absent. Answering 200
      // here would tell the user their rules were kept when nothing kept them.
      const booted = await boot({ agentWorkspacePreview: true, conversationRows: [] });
      harness = booted.harness;

      const put = await fetch(
        `http://127.0.0.1:${booted.port}/api/workspace/agents/agt_test/memory/rules`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
          body: JSON.stringify({ body: '- Always cc Priya' }),
        },
      );
      expect(put.status).toBe(503);
      expect(await put.json()).toEqual({ error: 'memory-unavailable' });

      // And the tab still opens, with no invented rows.
      const detail = (await (
        await fetch(`http://127.0.0.1:${booted.port}/api/workspace/agents/agt_test`)
      ).json()) as { memory: unknown[] };
      expect(detail.memory).toEqual([]);
    });

    it('404s a rules write for an agent the caller cannot reach', async () => {
      const memory = {
        rules: '',
        learned: [],
        writeCtx: [] as Array<{ agentId: string; userId: string; payloadAgentId: string }>,
      };
      const booted = await boot({
        agentWorkspacePreview: true,
        agentsAllow: false,
        memory,
      });
      harness = booted.harness;

      const put = await fetch(
        `http://127.0.0.1:${booted.port}/api/workspace/agents/agt_other/memory/rules`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
          body: JSON.stringify({ body: 'not mine' }),
        },
      );
      expect(put.status).toBe(404);
      // The ACL ran BEFORE any storage was touched.
      expect(memory.writeCtx).toEqual([]);
    });

    it('leaves /api/workspace/* unmounted when the preview is off', async () => {
      const booted = await boot({ user: null });
      harness = booted.harness;

      // Not registered at all — the cheapest capability minimization there is.
      const state = await fetch(
        `http://127.0.0.1:${booted.port}/api/workspace/state`,
      );
      expect(state.status).toBe(404);

      /*
        The Files routes (TASK-233) sit inside the same flag, and they are the
        ones worth naming: they are the only routes on this surface that read a
        caller-supplied path out of a workspace. A route accidentally pushed
        OUTSIDE the `if (agentWorkspacePreview)` block would still pass the
        assertion above, because that one only asks about `/state`.
      */
      const files = await fetch(
        `http://127.0.0.1:${booted.port}/api/workspace/agents/agt_test/files`,
      );
      expect(files.status).toBe(404);

      const oneFile = await fetch(
        `http://127.0.0.1:${booted.port}/api/workspace/agents/agt_test/files/x.md`,
      );
      expect(oneFile.status).toBe(404);

      const features = await fetch(`http://127.0.0.1:${booted.port}/api/features`);
      expect(features.status).toBe(200);
      expect(await features.json()).toEqual({ agentWorkspacePreview: false });
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

