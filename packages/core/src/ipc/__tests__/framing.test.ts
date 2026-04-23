import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, MAX_FRAME } from '../framing.js';
import { PluginError } from '../../errors.js';

function prefixBuf(len: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(len, 0);
  return b;
}

describe('IPC framing', () => {
  it('round-trips a single clean frame', () => {
    const frame = encodeFrame({ a: 1 });
    const dec = new FrameDecoder();
    expect(dec.feed(frame)).toEqual([{ a: 1 }]);
  });

  it('buffers a chunk split mid-prefix', () => {
    const frame = encodeFrame({ a: 1 });
    const dec = new FrameDecoder();
    expect(dec.feed(frame.subarray(0, 2))).toEqual([]);
    expect(dec.feed(frame.subarray(2))).toEqual([{ a: 1 }]);
  });

  it('buffers a chunk split mid-body', () => {
    const frame = encodeFrame({ a: 1 });
    const dec = new FrameDecoder();
    expect(dec.feed(frame.subarray(0, 5))).toEqual([]);
    expect(dec.feed(frame.subarray(5))).toEqual([{ a: 1 }]);
  });

  it('handles two frames in a single chunk', () => {
    const f1 = encodeFrame({ a: 1 });
    const f2 = encodeFrame({ b: 2 });
    const dec = new FrameDecoder();
    expect(dec.feed(Buffer.concat([f1, f2]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('handles two frames across three chunks', () => {
    const f1 = encodeFrame({ a: 1 });
    const f2 = encodeFrame({ b: 2 });
    const combined = Buffer.concat([f1, f2]);
    const dec = new FrameDecoder();
    const firstChunk = combined.subarray(0, f1.length); // A, 7 bytes if body is 3
    const secondChunk = combined.subarray(f1.length, f1.length + 3);
    const thirdChunk = combined.subarray(f1.length + 3);
    expect(dec.feed(firstChunk)).toEqual([{ a: 1 }]);
    expect(dec.feed(secondChunk)).toEqual([]);
    expect(dec.feed(thirdChunk)).toEqual([{ b: 2 }]);
  });

  it('throws on oversize-declared frame before allocating body', () => {
    const dec = new FrameDecoder();
    const badPrefix = prefixBuf(5 * 1024 * 1024);
    expect(() => dec.feed(badPrefix)).toThrowError(PluginError);
    try {
      const d2 = new FrameDecoder();
      d2.feed(badPrefix);
    } catch (e) {
      expect((e as PluginError).code).toBe('invalid-payload');
      expect((e as PluginError).plugin).toBe('core');
      expect((e as PluginError).hookName).toBe('ipc');
    }
  });

  it('throws on malformed JSON body', () => {
    const body = Buffer.from([0xff, 0xfe, 0xfd, 0x7b]); // not valid utf-8 JSON
    const frame = Buffer.concat([prefixBuf(body.length), body]);
    const dec = new FrameDecoder();
    try {
      dec.feed(frame);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PluginError);
      expect((e as PluginError).code).toBe('invalid-payload');
    }
  });

  it('treats an empty chunk as a no-op', () => {
    const dec = new FrameDecoder();
    expect(dec.feed(Buffer.alloc(0))).toEqual([]);
    // state unchanged: a subsequent real frame still decodes
    expect(dec.feed(encodeFrame({ ok: true }))).toEqual([{ ok: true }]);
  });

  it('encodeFrame rejects a body larger than MAX_FRAME', () => {
    const big = { x: 'A'.repeat(5 * 1024 * 1024) };
    expect(() => encodeFrame(big)).toThrowError(PluginError);
    try {
      encodeFrame(big);
    } catch (e) {
      expect((e as PluginError).code).toBe('invalid-payload');
      expect((e as PluginError).plugin).toBe('core');
      expect((e as PluginError).hookName).toBe('ipc');
    }
  });

  it('MAX_FRAME is 4 MiB', () => {
    expect(MAX_FRAME).toBe(4 * 1024 * 1024);
  });
});
