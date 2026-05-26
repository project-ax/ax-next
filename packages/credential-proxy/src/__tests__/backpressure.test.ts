import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  writeWithBackpressure,
  readCappedBody,
  type BackpressureSink,
  type PausableSource,
  type CappedBodySource,
} from '../listener.js';

// ---------------------------------------------------------------------------
// writeWithBackpressure (TASK-24) — bounds the host's per-connection memory on
// a slow consumer. The MITM data pumps used to call `socket.write(chunk)` and
// ignore the boolean return; when the consumer (e.g. a runner-pod TLS socket
// during a multi-MB download) can't keep up, Node buffers the unwritten bytes
// in the socket's write queue unboundedly → OOM. This helper pauses the source
// when write() returns false and resumes on the destination's 'drain'.
// ---------------------------------------------------------------------------

function fakeSink(writeReturns: boolean): BackpressureSink & {
  emitDrain: () => void;
  written: Buffer[];
} {
  let drainCb: (() => void) | null = null;
  const written: Buffer[] = [];
  return {
    written,
    write(chunk: Buffer): boolean {
      written.push(chunk);
      return writeReturns;
    },
    once(_event: 'drain', listener: () => void): void {
      drainCb = listener;
    },
    emitDrain(): void {
      const cb = drainCb;
      drainCb = null;
      cb?.();
    },
  };
}

function fakeSource(): PausableSource & { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> } {
  return { pause: vi.fn(), resume: vi.fn() };
}

describe('writeWithBackpressure', () => {
  it('does not pause the source when the sink accepts the write (buffer not full)', () => {
    const src = fakeSource();
    const sink = fakeSink(true); // write() returns true → room available
    writeWithBackpressure(src, sink, Buffer.from('x'.repeat(1024)));
    expect(sink.written).toHaveLength(1);
    expect(src.pause).not.toHaveBeenCalled();
    expect(src.resume).not.toHaveBeenCalled();
  });

  it('pauses the source when the sink buffer is full and resumes on drain', () => {
    const src = fakeSource();
    const sink = fakeSink(false); // write() returns false → buffer full
    writeWithBackpressure(src, sink, Buffer.from('x'.repeat(1024)));
    expect(sink.written).toHaveLength(1); // the write still happened
    expect(src.pause).toHaveBeenCalledTimes(1);
    expect(src.resume).not.toHaveBeenCalled();
    // The destination drains → the source must resume.
    sink.emitDrain();
    expect(src.resume).toHaveBeenCalledTimes(1);
  });

  it('skips empty chunks (no write, no pause)', () => {
    const src = fakeSource();
    const sink = fakeSink(false);
    writeWithBackpressure(src, sink, Buffer.alloc(0));
    expect(sink.written).toHaveLength(0);
    expect(src.pause).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readCappedBody (TASK-24) — caps the plain-HTTP request body and, crucially,
// SETTLES on every terminal outcome (incl. an already-closed request — the
// client can abort while the caller was awaiting slow DNS, so the terminal
// event fired before the listeners attached and won't replay; the handler must
// not hang). Driven by a fake EventEmitter `req` so timing is deterministic.
// ---------------------------------------------------------------------------

/** A fake IncomingMessage-ish: an EventEmitter with mutable destroyed/ended. */
function fakeReq(init?: { destroyed?: boolean; readableEnded?: boolean }): EventEmitter & CappedBodySource {
  const ee = new EventEmitter() as EventEmitter & { destroyed: boolean; readableEnded: boolean };
  ee.destroyed = init?.destroyed ?? false;
  ee.readableEnded = init?.readableEnded ?? false;
  return ee as EventEmitter & CappedBodySource;
}

describe('readCappedBody', () => {
  it('collects an under-cap body and resolves on end', async () => {
    const req = fakeReq();
    const p = readCappedBody(req, 1024);
    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    req.emit('end');
    const r = await p;
    expect(r.aborted).toBe(false);
    expect(r.oversized).toBe(false);
    expect(r.body.toString()).toBe('hello world');
    expect(r.bodyBytes).toBe(11);
  });

  it('flags oversized once the cap is exceeded but keeps draining to end', async () => {
    const req = fakeReq();
    const p = readCappedBody(req, 8);
    req.emit('data', Buffer.alloc(6, 0x61));
    req.emit('data', Buffer.alloc(6, 0x62)); // total 12 > 8 → oversized
    req.emit('data', Buffer.alloc(100, 0x63)); // keep draining
    req.emit('end');
    const r = await p;
    expect(r.oversized).toBe(true);
    expect(r.aborted).toBe(false);
    expect(r.body).toHaveLength(0); // buffers freed on overflow
  });

  it('resolves aborted on close before end (client hung up mid-upload)', async () => {
    const req = fakeReq();
    const p = readCappedBody(req, 1024);
    req.emit('data', Buffer.from('partial'));
    req.emit('close'); // no 'end'
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.body).toHaveLength(0);
  });

  it('rejects on a stream error', async () => {
    const req = fakeReq();
    const p = readCappedBody(req, 1024);
    req.emit('error', new Error('socket reset'));
    await expect(p).rejects.toThrow('socket reset');
  });

  it('SETTLES immediately when the request is ALREADY destroyed (Codex round-8 — no hang)', async () => {
    // The abort fired before readCappedBody attached its listeners (the caller
    // was awaiting slow DNS). EventEmitter won't replay 'close'/'aborted', so
    // the up-front destroyed check is the only thing that settles this.
    const req = fakeReq({ destroyed: true });
    const r = await readCappedBody(req, 1024); // must NOT hang
    expect(r.aborted).toBe(true);
    expect(r.body).toHaveLength(0);
  });

  it('SETTLES immediately when the request already ended before listeners attached', async () => {
    const req = fakeReq({ readableEnded: true });
    const r = await readCappedBody(req, 1024); // must NOT hang
    expect(r.aborted).toBe(true);
  });
});
