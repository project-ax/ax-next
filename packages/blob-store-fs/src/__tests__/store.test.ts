import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { BlobStore, blobPath, retiredPath, type BlobListResult } from '../store.js';

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

  describe('retire', () => {
    it('moves the live file to <root>/.retired/<aa>/<bb>/<sha>', async () => {
      const bytes = new TextEncoder().encode('retire me');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      expect(retiredPath(root, sha256)).toBe(
        join(root, '.retired', sha256.slice(0, 2), sha256.slice(2, 4), sha256),
      );
      await expect(fs.stat(blobPath(root, sha256))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(new Uint8Array(await fs.readFile(retiredPath(root, sha256)))).toEqual(bytes);
    });

    it('is a no-op for a missing blob (creates nothing retired)', async () => {
      const missing = '2'.repeat(64);
      await expect(store.retire(missing)).resolves.toBeUndefined();
      await expect(fs.stat(retiredPath(root, missing))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('is idempotent — retiring twice leaves one retired copy', async () => {
      const bytes = new TextEncoder().encode('retire twice');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      await store.retire(sha256);
      expect(new Uint8Array(await fs.readFile(retiredPath(root, sha256)))).toEqual(bytes);
      await expect(fs.stat(blobPath(root, sha256))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects an invalid sha', async () => {
      await expect(store.retire('../'.repeat(21) + 'a')).rejects.toMatchObject({
        code: 'invalid-payload',
      });
    });
  });

  describe('purge', () => {
    it('deletes the retired copy', async () => {
      const { sha256 } = await store.put(new TextEncoder().encode('purge me'));
      await store.retire(sha256);
      await store.purge(sha256);
      await expect(fs.stat(retiredPath(root, sha256))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await store.get(sha256)).toEqual({ found: false });
      expect(await store.stat(sha256)).toEqual({ found: false });
    });

    it('can never touch a LIVE blob — purge of a live sha leaves the live file intact', async () => {
      const bytes = new TextEncoder().encode('i am live, leave me be');
      const { sha256 } = await store.put(bytes);
      await store.purge(sha256);
      expect(new Uint8Array(await fs.readFile(blobPath(root, sha256)))).toEqual(bytes);
      const got = await store.get(sha256);
      expect('bytes' in got && got.bytes).toEqual(bytes);
    });

    it('is idempotent — purging twice / purging a missing sha is a no-op', async () => {
      const { sha256 } = await store.put(new TextEncoder().encode('purge twice'));
      await store.retire(sha256);
      await store.purge(sha256);
      await expect(store.purge(sha256)).resolves.toBeUndefined();
      await expect(store.purge('3'.repeat(64))).resolves.toBeUndefined();
    });

    it('rejects an invalid sha', async () => {
      await expect(store.purge('x')).rejects.toMatchObject({ code: 'invalid-payload' });
    });
  });

  describe('restore-on-miss', () => {
    const expectLiveAgain = async (sha256: string): Promise<void> => {
      await expect(fs.stat(blobPath(root, sha256))).resolves.toBeTruthy();
      await expect(fs.stat(retiredPath(root, sha256))).rejects.toMatchObject({ code: 'ENOENT' });
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('get of a retired blob restores it to the live path and serves it', async () => {
      const bytes = new TextEncoder().encode('come back');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      const got = await store.get(sha256);
      expect('bytes' in got && got.bytes).toEqual(bytes);
      await expectLiveAgain(sha256);
    });

    it('stat of a retired blob restores it by default', async () => {
      const bytes = new TextEncoder().encode('stat brings me back');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      expect(await store.stat(sha256)).toEqual({ size: bytes.length });
      await expectLiveAgain(sha256);
    });

    it('stat({ restore: true }) restores too', async () => {
      const bytes = new TextEncoder().encode('explicit restore');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      expect(await store.stat(sha256, { restore: true })).toEqual({ size: bytes.length });
      await expectLiveAgain(sha256);
    });

    it('stat({ restore: false }) reports a retired blob size and leaves it retired', async () => {
      const bytes = new TextEncoder().encode('just looking');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      expect(await store.stat(sha256, { restore: false })).toEqual({ size: bytes.length });
      await expect(fs.stat(blobPath(root, sha256))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(retiredPath(root, sha256))).resolves.toBeTruthy();
    });

    it('stat({ restore: false }) of a live blob still reports it', async () => {
      const bytes = new TextEncoder().encode('live probe');
      const { sha256 } = await store.put(bytes);
      expect(await store.stat(sha256, { restore: false })).toEqual({ size: bytes.length });
    });

    it('stat({ restore: false }) of a blob missing everywhere is { found: false }', async () => {
      expect(await store.stat('4'.repeat(64), { restore: false })).toEqual({ found: false });
    });

    it.each([['string', 'false'], ['number', 0], ['null', null], ['object', {}]])(
      'stat rejects a non-boolean restore (%s) with invalid-payload',
      async (_name, restore) => {
        await expect(
          store.stat('5'.repeat(64), { restore } as unknown as { restore: boolean }),
        ).rejects.toMatchObject({ code: 'invalid-payload', plugin: '@ax/blob-store-fs' });
      },
    );

    it('get still digest-verifies a restored blob — a tampered retired file is corrupt, not served', async () => {
      const { sha256 } = await store.put(new TextEncoder().encode('honest bytes'));
      await store.retire(sha256);
      await fs.writeFile(retiredPath(root, sha256), Buffer.from('swapped while retired'));
      await expect(store.get(sha256)).rejects.toMatchObject({ code: 'corrupt' });
    });

    it('two concurrent gets of a retired blob both return the bytes', async () => {
      const bytes = new TextEncoder().encode('two readers, one restore');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      const [a, b] = await Promise.all([store.get(sha256), store.get(sha256)]);
      expect('bytes' in a && a.bytes).toEqual(bytes);
      expect('bytes' in b && b.bytes).toEqual(bytes);
      await expectLiveAgain(sha256);
    });

    it('a restore that loses the race to another restore re-reads live and serves', async () => {
      // Deterministic: the moment our restore renames, another restorer has
      // already moved the retired copy live, so our rename misses (ENOENT).
      const bytes = new TextEncoder().encode('lost the restore race');
      const { sha256 } = await store.put(bytes);
      await store.retire(sha256);
      const realRename = fs.rename.bind(fs);
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
        await realRename(from, to); // the other restorer wins
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      });
      const got = await store.get(sha256);
      expect('bytes' in got && got.bytes).toEqual(bytes);
    });

    it('a restore that loses the race to a purge is { found: false }', async () => {
      const { sha256 } = await store.put(new TextEncoder().encode('purged under me'));
      await store.retire(sha256);
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (from) => {
        await fs.unlink(from); // a purge wins
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      });
      expect(await store.get(sha256)).toEqual({ found: false });
    });
  });

  describe('THE RACE: concurrent put + retire never loses a blob', () => {
    it('1000 rounds of Promise.all([put, retire]) then get returns the bytes every round', async () => {
      const ROUNDS = 1000;
      const lost: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const bytes = new Uint8Array(randomBytes(32 + (round % 64)));
        const { sha256 } = await store.put(bytes);
        if (round % 2 === 0) {
          await Promise.all([store.put(bytes), store.retire(sha256)]);
        } else {
          await Promise.all([store.retire(sha256), store.put(bytes)]);
        }
        const got = await store.get(sha256);
        if (!('bytes' in got) || Buffer.compare(Buffer.from(got.bytes), Buffer.from(bytes)) !== 0) {
          lost.push(round);
        }
      }
      expect(lost.length, `${lost.length} of ${ROUNDS} rounds lost the blob`).toBe(0);
    }, 30_000);
  });
});

