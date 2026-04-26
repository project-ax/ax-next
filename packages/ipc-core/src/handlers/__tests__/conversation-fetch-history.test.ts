import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  makeChatContext,
  type ChatContext,
} from '@ax/core';
import { conversationFetchHistoryHandler } from '../conversation-fetch-history.js';

// ---------------------------------------------------------------------------
// conversation.fetch-history handler — direct unit tests
//
// Bypasses the listener/dispatcher: we wire a HookBus with a stubbed
// `conversations:fetch-history` producer and drive the handler directly.
// The auth gate (token → ctx.userId) is covered by the listener tests in
// @ax/ipc-server; this file owns the shape contract:
//
//   - Schema validation on the request (.strict, conversationId required).
//   - Pass-through to bus.call('conversations:fetch-history', ...) with
//     the userId pulled from ctx (NOT the body — the runner cannot lie
//     about its userId because it never set it).
//   - PluginError mapping: not-found → 404 NOT_FOUND, forbidden → 403,
//     invalid-payload → 400.
//   - Response re-parse for shape-drift defense.
// ---------------------------------------------------------------------------

interface BusOpts {
  fetchImpl?: (
    ctx: ChatContext,
    input: { conversationId: string; userId: string },
  ) => Promise<unknown>;
}

function makeBus(opts: BusOpts = {}): { bus: HookBus; calls: Array<{ ctx: ChatContext; input: { conversationId: string; userId: string } }> } {
  const calls: Array<{
    ctx: ChatContext;
    input: { conversationId: string; userId: string };
  }> = [];
  const bus = new HookBus();
  bus.registerService(
    'conversations:fetch-history',
    'mock-conversations',
    async (ctx: ChatContext, raw: unknown) => {
      const input = raw as { conversationId: string; userId: string };
      calls.push({ ctx, input });
      if (opts.fetchImpl !== undefined) {
        return opts.fetchImpl(ctx, input);
      }
      return { turns: [] };
    },
  );
  return { bus, calls };
}

const ctxWith = (userId: string): ChatContext =>
  makeChatContext({
    sessionId: 'sess-1',
    agentId: 'agent-1',
    userId,
  });

describe('conversation.fetch-history handler', () => {
  it('200 with the turns the bus returned, request matches schema', async () => {
    const { bus, calls } = makeBus({
      fetchImpl: async () => ({
        turns: [
          { role: 'user', contentBlocks: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            contentBlocks: [{ type: 'text', text: 'hello' }],
          },
        ],
      }),
    });
    const ctx = ctxWith('u-1');
    const result = await conversationFetchHistoryHandler(
      { conversationId: 'cnv_abc' },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    expect((result.body as { turns: unknown[] }).turns).toHaveLength(2);
    // Critical: userId came from ctx, NOT from the request body. A
    // future change that lets the body smuggle a foreign userId would
    // break this test.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      conversationId: 'cnv_abc',
      userId: 'u-1',
    });
  });

  it('passes the runner-resolved userId to the bus, ignoring any body smuggle', async () => {
    // The schema is .strict so a body with a stray userId fails 400; we
    // use a `never` cast to mirror what a malicious runner would send.
    const { bus } = makeBus();
    const ctx = ctxWith('u-honest');
    const result = await conversationFetchHistoryHandler(
      {
        conversationId: 'cnv_abc',
        userId: 'u-evil',
      } as never,
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION',
    );
  });

  it('400 VALIDATION on an empty conversationId', async () => {
    const { bus } = makeBus();
    const result = await conversationFetchHistoryHandler(
      { conversationId: '' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION',
    );
  });

  it('400 VALIDATION on a missing conversationId', async () => {
    const { bus } = makeBus();
    const result = await conversationFetchHistoryHandler({}, ctxWith('u-1'), bus);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION',
    );
  });

  it('404 NOT_FOUND when the bus rejects with PluginError(not-found) (cross-tenant)', async () => {
    const { bus } = makeBus({
      fetchImpl: async () => {
        throw new PluginError({
          code: 'not-found',
          plugin: '@ax/conversations',
          hookName: 'conversations:fetch-history',
          message: "conversation 'cnv_foreign' not found",
        });
      },
    });
    const result = await conversationFetchHistoryHandler(
      { conversationId: 'cnv_foreign' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'NOT_FOUND',
    );
  });

  it('403 HOOK_REJECTED when the bus rejects with PluginError(forbidden)', async () => {
    const { bus } = makeBus({
      fetchImpl: async () => {
        throw new PluginError({
          code: 'forbidden',
          plugin: '@ax/conversations',
          hookName: 'conversations:fetch-history',
          message: 'agent not reachable',
        });
      },
    });
    const result = await conversationFetchHistoryHandler(
      { conversationId: 'cnv_abc' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'HOOK_REJECTED',
    );
  });

  it('500 INTERNAL when the bus returns a shape-drifted response', async () => {
    const { bus } = makeBus({
      fetchImpl: async () => ({ turns: [{ role: 'mystery', contentBlocks: [] }] }),
    });
    const result = await conversationFetchHistoryHandler(
      { conversationId: 'cnv_abc' },
      ctxWith('u-1'),
      bus,
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      'INTERNAL',
    );
  });
});
