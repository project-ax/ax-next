import { describe, it, expect, vi } from 'vitest';
import {
  writeWithBackpressure,
  type BackpressureSink,
  type PausableSource,
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
