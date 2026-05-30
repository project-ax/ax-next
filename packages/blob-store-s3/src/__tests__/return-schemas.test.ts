import { describe, expect, it } from 'vitest';
import {
  BlobDeleteOutputSchema,
  BlobGetOutputSchema,
  BlobPutOutputSchema,
  BlobStatOutputSchema,
} from '../plugin.js';

// ARCH-13 drift guard for the blob:* `returns` schemas. Each is a per-
// registration shape assertion; a new required field fails at compile, a new
// optional one fails here (zod object schemas strip undeclared keys → toEqual
// diverges). `bytes` is opaque Uint8Array — it must survive the round-trip by
// reference (z.instanceof keeps the instance, it isn't a plain record whose
// keys get stripped). These mirror @ax/blob-store-fs's drift guard so the two
// backends can't silently diverge on the shared blob:* surface.

describe('@ax/blob-store-s3 return schemas', () => {
  it('blob:put round-trips { sha256, size }', () => {
    const value = { sha256: 'a'.repeat(64), size: 12 };
    expect(BlobPutOutputSchema.parse(value)).toEqual(value);
  });

  it('blob:put rejects a non-number size', () => {
    expect(
      BlobPutOutputSchema.safeParse({ sha256: 'a'.repeat(64), size: '12' }).success,
    ).toBe(false);
  });

  it('blob:get round-trips a found object (bytes by reference)', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const parsed = BlobGetOutputSchema.parse({ bytes });
    expect('bytes' in parsed && parsed.bytes).toBe(bytes);
  });

  it('blob:get round-trips a not-found result', () => {
    expect(BlobGetOutputSchema.parse({ found: false })).toEqual({ found: false });
  });

  it('blob:get rejects a non-Uint8Array bytes field', () => {
    expect(BlobGetOutputSchema.safeParse({ bytes: 'nope' }).success).toBe(false);
  });

  it('blob:stat round-trips a size / not-found', () => {
    expect(BlobStatOutputSchema.parse({ size: 7 })).toEqual({ size: 7 });
    expect(BlobStatOutputSchema.parse({ found: false })).toEqual({ found: false });
  });

  it('blob:delete round-trips an empty object', () => {
    expect(BlobDeleteOutputSchema.parse({})).toEqual({});
  });
});
