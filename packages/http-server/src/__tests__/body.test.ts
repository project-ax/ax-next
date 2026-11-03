/**
 * TASK-1028 — `readBodyCapped` on a request that is already gone must SETTLE,
 * not hang.
 *
 * It used to attach data/error/end listeners and wait. `handle()` reads the
 * body only after awaiting `http:request`, so a client that hangs up during
 * that await leaves a request whose last event already fired: nothing ever
 * reached the listeners and the promise never settled. A bare destroy() after
 * attach emits only 'close', which it didn't listen for either. Each case
 * races the read against a short timer, so a regression reads as "hung"
 * rather than as a vitest timeout. Same shapes as ipc-core's TASK-1024 tests.
 */
import * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { BodyTooLargeError, readBodyCapped } from '../body.js';

type Outcome =
  | { kind: 'resolved'; value: unknown }
  | { kind: 'rejected'; err: unknown }
  | { kind: 'hung' };

async function settleWithin(p: Promise<unknown>, ms = 500): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'hung' }), ms);
  });
  try {
    return await Promise.race([
      p.then(
        (value): Outcome => ({ kind: 'resolved', value }),
        (err: unknown): Outcome => ({ kind: 'rejected', err }),
      ),
      hung,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fakeReq(headers: Record<string, string> = {}): http.IncomingMessage {
  const r = new Readable({ read() {} });
  (r as unknown as { headers: Record<string, string> }).headers = headers;
  return r as unknown as http.IncomingMessage;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
// Exact messages, so each test pins the branch that answered it.
const DESTROYED = 'request was already destroyed before its body was read';
const ENDED = 'request was already ended before its body was read';
const CLOSED = 'request closed before its body was read';

describe('readBodyCapped on a request that is already gone (TASK-1028)', () => {
  it('rejects when the request was destroyed before the read', async () => {
    const req = fakeReq();
    req.destroy();
    await tick(); // let 'close' fire before the reader attaches
    const out = await settleWithin(readBodyCapped(req, 1024));
    expect(out.kind).toBe('rejected');
    expect((out as { err: Error }).err.message).toBe(DESTROYED);
  });

  it('rejects with the original error when the request errored before the read', async () => {
    const req = fakeReq();
    const boom = new Error('client-reset-early');
    req.on('error', () => {}); // the pre-read error is someone else's to observe
    req.destroy(boom);
    await tick();
    const out = await settleWithin(readBodyCapped(req, 1024));
    expect(out.kind).toBe('rejected');
    // The very same object, not a structural look-alike.
    expect((out as { err: unknown }).err).toBe(boom);
  });

  it('rejects when the request already ended before the read', async () => {
    const req = fakeReq();
    req.push(null);
    req.resume();
    await new Promise((resolve) => req.on('end', resolve));
    await tick(); // auto-destroy lands too, as on a real IncomingMessage
    expect(req.destroyed).toBe(true);
    const out = await settleWithin(readBodyCapped(req, 1024));
    expect(out.kind).toBe('rejected');
    // Ended wins over destroyed: the bytes were consumed, not lost.
    expect((out as { err: Error }).err.message).toBe(ENDED);
  });

  it('rejects when the request closes mid-read with no end and no error', async () => {
    const req = fakeReq();
    const p = readBodyCapped(req, 1024);
    req.push(Buffer.from('{"partial":'));
    await tick();
    req.destroy();
    const out = await settleWithin(p);
    expect(out.kind).toBe('rejected');
    expect((out as { err: Error }).err.message).toBe(CLOSED);
  });

  it('rejects a real request whose client hung up before the read (ECONNRESET)', async () => {
    // The production shape: handle() awaits http:request, the client hangs
    // up meanwhile, and Node marks the request destroyed + errored with
    // nobody listening. The reader attaches only afterwards.
    let resolveOutcome!: (o: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let resolveSeen!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    const server = http.createServer((req) => {
      resolveSeen();
      req.socket.once('close', () => {
        void tick().then(async () => resolveOutcome(await settleWithin(readBodyCapped(req, 1024))));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('bad address');
      const client = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '100' },
      });
      client.on('error', () => {}); // we are the ones hanging up
      client.write('{"partial":'); // fewer bytes than declared: the body can't complete
      await requestSeen;
      client.destroy();

      const out = await Promise.race([
        outcome,
        new Promise<Outcome>((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 2000)),
      ]);
      expect(out.kind).toBe('rejected');
      expect((out as { err: NodeJS.ErrnoException }).err.code).toBe('ECONNRESET');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('still resolves a body that ends normally (end, then close)', async () => {
    const req = fakeReq();
    const p = readBodyCapped(req, 1024);
    req.push(Buffer.from('{"ok":true}'));
    req.push(null);
    const out = await settleWithin(p);
    expect(out.kind).toBe('resolved');
    expect((out as { value: Buffer }).value.toString()).toBe('{"ok":true}');
  });

  it('still answers an oversized body with BodyTooLargeError, not the close error', async () => {
    const req = fakeReq();
    const pending = settleWithin(readBodyCapped(req, 4));
    req.push(Buffer.from('0123456789'));
    await tick();
    req.destroy(); // the later close must not override the 413
    const out = await pending;
    expect(out.kind).toBe('rejected');
    expect((out as { err: unknown }).err).toBeInstanceOf(BodyTooLargeError);
  });
});
