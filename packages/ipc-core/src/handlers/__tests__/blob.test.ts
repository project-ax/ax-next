import { inspect } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { BLOB_PUT_STORAGE_FULL_FOR_AGENT, blobGetHandler, blobPutHandler } from '../blob.js';
import { sessionPutBlob } from '../session-blob-puts.js';
import type { HandlerBinary, HandlerErr, HandlerOk } from '../types.js';

const VALID_SHA = 'a'.repeat(64);

// `agents:resolve` answers a personal agent owned by `u1` unless a test hands
// `agent` in, so the tests that predate team charging stay about their own thing.
function fakeBus(
  impl: (hook: string, payload: unknown, ctx: unknown) => Promise<unknown>,
  agent: () => Promise<unknown> = async () => ({
    agent: { id: 'a1', ownerType: 'user', ownerId: 'u1' },
  }),
) {
  return {
    call: vi.fn(async (hook: string, ctx: unknown, payload: unknown) =>
      hook === 'agents:resolve' ? agent() : impl(hook, payload, ctx),
    ),
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

describe('blob.put handler (raw-body REQUEST channel)', () => {
  it('forwards the raw body bytes to blob:put and returns {sha256,size}', async () => {
    const body = Buffer.from('artifact bytes here');
    let seenBytes: Uint8Array | undefined;
    const bus = fakeBus(async (hook, payload) => {
      expect(hook).toBe('blob:put');
      seenBytes = (payload as { bytes: Uint8Array }).bytes;
      return { sha256: VALID_SHA, size: seenBytes.length };
    });
    const result = (await blobPutHandler(body, fakeCtx(), bus as never)) as HandlerOk;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ sha256: VALID_SHA, size: body.length });
    // The exact bytes reached the store (content-addressed; never interpreted).
    expect(Buffer.from(seenBytes!).equals(body)).toBe(true);
  });

  it('sanitizes a blob:put failure to 500 (no internal detail leak)', async () => {
    const bus = fakeBus(async () => {
      throw new Error('ENOSPC: no space left on device /var/blobs/aa/bb');
    });
    const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('/var/blobs');
  });

  it('TASK-690: a blob:put refused by a policy subscriber is a 409 carrying the host-authored reason, not a 500', async () => {
    // A storage-limit veto is not a fault: the runner must be able to tell
    // the agent (and through it the person) why the artifact was not saved.
    // A bare 500 reads as "the host broke" and tells nobody anything.
    // A refusal with no reason code (the fail-closed "could not check" one):
    // its own sentence passes through.
    const reason = "We couldn't check your storage just now, so that file wasn't saved. Please try again in a moment.";
    const bus = fakeBus(async () => {
      throw new PluginError({
        code: 'rejected',
        plugin: '@ax/blob-store-fs',
        hookName: 'blob:put',
        message: reason,
      });
    });
    const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: { code: 'HOOK_REJECTED', message: reason } });
  });

  it('TASK-993: a FULL-disk refusal tells the agent not to delete files on its own, instead of relaying the person-facing remedy', async () => {
    // The person-facing sentence says "ask your agent to clean up files it no
    // longer needs ... Then try again". Handed to the model verbatim, that reads
    // as an instruction to delete the person's files and retry.
    const personFacing =
      "You've used all of your storage (1 GB of 1 GB), so that file wasn't saved. " +
      'To make room, ask your agent to clean up files it no longer needs, or ask an admin for more room. Then try again.';
    const bus = fakeBus(async () => {
      throw new PluginError({
        code: 'rejected',
        plugin: '@ax/core',
        hookName: 'blob:put',
        message: personFacing,
        reasonCode: 'storage-full',
      });
    });
    const ctx = fakeCtx() as unknown as { logger: { warn: ReturnType<typeof vi.fn> } };
    const result = (await blobPutHandler(Buffer.from('x'), ctx as never, bus as never)) as HandlerErr;
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: { code: 'HOOK_REJECTED', message: BLOB_PUT_STORAGE_FULL_FOR_AGENT },
    });
    // The operator still sees which policy refused, and the original sentence.
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'blob_put_refused',
      expect.objectContaining({ reasonCode: 'storage-full', reason: personFacing }),
    );
    expect(BLOB_PUT_STORAGE_FULL_FOR_AGENT).toMatch(/do not delete or move any files on your own/i);
    expect(BLOB_PUT_STORAGE_FULL_FOR_AGENT).not.toMatch(/try again|clean up files it no longer needs/i);
  });

  it('TASK-993: a refusal with some OTHER reason code still passes its own sentence', async () => {
    const reason = 'Some other policy said no, for its own reasons.';
    const bus = fakeBus(async () => {
      throw new PluginError({
        code: 'rejected',
        plugin: '@ax/core',
        hookName: 'blob:put',
        message: reason,
        reasonCode: 'some-other-policy',
      });
    });
    const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: { code: 'HOOK_REJECTED', message: reason } });
  });

  it('sanitizes a store returning a malformed sha (shape drift) to 500', async () => {
    const bus = fakeBus(async () => ({ sha256: 'not-a-sha', size: 1 }));
    const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
  });
});

