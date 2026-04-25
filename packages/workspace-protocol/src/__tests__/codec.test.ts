import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes } from '../codec.js';

describe('codec', () => {
  it('round-trips an empty Uint8Array', () => {
    const out = base64ToBytes(bytesToBase64(new Uint8Array()));
    expect(out.byteLength).toBe(0);
  });
  it('round-trips arbitrary bytes', () => {
    const input = new Uint8Array([0, 1, 254, 255, 128, 42]);
    expect(Array.from(base64ToBytes(bytesToBase64(input)))).toEqual(Array.from(input));
  });
});
