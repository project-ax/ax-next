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

/** The per-request ctx the IPC listener stamps from the bearer token's session. */
function fakeCtx(conversationId?: string) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    sessionId: 's1',
    agentId: 'a1',
    userId: 'u1',
    ...(conversationId !== undefined ? { conversationId } : {}),
    logger,
  };
  return { ctx: ctx as never, logger };
}

const entry = {
  attachmentId: '3f1c2b9e-7d4a-4c1e-9b8f-2a6d5e4c3b1a',
  filename: 'a.png',
  sha256: VALID_SHA,
  mediaType: 'image/png',
  sizeBytes: 99,
};

describe('attachments.list handler', () => {
  it('returns the bound conversation upload set from the host hook', async () => {
    const bus = fakeBus(async (hook, payload) => {
      expect(hook).toBe('attachments:list-for-conversation');
      expect(payload).toEqual({ conversationId: 'c1' });
      return { files: [entry] };
    });
    const { ctx } = fakeCtx('c1');
    const result = (await attachmentsListHandler({ conversationId: 'c1' }, ctx, bus as never)) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ files: [entry] });
  });

  // The wire schema strips unknown keys: a host-side `path` (or any other
  // backend field) on an entry never reaches the runner.
  it('strips unknown keys such as path from list entries', async () => {
    const bus = fakeBus(async () => ({ files: [{ ...entry, path: 'x' }] }));
    const { ctx } = fakeCtx('c1');
    const result = (await attachmentsListHandler({ conversationId: 'c1' }, ctx, bus as never)) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ files: [entry] });
    expect('path' in (result.body as { files: object[] }).files[0]!).toBe(false);
  });

  it('returns an empty list cleanly (no uploads)', async () => {
    const bus = fakeBus(async () => ({ files: [] }));
    const { ctx } = fakeCtx('c1');
    const result = (await attachmentsListHandler({ conversationId: 'c1' }, ctx, bus as never)) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ files: [] });
  });

  // A runner can enumerate only the conversation its session is bound to.
  // The hook scopes by user alone, so without this a runner could list the
  // same person's OTHER conversations' uploads.
  it("lists only the session's bound conversation", async () => {
    const bus = fakeBus(async () => ({ files: [entry] }));
    const { ctx, logger } = fakeCtx('A');
    const result = (await attachmentsListHandler({ conversationId: 'B' }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(403);
    expect(bus.call).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toBe('attachments_list_foreign_conversation_refused');
  });

  it('refuses a session bound to no conversation', async () => {
    const bus = fakeBus(async () => ({ files: [entry] }));
    const { ctx } = fakeCtx();
    const result = (await attachmentsListHandler({ conversationId: 'c1' }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(403);
    expect(bus.call).not.toHaveBeenCalled();
  });

  it('rejects an empty conversationId before any bus call', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not reach the hook');
    });
    const { ctx } = fakeCtx('c1');
    const result = (await attachmentsListHandler({ conversationId: '' }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(400);
    expect(bus.call).not.toHaveBeenCalled();
  });

  // The response is re-checked against the wire schema: the runner names
  // files after these entries, so a malformed id must never reach it.
  it.each([
    ['a path-shaped attachmentId', { ...entry, attachmentId: '../x' }],
    ['an old path-keyed entry', { path: '.ax/uploads/c1/t1/a.png', sha256: VALID_SHA, mediaType: 'image/png', displayName: 'a.png', sizeBytes: 99 }],
  ])('answers 500 when the hook returns %s', async (_label, bad) => {
    const bus = fakeBus(async () => ({ files: [bad] }));
    const { ctx, logger } = fakeCtx('c1');
    const result = (await attachmentsListHandler({ conversationId: 'c1' }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('../x');
    expect(logger.error).toHaveBeenCalled();
  });
});