describe('blob.put handler: who is charged (spec C4)', () => {
  const VALID = { sha256: VALID_SHA, size: 1 };
  const team = async () => ({ agent: { id: 'a1', ownerType: 'team', ownerId: 't1' } });

  function putCtxs(bus: ReturnType<typeof fakeBus>): Array<{ userId: string }> {
    return bus.call.mock.calls.filter((c) => c[0] === 'blob:put').map((c) => c[1] as { userId: string });
  }

  it("a team agent's put is gated and charged as team:<id>", async () => {
    const bus = fakeBus(async () => VALID, team);
    const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerOk;
    expect(result.status).toBe(200);
    expect(putCtxs(bus).map((c) => c.userId)).toEqual(['team:t1']);
  });

  it("a personal agent's put is charged to its owner", async () => {
    const owned = async () => ({ agent: { id: 'a1', ownerType: 'user', ownerId: 'owner-9' } });
    const bus = fakeBus(async () => VALID, owned);
    await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never);
    expect(putCtxs(bus).map((c) => c.userId)).toEqual(['owner-9']);
  });

  it('an ownerless session keeps ctx.userId and asks nobody', async () => {
    const bus = fakeBus(async () => VALID, team);
    const ctx = { ...(fakeCtx() as object), agentId: 'ownerless:s1' } as never;
    await blobPutHandler(Buffer.from('x'), ctx, bus as never);
    expect(putCtxs(bus).map((c) => c.userId)).toEqual(['u1']);
    expect(bus.call.mock.calls.some((c) => c[0] === 'agents:resolve')).toBe(false);
  });

  it('without agents:resolve the session person is charged', async () => {
    const bus = fakeBus(async () => VALID, team);
    bus.hasService.mockImplementation((h: string) => h !== 'agents:resolve');
    await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never);
    expect(putCtxs(bus).map((c) => c.userId)).toEqual(['u1']);
  });

  it('the session record keeps the ORIGINAL ctx, so artifact.publish still accepts the sha', async () => {
    const bus = fakeBus(async () => VALID, team);
    const ctx = fakeCtx();
    await blobPutHandler(Buffer.from('x'), ctx, bus as never);
    expect(sessionPutBlob(ctx, VALID_SHA)).toBe(true);
  });

  it('an agent that no longer resolves gets 404 and nothing is put', async () => {
    for (const code of ['not-found', 'forbidden'] as const) {
      const gone = async () => {
        throw new PluginError({ code, plugin: '@ax/agents', hookName: 'agents:resolve', message: 'x' });
      };
      const bus = fakeBus(async () => VALID, gone);
      const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerErr;
      expect(result.status).toBe(404);
      expect(putCtxs(bus)).toEqual([]);
    }
  });

  it('an agents:resolve outage is a sanitized 500 and nothing is put', async () => {
    const bus = fakeBus(async () => VALID, async () => {
      throw new Error('db down');
    });
    const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
    expect(putCtxs(bus)).toEqual([]);
  });

  it("P12: a team agent over quota gets the agent-addressed storage-full error", async () => {
    const bus = fakeBus(async (_h, _p, ctx) => {
      expect((ctx as { userId: string }).userId).toBe('team:t1');
      throw new PluginError({
        code: 'rejected',
        plugin: '@ax/disk-quota',
        hookName: 'blob:pre-put',
        message: 'The team is full',
        reasonCode: 'storage-full',
      });
    }, team);
    const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: { code: 'HOOK_REJECTED', message: BLOB_PUT_STORAGE_FULL_FOR_AGENT },
    });
  });
});

