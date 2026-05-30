import { describe, it, expect, vi } from 'vitest';
import { attachmentsListHandler } from '../attachments-list.js';
import type { HandlerErr, HandlerOk } from '../types.js';

const VALID_SHA = 'a'.repeat(64);

function fakeBus(impl: (hook: string, payload: unknown) => Promise<unknown>) {
  return {
    call: vi.fn(async (hook: string, _ctx: unknown, payload: unknown) => impl(hook, payload)),
    hasService: vi.fn(() => true),
    registerService: vi.fn(),
    subscribe: vi.fn(),
    fire: vi.fn(),
  };
}

function fakeCtx() {
  return {
    sessionId: 's1',
    agentId: 'a1',
    userId: 'u1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe('attachments.list handler', () => {
  it('returns the conversation upload set from the host hook', async () => {
    const files = [
      {
        path: '.ax/uploads/c1/t1/a.png',
        sha256: VALID_SHA,
        mediaType: 'image/png',
        displayName: 'a.png',
        sizeBytes: 99,
      },
    ];
    const bus = fakeBus(async (hook, payload) => {
      expect(hook).toBe('attachments:list-for-conversation');
      expect((payload as { conversationId: string }).conversationId).toBe('c1');
      return { files };
    });
    const result = (await attachmentsListHandler({ conversationId: 'c1' }, fakeCtx(), bus as never)) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ files });
  });

  it('returns an empty list cleanly (foreign / no uploads)', async () => {
    const bus = fakeBus(async () => ({ files: [] }));
    const result = (await attachmentsListHandler({ conversationId: 'c1' }, fakeCtx(), bus as never)) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ files: [] });
  });

  it('rejects an empty conversationId before any bus call', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not reach the hook');
    });
    const result = (await attachmentsListHandler({ conversationId: '' }, fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).not.toBe(200);
    expect(bus.call).not.toHaveBeenCalled();
  });
});
