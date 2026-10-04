import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeS3Client } from './fake-s3.js';

// The fake is what every list test leans on, so pin down that its
// ListObjectsV2 behaves like S3's: lexicographic order, Prefix, StartAfter
// (exclusive), MaxKeys (default + cap 1000), and token paging. If the fake
// drifted from S3 the store tests would be proving the wrong thing.

const BUCKET = 'ax-blobs';

describe('FakeS3Client ListObjectsV2', () => {
  let fake: FakeS3Client;
  const list = (input: Partial<ConstructorParameters<typeof ListObjectsV2Command>[0]>) =>
    (fake as unknown as S3Client).send(new ListObjectsV2Command({ Bucket: BUCKET, ...input }));

  beforeEach(() => {
    fake = new FakeS3Client();
    // Seeded out of order on purpose.
    for (const k of ['b/2', 'a/1', 'b/1', 'c', 'a/2', 'ab']) {
      fake._put(BUCKET, k, new Uint8Array(k.length));
    }
  });

  it('returns every key in lexicographic order with its Size', async () => {
    const res = await list({});
    expect(res.Contents).toEqual([
      { Key: 'a/1', Size: 3 },
      { Key: 'a/2', Size: 3 },
      { Key: 'ab', Size: 2 },
      { Key: 'b/1', Size: 3 },
      { Key: 'b/2', Size: 3 },
      { Key: 'c', Size: 1 },
    ]);
    expect(res.KeyCount).toBe(6);
    expect(res.IsTruncated).toBe(false);
    expect('NextContinuationToken' in res).toBe(false);
  });

  it('narrows by Prefix', async () => {
    const res = await list({ Prefix: 'a/' });
    expect(res.Contents?.map((c) => c.Key)).toEqual(['a/1', 'a/2']);
  });

  it('StartAfter is exclusive', async () => {
    const res = await list({ StartAfter: 'a/2' });
    expect(res.Contents?.map((c) => c.Key)).toEqual(['ab', 'b/1', 'b/2', 'c']);
  });

  it('pages by MaxKeys with a continuation token, then reports the end', async () => {
    const first = await list({ MaxKeys: 4 });
    expect(first.Contents?.map((c) => c.Key)).toEqual(['a/1', 'a/2', 'ab', 'b/1']);
    expect(first.IsTruncated).toBe(true);
    expect(first.KeyCount).toBe(4);
    expect(typeof first.NextContinuationToken).toBe('string');

    const second = await list({ MaxKeys: 4, ContinuationToken: first.NextContinuationToken! });
    expect(second.Contents?.map((c) => c.Key)).toEqual(['b/2', 'c']);
    expect(second.IsTruncated).toBe(false);
    expect('NextContinuationToken' in second).toBe(false);
  });

  it('an exact fit is NOT truncated (S3 only says truncated when more remain)', async () => {
    const res = await list({ MaxKeys: 6 });
    expect(res.Contents).toHaveLength(6);
    expect(res.IsTruncated).toBe(false);
  });

  it('the token wins over StartAfter, like the real thing', async () => {
    const first = await list({ MaxKeys: 2 });
    const res = await list({
      StartAfter: 'b/2',
      ContinuationToken: first.NextContinuationToken!,
    });
    expect(res.Contents?.map((c) => c.Key)).toEqual(['ab', 'b/1', 'b/2', 'c']);
  });

  it('caps a page at 1000 keys, defaulting MaxKeys to 1000', async () => {
    const big = new FakeS3Client();
    for (let i = 0; i < 1200; i += 1) big._put(BUCKET, `k${String(i).padStart(4, '0')}`, new Uint8Array(0));
    const asClient = big as unknown as S3Client;

    const dflt = await asClient.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    expect(dflt.Contents).toHaveLength(1000);
    expect(dflt.IsTruncated).toBe(true);

    const over = await asClient.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 5000 }));
    expect(over.Contents).toHaveLength(1000);
  });

  it('is scoped to its bucket, and records the call', async () => {
    const res = await (fake as unknown as S3Client).send(
      new ListObjectsV2Command({ Bucket: 'other', Prefix: 'a/', MaxKeys: 7 }),
    );
    expect(res.Contents ?? []).toEqual([]);
    expect(fake.calls).toEqual([
      { name: 'ListObjectsV2', Bucket: 'other', Prefix: 'a/', MaxKeys: 7 },
    ]);
  });
});