describe('blob.get handler (JSON request → binary response)', () => {
  const OTHER_SHA = 'b'.repeat(64);

  // A bus whose `attachments:list-for-conversation` answers with `listed` (the
  // bound conversation's uploads) and whose `blob:get` answers with `blob`.
  // Records every list request so a test can assert WHICH conversation was
  // asked about.
  function scopedBus(opts: {
    listed: string[];
    blob?: (sha: string) => Promise<unknown>;
    hasList?: boolean;
  }) {
    const listRequests: unknown[] = [];
    const bus = fakeBus(async (hook, payload) => {
      if (hook === 'attachments:list-for-conversation') {
        listRequests.push(payload);
        return {
          files: opts.listed.map((sha256, k) => ({
            attachmentId: `att-${k}`,
            filename: `f${k}.txt`,
            sha256,
            mediaType: 'text/plain',
            sizeBytes: 1,
          })),
        };
      }
      if (hook === 'blob:get') {
        const sha = (payload as { sha256: string }).sha256;
        return opts.blob ? opts.blob(sha) : { bytes: new Uint8Array([1, 2, 3]) };
      }
      throw new Error(`unexpected hook ${hook}`);
    });
    bus.hasService.mockImplementation(((hook: string) =>
      hook === 'attachments:list-for-conversation' ? opts.hasList !== false : true) as never);
    return { bus, listRequests };
  }

  function boundCtx(conversationId: string | null = 'conv-1') {
    return {
      sessionId: 's1',
      agentId: 'a1',
      userId: 'u1',
      ...(conversationId !== null ? { conversationId } : {}),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never;
  }

  function blobGetCalls(bus: ReturnType<typeof fakeBus>) {
    return bus.call.mock.calls.filter((c) => c[0] === 'blob:get');
  }

  it("streams a blob the bound conversation's uploads reference", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { bus, listRequests } = scopedBus({ listed: [OTHER_SHA, VALID_SHA], blob: async () => ({ bytes }) });
    const result = (await blobGetHandler({ sha256: VALID_SHA }, boundCtx(), bus as never)) as HandlerBinary;
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/octet-stream');
    expect(Buffer.from(result.binary).equals(Buffer.from(bytes))).toBe(true);
    // The scope is the conversation the SESSION is bound to.
    expect(listRequests).toEqual([{ conversationId: 'conv-1' }]);
    expect(blobGetCalls(bus).map((c) => c[2])).toEqual([{ sha256: VALID_SHA }]);
  });

  it('TASK-1009: refuses a blob the session does not own, without reading the store', async () => {
    const { bus } = scopedBus({ listed: [OTHER_SHA] });
    const ctx = boundCtx();
    const result = (await blobGetHandler({ sha256: VALID_SHA }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(404);
    // The hash alone is not a capability: the bytes are never fetched.
    expect(blobGetCalls(bus)).toHaveLength(0);
    // Logged host-side so a misbehaving runner is visible to operators.
    const warn = (ctx as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn;
    expect(warn).toHaveBeenCalledWith('blob_get_unreferenced_refused', {
      action: 'blob.get',
      reason: 'not-referenced',
    });
    // The sha is the would-be capability: it reaches no log level.
    const logger = (ctx as { logger: Record<string, ReturnType<typeof vi.fn>> }).logger;
    for (const level of ['info', 'warn', 'error', 'debug']) {
      // inspect, not JSON.stringify: it expands an Error's message and stack.
      expect(inspect(logger[level]!.mock.calls, { depth: null })).not.toContain(VALID_SHA);
    }
  });

  it('TASK-1009: "not yours" and "missing" give the runner the same response', async () => {
    // Not owned: the store holds the bytes, but nothing of this session references them.
    const notOwned = scopedBus({ listed: [OTHER_SHA] });
    const a = (await blobGetHandler({ sha256: VALID_SHA }, boundCtx(), notOwned.bus as never)) as HandlerErr;
    // Missing: referenced by the conversation, but the bytes are gone.
    const missing = scopedBus({ listed: [VALID_SHA], blob: async () => ({ found: false }) });
    const b = (await blobGetHandler({ sha256: VALID_SHA }, boundCtx(), missing.bus as never)) as HandlerErr;
    expect(a.status).toBe(404);
    expect(a).toEqual(b);
  });

  it('TASK-1009: a session bound to no conversation can fetch nothing', async () => {
    const { bus } = scopedBus({ listed: [VALID_SHA] });
    const ctx = boundCtx(null);
    const result = (await blobGetHandler({ sha256: VALID_SHA }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(404);
    expect(bus.call).not.toHaveBeenCalled();
    expect((ctx as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalledWith(
      'blob_get_unreferenced_refused',
      { action: 'blob.get', reason: 'unbound-session' },
    );
  });

  it('TASK-1009: an empty conversation binding can fetch nothing', async () => {
    const { bus } = scopedBus({ listed: [VALID_SHA] });
    const ctx = boundCtx('');
    const result = (await blobGetHandler({ sha256: VALID_SHA }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(404);
    expect(bus.call).not.toHaveBeenCalled();
    expect((ctx as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalledWith(
      'blob_get_unreferenced_refused',
      { action: 'blob.get', reason: 'unbound-session' },
    );
  });

  it('TASK-1009: with no uploads store loaded, fails closed (404, no store read)', async () => {
    const { bus } = scopedBus({ listed: [VALID_SHA], hasList: false });
    const ctx = boundCtx();
    const result = (await blobGetHandler({ sha256: VALID_SHA }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(404);
    expect(bus.call).not.toHaveBeenCalled();
    expect((ctx as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalledWith(
      'blob_get_unreferenced_refused',
      { action: 'blob.get', reason: 'no-uploads-store' },
    );
  });

  it('TASK-1009: a failing uploads lookup is a sanitized 500, never the bytes', async () => {
    const bus = fakeBus(async (hook) => {
      if (hook === 'attachments:list-for-conversation') throw new Error('db down at 10.0.0.5');
      return { bytes: new Uint8Array([9]) };
    });
    const result = (await blobGetHandler({ sha256: VALID_SHA }, boundCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('10.0.0.5');
    expect(blobGetCalls(bus)).toHaveLength(0);
  });

  it('TASK-1009: a PluginError from the uploads lookup maps like attachments.list does', async () => {
    const bus = fakeBus(async (hook) => {
      if (hook === 'attachments:list-for-conversation') {
        throw new PluginError({
          code: 'forbidden',
          plugin: '@ax/attachments',
          hookName: 'attachments:list-for-conversation',
          message: 'nope',
        });
      }
      return { bytes: new Uint8Array([9]) };
    });
    const result = (await blobGetHandler({ sha256: VALID_SHA }, boundCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(403);
    expect(blobGetCalls(bus)).toHaveLength(0);
  });

  it('TASK-1009: a wrapped lookup outage (PluginError unknown, as the real bus throws) is a LOGGED 500', async () => {
    const bus = fakeBus(async (hook) => {
      if (hook === 'attachments:list-for-conversation') {
        throw new PluginError({
          code: 'unknown',
          plugin: '@ax/attachments',
          hookName: 'attachments:list-for-conversation',
          message: 'db down',
        });
      }
      return { bytes: new Uint8Array([9]) };
    });
    const ctx = boundCtx();
    const result = (await blobGetHandler({ sha256: VALID_SHA }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
    expect(blobGetCalls(bus)).toHaveLength(0);
    expect((ctx as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalledWith(
      'ipc_dispatch_internal_error',
      expect.objectContaining({ action: 'blob.get', pluginErrorCode: 'unknown' }),
    );
  });

  it('TASK-1009: a malformed uploads answer fails closed (500, no store read)', async () => {
    const bus = fakeBus(async (hook) => {
      if (hook === 'attachments:list-for-conversation') return { files: 'nope' };
      return { bytes: new Uint8Array([9]) };
    });
    const ctx = boundCtx();
    const result = (await blobGetHandler({ sha256: VALID_SHA }, ctx, bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
    expect(blobGetCalls(bus)).toHaveLength(0);
    // A plain (unwrapped) failure is logged too, not just a PluginError.
    expect((ctx as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalledWith(
      'ipc_dispatch_internal_error',
      expect.objectContaining({ action: 'blob.get' }),
    );
  });

  it('rejects a malformed sha256 at the handler before calling any hook (traversal defense)', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not reach any hook');
    });
    const result = (await blobGetHandler({ sha256: '../../etc/passwd' }, boundCtx(), bus as never)) as HandlerErr;
    expect(result.status).not.toBe(200);
    expect(bus.call).not.toHaveBeenCalled();
  });
});
