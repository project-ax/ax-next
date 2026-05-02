import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
} from '@ax/core';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { sessionGetConfigHandler } from '../session-get-config.js';

// ---------------------------------------------------------------------------
// session.get-config handler — direct unit tests
//
// Bypass the listener/dispatcher (no socket, no auth) — we drive the
// handler with a HookBus that has @ax/session-inmemory registered. The
// listener tests in @ax/ipc-server own the auth path; the handler tests
// own the shape contract: empty body in, frozen agentConfig out, the
// owner-missing / unknown-session error paths, AND the Phase E
// composition with `conversations:get-metadata` to fold runnerSessionId
// onto the wire.
// ---------------------------------------------------------------------------

const OWNER = {
  userId: 'u-1',
  agentId: 'a-1',
  agentConfig: {
    systemPrompt: 'you are a poet',
    allowedTools: ['file.read'],
    mcpConfigIds: ['mcp-1'],
    model: 'claude-sonnet-4-7',
  },
};

interface Env {
  bus: HookBus;
  ctx: (sessionId: string) => AgentContext;
}

interface MetadataMock {
  /** runnerSessionId returned by the metadata stub when called with this conversationId. */
  byConversationId: Map<string, string | null>;
  /** Conversation ids whose metadata call should throw not-found. */
  notFound: Set<string>;
  /** Conversation ids whose metadata call should throw the supplied PluginError. */
  errors: Map<string, PluginError | Error>;
  /** Mutable call log so individual tests can introspect. */
  calls: Array<{ conversationId: string; userId: string }>;
}

function makeMetadataMock(): MetadataMock {
  return {
    byConversationId: new Map(),
    notFound: new Set(),
    errors: new Map(),
    calls: [],
  };
}

/**
 * Bootstrap the bus with session-inmemory and register a stub for
 * `conversations:get-metadata`. The IPC handler talks to BOTH hooks; we
 * stub conversations rather than pull in the real plugin so the tests stay
 * focused on the composition logic in the handler. The stub mirrors the
 * real plugin's ACL surface (throws PluginError(not-found) on a foreign or
 * unknown row).
 */
async function makeEnv(metadata?: MetadataMock): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createSessionInmemoryPlugin()],
    config: {},
  });
  if (metadata !== undefined) {
    bus.registerService<
      { conversationId: string; userId: string },
      { runnerSessionId: string | null }
    >(
      'conversations:get-metadata',
      'test-stub',
      async (_ctx, input) => {
        metadata.calls.push({
          conversationId: input.conversationId,
          userId: input.userId,
        });
        const errToThrow = metadata.errors.get(input.conversationId);
        if (errToThrow !== undefined) throw errToThrow;
        if (metadata.notFound.has(input.conversationId)) {
          throw new PluginError({
            code: 'not-found',
            plugin: 'test-stub',
            hookName: 'conversations:get-metadata',
            message: `conversation '${input.conversationId}' not found`,
          });
        }
        const rsid = metadata.byConversationId.get(input.conversationId) ?? null;
        return { runnerSessionId: rsid };
      },
    );
  }
  return {
    bus,
    ctx: (sessionId: string) =>
      makeAgentContext({ sessionId, agentId: 'ipc-server', userId: 'ipc-server' }),
  };
}

