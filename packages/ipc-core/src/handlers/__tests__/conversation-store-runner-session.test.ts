import { describe, it, expect, vi } from 'vitest';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  type AgentContext,
  type AgentContextSource,
  type Logger,
} from '@ax/core';
import { conversationStoreRunnerSessionHandler } from '../conversation-store-runner-session.js';

// ---------------------------------------------------------------------------
// conversation.store-runner-session handler — direct unit tests
//
// Bypasses the listener/dispatcher: we wire a HookBus with a stubbed
// `conversations:store-runner-session` producer and drive the handler
// directly. The auth gate (token → ctx.userId) is covered by the listener
// tests in @ax/ipc-server; this file owns the shape contract:
//
//   - Schema validation on the request (.strict, conversationId +
//     runnerSessionId required).
//   - The bound-conversation guard (TASK-1122): only the conversation the
//     session is bound to (ctx.conversationId, stamped by the listener from
//     the token's session) may be bound, whatever the session's source.
//   - Pass-through to bus.call('conversations:store-runner-session', ...)
//     with NO userId smuggled in the body — the bus reads ctx.userId
//     directly.
//   - PluginError mapping: conflict → 409 HOOK_REJECTED, not-found → 404,
//     invalid-payload → 400, anything else → 500.
//   - Response re-parse for shape-drift defense.
// ---------------------------------------------------------------------------

interface BusOpts {
  storeImpl?: (
    ctx: AgentContext,
    input: { conversationId: string; runnerSessionId: string },
  ) => Promise<unknown>;
}

function makeBus(opts: BusOpts = {}): {
  bus: HookBus;
  calls: Array<{
    ctx: AgentContext;
    input: { conversationId: string; runnerSessionId: string };
  }>;
} {
  const calls: Array<{
    ctx: AgentContext;
    input: { conversationId: string; runnerSessionId: string };
  }> = [];
  const bus = new HookBus();
  bus.registerService(
    'conversations:store-runner-session',
    'mock-conversations',
    async (ctx: AgentContext, raw: unknown) => {
      const input = raw as { conversationId: string; runnerSessionId: string };
      calls.push({ ctx, input });
      if (opts.storeImpl !== undefined) {
        return opts.storeImpl(ctx, input);
      }
      // Bus impl returns void on success.
      return undefined;
    },
  );
  return { bus, calls };
}

/**
 * The per-request ctx the listener stamps from the bearer token's session:
 * bound to `conversationId` (null = a session bound to no conversation).
 */
const ctxWith = (
  userId: string,
  conversationId: string | null = 'cnv_abc',
  extra: { source?: AgentContextSource; logger?: Logger } = {},
): AgentContext =>
  makeAgentContext({
    sessionId: 'sess-1',
    agentId: 'agent-1',
    userId,
    ...(conversationId !== null ? { conversationId } : {}),
    ...extra,
  });

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): Logger => logger,
  };
  return logger;
}

