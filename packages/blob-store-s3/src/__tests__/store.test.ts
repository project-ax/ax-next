import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { PluginError } from '@ax/core';
import { S3BlobStore, blobKey, type BlobListResult } from '../store.js';
import { FakeS3Client, type FakeS3Call } from './fake-s3.js';

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
    await store.delete(ghost);

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

  it("`state: 'retired'` is empty for now, even when live blobs exist — and asks S3 nothing", async () => {
    // A later card (TASK-778) adds the retired namespace; until then there is
    // nothing retired to list.
    await seedBlobs(store, 5, 'retired');
    fake.calls.length = 0;

    const page = await store.list({ state: 'retired', limit: 10 });

    expect(page).toEqual({ items: [] });
    expect('next' in page).toBe(false);
    expect(fake.calls).toEqual([]);
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

    it("validates a 'retired' request too (the stub gets no free pass)", async () => {
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