describe('session.get-config handler', () => {
  it('returns the frozen agent config for an owned session (no conversation → no metadata call, runnerSessionId=null)', async () => {
    const md = makeMetadataMock();
    const { bus, ctx } = await makeEnv(md);
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx('init'),
      { sessionId: 's-cfg', workspaceRoot: '/tmp/ws', owner: OWNER },
    );
    const result = await sessionGetConfigHandler({}, ctx('s-cfg'), bus);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      userId: 'u-1',
      agentId: 'a-1',
      agentConfig: OWNER.agentConfig,
      // Task 15 (Week 10–12): conversationId is on the wire shape now,
      // null for non-conversation sessions like this one.
      conversationId: null,
      // Phase E (2026-05-09): null because conversationId is null —
      // metadata isn't called.
      runnerSessionId: null,
    });
    // Confirm the handler short-circuits the metadata call when there's
    // no conversation to look up — saves an unnecessary bus round-trip.
    expect(md.calls).toHaveLength(0);
  });

  it('returns conversationId when the session was created with one (Task 15)', async () => {
    const md = makeMetadataMock();
    md.byConversationId.set('cnv_test_1', null);
    const { bus, ctx } = await makeEnv(md);
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx('init'),
      {
        sessionId: 's-conv',
        workspaceRoot: '/tmp/ws',
        owner: { ...OWNER, conversationId: 'cnv_test_1' },
      },
    );
    const result = await sessionGetConfigHandler({}, ctx('s-conv'), bus);
    expect(result.status).toBe(200);
    expect((result.body as { conversationId: string }).conversationId).toBe(
      'cnv_test_1',
    );
  });

  it('Phase E: composes runnerSessionId from conversations:get-metadata when conversationId is set', async () => {
    const md = makeMetadataMock();
    md.byConversationId.set('cnv_resume', 'sdk-sess-resume');
    const { bus, ctx } = await makeEnv(md);
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx('init'),
      {
        sessionId: 's-resume',
        workspaceRoot: '/tmp/ws',
        owner: { ...OWNER, conversationId: 'cnv_resume' },
      },
    );
    const result = await sessionGetConfigHandler({}, ctx('s-resume'), bus);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      userId: 'u-1',
      agentId: 'a-1',
      agentConfig: OWNER.agentConfig,
      conversationId: 'cnv_resume',
      runnerSessionId: 'sdk-sess-resume',
    });
    // Pin the input shape passed to conversations:get-metadata. The
    // userId MUST come from the session.get-config response (not from
    // any field the runner could control) — the test guards against a
    // refactor that wires userId from the request body.
    expect(md.calls).toEqual([{ conversationId: 'cnv_resume', userId: 'u-1' }]);
  });

  it('Phase E: composes runnerSessionId=null when get-metadata returns null (no bind yet)', async () => {
    const md = makeMetadataMock();
    md.byConversationId.set('cnv_fresh', null);
    const { bus, ctx } = await makeEnv(md);
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx('init'),
      {
        sessionId: 's-fresh',
        workspaceRoot: '/tmp/ws',
        owner: { ...OWNER, conversationId: 'cnv_fresh' },
      },
    );
    const result = await sessionGetConfigHandler({}, ctx('s-fresh'), bus);
    expect(result.status).toBe(200);
    expect((result.body as { runnerSessionId: string | null }).runnerSessionId).toBeNull();
  });

  it('Phase E: get-metadata throwing not-found is non-fatal — runnerSessionId=null + 200 (defensive: delete-during-boot race)', async () => {
    const md = makeMetadataMock();
    md.notFound.add('cnv_gone');
    const { bus, ctx } = await makeEnv(md);
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx('init'),
      {
        sessionId: 's-gone',
        workspaceRoot: '/tmp/ws',
        owner: { ...OWNER, conversationId: 'cnv_gone' },
      },
    );
    const result = await sessionGetConfigHandler({}, ctx('s-gone'), bus);
    expect(result.status).toBe(200);
    expect((result.body as { runnerSessionId: string | null }).runnerSessionId).toBeNull();
    // conversationId is preserved (the runner already learned it from
    // the prior session.get-config response — we don't lie about it just
    // because the metadata read raced).
    expect((result.body as { conversationId: string }).conversationId).toBe(
      'cnv_gone',
    );
  });

  it('Phase E: get-metadata throwing forbidden propagates as 403 HOOK_REJECTED', async () => {
    // ACL drift / agents:resolve denial. Treat as a real error; don't
    // silently downgrade to runnerSessionId=null since the runner needs
    // to know boot failed for a reason it didn't expect.
    const md = makeMetadataMock();
    md.errors.set(
      'cnv_forbidden',
      new PluginError({
        code: 'forbidden',
        plugin: 'test-stub',
        hookName: 'conversations:get-metadata',
        message: 'agent denied',
      }),
    );
    const { bus, ctx } = await makeEnv(md);
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx('init'),
      {
        sessionId: 's-forbidden',
        workspaceRoot: '/tmp/ws',
        owner: { ...OWNER, conversationId: 'cnv_forbidden' },
      },
    );
    const result = await sessionGetConfigHandler(
      {},
      ctx('s-forbidden'),
      bus,
    );
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'HOOK_REJECTED',
    );
  });

  it('Phase E: get-metadata throwing a generic error propagates as 500 INTERNAL', async () => {
    const md = makeMetadataMock();
    md.errors.set('cnv_boom', new Error('storage hiccup'));
    const { bus, ctx } = await makeEnv(md);
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx('init'),
      {
        sessionId: 's-boom',
        workspaceRoot: '/tmp/ws',
        owner: { ...OWNER, conversationId: 'cnv_boom' },
      },
    );
    const result = await sessionGetConfigHandler({}, ctx('s-boom'), bus);
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'INTERNAL',
    );
  });

  it('rejects a non-empty body as 400 VALIDATION (no sessionId smuggling)', async () => {
    // The schema is .strict({}) on purpose — a runner cannot ask for
    // someone else's config. If we ever loosen this, the test fails
    // loudly so the security posture review reads the change.
    const { bus, ctx } = await makeEnv();
    const result = await sessionGetConfigHandler(
      { sessionId: 'someone-else' } as never,
      ctx('s-cfg'),
      bus,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('VALIDATION');
  });

  it('returns 401 SESSION_INVALID when ctx.sessionId is unknown', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await sessionGetConfigHandler({}, ctx('never-existed'), bus);
    expect(result.status).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'SESSION_INVALID',
    );
  });

  it('returns 401 SESSION_INVALID when the session has no owner (pre-9.5 record)', async () => {
    const { bus, ctx } = await makeEnv();
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx('init'),
      { sessionId: 's-legacy', workspaceRoot: '/tmp/ws' },
    );
    const result = await sessionGetConfigHandler({}, ctx('s-legacy'), bus);
    expect(result.status).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'SESSION_INVALID',
    );
  });
});