// ---------------------------------------------------------------------------
// list — the GC's enumeration seam (blob:list, TASK-777). Walks the two shard
// levels in sorted order, so pages come back ascending by sha with a cursor
// (`next`) the caller feeds back as `after`.
// ---------------------------------------------------------------------------

/** Put `count` distinct tiny blobs, a batch at a time (real fs, so keep it brisk). */
async function seedBlobs(store: BlobStore, count: number, tag: string): Promise<string[]> {
  const shas: string[] = [];
  const batch = 50;
  for (let start = 0; start < count; start += batch) {
    const end = Math.min(start + batch, count);
    const done = await Promise.all(
      Array.from({ length: end - start }, (_, k) =>
        store.put(new TextEncoder().encode(`${tag}-${start + k}`)),
      ),
    );
    for (const d of done) shas.push(d.sha256);
  }
  return shas.sort();
}

/**
 * Page through the store the way a caller does: feed each `next` back as
 * `after` until it is absent. Returns every page so tests can assert on shape.
 */
async function drain(
  store: BlobStore,
  limit: number,
  start?: string,
  state: 'live' | 'retired' = 'live',
): Promise<BlobListResult[]> {
  const pages: BlobListResult[] = [];
  let after = start;
  for (;;) {
    const page: BlobListResult = await store.list(
      after === undefined ? { state, limit } : { state, limit, after },
    );
    pages.push(page);
    if (page.next === undefined) return pages;
    after = page.next;
    if (pages.length > 100) throw new Error('list did not terminate');
  }
}

