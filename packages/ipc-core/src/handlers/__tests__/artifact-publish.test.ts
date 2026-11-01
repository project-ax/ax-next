import { describe, it, expect, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { artifactPublishHandler } from '../artifact-publish.js';
import type { HandlerErr, HandlerOk } from '../types.js';

const VALID_SHA = 'a'.repeat(64);
const validReq = {
  conversationId: 'conv-1',
  sha256: VALID_SHA,
  path: 'workspace/report.pdf',
  displayName: 'report.pdf',
  mediaType: 'application/pdf',
  size: 1024,
};

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
function fakeCtx(conversationId: string | null = 'conv-1') {
  return {
    sessionId: 's1',
    agentId: 'a1',
    userId: 'u1',
    ...(conversationId !== null ? { conversationId } : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

describe('artifact.publish handler', () => {
  it('inserts the metadata row and mints ax://artifact/<id>', async () => {
    const bus = fakeBus(async (hook, payload) => {
      expect(hook).toBe('artifacts:publish-blob');
      expect(payload).toMatchObject({
        conversationId: 'conv-1',
        sha256: VALID_SHA,
        path: 'workspace/report.pdf',
        displayName: 'report.pdf',
        mediaType: 'application/pdf',
        size: 1024,
      });
      return { artifactId: 'abc123' };
    });
    const result = (await artifactPublishHandler(validReq, fakeCtx(), bus as never)) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      artifactId: 'abc123',
      downloadUrl: 'ax://artifact/abc123',
    });
  });

  it('maps a forbidden PluginError (foreign conversation) to its HTTP status', async () => {
    const bus = fakeBus(async () => {
      throw new PluginError({
        code: 'forbidden',
        plugin: '@ax/attachments',
        message: 'conversation owned by a different user',
      });
    });
    const result = (await artifactPublishHandler(validReq, fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(403);
  });

  // Downloads resolve an artifact by id + the row's conversation, so where a
  // row is recorded decides who can read it. A runner records rows only for
  // the conversation its session is bound to.
  it("refuses a conversation other than the session's bound one, without calling the hook", async () => {
    const bus = fakeBus(async () => ({ artifactId: 'abc123' }));
    const ctx = fakeCtx('conv-1') as unknown as { logger: { warn: ReturnType<typeof vi.fn> } };
    const result = (await artifactPublishHandler(
      { ...validReq, conversationId: 'conv-2' },
      ctx as never,
      bus as never,
    )) as HandlerErr;
    expect(result.status).toBe(403);
    expect(bus.call).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn.mock.calls[0]![0]).toBe('artifact_publish_foreign_conversation_refused');
  });

  it('refuses a session bound to no conversation', async () => {
    const bus = fakeBus(async () => ({ artifactId: 'abc123' }));
    const result = (await artifactPublishHandler(validReq, fakeCtx(null), bus as never)) as HandlerErr;
    expect(result.status).toBe(403);
    expect(bus.call).not.toHaveBeenCalled();
  });

  it('rejects a malformed request before any bus call', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not reach the hook');
    });
    const result = (await artifactPublishHandler(
      { ...validReq, sha256: 'short' },
      fakeCtx(),
      bus as never,
    )) as HandlerErr;
    expect(result.status).not.toBe(200);
    expect(bus.call).not.toHaveBeenCalled();
  });
});
