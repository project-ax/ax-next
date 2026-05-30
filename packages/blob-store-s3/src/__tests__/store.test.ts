import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { PluginError } from '@ax/core';
import { S3BlobStore, blobKey } from '../store.js';
import { FakeS3Client } from './fake-s3.js';

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

const BUCKET = 'ax-blobs';

describe('S3BlobStore (content-addressed S3 store)', () => {
  let fake: FakeS3Client;
  let store: S3BlobStore;

  beforeEach(() => {
    fake = new FakeS3Client();
    store = new S3BlobStore(fake as unknown as S3Client, BUCKET);
  });

  afterEach(() => {
    fake.calls.length = 0;
  });

  describe('blobKey', () => {
    it('shards by the first two byte-pairs of the sha', () => {
      const sha = 'a'.repeat(64);
      expect(blobKey('', sha)).toBe(`aa/aa/${sha}`);
    });

    it('prepends a non-empty key prefix (normalized to one trailing slash)', () => {
      const sha = 'b'.repeat(64);
      expect(blobKey('blobs', sha)).toBe(`blobs/bb/bb/${sha}`);
      expect(blobKey('blobs/', sha)).toBe(`blobs/bb/bb/${sha}`);
    });

    it('strips MULTIPLE trailing slashes without regex backtracking (ReDoS guard)', () => {
      const sha = 'c'.repeat(64);
      expect(blobKey('blobs///', sha)).toBe(`blobs/cc/cc/${sha}`);
      // A pathological all-slashes prefix collapses to empty + must return
      // FAST (the non-regex strip is O(n), no polynomial backtracking).
      const t0 = Date.now();
      expect(blobKey('/'.repeat(100_000), sha)).toBe(`/cc/cc/${sha}`);
      expect(Date.now() - t0).toBeLessThan(1000);
    });
  });

  describe('put', () => {
    it('returns the content sha256 + size', async () => {
      const bytes = new TextEncoder().encode('hello blob');
      const { sha256, size } = await store.put(bytes);
      expect(sha256).toBe(sha256Hex(bytes));
      expect(size).toBe(bytes.length);
    });

    it('writes the object to the content-addressed key', async () => {
      const bytes = new TextEncoder().encode('on bucket');
      const { sha256 } = await store.put(bytes);
      expect(fake._get(BUCKET, blobKey('', sha256))).toEqual(bytes);
    });

    it('is idempotent on identical bytes — same sha, HeadObject fast-path skips re-PUT', async () => {
      const bytes = new TextEncoder().encode('idempotent');
      const first = await store.put(bytes);
      fake.calls.length = 0;
      const second = await store.put(bytes);
      expect(second.sha256).toBe(first.sha256);
      expect(second.size).toBe(first.size);
      // Second put must HeadObject, find it present, and NOT issue PutObject.
      expect(fake.calls.map((c) => c.name)).toEqual(['HeadObject']);
    });

    it('stores empty bytes (zero-length blob is valid)', async () => {
      const bytes = new Uint8Array(0);
      const { sha256, size } = await store.put(bytes);
      expect(size).toBe(0);
      expect(sha256).toBe(sha256Hex(bytes));
      const got = await store.get(sha256);
      expect('bytes' in got && got.bytes.length).toBe(0);
    });
  });

  describe('get', () => {
    it('round-trips the exact bytes', async () => {
      const bytes = new Uint8Array([0, 1, 2, 255, 128, 0, 7]);
      const { sha256 } = await store.put(bytes);
      const got = await store.get(sha256);
      expect('bytes' in got).toBe(true);
      expect('bytes' in got && got.bytes).toEqual(bytes);
    });

    it('returns { found: false } for a missing object', async () => {
      const missing = '0'.repeat(64);
      expect(await store.get(missing)).toEqual({ found: false });
    });

    it('REJECTS a tampered object (digest re-verification) — never returns bad bytes', async () => {
      const bytes = new TextEncoder().encode('original content');
      const { sha256 } = await store.put(bytes);
      // Tamper the stored bytes under the same (now-wrong) key.
      fake._put(BUCKET, blobKey('', sha256), new Uint8Array(Buffer.from('tampered!')));
      await expect(store.get(sha256)).rejects.toMatchObject({ code: 'corrupt' });
    });

    it('rejects an invalid sha (wrong length) before touching S3', async () => {
      await expect(store.get('abc')).rejects.toBeInstanceOf(PluginError);
      expect(fake.calls).toEqual([]);
    });

    it('rejects an uppercase sha (must be lowercase hex)', async () => {
      await expect(store.get('A'.repeat(64))).rejects.toMatchObject({
        code: 'invalid-payload',
      });
    });

    it('rejects a path-traversal attempt in the sha key', async () => {
      const traversal = '../'.repeat(21) + 'a'; // 64 chars, has `..` and `/`
      expect(traversal.length).toBe(64);
      await expect(store.get(traversal)).rejects.toMatchObject({
        code: 'invalid-payload',
      });
      expect(fake.calls).toEqual([]);
    });

    it('rejects a NUL byte in the sha key', async () => {
      const withNul = 'a'.repeat(63) + '\x00';
      await expect(store.get(withNul)).rejects.toMatchObject({
        code: 'invalid-payload',
      });
    });
  });

  describe('stat', () => {
    it('returns the size of a stored object', async () => {
      const bytes = new TextEncoder().encode('size me up');
      const { sha256 } = await store.put(bytes);
      expect(await store.stat(sha256)).toEqual({ size: bytes.length });
    });

    it('returns { found: false } for a missing object', async () => {
      expect(await store.stat('1'.repeat(64))).toEqual({ found: false });
    });

    it('rejects an invalid sha', async () => {
      await expect(store.stat('nope')).rejects.toMatchObject({
        code: 'invalid-payload',
      });
    });
  });

  describe('delete', () => {
    it('removes a stored object', async () => {
      const bytes = new TextEncoder().encode('delete me');
      const { sha256 } = await store.put(bytes);
      await store.delete(sha256);
      expect(await store.stat(sha256)).toEqual({ found: false });
      expect(await store.get(sha256)).toEqual({ found: false });
    });

    it('is idempotent — deleting a missing object is a no-op', async () => {
      await expect(store.delete('2'.repeat(64))).resolves.toBeUndefined();
    });

    it('rejects an invalid sha', async () => {
      await expect(store.delete('x')).rejects.toMatchObject({
        code: 'invalid-payload',
      });
    });
  });

  describe('keyPrefix', () => {
    it('round-trips through a configured prefix', async () => {
      const prefixed = new S3BlobStore(fake as unknown as S3Client, BUCKET, 'team-a');
      const bytes = new TextEncoder().encode('prefixed payload');
      const { sha256 } = await prefixed.put(bytes);
      expect(fake._get(BUCKET, blobKey('team-a', sha256))).toEqual(bytes);
      const got = await prefixed.get(sha256);
      expect('bytes' in got && got.bytes).toEqual(bytes);
    });
  });
});
