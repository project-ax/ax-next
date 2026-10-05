import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { PluginError } from '@ax/core';
import { S3BlobStore, blobKey, retiredBlobKey, type BlobListResult } from '../store.js';
import { FakeS3Client, type FakeS3Call } from './fake-s3.js';

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

const BUCKET = 'ax-blobs';

/** Fake-S3 jitter: no yield, a microtask, or a macrotask, at random. */
const randomYield = async (): Promise<void> => {
  const r = Math.random();
  if (r < 0.33) return;
  if (r < 0.66) {
    await Promise.resolve();
    return;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
};

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

  describe('retiredBlobKey', () => {
    it('files a retired blob under retired/ with the same shard', () => {
      const sha = 'a'.repeat(64);
      expect(retiredBlobKey('', sha)).toBe(`retired/aa/aa/${sha}`);
      expect(retiredBlobKey('blobs', sha)).toBe(`blobs/retired/aa/aa/${sha}`);
      expect(retiredBlobKey('blobs//', sha)).toBe(`blobs/retired/aa/aa/${sha}`);
    });

    it('never equals the live key for the same sha and prefix', () => {
      for (const p of ['', 'blobs', 'blobs/', 'team-a/x']) {
        const sha = 'd'.repeat(64);
        expect(retiredBlobKey(p, sha)).not.toBe(blobKey(p, sha));
      }
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

  it('has no delete method (blob:delete is gone; retire + purge replace it)', () => {
    expect('delete' in store).toBe(false);
  });

  describe('retire', () => {
    it('copies live -> retired, then deletes the live key', async () => {
      const bytes = new TextEncoder().encode('retire me');
      const { sha256 } = await store.put(bytes);
      fake.calls.length = 0;

      await expect(store.retire(sha256)).resolves.toBeUndefined();

      expect(fake.calls).toEqual([
        {
          name: 'CopyObject',
          Bucket: BUCKET,
          Key: retiredBlobKey('', sha256),
          CopySource: `${BUCKET}/${blobKey('', sha256)}`,
        },
        { name: 'DeleteObject', Bucket: BUCKET, Key: blobKey('', sha256) },
      ]);
      expect(fake._get(BUCKET, blobKey('', sha256))).toBeUndefined();
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toEqual(bytes);
    });

    it('URL-encodes the bucket and every key segment of CopySource', async () => {
      const odd = new S3BlobStore(fake as unknown as S3Client, 'my bucket', 'a b/c+d');
      const bytes = new TextEncoder().encode('odd names');
      const { sha256 } = await odd.put(bytes);
      fake.calls.length = 0;

      await odd.retire(sha256);

      const copy = fake.calls.find((c) => c.name === 'CopyObject')!;
      expect(copy.CopySource).toBe(
        `my%20bucket/a%20b/c%2Bd/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
      );
      expect(fake._get('my bucket', retiredBlobKey('a b/c+d', sha256))).toEqual(bytes);
    });

    it('a missing live blob is a no-op: nothing is deleted', async () => {
      const sha = '3'.repeat(64);
      await expect(store.retire(sha)).resolves.toBeUndefined();
      expect(fake.calls.map((c) => c.name)).toEqual(['CopyObject']);
    });

    it('is idempotent: retiring twice keeps the retired copy', async () => {
      const bytes = new TextEncoder().encode('retire twice');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      await store.retire(sha256);
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toEqual(bytes);
      expect(fake._get(BUCKET, blobKey('', sha256))).toBeUndefined();
    });

    it('rethrows a non-404 copy failure without deleting the live key', async () => {
      const bytes = new TextEncoder().encode('copy blows up');
      const { sha256 } = await store.put(bytes);
      const send = fake.send.bind(fake);
      fake.send = async (cmd) => {
        if (cmd.constructor.name === 'CopyObjectCommand') throw new Error('AccessDenied');
        return send(cmd);
      };
      await expect(store.retire(sha256)).rejects.toThrow('AccessDenied');
      expect(fake._get(BUCKET, blobKey('', sha256))).toEqual(bytes);
    });

    it('rejects an invalid sha before touching S3', async () => {
      await expect(store.retire('../'.repeat(21) + 'a')).rejects.toMatchObject({
        code: 'invalid-payload',
      });
      expect(fake.calls).toEqual([]);
    });
  });

  describe('purge', () => {
    it('deletes the retired key only', async () => {
      const bytes = new TextEncoder().encode('purge me');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      fake.calls.length = 0;

      await expect(store.purge(sha256)).resolves.toBeUndefined();

      expect(fake.calls).toEqual([
        { name: 'DeleteObject', Bucket: BUCKET, Key: retiredBlobKey('', sha256) },
      ]);
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toBeUndefined();
      expect(await store.get(sha256)).toEqual({ found: false });
    });

    it.each([
      ['no prefix', ''],
      ['a prefix', 'team-a/'],
    ])('never touches a LIVE blob of the same sha (%s)', async (_label, prefix) => {
      const s = new S3BlobStore(fake as unknown as S3Client, BUCKET, prefix);
      const bytes = new TextEncoder().encode('i am live, leave me alone');
      const { sha256 } = await s.put(bytes);
      fake.calls.length = 0;

      await s.purge(sha256);
      await s.purge(sha256);

      expect(fake._get(BUCKET, blobKey(prefix, sha256))).toEqual(bytes);
      const live = blobKey(prefix, sha256);
      for (const c of fake.calls) {
        expect(c.Key).not.toBe(live);
        expect(c.CopySource ?? '').not.toContain(live);
      }
      const got = await s.get(sha256);
      expect('bytes' in got && got.bytes).toEqual(bytes);
    });

    it('is idempotent: purging a missing sha is a no-op', async () => {
      await expect(store.purge('4'.repeat(64))).resolves.toBeUndefined();
      await expect(store.purge('4'.repeat(64))).resolves.toBeUndefined();
    });

    it('rejects an invalid sha before touching S3', async () => {
      await expect(store.purge('A'.repeat(64))).rejects.toMatchObject({
        code: 'invalid-payload',
      });
      expect(fake.calls).toEqual([]);
    });
  });

  describe('restore on miss', () => {
    async function putAndRetire(text: string): Promise<{ sha256: string; bytes: Uint8Array }> {
      const bytes = new TextEncoder().encode(text);
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      fake.calls.length = 0;
      return { sha256, bytes };
    }

    it('get restores a retired blob (copy back, retired key deleted) and serves it', async () => {
      const { sha256, bytes } = await putAndRetire('bring me back');

      const got = await store.get(sha256);

      expect('bytes' in got && got.bytes).toEqual(bytes);
      expect(fake._get(BUCKET, blobKey('', sha256))).toEqual(bytes);
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toBeUndefined();
      expect(fake.calls.map((c) => c.name)).toEqual([
        'GetObject',
        'CopyObject',
        'DeleteObject',
        'GetObject',
      ]);
      expect(fake.calls[1]).toMatchObject({
        Key: blobKey('', sha256),
        CopySource: `${BUCKET}/${retiredBlobKey('', sha256)}`,
      });
      expect(fake.calls[2]).toMatchObject({ Key: retiredBlobKey('', sha256) });
    });

    it('get still digest-verifies a tampered retired object (corrupt, never served)', async () => {
      const { sha256 } = await putAndRetire('honest bytes');
      fake._put(BUCKET, retiredBlobKey('', sha256), new TextEncoder().encode('evil swap'));

      await expect(store.get(sha256)).rejects.toMatchObject({ code: 'corrupt' });
    });

    it('stat restores a retired blob and reports its size', async () => {
      const { sha256, bytes } = await putAndRetire('stat me back');

      expect(await store.stat(sha256)).toEqual({ size: bytes.length });

      expect(fake._get(BUCKET, blobKey('', sha256))).toEqual(bytes);
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toBeUndefined();
    });

    it('stat({ restore: false }) reports a retired size without moving it', async () => {
      const { sha256, bytes } = await putAndRetire('leave me retired');

      expect(await store.stat(sha256, { restore: false })).toEqual({ size: bytes.length });

      expect(fake.calls.map((c) => c.name)).toEqual(['HeadObject', 'HeadObject']);
      expect(fake.calls[1]!.Key).toBe(retiredBlobKey('', sha256));
      expect(fake._get(BUCKET, blobKey('', sha256))).toBeUndefined();
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toEqual(bytes);
    });

    it('stat({ restore: false }) on a live blob is a single HeadObject', async () => {
      const bytes = new TextEncoder().encode('just live');
      const { sha256 } = await store.put(bytes);
      fake.calls.length = 0;
      expect(await store.stat(sha256, { restore: false })).toEqual({ size: bytes.length });
      expect(fake.calls.map((c) => c.name)).toEqual(['HeadObject']);
    });

    it('stat({ restore: false }) of a sha missing everywhere is { found: false }', async () => {
      expect(await store.stat('5'.repeat(64), { restore: false })).toEqual({ found: false });
      expect(fake.calls.some((c) => c.name === 'CopyObject' || c.name === 'DeleteObject')).toBe(
        false,
      );
    });

    it.each([['yes'], [1], [null], [{}]])(
      'stat rejects a non-boolean restore (%j) with invalid-payload, before touching S3',
      async (restore) => {
        await expect(
          store.stat('6'.repeat(64), { restore } as unknown as { restore: boolean }),
        ).rejects.toMatchObject({ code: 'invalid-payload' });
        expect(fake.calls).toEqual([]);
      },
    );

    it('get and stat of a sha missing everywhere are { found: false } and write nothing', async () => {
      expect(await store.get('7'.repeat(64))).toEqual({ found: false });
      expect(await store.stat('7'.repeat(64))).toEqual({ found: false });
      expect(fake.buckets.get(BUCKET)?.size ?? 0).toBe(0);
    });

    it('a restore that loses the race re-reads live once (the winner already restored)', async () => {
      const { sha256, bytes } = await putAndRetire('lost the race');
      // Simulate another reader finishing its restore between our live miss and
      // our copy: when our CopyObject arrives the retired copy is already gone.
      const send = fake.send.bind(fake);
      let raced = false;
      fake.send = async (cmd) => {
        if (!raced && cmd.constructor.name === 'CopyObjectCommand') {
          raced = true;
          fake._put(BUCKET, blobKey('', sha256), fake._get(BUCKET, retiredBlobKey('', sha256))!);
          fake.buckets.get(BUCKET)!.delete(retiredBlobKey('', sha256));
        }
        return send(cmd);
      };

      const got = await store.get(sha256);

      expect('bytes' in got && got.bytes).toEqual(bytes);
      expect(fake.calls.map((c) => c.name)).toEqual(['GetObject', 'CopyObject', 'GetObject']);
    });

    it('a restore that loses the race to a purge reports { found: false }', async () => {
      const { sha256 } = await putAndRetire('purged under me');
      const send = fake.send.bind(fake);
      fake.send = async (cmd) => {
        if (cmd.constructor.name === 'CopyObjectCommand') {
          fake.buckets.get(BUCKET)!.delete(retiredBlobKey('', sha256));
        }
        return send(cmd);
      };
      expect(await store.get(sha256)).toEqual({ found: false });
      expect(await store.stat(sha256)).toEqual({ found: false });
    });

    it('two concurrent gets of a retired blob both get the bytes (jitter on)', async () => {
      fake.jitter = randomYield;
      for (let round = 0; round < 50; round += 1) {
        const bytes = new TextEncoder().encode(`concurrent-restore-${round}`);
        const { sha256 } = await store.put(bytes);
        await store.retire(sha256);
        const [a, b, c] = await Promise.all([
          store.get(sha256),
          store.get(sha256),
          store.stat(sha256),
        ]);
        expect('bytes' in a && a.bytes).toEqual(bytes);
        expect('bytes' in b && b.bytes).toEqual(bytes);
        expect(c).toEqual({ size: bytes.length });
      }
    });
  });

  // -------------------------------------------------------------------------
  // A MOVE KILLED HALFWAY (TASK-836). S3 has no rename, so retire and restore
  // are CopyObject then DeleteObject. Kill the process between the two and
  // BOTH copies are left, never none, and the bytes stay readable. The GC's
  // next sweep sees the sha in both listings and repairs it with
  // `stat({ restore: true })` then `purge`, which is exercised here against
  // the real store code.
  // -------------------------------------------------------------------------
  describe('a move killed between its CopyObject and its DeleteObject', () => {
    /** The process dies on the first DeleteObject of `key`: the request never lands. */
    function killOnDeleteOf(key: string): void {
      const send = fake.send.bind(fake);
      let killed = false;
      fake.send = async (cmd) => {
        const input = (cmd as { input?: { Key?: string } }).input;
        if (!killed && cmd.constructor.name === 'DeleteObjectCommand' && input?.Key === key) {
          killed = true;
          throw new Error('process killed');
        }
        return send(cmd);
      };
    }

    async function bothCopiesAreThere(sha256: string, bytes: Uint8Array): Promise<void> {
      expect(fake._get(BUCKET, blobKey('', sha256))).toEqual(bytes);
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toEqual(bytes);
      // Both listings name it: this is what the sweep's repair keys off.
      expect((await store.list({ state: 'live', limit: 10 })).items).toEqual([
        { sha256, size: bytes.length },
      ]);
      expect((await store.list({ state: 'retired', limit: 10 })).items).toEqual([
        { sha256, size: bytes.length },
      ]);
    }

    /** The sweep's repair for a retired copy under a live row. */
    async function sweepRepair(sha256: string, bytes: Uint8Array): Promise<void> {
      expect(await store.stat(sha256, { restore: true })).toEqual({ size: bytes.length });
      await store.purge(sha256);
      expect(fake._get(BUCKET, blobKey('', sha256))).toEqual(bytes);
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toBeUndefined();
      const got = await store.get(sha256);
      expect('bytes' in got && got.bytes).toEqual(bytes);
    }

    it('retire killed after its copy: both copies, still readable, and the repair keeps the live one', async () => {
      const bytes = new TextEncoder().encode('retire killed halfway');
      const { sha256 } = await store.put(bytes);
      killOnDeleteOf(blobKey('', sha256));

      await expect(store.retire(sha256)).rejects.toThrow('process killed');

      await bothCopiesAreThere(sha256, bytes);
      fake.calls.length = 0;
      const got = await store.get(sha256);
      expect('bytes' in got && got.bytes).toEqual(bytes);
      // Served from live: no move was attempted.
      expect(fake.calls.map((c) => c.name)).toEqual(['GetObject']);
      await sweepRepair(sha256, bytes);
    });

    it('retire killed after its copy, then retired again: the second retire finishes the move', async () => {
      const bytes = new TextEncoder().encode('retire killed, retried');
      const { sha256 } = await store.put(bytes);
      killOnDeleteOf(blobKey('', sha256));
      await expect(store.retire(sha256)).rejects.toThrow('process killed');

      await store.retire(sha256);

      expect(fake._get(BUCKET, blobKey('', sha256))).toBeUndefined();
      expect(fake._get(BUCKET, retiredBlobKey('', sha256))).toEqual(bytes);
    });

    it('restore killed after its copy back: both copies, still readable, and the repair drops the retired one', async () => {
      const bytes = new TextEncoder().encode('restore killed halfway');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      killOnDeleteOf(retiredBlobKey('', sha256));

      await expect(store.get(sha256)).rejects.toThrow('process killed');

      await bothCopiesAreThere(sha256, bytes);
      await sweepRepair(sha256, bytes);
    });

    it('the repair restores, never purges, a retired copy that is the ONLY copy', async () => {
      const bytes = new TextEncoder().encode('only the retired copy');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);

      await sweepRepair(sha256, bytes);
    });
  });

  // -------------------------------------------------------------------------
  // THE RACE (design D3). A put whose HeadObject fast path sees the live key
  // can return success while a concurrent retire moves that key away. Nothing
  // may be lost: the following get must restore and serve the bytes. With the
  // jitter on, each S3 round-trip yields at random so the two operations
  // genuinely interleave at every command boundary.
  // -------------------------------------------------------------------------
  it('put racing retire never loses the blob (1000 rounds, jitter on)', async () => {
    fake.jitter = randomYield;
    const failures: number[] = [];
    for (let round = 0; round < 1000; round += 1) {
      const bytes = new Uint8Array(randomBytes(8 + (round % 24)));
      const { sha256 } = await store.put(bytes);
      await Promise.all([store.put(bytes), store.retire(sha256)]);
      const got = await store.get(sha256);
      if (!('bytes' in got) || !Buffer.from(got.bytes).equals(Buffer.from(bytes))) {
        failures.push(round);
      }
    }
    expect({ failed: failures.length, first: failures.slice(0, 5) }).toEqual({
      failed: 0,
      first: [],
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

// ---------------------------------------------------------------------------
// list — the GC's enumeration seam (blob:list, TASK-777). One ListObjectsV2
// scan of the live namespace, ascending by sha, with a cursor (`next`) the
// caller feeds back as `after`.
// ---------------------------------------------------------------------------

/** A sha-shaped string whose first four chars are `aa` + `bb`. List never reads content. */
const shaIn = (aa: string, bb: string, fill = '0'): string => aa + bb + fill.repeat(60);

/** Put `count` distinct tiny blobs through the real `put`. Returns their shas, sorted. */
async function seedBlobs(store: S3BlobStore, count: number, tag: string): Promise<string[]> {
  const shas: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { sha256 } = await store.put(new TextEncoder().encode(`${tag}-${i}`));
    shas.push(sha256);
  }
  return shas.sort();
}

/** Page through the store the way a caller does: feed each `next` back as `after`. */
async function drain(
  store: S3BlobStore,
  limit: number,
  start?: string,
): Promise<BlobListResult[]> {
  const pages: BlobListResult[] = [];
  let after = start;
  for (;;) {
    const page: BlobListResult = await store.list(
      after === undefined ? { state: 'live', limit } : { state: 'live', limit, after },
    );
    pages.push(page);
    if (page.next === undefined) return pages;
    after = page.next;
    if (pages.length > 100) throw new Error('list did not terminate');
  }
}

describe.each([
  { label: 'no key prefix', prefix: '' },
  // Trailing slash on purpose: the store normalizes it away.
  { label: 'a key prefix', prefix: 'team-a/' },
])('S3BlobStore.list ($label)', ({ prefix }) => {
  let fake: FakeS3Client;
  let store: S3BlobStore;

  /** Where a key sits under this store's prefix. */
  const key = (rest: string): string => (prefix === '' ? rest : `${prefix}${rest}`);
  const listCalls = (): FakeS3Call[] => fake.calls.filter((c) => c.name === 'ListObjectsV2');

  beforeEach(() => {
    fake = new FakeS3Client();
    store = new S3BlobStore(fake as unknown as S3Client, BUCKET, prefix);
  });

  it('returns { items: [] } for an empty bucket (and no `next` key)', async () => {
    const page = await store.list({ state: 'live', limit: 10 });
    expect(page).toEqual({ items: [] });
    expect('next' in page).toBe(false);
  });

  it('lists stored blobs ascending by sha with their sizes', async () => {
    const payloads = ['alpha', 'bravo-bravo', 'c', '', 'delta delta delta'].map((t) =>
      new TextEncoder().encode(t),
    );
    for (const p of payloads) await store.put(p);
    const expected = payloads
      .map((p) => ({ sha256: sha256Hex(p), size: p.length }))
      .sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));

    const page = await store.list({ state: 'live', limit: 100 });

    expect(page.items).toEqual(expected);
    expect('next' in page).toBe(false);
  });

  it('asks S3 for the prefix, the cursor and the limit', async () => {
    const shas = await seedBlobs(store, 6, 'request-shape');
    fake.calls.length = 0;

    await store.list({ state: 'live', limit: 4 });
    await store.list({ state: 'live', limit: 3, after: shas[1]! });

    const base = prefix === '' ? {} : { Prefix: 'team-a/' };
    expect(listCalls()).toEqual([
      { name: 'ListObjectsV2', Bucket: BUCKET, MaxKeys: 4, ...base },
      {
        name: 'ListObjectsV2',
        Bucket: BUCKET,
        MaxKeys: 3,
        StartAfter: blobKey(prefix, shas[1]!),
        ...base,
      },
    ]);
  });

  it('`after` excludes itself and everything before it', async () => {
    const shas = await seedBlobs(store, 40, 'after');
    const pivot = shas[17]!;

    const page = await store.list({ state: 'live', limit: 100, after: pivot });

    expect(page.items.map((i) => i.sha256)).toEqual(shas.slice(18));
  });

  it('`after` need not name a stored blob', async () => {
    const shas = await seedBlobs(store, 20, 'ghost-cursor');
    const ghost = shas[9]!;
    fake.buckets.get(BUCKET)!.delete(blobKey(prefix, ghost));

    const page = await store.list({ state: 'live', limit: 100, after: ghost });

    expect(page.items.map((i) => i.sha256)).toEqual(shas.slice(10));
  });

  it('sets `next` to the last sha iff the page is full', async () => {
    const shas = await seedBlobs(store, 5, 'next');

    const full = await store.list({ state: 'live', limit: 5 });
    expect(full.items).toHaveLength(5);
    expect(full.next).toBe(shas[4]);

    const partial = await store.list({ state: 'live', limit: 6 });
    expect(partial.items).toHaveLength(5);
    expect('next' in partial).toBe(false);

    const small = await store.list({ state: 'live', limit: 2 });
    expect(small.items.map((i) => i.sha256)).toEqual(shas.slice(0, 2));
    expect(small.next).toBe(shas[1]);
  });

  it('never returns temp keys, retired/, other prefixes, or keys that are not blobs', async () => {
    const real = await store.put(new TextEncoder().encode('the one real blob'));
    const sha = real.sha256;
    const seed = (k: string): void => fake._put(BUCKET, k, new Uint8Array([1, 2, 3]));

    // A temp object right next to a real blob (an in-flight upload).
    seed(`${blobKey(prefix, sha)}.tmp.x`);
    // A temp object for a sha that has no final object.
    seed(key(`ab/ab/${shaIn('ab', 'ab', 'c')}.tmp.9.uuid`));
    // The retired namespace (a later card fills it) sits under the same prefix.
    seed(key(`retired/cd/cd/${shaIn('cd', 'cd')}`));
    // Shapes that are not blobs: wrong shard, uppercase, extra / missing levels, junk.
    seed(key(`ab/ab/${shaIn('cd', 'cd')}`));
    seed(key(`AA/BB/${shaIn('AA', 'BB')}`));
    seed(key(`ab/cd/${shaIn('ab', 'cd')}/extra`));
    seed(key(`ab/${shaIn('ab', 'cd')}`));
    seed(key('ab/cd/not-a-sha'));
    seed(key('README'));
    seed(key('zz/zz/zzzz'));
    // Beside the prefix: a sibling namespace, another store's blobs, the bucket root.
    seed(`team-a2/ee/ee/${shaIn('ee', 'ee')}`);
    seed(`team-b/ee/ee/${shaIn('ee', 'ee')}`);
    if (prefix !== '') seed(`ee/ee/${shaIn('ee', 'ee')}`);

    const page = await store.list({ state: 'live', limit: 100 });

    expect(page.items).toEqual([{ sha256: sha, size: real.size }]);
  });

  it('stops at the first key past the hex shards, so retired/ is never read', async () => {
    const live = await seedBlobs(store, 10, 'before-retired');
    // 2,500 retired keys would take three full pages to scan.
    for (let i = 0; i < 2500; i += 1) {
      const sha = sha256Hex(new TextEncoder().encode(`retired-${i}`));
      fake._put(
        BUCKET,
        key(`retired/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`),
        new Uint8Array(1),
      );
    }
    fake.calls.length = 0;

    const page = await store.list({ state: 'live', limit: 1000 });

    expect(page.items.map((i) => i.sha256)).toEqual(live);
    expect('next' in page).toBe(false);
    // The first page already showed a `retired/` key; no second request.
    expect(listCalls()).toHaveLength(1);
  });

  it('keeps paging S3 past pages of non-blobs until the limit is filled', async () => {
    // 300 temp keys sort ahead of the real blobs, so with MaxKeys = limit the
    // first requests come back with nothing usable in them.
    for (let i = 0; i < 300; i += 1) {
      fake._put(BUCKET, key(`00/00/${shaIn('00', '00')}.tmp.${i}`), new Uint8Array(1));
    }
    const realShas = [shaIn('f0', '00', '1'), shaIn('f0', '00', '2'), shaIn('f0', '01', '3')];
    for (const sha of realShas) {
      fake._put(BUCKET, key(`${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`), new Uint8Array(7));
    }
    fake.calls.length = 0;

    const page = await store.list({ state: 'live', limit: 2 });

    expect(page.items).toEqual(realShas.slice(0, 2).map((sha256) => ({ sha256, size: 7 })));
    expect(page.next).toBe(realShas[1]);
    const calls = listCalls();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]!.ContinuationToken).toBeUndefined();
    for (const c of calls.slice(1)) expect(c.ContinuationToken).toBeDefined();
  });

  describe("state: 'retired'", () => {
    /** Put + retire `count` blobs; returns their shas, sorted. */
    async function seedRetired(count: number, tag: string): Promise<string[]> {
      const shas = await seedBlobs(store, count, tag);
      for (const sha of shas) await store.retire(sha);
      return shas;
    }
    const listRetired = (limit: number, after?: string): Promise<BlobListResult> =>
      store.list(
        after === undefined ? { state: 'retired', limit } : { state: 'retired', limit, after },
      );

    it('is empty when nothing is retired, even with live blobs', async () => {
      await seedBlobs(store, 5, 'live-only');
      const page = await listRetired(10);
      expect(page).toEqual({ items: [] });
      expect('next' in page).toBe(false);
    });

    it('lists retired blobs ascending by sha with their sizes, and live listing excludes them', async () => {
      const payloads = ['r-one', 'r-two-two', ''].map((t) => new TextEncoder().encode(t));
      for (const p of payloads) await store.retire((await store.put(p)).sha256);
      const stillLive = await store.put(new TextEncoder().encode('stays live'));
      const expected = payloads
        .map((p) => ({ sha256: sha256Hex(p), size: p.length }))
        .sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));

      expect((await listRetired(100)).items).toEqual(expected);
      expect((await store.list({ state: 'live', limit: 100 })).items).toEqual([
        { sha256: stillLive.sha256, size: stillLive.size },
      ]);
    });

    it('asks S3 for the retired prefix, with StartAfter = the retired key of `after`', async () => {
      const shas = await seedRetired(6, 'retired-request-shape');
      fake.calls.length = 0;

      await listRetired(4);
      await listRetired(3, shas[1]!);

      const retiredPrefix = prefix === '' ? 'retired/' : 'team-a/retired/';
      expect(listCalls()).toEqual([
        { name: 'ListObjectsV2', Bucket: BUCKET, MaxKeys: 4, Prefix: retiredPrefix },
        {
          name: 'ListObjectsV2',
          Bucket: BUCKET,
          MaxKeys: 3,
          Prefix: retiredPrefix,
          StartAfter: retiredBlobKey(prefix, shas[1]!),
        },
      ]);
    });

    it('`after` is exclusive and `next` is set iff the page is full', async () => {
      const shas = await seedRetired(7, 'retired-paging');

      const after = await listRetired(100, shas[2]!);
      expect(after.items.map((i) => i.sha256)).toEqual(shas.slice(3));
      expect('next' in after).toBe(false);

      const full = await listRetired(3);
      expect(full.items.map((i) => i.sha256)).toEqual(shas.slice(0, 3));
      expect(full.next).toBe(shas[2]);

      const exact = await listRetired(7);
      expect(exact.next).toBe(shas[6]);
      const empty = await listRetired(7, exact.next);
      expect(empty).toEqual({ items: [] });
    });

    it('pages 2,500 retired blobs 1000 / 1000 / 500 with no duplicates', async () => {
      const all: string[] = [];
      for (let i = 0; i < 2500; i += 1) {
        const sha = sha256Hex(new TextEncoder().encode(`retired-big-${i}`));
        fake._put(BUCKET, retiredBlobKey(prefix, sha), new Uint8Array(2));
        all.push(sha);
      }
      all.sort();
      const pages: BlobListResult[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await listRetired(1000, after);
        pages.push(page);
        if (page.next === undefined) break;
        after = page.next;
      }
      expect(pages.map((p) => p.items.length)).toEqual([1000, 1000, 500]);
      expect(pages.flatMap((p) => p.items.map((i) => i.sha256))).toEqual(all);
    });

    it('only well-formed keys count: no temp keys, wrong shards, live keys or other prefixes', async () => {
      const [sha] = await seedRetired(1, 'the-retired-one');
      const seed = (k: string): void => fake._put(BUCKET, k, new Uint8Array([1, 2, 3]));
      seed(`${retiredBlobKey(prefix, sha!)}.tmp.x`);
      seed(key(`retired/ab/ab/${shaIn('cd', 'cd')}`));
      seed(key(`retired/AA/BB/${shaIn('AA', 'BB')}`));
      seed(key(`retired/ab/cd/${shaIn('ab', 'cd')}/extra`));
      seed(key(`retired/ab/${shaIn('ab', 'cd')}`));
      seed(key('retired/README'));
      seed(key(`retired2/ee/ee/${shaIn('ee', 'ee')}`));
      seed(key(`ee/ee/${shaIn('ee', 'ee')}`));
      seed(`team-b/retired/ee/ee/${shaIn('ee', 'ee')}`);
      if (prefix !== '') seed(`retired/ee/ee/${shaIn('ee', 'ee')}`);

      expect((await listRetired(100)).items).toEqual([
        { sha256: sha!, size: new TextEncoder().encode('the-retired-one-0').length },
      ]);
    });
  });

  describe('input validation (before touching S3)', () => {
    it.each([
      ['limit 0', { state: 'live', limit: 0 }],
      ['limit 1001', { state: 'live', limit: 1001 }],
      ['limit -1', { state: 'live', limit: -1 }],
      ['limit 1.5', { state: 'live', limit: 1.5 }],
      ['limit NaN', { state: 'live', limit: Number.NaN }],
      ['limit as a string', { state: 'live', limit: '10' }],
      ['limit missing', { state: 'live' }],
      ['uppercase after', { state: 'live', limit: 10, after: 'A'.repeat(64) }],
      ['short after', { state: 'live', limit: 10, after: 'abc' }],
      ['long after', { state: 'live', limit: 10, after: 'a'.repeat(65) }],
      ['after with a path', { state: 'live', limit: 10, after: '../'.repeat(21) + 'a' }],
      ['null after', { state: 'live', limit: 10, after: null }],
      ["state 'x'", { state: 'x', limit: 10 }],
      ['state missing', { limit: 10 }],
    ])('rejects %s with invalid-payload', async (_name, input) => {
      await expect(
        store.list(input as unknown as Parameters<S3BlobStore['list']>[0]),
      ).rejects.toMatchObject({ code: 'invalid-payload', plugin: '@ax/blob-store-s3' });
      expect(fake.calls).toEqual([]);
    });

    it('accepts the limit boundaries 1 and 1000', async () => {
      await seedBlobs(store, 3, 'bounds');
      expect((await store.list({ state: 'live', limit: 1 })).items).toHaveLength(1);
      expect((await store.list({ state: 'live', limit: 1000 })).items).toHaveLength(3);
    });

    it("validates a 'retired' request too", async () => {
      await expect(store.list({ state: 'retired', limit: 0 })).rejects.toMatchObject({
        code: 'invalid-payload',
      });
    });
  });

  describe('paging at scale (2,500 blobs)', () => {
    let all: string[];

    beforeEach(async () => {
      all = await seedBlobs(store, 2500, 'big');
    });

    it('pages 1000 / 1000 / 500; the last page has no `next`; no duplicates', async () => {
      const pages = await drain(store, 1000);

      expect(pages.map((p) => p.items.length)).toEqual([1000, 1000, 500]);
      expect(pages[0]!.next).toBe(pages[0]!.items[999]!.sha256);
      expect(pages[1]!.next).toBe(pages[1]!.items[999]!.sha256);
      expect('next' in pages[2]!).toBe(false);
      const seen = pages.flatMap((p) => p.items.map((i) => i.sha256));
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(2500);
    });

    it('an exact multiple ends with an EMPTY final page (1000, 1000, then nothing)', async () => {
      // Resume after the 500th sha: exactly 2,000 blobs remain.
      const pages = await drain(store, 1000, all[499]);

      expect(pages.map((p) => p.items.length)).toEqual([1000, 1000, 0]);
      expect(pages[1]!.next).toBe(all[2499]);
      expect('next' in pages[2]!).toBe(false);
      expect(pages.flatMap((p) => p.items.map((i) => i.sha256))).toEqual(all.slice(500));
    });
  });
});

describe('S3BlobStore.list against a scripted S3', () => {
  it('reports a missing Size as 0', async () => {
    const sha = shaIn('ab', 'cd', '1');
    const client = {
      send: async (): Promise<unknown> => ({
        Contents: [{ Key: `ab/cd/${sha}` }],
        IsTruncated: false,
      }),
    };
    const store = new S3BlobStore(client as unknown as S3Client, BUCKET);

    expect(await store.list({ state: 'live', limit: 10 })).toEqual({
      items: [{ sha256: sha, size: 0 }],
    });
  });

  it('ignores a key outside the prefix even if the server hands it back', async () => {
    // A well-behaved S3 never does this; an S3-compatible server with a
    // prefix bug must not make us report another store's blob as ours.
    const mine = shaIn('ab', 'cd', '1');
    const theirs = shaIn('ab', 'cd', '2');
    const client = {
      send: async (): Promise<unknown> => ({
        Contents: [
          // Same length as 'team-a/', so a missing prefix check slices it clean.
          { Key: `team-b/ab/cd/${theirs}`, Size: 9 },
          { Key: `team-a/ab/cd/${mine}`, Size: 5 },
        ],
        IsTruncated: false,
      }),
    };
    const store = new S3BlobStore(client as unknown as S3Client, BUCKET, 'team-a');

    expect(await store.list({ state: 'live', limit: 10 })).toEqual({
      items: [{ sha256: mine, size: 5 }],
    });
  });

  it('survives a page with no Contents at all (an empty listing omits the field)', async () => {
    const client = { send: async (): Promise<unknown> => ({ IsTruncated: false, KeyCount: 0 }) };
    const store = new S3BlobStore(client as unknown as S3Client, BUCKET);

    expect(await store.list({ state: 'live', limit: 10 })).toEqual({ items: [] });
  });

  it('gives up if S3 says truncated but sends no continuation token (no spin)', async () => {
    let calls = 0;
    const client = {
      send: async (): Promise<unknown> => {
        calls += 1;
        return { Contents: [], IsTruncated: true };
      },
    };
    const store = new S3BlobStore(client as unknown as S3Client, BUCKET);

    expect(await store.list({ state: 'live', limit: 10 })).toEqual({ items: [] });
    expect(calls).toBe(1);
  });
});
