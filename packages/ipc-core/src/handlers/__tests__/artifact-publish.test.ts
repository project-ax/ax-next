import { createHash } from 'node:crypto';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { artifactPublishHandler } from '../artifact-publish.js';
import { blobPutHandler } from '../blob.js';
import {
  MAX_SESSIONS,
  MAX_SHAS_PER_SESSION,
  recordSessionBlobPut,
  resetSessionBlobPutsForTests,
  sessionPutBlob,
} from '../session-blob-puts.js';
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
function fakeCtx(conversationId: string | null = 'conv-1', sessionId = 's1', userId = 'u1') {
  return {
    sessionId,
    agentId: 'a1',
    userId,
    ...(conversationId !== null ? { conversationId } : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

beforeEach(() => {
  resetSessionBlobPutsForTests();
  // The ordinary path: this session's own blob.put returned VALID_SHA.
  recordSessionBlobPut(fakeCtx(), VALID_SHA);
});

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

// TASK-1010: a sha is not a capability. Only a sha this session's own
// blob.put returned may be published; everything else is one 404.
describe('artifact.publish: only this session\'s own blob.put shas', () => {
  const OTHER_SHA = 'b'.repeat(64);
  const okBus = () => fakeBus(async () => ({ artifactId: 'abc123' }));

  it('refuses a sha this session never put, without calling the hook or logging the sha', async () => {
    const bus = okBus();
    const ctx = fakeCtx() as unknown as { logger: { warn: ReturnType<typeof vi.fn> } };
    const result = (await artifactPublishHandler(
      { ...validReq, sha256: OTHER_SHA },
      ctx as never,
      bus as never,
    )) as HandlerErr;
    expect(result.status).toBe(404);
    expect(bus.call).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn.mock.calls[0]![0]).toBe('artifact_publish_unput_sha_refused');
    expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toContain(OTHER_SHA);
  });

  it('gives a foreign sha (put by another session, user or conversation) the same answer as a missing one', async () => {
    recordSessionBlobPut(fakeCtx('conv-1', 's2'), OTHER_SHA); // another session
    recordSessionBlobPut(fakeCtx('conv-1', 's1', 'u2'), OTHER_SHA); // another user
    recordSessionBlobPut(fakeCtx('conv-2'), OTHER_SHA); // another conversation
    const foreign = await artifactPublishHandler(
      { ...validReq, sha256: OTHER_SHA },
      fakeCtx(),
      okBus() as never,
    );
    const missing = await artifactPublishHandler(
      { ...validReq, sha256: 'c'.repeat(64) },
      fakeCtx(),
      okBus() as never,
    );
    expect(foreign).toEqual(missing);
    expect((foreign as HandlerErr).status).toBe(404);
  });

  it("answers a refused sha exactly as it answers this session's own sha whose blob has gone", async () => {
    const goneBus = fakeBus(async () => {
      throw new PluginError({
        code: 'not-found',
        plugin: '@ax/attachments',
        hookName: 'artifacts:publish-blob',
        message: 'artifact bytes are not in the blob store',
      });
    });
    const gone = await artifactPublishHandler(validReq, fakeCtx(), goneBus as never);
    const refused = await artifactPublishHandler(
      { ...validReq, sha256: OTHER_SHA },
      fakeCtx(),
      okBus() as never,
    );
    expect(refused).toEqual(gone);
  });

  it('accepts the sha blob.put just returned to the same session (put, then publish)', async () => {
    resetSessionBlobPutsForTests();
    const bus = fakeBus(async (hook) => {
      if (hook === 'blob:put') return { sha256: OTHER_SHA, size: 3 };
      if (hook === 'artifacts:publish-blob') return { artifactId: 'abc123' };
      throw new Error(`unexpected hook ${hook}`);
    });
    const before = (await artifactPublishHandler(
      { ...validReq, sha256: OTHER_SHA },
      fakeCtx(),
      bus as never,
    )) as HandlerErr;
    expect(before.status).toBe(404);
    const put = (await blobPutHandler(
      Buffer.from('abc'),
      fakeCtx(),
      bus as never,
      new URL('http://ipc/blob.put'),
    )) as HandlerOk;
    expect(put.status).toBe(200);
    const after = (await artifactPublishHandler(
      { ...validReq, sha256: OTHER_SHA },
      fakeCtx(),
      bus as never,
    )) as HandlerOk;
    expect(after.status).toBe(200);
    // A different session of the same user and conversation still may not.
    const sibling = (await artifactPublishHandler(
      { ...validReq, sha256: OTHER_SHA },
      fakeCtx('conv-1', 's2'),
      bus as never,
    )) as HandlerErr;
    expect(sibling.status).toBe(404);
  });

  it('does not remember the sha of bytes whose blob.put was refused', async () => {
    resetSessionBlobPutsForTests();
    const bytes = Buffer.from('abc');
    const bytesSha = createHash('sha256').update(bytes).digest('hex');
    const bus = fakeBus(async () => {
      throw new PluginError({ code: 'rejected', plugin: '@ax/disk-quota', message: 'full' });
    });
    const put = (await blobPutHandler(bytes, fakeCtx(), bus as never, new URL('http://ipc/blob.put'))) as HandlerErr;
    expect(put.status).toBe(409);
    expect(sessionPutBlob(fakeCtx(), bytesSha)).toBe(false);
  });

  it('does not remember a sha from a blob.put answer that fails the response schema', async () => {
    resetSessionBlobPutsForTests();
    const bus = fakeBus(async () => ({ sha256: OTHER_SHA, size: -1 }));
    const put = (await blobPutHandler(
      Buffer.from('abc'),
      fakeCtx(),
      bus as never,
      new URL('http://ipc/blob.put'),
    )) as HandlerErr;
    expect(put.status).toBe(500);
    expect(sessionPutBlob(fakeCtx(), OTHER_SHA)).toBe(false);
  });

  it('logs a bus-wrapped hook failure before returning 500', async () => {
    const bus = fakeBus(async () => {
      throw new PluginError({
        code: 'unknown',
        plugin: '@ax/attachments',
        hookName: 'artifacts:publish-blob',
        message: 'connection refused',
      });
    });
    const ctx = fakeCtx() as unknown as { logger: { error: ReturnType<typeof vi.fn> } };
    const result = (await artifactPublishHandler(validReq, ctx as never, bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
    expect(ctx.logger.error).toHaveBeenCalledTimes(1);
    expect(ctx.logger.error.mock.calls[0]![0]).toBe('ipc_dispatch_internal_error');
    expect(ctx.logger.error.mock.calls[0]![1]).toMatchObject({
      action: 'artifact.publish',
      pluginErrorCode: 'unknown',
    });
  });

  it('bounds memory: a session keeps only its most recent shas, and only recent sessions are kept', () => {
    resetSessionBlobPutsForTests();
    const sha = (n: number) => n.toString(16).padStart(64, '0');
    const own = fakeCtx();
    for (let i = 0; i <= MAX_SHAS_PER_SESSION; i += 1) recordSessionBlobPut(own, sha(i));
    expect(sessionPutBlob(own, sha(0))).toBe(false);
    expect(sessionPutBlob(own, sha(1))).toBe(true);
    expect(sessionPutBlob(own, sha(MAX_SHAS_PER_SESSION))).toBe(true);
    // Another session's puts never evict this session's entries...
    for (let i = 0; i <= MAX_SHAS_PER_SESSION; i += 1) recordSessionBlobPut(fakeCtx('conv-1', 's2'), sha(i));
    expect(sessionPutBlob(own, sha(1))).toBe(true);
    // ...until this session is the least recently active of too many.
    for (let i = 0; i < MAX_SESSIONS; i += 1) recordSessionBlobPut(fakeCtx('conv-1', `x${i}`), VALID_SHA);
    expect(sessionPutBlob(own, sha(1))).toBe(false);
  });

  it('a new put refreshes recency: the session and the re-put sha survive eviction', () => {
    resetSessionBlobPutsForTests();
    const sha = (n: number) => n.toString(16).padStart(64, '0');
    const own = fakeCtx();
    const other = fakeCtx('conv-1', 's2');
    recordSessionBlobPut(own, sha(0));
    recordSessionBlobPut(own, sha(1));
    recordSessionBlobPut(other, sha(0));
    recordSessionBlobPut(own, sha(0)); // refreshes `own` and its sha(0)
    // Fill up to MAX_SHAS_PER_SESSION more for `own`: sha(1) is now the oldest.
    for (let i = 2; i < MAX_SHAS_PER_SESSION + 1; i += 1) recordSessionBlobPut(own, sha(i));
    expect(sessionPutBlob(own, sha(1))).toBe(false);
    expect(sessionPutBlob(own, sha(0))).toBe(true);
    // One session too many: `other` (least recently active) goes, `own` stays.
    for (let i = 0; i < MAX_SESSIONS - 1; i += 1) recordSessionBlobPut(fakeCtx('conv-1', `x${i}`), VALID_SHA);
    expect(sessionPutBlob(other, sha(0))).toBe(false);
    expect(sessionPutBlob(own, sha(0))).toBe(true);
  });

  it('logs an expected hook refusal at warn, not as an internal error', async () => {
    const bus = fakeBus(async () => {
      throw new PluginError({ code: 'not-found', plugin: '@ax/attachments', message: 'gone' });
    });
    const ctx = fakeCtx() as unknown as {
      logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    };
    const result = (await artifactPublishHandler(validReq, ctx as never, bus as never)) as HandlerErr;
    expect(result.status).toBe(404);
    expect(ctx.logger.error).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith('artifact_publish_hook_refused', {
      action: 'artifact.publish',
      pluginErrorCode: 'not-found',
    });
  });
});
