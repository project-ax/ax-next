import { describe, it, expect } from 'vitest';
import {
  StorageDeletePrefixOutputSchema,
  StorageGetOutputSchema,
  StorageListPrefixOutputSchema,
} from '../plugin.js';

// ARCH-13 drift guard for the data-returning storage:* hooks. The kv contract
// is opaque bytes (Uint8Array); the bytes must survive the round-trip by
// reference (a strict z.object on Uint8Array keeps the instance — it isn't a
// plain record whose keys get stripped).

describe('storage-sqlite return schemas', () => {
  it('storage:get round-trips a present value (bytes by reference)', () => {
    const value = new Uint8Array([1, 2, 3]);
    const parsed = StorageGetOutputSchema.parse({ value });
    expect(parsed.value).toBe(value);
  });

  it('storage:get round-trips an absent value', () => {
    expect(StorageGetOutputSchema.parse({ value: undefined })).toEqual({ value: undefined });
  });

  it('storage:get rejects a non-Uint8Array value', () => {
    expect(StorageGetOutputSchema.safeParse({ value: 'nope' }).success).toBe(false);
  });

  it('storage:list-prefix round-trips entries (bytes by reference)', () => {
    const value = new Uint8Array([9]);
    const parsed = StorageListPrefixOutputSchema.parse({ entries: [{ key: 'a', value }] });
    expect(parsed.entries[0]!.value).toBe(value);
    expect(parsed.entries[0]!.key).toBe('a');
  });

  it('storage:list-prefix accepts an empty entries array', () => {
    expect(StorageListPrefixOutputSchema.parse({ entries: [] })).toEqual({ entries: [] });
  });

  it('storage:delete-prefix round-trips', () => {
    expect(StorageDeletePrefixOutputSchema.parse({ deleted: 4 })).toEqual({ deleted: 4 });
  });

  it('storage:delete-prefix rejects a non-number deleted', () => {
    expect(StorageDeletePrefixOutputSchema.safeParse({ deleted: '4' }).success).toBe(false);
  });
});
