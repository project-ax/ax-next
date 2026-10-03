import { describe, it, expect, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { conversationDrainSaveRefusalsHandler } from '../conversation-drain-save-refusals.js';

// ---------------------------------------------------------------------------
// TASK-749 — conversation.drain-save-refusals: the runner takes the refused
// saves its model was not told about. The conversation comes from ctx (bound to
// the bearer token), never from the body; the answer is closed codes only.
// ---------------------------------------------------------------------------

function fakeBus(opts: {
  hasService?: boolean;
  drainImpl?: (ctx: unknown, input: unknown) => Promise<unknown>;
}) {
  const drainImpl =
    opts.drainImpl ??
    (async () => ({ refusals: [{ code: 'refused', turnReqId: null }] }));
  return {
    call: vi.fn(async (hook: string, ctx: unknown, input: unknown) => {
      if (hook === 'conversations:drain-save-refusals') return drainImpl(ctx, input);
      throw new Error(`unexpected hook ${hook}`);
    }),
    hasService: vi.fn((hook: string) =>
      hook === 'conversations:drain-save-refusals' ? opts.hasService ?? true : false,
    ),
  };
}

/** `null` = a run bound to no conversation (the single-session CLI). */
function fakeCtx(conversationId: string | null = 'c-own') {
  return {
    sessionId: 's1',
    agentId: 'a1',
    userId: 'u1',
    ...(conversationId !== null ? { conversationId } : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe('conversation.drain-save-refusals handler (TASK-749)', () => {
  it('drains the ctx conversation (not a body field) and returns the closed codes', async () => {
    const bus = fakeBus({
      drainImpl: async () => ({
        refusals: [
          { code: 'too-large', turnReqId: 'req-1' },
          { code: 'storage-full', turnReqId: null },
        ],
      }),
    });
    const ctx = fakeCtx('c-own');
    const result = await conversationDrainSaveRefusalsHandler({}, ctx, bus as never);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      refusals: [
        { code: 'too-large', turnReqId: 'req-1' },
        { code: 'storage-full', turnReqId: null },
      ],
    });
    expect(bus.call).toHaveBeenCalledWith('conversations:drain-save-refusals', ctx, {
      conversationId: 'c-own',
    });
  });

  it('rejects a body naming another conversation before touching the hook', async () => {
    const bus = fakeBus({});
    const result = await conversationDrainSaveRefusalsHandler(
      { conversationId: 'someone-elses' },
      fakeCtx(),
      bus as never,
    );
    expect(result.status).toBe(400);
    expect(bus.call).not.toHaveBeenCalled();
  });

  it('degrades to { refusals: [] } without the hook: no conversation on ctx, or no conversation store', async () => {
    for (const [bus, ctx] of [
      [fakeBus({}), fakeCtx(null)],
      [fakeBus({ hasService: false }), fakeCtx('c-own')],
    ] as const) {
      const result = await conversationDrainSaveRefusalsHandler({}, ctx, bus as never);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ refusals: [] });
      expect(bus.call).not.toHaveBeenCalled();
    }
  });

  it('refuses to put anything but closed codes on the wire (shape drift → 500)', async () => {
    const bus = fakeBus({
      drainImpl: async () => ({
        refusals: [{ code: 'refused', turnReqId: null, reason: 'model-chosen text' }],
      }),
    });
    const result = await conversationDrainSaveRefusalsHandler({}, fakeCtx(), bus as never);
    expect(result.status).toBe(500);
  });

  it('maps a hook PluginError to its envelope', async () => {
    const bus = fakeBus({
      drainImpl: async () => {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: '@ax/conversations',
          hookName: 'conversations:drain-save-refusals',
          message: 'bad',
        });
      },
    });
    const result = await conversationDrainSaveRefusalsHandler({}, fakeCtx(), bus as never);
    expect(result.status).toBe(400);
  });
});
