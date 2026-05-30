import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginError } from '@ax/core';
import { BlobStore, blobPath } from '../store.js';

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

describe('BlobStore (content-addressed fs store)', () => {
  let root: string;
  let store: BlobStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ax-blob-store-test-'));
    store = new BlobStore(root);
    await store.ensureRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('blobPath', () => {
    it('shards by the first two byte-pairs of the sha', () => {
      const sha = 'a'.repeat(64);
      expect(blobPath(root, sha)).toBe(join(root, 'aa', 'aa', sha));
    });
  });

  describe('put', () => {
    it('returns the content sha256 + size', async () => {
      const bytes = new TextEncoder().encode('hello blob');
      const { sha256, size } = await store.put(bytes);
      expect(sha256).toBe(sha256Hex(bytes));
      expect(size).toBe(bytes.length);
    });

    it('writes the object to the content-addressed path', async () => {
      const bytes = new TextEncoder().encode('on disk');
      const { sha256 } = await store.put(bytes);
      const onDisk = await fs.readFile(blobPath(root, sha256));
      expect(new Uint8Array(onDisk)).toEqual(bytes);
    });

    it('is idempotent on identical bytes — same sha, stored once', async () => {
      const bytes = new TextEncoder().encode('idempotent');
      const first = await store.put(bytes);
      const second = await store.put(bytes);
      expect(second.sha256).toBe(first.sha256);
      expect(second.size).toBe(first.size);
      // Exactly one file in the shard dir — no duplicate / leftover temp file.
      const shardDir = join(root, first.sha256.slice(0, 2), first.sha256.slice(2, 4));
      const entries = await fs.readdir(shardDir);
      expect(entries).toEqual([first.sha256]);
    });

    it('leaves no temp file behind after a successful put', async () => {
      const bytes = new TextEncoder().encode('no temp leak');
      const { sha256 } = await store.put(bytes);
      const shardDir = join(root, sha256.slice(0, 2), sha256.slice(2, 4));
      const entries = await fs.readdir(shardDir);
      expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
    });

    it('stores empty bytes (zero-length blob is valid)', async () => {
      const bytes = new Uint8Array(0);
      const { sha256, size } = await store.put(bytes);
      expect(size).toBe(0);
      expect(sha256).toBe(sha256Hex(bytes));
      const got = await store.get(sha256);
      expect('bytes' in got && got.bytes.length).toBe(0);
    });

    it('handles concurrent puts of the same bytes without corruption', async () => {
      const bytes = new TextEncoder().encode('race condition');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.put(bytes)),
      );
      const shas = new Set(results.map((r) => r.sha256));
      expect(shas.size).toBe(1);
      const sha = results[0]!.sha256;
      const shardDir = join(root, sha.slice(0, 2), sha.slice(2, 4));
      const entries = await fs.readdir(shardDir);
      expect(entries).toEqual([sha]); // exactly one object, no orphan temps
      const got = await store.get(sha);
      expect('bytes' in got && got.bytes).toEqual(bytes);
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
      // Tamper the on-disk bytes under the same (now-wrong) path.
      await fs.writeFile(blobPath(root, sha256), Buffer.from('tampered!'));
      await expect(store.get(sha256)).rejects.toMatchObject({
        code: 'corrupt',
      });
    });

    it('rejects an invalid sha (wrong length) before touching the fs', async () => {
      await expect(store.get('abc')).rejects.toBeInstanceOf(PluginError);
    });

    it('rejects an uppercase sha (must be lowercase hex)', async () => {
      await expect(store.get('A'.repeat(64))).rejects.toMatchObject({
        code: 'invalid-payload',
      });
    });

    it('rejects a path-traversal attempt in the sha key', async () => {
      // 64 chars but containing path metacharacters — must never build a path.
      const traversal = '../'.repeat(21) + 'a'; // 64 chars, has `..` and `/`
      expect(traversal.length).toBe(64);
      await expect(store.get(traversal)).rejects.toMatchObject({
        code: 'invalid-payload',
      });
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
});