describe('BlobStore.list', () => {
  let root: string;
  let store: BlobStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ax-blob-list-test-'));
    store = new BlobStore(root);
    await store.ensureRoot();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns { items: [] } for an empty store (and no `next` key)', async () => {
    const page = await store.list({ state: 'live', limit: 10 });
    expect(page).toEqual({ items: [] });
    expect('next' in page).toBe(false);
  });

  it('returns { items: [] } when the root directory does not exist yet', async () => {
    const ghost = new BlobStore(join(root, 'never-created'));
    expect(await ghost.list({ state: 'live', limit: 10 })).toEqual({ items: [] });
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

  it('`after` excludes itself and everything before it', async () => {
    const shas = await seedBlobs(store, 40, 'after');
    const pivot = shas[17]!;

    const page = await store.list({ state: 'live', limit: 100, after: pivot });

    expect(page.items.map((i) => i.sha256)).toEqual(shas.slice(18));
    expect(page.items.every((i) => i.sha256 > pivot)).toBe(true);
  });

  it('`after` need not name a stored blob (a cursor from a since-retired blob still pages)', async () => {
    const shas = await seedBlobs(store, 20, 'ghost-cursor');
    const ghost = shas[9]!;
    await store.retire(ghost);

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

  it('never returns temp files, .retired/, non-hex dirs, stray files, or misplaced shas', async () => {
    const real = await store.put(new TextEncoder().encode('the one real blob'));
    const sha = real.sha256;
    const shard = join(root, sha.slice(0, 2), sha.slice(2, 4));

    // An in-flight put: `<sha>.tmp.<pid>.<uuid>` right next to a real blob.
    await fs.writeFile(join(shard, `${sha}.tmp.123.0f0e0d0c-aaaa-bbbb-cccc-000000000000`), 'x');
    // A temp file for a sha that has no final file yet.
    const lonely = 'ab'.repeat(32);
    await fs.mkdir(join(root, 'ab', 'ab'), { recursive: true });
    await fs.writeFile(join(root, 'ab', 'ab', `${lonely}.tmp.9.uuid`), 'x');
    // The retired namespace lives under the same root but is not live.
    const gone = 'cd'.repeat(32);
    await fs.mkdir(join(root, '.retired', 'cd', 'cd'), { recursive: true });
    await fs.writeFile(join(root, '.retired', 'cd', 'cd', gone), 'x');
    // Non-hex directories and stray files at every level.
    await fs.mkdir(join(root, 'lost+found'), { recursive: true });
    await fs.writeFile(join(root, 'lost+found', 'junk'), 'x');
    await fs.mkdir(join(root, 'ZZ', 'zz'), { recursive: true });
    await fs.writeFile(join(root, 'README'), 'x');
    await fs.writeFile(join(root, 'ee'), 'a FILE named like a shard dir');
    await fs.mkdir(join(root, 'ff', 'ff'), { recursive: true });
    await fs.writeFile(join(root, 'ff', 'stray-file'), 'x');
    await fs.mkdir(join(root, 'ff', 'GG'), { recursive: true });
    await fs.writeFile(join(root, 'ff', 'ff', 'not-a-sha'), 'x');
    // Uppercase hex is not a sha here either.
    await fs.writeFile(join(root, 'ff', 'ff', 'F'.repeat(64)), 'x');
    // A well-formed sha filed under the WRONG shard.
    await fs.writeFile(join(root, 'ff', 'ff', 'ab'.repeat(32)), 'x');

    const page = await store.list({ state: 'live', limit: 100 });

    expect(page.items).toEqual([{ sha256: sha, size: real.size }]);
  });

  describe("state: 'retired'", () => {
    it('lists exactly the retired blobs, ascending, with sizes — and live listing excludes them', async () => {
      const shas = await seedBlobs(store, 30, 'retired-list');
      const retired = shas.filter((_, i) => i % 3 === 0);
      for (const sha of retired) await store.retire(sha);
      const live = shas.filter((s) => !retired.includes(s));

      const r = await store.list({ state: 'retired', limit: 1000 });
      expect(r.items.map((i) => i.sha256)).toEqual(retired);
      for (const item of r.items) {
        expect(item.size).toBe((await fs.stat(retiredPath(root, item.sha256))).size);
      }
      expect('next' in r).toBe(false);

      const l = await store.list({ state: 'live', limit: 1000 });
      expect(l.items.map((i) => i.sha256)).toEqual(live);
    });

    it('empty retired namespace (no .retired dir yet) is { items: [] }', async () => {
      await seedBlobs(store, 5, 'none-retired');
      const page = await store.list({ state: 'retired', limit: 10 });
      expect(page).toEqual({ items: [] });
      expect('next' in page).toBe(false);
    });

    it('pages with the live contract: `next` iff full, `after` exclusive, no duplicates', async () => {
      const shas = await seedBlobs(store, 23, 'retired-page');
      for (const sha of shas) await store.retire(sha);

      const pages = await drain(store, 5, undefined, 'retired');
      expect(pages.map((p) => p.items.length)).toEqual([5, 5, 5, 5, 3]);
      for (const p of pages.slice(0, 4)) expect(p.next).toBe(p.items[4]!.sha256);
      expect('next' in pages[4]!).toBe(false);
      expect(pages.flatMap((p) => p.items.map((i) => i.sha256))).toEqual(shas);

      const after = await store.list({ state: 'retired', limit: 100, after: shas[10]! });
      expect(after.items.map((i) => i.sha256)).toEqual(shas.slice(11));

      // Exact multiple: full pages then an empty one.
      const exact = await drain(store, 5, shas[2]!, 'retired');
      expect(exact.map((p) => p.items.length)).toEqual([5, 5, 5, 5, 0]);
    });

    it('skips temp files, malformed names, misplaced shas, and non-shard dirs', async () => {
      const real = await store.put(new TextEncoder().encode('the one retired blob'));
      await store.retire(real.sha256);
      const sha = real.sha256;
      const rroot = join(root, '.retired');
      const shard = join(rroot, sha.slice(0, 2), sha.slice(2, 4));
      await fs.writeFile(join(shard, `${sha}.tmp.1.uuid`), 'x');
      await fs.writeFile(join(shard, 'not-a-sha'), 'x');
      await fs.writeFile(join(shard, 'F'.repeat(64)), 'x');
      await fs.mkdir(join(rroot, 'ff', 'ff'), { recursive: true });
      await fs.writeFile(join(rroot, 'ff', 'ff', 'ab'.repeat(32)), 'x');
      await fs.mkdir(join(rroot, 'ZZ', 'zz'), { recursive: true });
      await fs.writeFile(join(rroot, 'README'), 'x');
      // A live blob is never listed as retired.
      await store.put(new TextEncoder().encode('live neighbour'));

      const page = await store.list({ state: 'retired', limit: 100 });
      expect(page.items).toEqual([{ sha256: sha, size: real.size }]);
    });
  });

  it('skips an entry that vanishes between readdir and stat (ENOENT)', async () => {
    const shas = await seedBlobs(store, 6, 'vanish');
    const victim = shas[2]!;
    const realStat = fs.stat.bind(fs) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, 'stat').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (String(p) === blobPath(root, victim)) {
        return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      }
      return realStat(p, ...rest);
    }) as unknown as typeof fs.stat);

    const page = await store.list({ state: 'live', limit: 100 });

    expect(page.items.map((i) => i.sha256)).toEqual(shas.filter((s) => s !== victim));
  });

  it('propagates a stat error that is not ENOENT', async () => {
    await seedBlobs(store, 3, 'eacces');
    vi.spyOn(fs, 'stat').mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'EACCES' }),
    );
    await expect(store.list({ state: 'live', limit: 10 })).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('does not even read shard directories that sort before `after` (cheap paging)', async () => {
    // List never checks content, so lay out shards by hand: 3 first-level
    // shards x 4 second-level shards, one sha-shaped file each. Several `bb`
    // under one `aa` is what makes the second-level skip observable.
    const shaIn = (aa: string, bb: string): string => aa + bb + '0'.repeat(60);
    const layout: string[] = [];
    for (const aa of ['10', '20', '30']) {
      for (const bb of ['00', '40', '80', 'c0']) {
        await fs.mkdir(join(root, aa, bb), { recursive: true });
        await fs.writeFile(join(root, aa, bb, shaIn(aa, bb)), 'x');
        layout.push(shaIn(aa, bb));
      }
    }
    const pivot = shaIn('20', '40');
    const readSpy = vi.spyOn(fs, 'readdir');

    const page = await store.list({ state: 'live', limit: 1000, after: pivot });

    expect(page.items.map((i) => i.sha256)).toEqual(layout.filter((s) => s > pivot));
    const read = readSpy.mock.calls.map((c) => String(c[0]).slice(root.length));
    // Whole `10/` is behind the cursor, and so is `20/00`; `20/40` is the
    // cursor's own shard (read, then filtered), and everything after it is read.
    expect(read).toEqual(['', '/20', '/20/40', '/20/80', '/20/c0', '/30', '/30/00', '/30/40', '/30/80', '/30/c0']);
  });

  it('never walks into .retired/ or other non-shard directories', async () => {
    await seedBlobs(store, 5, 'no-retired-walk');
    await fs.mkdir(join(root, '.retired', 'cd', 'cd'), { recursive: true });
    await fs.mkdir(join(root, 'lost+found'), { recursive: true });
    await fs.mkdir(join(root, 'ZZ', 'zz'), { recursive: true });
    const readSpy = vi.spyOn(fs, 'readdir');

    await store.list({ state: 'live', limit: 100 });

    const read = readSpy.mock.calls.map((c) => String(c[0]).slice(root.length));
    expect(read.length).toBeGreaterThan(1);
    expect(read.filter((d) => /\.retired|lost\+found|ZZ/.test(d))).toEqual([]);
  });

  it('sorts for itself — it does not lean on the order the filesystem returns entries', async () => {
    // Crowd one shard so the third level has real work to sort, then make
    // readdir answer in REVERSE at every level, whatever the host fs does.
    const crowded = Array.from({ length: 12 }, (_, i) => 'abcd' + i.toString(16).padStart(2, '0') + '0'.repeat(58));
    await fs.mkdir(join(root, 'ab', 'cd'), { recursive: true });
    for (const sha of [...crowded].reverse()) await fs.writeFile(join(root, 'ab', 'cd', sha), 'x');
    const others = await seedBlobs(store, 40, 'reverse-readdir');
    const expected = [...crowded, ...others].sort();
    const realReaddir = fs.readdir.bind(fs) as (...a: unknown[]) => Promise<unknown[]>;
    vi.spyOn(fs, 'readdir').mockImplementation((async (...a: unknown[]) =>
      (await realReaddir(...a)).reverse()) as unknown as typeof fs.readdir);

    const page = await store.list({ state: 'live', limit: 1000 });

    expect(page.items.map((i) => i.sha256)).toEqual(expected);
  });

  describe('input validation (before touching the disk)', () => {
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
      const readSpy = vi.spyOn(fs, 'readdir');
      await expect(
        store.list(input as unknown as Parameters<BlobStore['list']>[0]),
      ).rejects.toMatchObject({ code: 'invalid-payload', plugin: '@ax/blob-store-fs' });
      expect(readSpy).not.toHaveBeenCalled();
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

  describe('paging at scale (2,500 real blobs)', () => {
    let bigRoot: string;
    let big: BlobStore;
    let all: string[];

    beforeAll(async () => {
      bigRoot = await fs.mkdtemp(join(tmpdir(), 'ax-blob-list-big-'));
      big = new BlobStore(bigRoot);
      await big.ensureRoot();
      all = await seedBlobs(big, 2500, 'big');
    }, 120_000);

    afterAll(async () => {
      await fs.rm(bigRoot, { recursive: true, force: true });
    });

    it('pages 1000 / 1000 / 500; the last page has no `next`; no duplicates', async () => {
      const pages = await drain(big, 1000);

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
      const pages = await drain(big, 1000, all[499]);

      expect(pages.map((p) => p.items.length)).toEqual([1000, 1000, 0]);
      expect(pages[1]!.next).toBe(all[2499]);
      expect('next' in pages[2]!).toBe(false);
      expect(pages.flatMap((p) => p.items.map((i) => i.sha256))).toEqual(all.slice(500));
    });
  });
});