describe('conversation.store-runner-session handler', () => {
  it('200 with { ok: true } on bus success; passes the runner-resolved ctx and does NOT smuggle userId into the input', async () => {
    const { bus, calls } = makeBus();
    const ctx = ctxWith('u-1');
    const result = await conversationStoreRunnerSessionHandler(
      { conversationId: 'cnv_abc', runnerSessionId: 'rs_xyz' },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    // Critical: input has exactly the two declared fields. The bus reads
    // ctx.userId itself; the handler must not smuggle userId into input.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      conversationId: 'cnv_abc',
      runnerSessionId: 'rs_xyz',
    });
    expect(calls[0]?.ctx.userId).toBe('u-1');
  });

  // TASK-1122: the store scopes the bind by user only. Without the guard, a
  // runner could bind an id onto another of its user's conversations (a
  // channel connector's private chats included), and that conversation's next
  // pod would join the id into a filename.
  it("403 for a conversation other than the session's bound one, without calling the hook", async () => {
    const { bus, calls } = makeBus();
    const logger = fakeLogger();
    const result = await conversationStoreRunnerSessionHandler(
      { conversationId: 'cnv_other', runnerSessionId: 'rs_xyz' },
      ctxWith('u-1', 'cnv_mine', { logger }),
      bus,
    );
    expect(result).toEqual({
      status: 403,
      body: { error: { code: 'HOOK_REJECTED', message: 'forbidden' } },
    });
    expect(calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'store_runner_session_foreign_conversation_refused',
      { action: 'conversation.store-runner-session', sessionBoundToConversation: true },
    );
  });

  it('403 for a session bound to no conversation, without calling the hook', async () => {
    const { bus, calls } = makeBus();
    const logger = fakeLogger();
    const result = await conversationStoreRunnerSessionHandler(
      { conversationId: 'cnv_abc', runnerSessionId: 'rs_xyz' },
      ctxWith('u-1', null, { logger }),
      bus,
    );
    expect(result.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'store_runner_session_foreign_conversation_refused',
      { action: 'conversation.store-runner-session', sessionBoundToConversation: false },
    );
  });

  it("binds the session's own conversation whatever its source (an outsider's thread still resumes)", async () => {
    for (const source of [undefined, 'user', 'routine', 'external'] as const) {
      const { bus, calls } = makeBus();
      const result = await conversationStoreRunnerSessionHandler(
        { conversationId: 'cnv_abc', runnerSessionId: 'rs_xyz' },
        ctxWith('u-1', 'cnv_abc', source !== undefined ? { source } : {}),
        bus,
      );
      expect(result.status).toBe(200);
      expect(calls).toHaveLength(1);
    }
  });

  it('400 VALIDATION on a missing conversationId', async () => {
    const { bus } = makeBus();
    const result = await conversationStoreRunnerSessionHandler(
      { runnerSessionId: 'rs_xyz' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION',
    );
  });

  it('400 VALIDATION on a missing runnerSessionId', async () => {
    const { bus } = makeBus();
    const result = await conversationStoreRunnerSessionHandler(
      { conversationId: 'cnv_abc' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION',
    );
  });

  it('400 VALIDATION on extra body fields (.strict)', async () => {
    // The schema is .strict so a body with stray fields fails 400. This
    // also locks the posture: a malicious runner cannot smuggle a
    // foreign userId here, because the body is rejected before the bus
    // call.
    const { bus } = makeBus();
    const result = await conversationStoreRunnerSessionHandler(
      {
        conversationId: 'cnv_abc',
        runnerSessionId: 'rs_xyz',
        userId: 'u-evil',
      } as never,
      ctxWith('u-honest'),
      bus,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION',
    );
  });

  it('409 HOOK_REJECTED when the bus rejects with PluginError(conflict)', async () => {
    const { bus } = makeBus({
      storeImpl: async () => {
        throw new PluginError({
          code: 'conflict',
          plugin: '@ax/conversations',
          hookName: 'conversations:store-runner-session',
          message:
            "runner_session_id already bound to a different value for conversation 'cnv_abc'",
        });
      },
    });
    const result = await conversationStoreRunnerSessionHandler(
      { conversationId: 'cnv_abc', runnerSessionId: 'rs_xyz' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'HOOK_REJECTED',
    );
  });

  it('404 NOT_FOUND when the bus rejects with PluginError(not-found)', async () => {
    const { bus } = makeBus({
      storeImpl: async () => {
        throw new PluginError({
          code: 'not-found',
          plugin: '@ax/conversations',
          hookName: 'conversations:store-runner-session',
          message: "conversation 'cnv_foreign' not found",
        });
      },
    });
    // The session is bound to cnv_foreign, so the guard passes and this
    // exercises the store's own not-found (a row the user doesn't own).
    const result = await conversationStoreRunnerSessionHandler(
      { conversationId: 'cnv_foreign', runnerSessionId: 'rs_xyz' },
      ctxWith('u-1', 'cnv_foreign'),
      bus,
    );
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'NOT_FOUND',
    );
  });

  it('400 VALIDATION when the bus rejects with PluginError(invalid-payload)', async () => {
    const { bus } = makeBus({
      storeImpl: async () => {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: '@ax/conversations',
          hookName: 'conversations:store-runner-session',
          message: 'conversationId out of bounds',
        });
      },
    });
    const result = await conversationStoreRunnerSessionHandler(
      { conversationId: 'cnv_abc', runnerSessionId: 'rs_xyz' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION',
    );
  });

  it('500 INTERNAL on an unrelated thrown error', async () => {
    const { bus } = makeBus({
      storeImpl: async () => {
        throw new Error('boom');
      },
    });
    const result = await conversationStoreRunnerSessionHandler(
      { conversationId: 'cnv_abc', runnerSessionId: 'rs_xyz' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'INTERNAL',
    );
  });
});
