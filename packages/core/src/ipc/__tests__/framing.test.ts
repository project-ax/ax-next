import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, MAX_FRAME } from '../framing.js';
import { PluginError } from '../../errors.js';

describe('framing', () => {
  it('round-trips a single frame', () => {
    const buf = encodeFrame({ hello: 'world' });
    const dec = new FrameDecoder();
    expect(dec.feed(buf)).toEqual([{ hello: 'world' }]);
  });

  it('recombines a chunk split mid-prefix', () => {
    const buf = encodeFrame({ x: 1 });
    const dec = new FrameDecoder();
    expect(dec.feed(buf.subarray(0, 2))).toEqual([]);
    expect(dec.feed(buf.subarray(2))).toEqual([{ x: 1 }]);
  });

  it('recombines a chunk split mid-payload', () => {
    const buf = encodeFrame({ x: 1 });
    const dec = new FrameDecoder();
    expect(dec.feed(buf.subarray(0, 5))).toEqual([]);
    expect(dec.feed(buf.subarray(5))).toEqual([{ x: 1 }]);
  });

  it('emits two frames from one chunk', () => {
    const a = encodeFrame({ a: 1 });
    const b = encodeFrame({ b: 2 });
    const dec = new FrameDecoder();
    expect(dec.feed(Buffer.concat([a, b]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('no-ops on empty chunk', () => {
    const dec = new FrameDecoder();
    expect(dec.feed(Buffer.alloc(0))).toEqual([]);
  });

  it('throws PluginError (not TypeError) on oversize-declared frame BEFORE allocation', () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(MAX_FRAME + 1, 0);
    const dec = new FrameDecoder();
    expect(() => dec.feed(prefix)).toThrow(PluginError);
  });

  it('throws PluginError on malformed JSON body', () => {
    const bad = Buffer.from('not json');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bad.length, 0);
    const dec = new FrameDecoder();
    expect(() => dec.feed(Buffer.concat([prefix, bad]))).toThrow(PluginError);
  });

  it('encodeFrame throws PluginError on circular input (not raw TypeError)', () => {
    const obj: any = {};
    obj.self = obj;
    expect(() => encodeFrame(obj)).toThrow(PluginError);
  });

  it('encodeFrame throws PluginError on undefined input', () => {
    expect(() => encodeFrame(undefined)).toThrow(PluginError);
  });

  it('encodeFrame throws PluginError on BigInt in input', () => {
    expect(() => encodeFrame({ n: 1n as unknown as number })).toThrow(PluginError);
  });
});
