import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHANGE_SHARED_REQUEST_MAX_BYTES } from '../storage-node/protocol.js';
import { STORAGE_REQUEST_MAX_BYTES, type StorageNodeEngine } from '../storage-node/engine.js';

// The route table and body caps, without TLS: createServer is captured and the
// handler driven with a fake request. The mTLS options are asserted as passed.
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
const state = vi.hoisted(() => ({ options: undefined as unknown, handler: undefined as unknown }));
vi.mock('node:https', () => ({
  createServer: vi.fn((options: unknown, handler: unknown) => {
    state.options = options; state.handler = handler;
    return { requestTimeout: 0, headersTimeout: 0, setTimeout: vi.fn() };
  }),
}));
const { createStorageServer, requestCap } = await import('../storage-node/server.js');

function engine() {
  return {
    assign: vi.fn(async () => ({ assignmentId: 'id' })), status: vi.fn(async () => ({ accepted: true })),
    release: vi.fn(async () => undefined),
    changeShared: vi.fn(async () => ({ kind: 'done', results: [{ path: 'a', outcome: 'created' }] })),
  };
}
async function send(e: ReturnType<typeof engine>, url: string, body: Buffer | string, method = 'POST') {
  createStorageServer(e as unknown as StorageNodeEngine, { key: 'k', cert: 'c', ca: 'ca' });
  const chunks = [Buffer.from(body)];
  const req = Object.assign({ method, url, destroy: vi.fn(), async *[Symbol.asyncIterator]() { yield* chunks; } });
  let status = 0; let out = '';
  const res = { writeHead: vi.fn((s: number) => { status = s; }), end: vi.fn((b: string) => { out = b; }) };
  await (state.handler as Handler)(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { status, body: JSON.parse(out) as unknown, req };
}

describe('storage-node server', () => {
  it('keeps mTLS: a client certificate from the deployment CA is required', async () => {
    await send(engine(), '/status', '{}');
    expect(state.options).toMatchObject({ requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', ca: 'ca' });
  });
  it('routes /change-shared to the engine with the raw wire body and replies 200', async () => {
    const e = engine();
    const wire = { folderId: 'sf_a', changes: [{ op: 'mkdir', path: 'a' }] };
    const out = await send(e, '/change-shared', JSON.stringify(wire));
    expect(out).toMatchObject({ status: 200, body: { kind: 'done', results: [{ path: 'a', outcome: 'created' }] } });
    expect(e.changeShared).toHaveBeenCalledWith(wire);
    expect(e.assign).not.toHaveBeenCalled();
  });
  it('replies 200 with a refusal, and 409 when the engine throws', async () => {
    const e = engine();
    e.changeShared.mockResolvedValueOnce({ kind: 'refused', refused: 'not-empty', results: [] } as never);
    expect(await send(e, '/change-shared', '{}')).toMatchObject({ status: 200, body: { kind: 'refused', refused: 'not-empty' } });
    e.changeShared.mockRejectedValueOnce(new Error('bad request'));
    expect(await send(e, '/change-shared', '{}')).toMatchObject({ status: 409, body: { error: 'storage operation rejected' } });
    expect(await send(e, '/change-shared', 'not json')).toMatchObject({ status: 409 });
  });
  it('gives /change-shared alone the large body cap', async () => {
    expect(requestCap('/change-shared')).toBe(CHANGE_SHARED_REQUEST_MAX_BYTES);
    for (const route of ['/assign', '/status', '/release']) expect(requestCap(route)).toBe(STORAGE_REQUEST_MAX_BYTES);
    expect(CHANGE_SHARED_REQUEST_MAX_BYTES).toBeGreaterThan(STORAGE_REQUEST_MAX_BYTES);
    // A body over the small cap is fine on /change-shared and refused on /status.
    const big = Buffer.alloc(STORAGE_REQUEST_MAX_BYTES + 1, 0x20);
    const e = engine();
    expect((await send(e, '/status', big)).status).toBe(413);
    expect(e.status).not.toHaveBeenCalled();
    expect((await send(e, '/change-shared', Buffer.concat([Buffer.from('{}'), big]))).status).toBe(200);
    const huge = Buffer.alloc(CHANGE_SHARED_REQUEST_MAX_BYTES + 1, 0x20);
    const refused = await send(e, '/change-shared', huge);
    expect(refused.status).toBe(413); expect(refused.req.destroy).toHaveBeenCalled();
    expect(e.changeShared).toHaveBeenCalledTimes(1);
  });
  it('buffers at most two /change-shared bodies at once; the rest wait their turn', async () => {
    const e = engine(); let open!: () => void; const gate = new Promise<void>(r => { open = r; });
    e.changeShared.mockImplementation(async () => { await gate; return { kind: 'done', results: [] }; });
    createStorageServer(e as unknown as StorageNodeEngine, {});
    const handler = state.handler as Handler;
    const call = () => handler({ method: 'POST', url: '/change-shared', destroy: vi.fn(),
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } } as unknown as IncomingMessage,
    { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse);
    const all = [call(), call(), call()];
    await new Promise(r => setTimeout(r, 10));
    expect(e.changeShared).toHaveBeenCalledTimes(2);
    open(); await Promise.all(all);
    expect(e.changeShared).toHaveBeenCalledTimes(3);
  });
  it('404s an unknown route or method', async () => {
    expect((await send(engine(), '/change-shared', '{}', 'GET')).status).toBe(404);
    expect((await send(engine(), '/write', '{}')).status).toBe(404);
  });
});
