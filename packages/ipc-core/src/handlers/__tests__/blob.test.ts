import { describe, it, expect, vi } from 'vitest';
import { blobGetHandler, blobPutHandler } from '../blob.js';
import type { HandlerBinary, HandlerErr, HandlerOk } from '../types.js';

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

  it('sanitizes a store returning a malformed sha (shape drift) to 500', async () => {
    const bus = fakeBus(async () => ({ sha256: 'not-a-sha', size: 1 }));
    const result = (await blobPutHandler(Buffer.from('x'), fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(500);
  });
});

describe('blob.get handler (JSON request → binary response)', () => {
  it('streams the blob bytes back as a binary response', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const bus = fakeBus(async (hook, payload) => {
      expect(hook).toBe('blob:get');
      expect((payload as { sha256: string }).sha256).toBe(VALID_SHA);
      return { bytes };
    });
    const result = (await blobGetHandler({ sha256: VALID_SHA }, fakeCtx(), bus as never)) as HandlerBinary;
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/octet-stream');
    expect(Buffer.from(result.binary).equals(Buffer.from(bytes))).toBe(true);
  });

  it('returns 404 when the blob is not found', async () => {
    const bus = fakeBus(async () => ({ found: false }));
    const result = (await blobGetHandler({ sha256: VALID_SHA }, fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).toBe(404);
  });

  it('rejects a malformed sha256 at the handler before calling blob:get (traversal defense)', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not reach blob:get');
    });
    const result = (await blobGetHandler({ sha256: '../../etc/passwd' }, fakeCtx(), bus as never)) as HandlerErr;
    expect(result.status).not.toBe(200);
    expect(bus.call).not.toHaveBeenCalled();
  });
});
