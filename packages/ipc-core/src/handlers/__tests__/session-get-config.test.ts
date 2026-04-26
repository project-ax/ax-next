import { describe, it, expect } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeChatContext,
  type ChatContext,
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
// own the shape contract: empty body in, frozen agentConfig out, and the
// owner-missing / unknown-session error paths.
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
  ctx: (sessionId: string) => ChatContext;
}

async function makeEnv(): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createSessionInmemoryPlugin()],
    config: {},
  });
  return {
    bus,
    ctx: (sessionId: string) =>
      makeChatContext({ sessionId, agentId: 'ipc-server', userId: 'ipc-server' }),
  };
}

describe('session.get-config handler', () => {
  it('returns the frozen agent config for an owned session', async () => {
    const { bus, ctx } = await makeEnv();
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
    });
  });

  it('returns conversationId when the session was created with one (Task 15)', async () => {
    const { bus, ctx } = await makeEnv();
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
